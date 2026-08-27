import { z } from 'zod';
import { clientIp, ApiError, ok, parseBody, parseQuery, route } from '@/lib/http';
import { audit, requireAuth } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';
import { timeToMinutes, utcToZoned, zonedToUtc } from '@/lib/datetime';
import { getTenantContext } from '@/server/repositories/tenant.repo';
import { setStatus } from '@/server/services/appointment.service';

export const dynamic = 'force-dynamic';

const listSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
});

export const GET = route(async (req: Request) => {
  const session = await requireAuth(req);
  const q = parseQuery(req, listSchema);

  const blocks = await query(
    `SELECT b.id, b.professional_id AS "professionalId", p.name AS "professionalName",
            b.starts_at AS "startsAt", b.ends_at AS "endsAt", b.reason, b.kind
       FROM blocked_periods b
       LEFT JOIN professionals p ON p.id = b.professional_id
      WHERE b.tenant_id = $1
        AND ($2::timestamptz IS NULL OR b.ends_at >= $2)
        AND ($3::timestamptz IS NULL OR b.starts_at <= $3)
      ORDER BY b.starts_at`,
    [session.tenantId, q.from ?? null, q.to ?? null]
  );

  return ok({ blocks });
});

const schema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Para férias e emendas de feriado. Ausente = só o dia de `date`. */
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** Ausentes = dia inteiro. */
  startTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  endTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  /** null = fecha para todo mundo. */
  professionalId: z.string().uuid().nullable().optional(),
  reason: z.string().max(200).optional(),
  kind: z.enum(['block', 'holiday', 'vacation', 'dayoff']).default('block'),
  /** Vira uma pausa fixa toda semana (ex.: "Larissa não atende segunda de manhã"). */
  repeatWeekly: z.boolean().optional(),
  /**
   * O que fazer com quem já está marcado no período:
   *  abort  - recusa e devolve a lista (padrão: ninguém fecha agenda sem ver)
   *  keep   - fecha para novos, mantém os já marcados
   *  cancel - cancela os agendamentos e fecha
   */
  onConflict: z.enum(['abort', 'keep', 'cancel']).default('abort'),
});

/**
 * Fechar a agenda.
 *
 * Regra de ouro: bloquear NUNCA some com cliente marcado sem avisar. Se houver
 * alguém no período, a resposta é 409 com a lista — quem decide é a pessoa,
 * escolhendo manter ou cancelar.
 */
export const POST = route(async (req: Request) => {
  const session = await requireAuth(req);
  const body = await parseBody(req, schema);
  const { tenant } = await getTenantContext(session.tenantId);
  const tz = tenant.timezone;

  const allDay = !body.startTime && !body.endTime;
  const lastDate = body.endDate ?? body.date;
  if (lastDate < body.date) throw ApiError.badRequest('A data final é anterior à inicial');
  if (body.startTime && body.endTime && body.endTime <= body.startTime) {
    throw ApiError.badRequest('O horário final precisa ser maior que o inicial');
  }

  // ------------------------------------------------- pausa fixa semanal
  if (body.repeatWeekly) {
    if (allDay) {
      throw ApiError.badRequest(
        'Para folga fixa o dia inteiro, remova o dia em Configurações → Horário de funcionamento.',
        'weekly_needs_time'
      );
    }
    const [y, m, d] = body.date.split('-').map(Number);
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();

    const created = await queryOne(
      `INSERT INTO business_breaks (tenant_id, professional_id, weekday, starts_at, ends_at, label)
       VALUES ($1,$2,$3,$4::time,$5::time,$6)
       RETURNING id, weekday, starts_at::text AS "startsAt", ends_at::text AS "endsAt", label`,
      [session.tenantId, body.professionalId ?? null, weekday, body.startTime, body.endTime, body.reason ?? null]
    );

    await audit({
      tenantId: session.tenantId,
      userId: session.userId,
      action: 'block.weekly.create',
      entity: 'business_break',
      entityId: (created as { id: string }).id,
      after: body,
      ip: clientIp(req),
    });

    return ok({ weeklyBreak: created, repeated: true }, 201);
  }

  // ------------------------------------------------------ bloqueio pontual
  const startsAt = zonedToUtc(body.date, body.startTime ? timeToMinutes(body.startTime) : 0, tz);
  const endsAt = body.endTime
    ? zonedToUtc(lastDate, timeToMinutes(body.endTime), tz)
    : zonedToUtc(lastDate, 24 * 60, tz);

  // quem já está marcado dentro da janela (o bloqueio de todos pega todo mundo)
  const conflicts = await query<{
    id: string;
    starts_at: Date;
    client_name: string;
    client_phone: string;
    professional_name: string | null;
    services: string;
  }>(
    `SELECT a.id, a.starts_at, c.name AS client_name, c.phone AS client_phone,
            p.name AS professional_name,
            COALESCE((SELECT string_agg(s.service_name, ' + ' ORDER BY s.position)
                        FROM appointment_services s WHERE s.appointment_id = a.id), '') AS services
       FROM appointments a
       JOIN clients c ON c.id = a.client_id
       LEFT JOIN professionals p ON p.id = a.professional_id
      WHERE a.tenant_id = $1
        AND a.status IN ('pending', 'confirmed')
        AND a.starts_at < $3 AND a.ends_at > $2
        AND ($4::uuid IS NULL OR a.professional_id = $4)
      ORDER BY a.starts_at`,
    [session.tenantId, startsAt, endsAt, body.professionalId ?? null]
  );

  if (conflicts.length && body.onConflict === 'abort') {
    throw ApiError.conflict(
      conflicts.length === 1
        ? 'Há 1 cliente marcado nesse período.'
        : `Há ${conflicts.length} clientes marcados nesse período.`,
      'has_appointments',
      {
        appointments: conflicts.map((a) => ({
          id: a.id,
          time: utcToZoned(new Date(a.starts_at), tz).timeStr,
          date: utcToZoned(new Date(a.starts_at), tz).dateStr,
          clientName: a.client_name,
          clientPhone: a.client_phone,
          professionalName: a.professional_name,
          services: a.services,
        })),
      }
    );
  }

  const block = await queryOne(
    `INSERT INTO blocked_periods (tenant_id, professional_id, starts_at, ends_at, reason, kind, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, professional_id AS "professionalId", starts_at AS "startsAt",
               ends_at AS "endsAt", reason, kind`,
    [
      session.tenantId,
      body.professionalId ?? null,
      startsAt,
      endsAt,
      body.reason ?? null,
      body.kind,
      session.userId,
    ]
  );

  // cancelar avisa o cliente pelos canais normais (setStatus derruba a fila)
  let cancelled = 0;
  if (body.onConflict === 'cancel') {
    for (const appointment of conflicts) {
      await setStatus({
        tenantId: session.tenantId,
        appointmentId: appointment.id,
        status: 'cancelled',
        userId: session.userId,
        reason: body.reason ? `Agenda fechada: ${body.reason}` : 'Agenda fechada pela empresa',
        ip: clientIp(req),
      });
      cancelled++;
    }
  }

  await audit({
    tenantId: session.tenantId,
    userId: session.userId,
    action: 'block.create',
    entity: 'blocked_period',
    entityId: (block as { id: string }).id,
    after: { ...body, cancelled },
    ip: clientIp(req),
  });

  return ok({ block, cancelledAppointments: cancelled, keptAppointments: conflicts.length - cancelled }, 201);
});
