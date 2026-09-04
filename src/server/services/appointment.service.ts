import type { PoolClient } from 'pg';
import { lockProfessionalAgenda, query, queryOne, transaction } from '@/lib/db';
import { ApiError } from '@/lib/http';
import { audit, generateManageToken } from '@/lib/auth';
import { todayInTz, utcToZoned } from '@/lib/datetime';
import type { AppointmentStatus, Service } from '../types';
import { getTenantContext } from '../repositories/tenant.repo';
import { upsertClientByPhone } from '../repositories/client.repo';
import {
  assertSlotFree,
  loadAgendaContext,
  loadServices,
  professionalsForServices,
} from './availability.service';
import {
  scheduleAppointmentNotifications,
  cancelScheduledNotifications,
  notifyOwner,
} from './notification.service';

export type BookingItemInput = {
  startsAt: string;              // ISO
  serviceIds: string[];
  professionalId?: string | null;
};

export type CreateBookingInput = {
  tenantId: string;
  items: BookingItemInput[];     // 1 item = servicos emendados | N itens = horarios separados
  client: { id?: string; name?: string; phone?: string; notes?: string | null };
  source: 'online' | 'manual' | 'whatsapp' | 'ai';
  createdByUserId?: string | null;
  /** online: reserva temporaria ate o pagamento. manual: confirma direto. */
  requirePayment: boolean;
  notes?: string | null;
  ip?: string;
};

export type BookingResult = {
  bookingGroupId: string;
  manageToken: string;
  status: AppointmentStatus;
  holdExpiresAt: string | null;
  totalAmount: number;
  appointments: {
    id: string;
    startsAt: string;
    endsAt: string;
    professionalId: string | null;
    services: { id: string; name: string; price: number; durationMinutes: number }[];
    amount: number;
  }[];
};

/** Overlap dentro da transacao: a validacao que realmente vale. */
async function assertNoOverlapTx(
  tx: PoolClient,
  tenantId: string,
  professionalId: string | null,
  startsAt: Date,
  endsAt: Date,
  ignoreAppointmentId?: string
): Promise<void> {
  const clash = await tx.query(
    `SELECT id FROM appointments
      WHERE tenant_id = $1
        AND professional_id IS NOT DISTINCT FROM $2
        AND starts_at < $4 AND ends_at > $3
        AND ($5::uuid IS NULL OR id <> $5)
        AND (
          status IN ('confirmed', 'completed')
          OR (status = 'pending' AND (hold_expires_at IS NULL OR hold_expires_at > now()))
        )
      LIMIT 1`,
    [tenantId, professionalId, startsAt, endsAt, ignoreAppointmentId ?? null]
  );
  if (clash.rowCount) {
    throw ApiError.conflict('Este horario acabou de ser reservado. Escolha outro.', 'slot_taken');
  }
}

export async function createBooking(input: CreateBookingInput): Promise<BookingResult> {
  const { tenant, settings } = await getTenantContext(input.tenantId);
  const tz = tenant.timezone;
  const now = new Date();

  if (!input.items.length) throw ApiError.badRequest('Nenhum horario informado');
  if (input.items.length > 1 && !settings.allow_split_appointments) {
    throw ApiError.badRequest('Esta empresa nao aceita servicos em horarios separados');
  }

  // ---------------------------------------------------- resolucao dos itens
  const resolved: {
    startsAt: Date;
    endsAt: Date;
    duration: number;
    amount: number;
    professionalId: string | null;
    services: Service[];
    dateStr: string;
  }[] = [];

  for (const item of input.items) {
    const services = await loadServices(input.tenantId, item.serviceIds);
    const duration = services.reduce((s, x) => s + x.duration_minutes, 0);
    const amount = services.reduce((s, x) => s + Number(x.price), 0);
    const startsAt = new Date(item.startsAt);
    if (Number.isNaN(startsAt.getTime())) throw ApiError.badRequest('Horario invalido');
    const endsAt = new Date(startsAt.getTime() + duration * 60_000);
    const dateStr = utcToZoned(startsAt, tz).dateStr;

    // agendamento manual pode furar antecedencia minima; o publico nao
    if (input.source === 'online') {
      if (startsAt.getTime() < now.getTime() + settings.min_advance_minutes * 60_000) {
        throw ApiError.badRequest('Este horario esta muito proximo para agendamento online');
      }
      const limitDate = new Date(now.getTime() + settings.max_advance_days * 86_400_000);
      if (startsAt > limitDate) {
        throw ApiError.badRequest('Data fora do periodo liberado para agendamento');
      }
    }

    let professionalId = item.professionalId ?? null;
    const allowed = await professionalsForServices(input.tenantId, item.serviceIds);
    if (professionalId && allowed && !allowed.has(professionalId)) {
      throw ApiError.badRequest('Este profissional nao realiza todos os servicos selecionados');
    }

    // Sem escolha do cliente: pegamos quem estiver livre no horario.
    const ctx = await loadAgendaContext(input.tenantId, dateStr, dateStr, professionalId);
    if (!professionalId) {
      const candidates = ctx.professionals.filter((p) => !allowed || allowed.has(p.id));
      if (!candidates.length && ctx.professionals.length) {
        throw ApiError.badRequest('Nenhum profissional atende os servicos selecionados');
      }
      if (candidates.length) {
        const free = candidates.find((p) => {
          try {
            assertSlotFree(ctx, p.id, startsAt, endsAt, dateStr);
            return true;
          } catch {
            return false;
          }
        });
        if (!free) throw ApiError.conflict('Nao ha profissional livre neste horario', 'slot_taken');
        professionalId = free.id;
      }
    } else {
      assertSlotFree(ctx, professionalId, startsAt, endsAt, dateStr);
    }

    if (professionalId === null && ctx.professionals.length === 0) {
      assertSlotFree(ctx, null, startsAt, endsAt, dateStr);
    }

    resolved.push({ startsAt, endsAt, duration, amount, professionalId, services, dateStr });
  }

  // itens do mesmo grupo nao podem colidir entre si
  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      const a = resolved[i];
      const b = resolved[j];
      if (a.professionalId === b.professionalId && a.startsAt < b.endsAt && b.startsAt < a.endsAt) {
        throw ApiError.badRequest('Os horarios escolhidos se sobrepoem');
      }
    }
  }

  const totalAmount = resolved.reduce((s, r) => s + r.amount, 0);
  const status: AppointmentStatus = input.requirePayment ? 'pending' : 'confirmed';
  const holdExpiresAt = input.requirePayment
    ? new Date(now.getTime() + settings.hold_expiration_minutes * 60_000)
    : null;
  const manageToken = generateManageToken();
  const manageExpires = new Date(
    Math.max(...resolved.map((r) => r.endsAt.getTime())) + settings.manage_link_ttl_hours * 3_600_000
  );

  // ------------------------------------------------------------- transacao
  const result = await transaction(async (tx) => {
    const client = await upsertClientByPhone(tx, input.tenantId, {
      id: input.client.id,
      name: input.client.name,
      phone: input.client.phone,
      notes: input.client.notes ?? null,
    });
    if (client.blocked) throw ApiError.forbidden('Cadastro bloqueado. Entre em contato com a empresa.');

    const groupRow = await tx.query<{ id: string }>('SELECT gen_random_uuid() AS id');
    const bookingGroupId = groupRow.rows[0].id;

    const created: BookingResult['appointments'] = [];

    for (const [index, r] of resolved.entries()) {
      await lockProfessionalAgenda(tx, input.tenantId, r.professionalId);
      await assertNoOverlapTx(tx, input.tenantId, r.professionalId, r.startsAt, r.endsAt);

      const appt = await tx.query<{ id: string }>(
        `INSERT INTO appointments (
           tenant_id, booking_group_id, client_id, professional_id, starts_at, ends_at,
           duration_minutes, status, source, total_amount, paid_amount, payment_status,
           hold_expires_at, manage_token, manage_token_expires_at, notes, created_by_user_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,'pending',$11,$12,$13,$14,$15)
         RETURNING id`,
        [
          input.tenantId,
          bookingGroupId,
          client.id,
          r.professionalId,
          r.startsAt,
          r.endsAt,
          r.duration,
          status,
          input.source,
          r.amount,
          holdExpiresAt,
          index === 0 ? manageToken : null, // token unico por reserva, guardado no 1o item
          index === 0 ? manageExpires : null,
          input.notes ?? null,
          input.createdByUserId ?? null,
        ]
      );
      const appointmentId = appt.rows[0].id;

      for (const [pos, service] of r.services.entries()) {
        await tx.query(
          `INSERT INTO appointment_services
             (tenant_id, appointment_id, service_id, service_name, price, duration_minutes, position)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [input.tenantId, appointmentId, service.id, service.name, service.price, service.duration_minutes, pos]
        );
      }

      created.push({
        id: appointmentId,
        startsAt: r.startsAt.toISOString(),
        endsAt: r.endsAt.toISOString(),
        professionalId: r.professionalId,
        amount: r.amount,
        services: r.services.map((s) => ({
          id: s.id,
          name: s.name,
          price: Number(s.price),
          durationMinutes: s.duration_minutes,
        })),
      });
    }

    return { bookingGroupId, clientId: client.id, appointments: created };
  });

  await audit({
    tenantId: input.tenantId,
    userId: input.createdByUserId ?? null,
    actor: input.createdByUserId ? `user:${input.createdByUserId}` : input.source,
    action: 'appointment.create',
    entity: 'booking_group',
    entityId: result.bookingGroupId,
    after: { total: totalAmount, status, items: result.appointments.length },
    ip: input.ip,
  });

  if (status === 'confirmed') {
    for (const appt of result.appointments) {
      await scheduleAppointmentNotifications(input.tenantId, appt.id).catch((err) =>
        console.error('[notificacao] falha ao agendar:', err)
      );
    }
    // Um aviso por appointment, nao um pelo grupo.
    //
    // Corte + barba no MESMO horario ja e' um appointment so, com dois
    // `appointment_services` -- o texto do aviso lista os dois e nao ha
    // repeticao. O grupo so passa de um item quando o cliente escolhe horarios
    // separados -- e ai avisar so o primeiro escondia o resto: quem marcasse
    // corte as 14h e barba as 16h aparecia para a loja como se tivesse marcado
    // so as 14h, e o segundo horario ficava ocupado sem ninguem saber.
    for (const appt of result.appointments) {
      await notifyOwner(input.tenantId, appt.id, 'owner_new').catch((err) =>
        console.error('[notificacao] falha ao avisar a loja:', err)
      );
    }
  }

  return {
    bookingGroupId: result.bookingGroupId,
    manageToken,
    status,
    holdExpiresAt: holdExpiresAt?.toISOString() ?? null,
    totalAmount,
    appointments: result.appointments,
  };
}

// ------------------------------------------------------------- consultas
const APPT_SELECT = `
  a.id, a.tenant_id, a.booking_group_id, a.client_id, a.professional_id,
  a.starts_at, a.ends_at, a.duration_minutes, a.status, a.source,
  a.total_amount::float8 AS total_amount, a.paid_amount::float8 AS paid_amount,
  a.payment_status, a.hold_expires_at, a.manage_token, a.notes,
  a.cancelled_at, a.cancelled_reason, a.created_at,
  c.name AS client_name, c.phone AS client_phone,
  p.name AS professional_name, p.photo_url AS professional_photo,
  COALESCE(
    (SELECT json_agg(json_build_object(
        'id', s.service_id, 'name', s.service_name,
        'price', s.price::float8, 'durationMinutes', s.duration_minutes)
      ORDER BY s.position)
       FROM appointment_services s WHERE s.appointment_id = a.id),
    '[]'::json) AS services
`;

const APPT_FROM = `
  FROM appointments a
  JOIN clients c ON c.id = a.client_id
  LEFT JOIN professionals p ON p.id = a.professional_id
`;

export type AppointmentRow = Record<string, any>;

export async function listAppointments(params: {
  tenantId: string;
  from?: string;
  to?: string;
  status?: string;
  professionalId?: string;
  clientId?: string;
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<{ items: AppointmentRow[]; total: number }> {
  const where: string[] = ['a.tenant_id = $1'];
  const values: unknown[] = [params.tenantId];

  /** Cada filtro vira um placeholder proprio - nada de string concatenada. */
  const push = (clause: (p: string) => string, value: unknown) => {
    values.push(value);
    where.push(clause(`$${values.length}`));
  };

  if (params.from) push((p) => `a.starts_at >= ${p}`, new Date(params.from));
  if (params.to) push((p) => `a.starts_at < ${p}`, new Date(params.to));
  if (params.status) push((p) => `a.status = ${p}::appointment_status`, params.status);
  if (params.professionalId) push((p) => `a.professional_id = ${p}`, params.professionalId);
  if (params.clientId) push((p) => `a.client_id = ${p}`, params.clientId);
  if (params.search) push((p) => `(c.name ILIKE ${p} OR c.phone ILIKE ${p})`, `%${params.search}%`);

  const whereSql = where.join(' AND ');
  const limit = Math.min(params.limit ?? 100, 500);
  const offset = params.offset ?? 0;

  const [items, countRow] = await Promise.all([
    query(
      `SELECT ${APPT_SELECT} ${APPT_FROM} WHERE ${whereSql}
       ORDER BY a.starts_at LIMIT ${limit} OFFSET ${offset}`,
      values
    ),
    queryOne<{ count: string }>(`SELECT count(*)::text AS count ${APPT_FROM} WHERE ${whereSql}`, values),
  ]);

  return { items, total: Number(countRow?.count ?? 0) };
}

export async function getAppointment(tenantId: string, id: string): Promise<AppointmentRow> {
  const row = await queryOne(
    `SELECT ${APPT_SELECT} ${APPT_FROM} WHERE a.tenant_id = $1 AND a.id = $2`,
    [tenantId, id]
  );
  if (!row) throw ApiError.notFound('Agendamento nao encontrado');
  return row;
}

export async function getBookingByToken(token: string): Promise<{
  tenantId: string;
  bookingGroupId: string;
  appointments: AppointmentRow[];
}> {
  const anchor = await queryOne<{ tenant_id: string; booking_group_id: string; manage_token_expires_at: Date | null }>(
    `SELECT tenant_id, booking_group_id, manage_token_expires_at
       FROM appointments WHERE manage_token = $1`,
    [token]
  );
  if (!anchor) throw ApiError.notFound('Link de agendamento invalido');
  if (anchor.manage_token_expires_at && new Date(anchor.manage_token_expires_at) < new Date()) {
    throw ApiError.forbidden('Este link expirou');
  }
  const appointments = await query(
    `SELECT ${APPT_SELECT} ${APPT_FROM}
      WHERE a.booking_group_id = $1 ORDER BY a.starts_at`,
    [anchor.booking_group_id]
  );
  return {
    tenantId: anchor.tenant_id,
    bookingGroupId: anchor.booking_group_id,
    appointments,
  };
}

// --------------------------------------------------------------- mutacoes
export async function setStatus(input: {
  tenantId: string;
  appointmentId: string;
  status: AppointmentStatus;
  userId?: string | null;
  reason?: string | null;
  ip?: string;
}): Promise<AppointmentRow> {
  const before = await getAppointment(input.tenantId, input.appointmentId);

  await query(
    `UPDATE appointments
        SET status = $3::appointment_status,
            cancelled_at = CASE WHEN $3 IN ('cancelled','no_show') THEN now() ELSE cancelled_at END,
            cancelled_reason = CASE WHEN $3 IN ('cancelled','no_show') THEN $4 ELSE cancelled_reason END,
            hold_expires_at = CASE WHEN $3 = 'confirmed' THEN NULL ELSE hold_expires_at END
      WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.appointmentId, input.status, input.reason ?? null]
  );

  if (input.status === 'no_show') {
    await query('UPDATE clients SET no_show_count = no_show_count + 1 WHERE id = $1', [before.client_id]);
  }
  if (input.status === 'cancelled' || input.status === 'no_show') {
    await cancelScheduledNotifications(input.tenantId, input.appointmentId);
    await notifyOwner(input.tenantId, input.appointmentId, 'owner_cancelled').catch((err) =>
      console.error('[notificacao] falha ao avisar a loja:', err)
    );
  }

  await audit({
    tenantId: input.tenantId,
    userId: input.userId ?? null,
    action: `appointment.${input.status}`,
    entity: 'appointment',
    entityId: input.appointmentId,
    before: { status: before.status },
    after: { status: input.status, reason: input.reason ?? null },
    ip: input.ip,
  });

  return getAppointment(input.tenantId, input.appointmentId);
}

export async function rescheduleAppointment(input: {
  tenantId: string;
  appointmentId: string;
  startsAt: string;
  professionalId?: string | null;
  userId?: string | null;
  /** true quando quem remarca e o cliente pelo link publico */
  enforceNotice: boolean;
  ip?: string;
}): Promise<AppointmentRow> {
  const { tenant, settings } = await getTenantContext(input.tenantId);
  const current = await getAppointment(input.tenantId, input.appointmentId);

  if (['cancelled', 'completed', 'no_show'].includes(current.status)) {
    throw ApiError.badRequest('Este agendamento nao pode mais ser alterado');
  }

  if (input.enforceNotice) {
    const limit = new Date(
      new Date(current.starts_at).getTime() - settings.minimum_reschedule_notice_minutes * 60_000
    );
    if (new Date() > limit) {
      const hours = Math.round(settings.minimum_reschedule_notice_minutes / 60);
      throw ApiError.forbidden(
        `Alteracoes sao permitidas ate ${hours}h antes do horario. Entre em contato com a empresa.`
      );
    }
  }

  const startsAt = new Date(input.startsAt);
  if (Number.isNaN(startsAt.getTime())) throw ApiError.badRequest('Horario invalido');
  const endsAt = new Date(startsAt.getTime() + current.duration_minutes * 60_000);
  const dateStr = utcToZoned(startsAt, tenant.timezone).dateStr;
  const professionalId = input.professionalId ?? current.professional_id;

  const ctx = await loadAgendaContext(input.tenantId, dateStr, dateStr, professionalId);
  // o proprio agendamento nao pode bloquear a si mesmo na revalidacao
  ctx.busy = ctx.busy.filter(
    (b) =>
      !(
        new Date(b.starts_at).getTime() === new Date(current.starts_at).getTime() &&
        b.professional_id === current.professional_id
      )
  );
  assertSlotFree(ctx, professionalId, startsAt, endsAt, dateStr);

  await transaction(async (tx) => {
    await lockProfessionalAgenda(tx, input.tenantId, professionalId);
    await assertNoOverlapTx(tx, input.tenantId, professionalId, startsAt, endsAt, input.appointmentId);
    await tx.query(
      `UPDATE appointments
          SET starts_at = $3, ends_at = $4, professional_id = $5, status =
              CASE WHEN status = 'pending' THEN 'pending'::appointment_status ELSE 'confirmed'::appointment_status END
        WHERE tenant_id = $1 AND id = $2`,
      [input.tenantId, input.appointmentId, startsAt, endsAt, professionalId]
    );
  });

  await cancelScheduledNotifications(input.tenantId, input.appointmentId);
  await scheduleAppointmentNotifications(input.tenantId, input.appointmentId, { includeConfirmation: true }).catch(
    (err) => console.error('[notificacao] falha ao reagendar avisos:', err)
  );
  await notifyOwner(input.tenantId, input.appointmentId, 'owner_rescheduled').catch((err) =>
    console.error('[notificacao] falha ao avisar a loja:', err)
  );

  await audit({
    tenantId: input.tenantId,
    userId: input.userId ?? null,
    actor: input.userId ? `user:${input.userId}` : 'client',
    action: 'appointment.reschedule',
    entity: 'appointment',
    entityId: input.appointmentId,
    before: { starts_at: current.starts_at },
    after: { starts_at: startsAt.toISOString() },
    ip: input.ip,
  });

  return getAppointment(input.tenantId, input.appointmentId);
}

export async function cancelByClient(input: {
  token: string;
  appointmentId?: string;
  reason?: string;
  ip?: string;
}): Promise<void> {
  const booking = await getBookingByToken(input.token);
  const { settings } = await getTenantContext(booking.tenantId);
  if (!settings.allow_client_cancel) {
    throw ApiError.forbidden('Cancelamento pelo link nao esta habilitado. Fale com a empresa.');
  }

  const targets = input.appointmentId
    ? booking.appointments.filter((a) => a.id === input.appointmentId)
    : booking.appointments;
  if (!targets.length) throw ApiError.notFound('Agendamento nao encontrado');

  for (const appt of targets) {
    if (['cancelled', 'completed', 'no_show'].includes(appt.status)) continue;
    const limit = new Date(
      new Date(appt.starts_at).getTime() - settings.minimum_reschedule_notice_minutes * 60_000
    );
    if (new Date() > limit) {
      const hours = Math.round(settings.minimum_reschedule_notice_minutes / 60);
      throw ApiError.forbidden(`Cancelamento permitido ate ${hours}h antes do horario.`);
    }
    await setStatus({
      tenantId: booking.tenantId,
      appointmentId: appt.id,
      status: 'cancelled',
      reason: input.reason ?? 'Cancelado pelo cliente',
      ip: input.ip,
    });
  }
}

/**
 * Job: devolve para a agenda as reservas que nao viraram pagamento.
 *
 * `tenantId` limita a varredura a uma empresa. O cron nao passa nada e varre
 * todas, que e o comportamento certo em producao: uma chamada por minuto para
 * o sistema inteiro. Quem passa e' quem chama pela API para uma empresa so --
 * hoje a suite e2e, cujos arquivos rodam em paralelo. Sem escopo, duas suites
 * chamando o worker ao mesmo tempo roubavam trabalho uma da outra: a que
 * chegasse depois recebia `reservasExpiradas: 0` porque a outra ja tinha
 * expirado a reserva dela, e o teste falhava sem nada estar quebrado.
 */
export async function expireHolds(tenantId?: string): Promise<number> {
  const rows = await query<{ id: string; tenant_id: string }>(
    `UPDATE appointments
        SET status = 'cancelled', cancelled_at = now(),
            cancelled_reason = 'Reserva expirada (pagamento nao concluido)'
      WHERE status = 'pending' AND hold_expires_at IS NOT NULL AND hold_expires_at < now()
        AND ($1::uuid IS NULL OR tenant_id = $1)
      RETURNING id, tenant_id`,
    [tenantId ?? null]
  );
  for (const row of rows) {
    await cancelScheduledNotifications(row.tenant_id, row.id);
  }
  return rows.length;
}

/** Agenda do dia para o painel (usa o fuso da empresa, nao o do servidor). */
export async function agendaOfDay(tenantId: string, date?: string) {
  const { tenant } = await getTenantContext(tenantId);
  const day = date ?? todayInTz(tenant.timezone);
  const { zonedToUtc } = await import('@/lib/datetime');
  const from = zonedToUtc(day, 0, tenant.timezone);
  const to = zonedToUtc(day, 24 * 60, tenant.timezone);
  const { items } = await listAppointments({
    tenantId,
    from: from.toISOString(),
    to: to.toISOString(),
    limit: 500,
  });
  return { date: day, timezone: tenant.timezone, items };
}
