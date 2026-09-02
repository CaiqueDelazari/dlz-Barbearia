import { z } from 'zod';
import { ok, parseQuery, route } from '@/lib/http';
import { requireAuth } from '@/lib/auth';
import { query } from '@/lib/db';
import { addDays, todayInTz, zonedToUtc } from '@/lib/datetime';
import { getTenantContext } from '@/server/repositories/tenant.repo';
import { listAppointments } from '@/server/services/appointment.service';
import { escopoDeAgenda, filtroDeProfissional } from '@/server/services/escopo.service';

export const dynamic = 'force-dynamic';

const schema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  view: z.enum(['day', 'week', 'month']).default('day'),
  professionalId: z.string().uuid().optional(),
});

/**
 * Agenda do painel em dia/semana/mês, sempre no fuso da empresa.
 *
 * Devolve o dia inteiro como ele é: agendamentos, bloqueios pontuais, pausas
 * fixas e o horário de funcionamento. Sem isso a pessoa olha a tela vazia e não
 * sabe se está livre ou fechado.
 */
export const GET = route(async (req: Request) => {
  const session = await requireAuth(req);
  const q = parseQuery(req, schema);
  const { tenant } = await getTenantContext(session.tenantId);
  const tz = tenant.timezone;

  // STAFF ve so a propria agenda -- inclusive os bloqueios e as pausas, senao a
  // tela mostraria a folga dos colegas em cima dos horarios dele.
  const escopo = await escopoDeAgenda(session);
  const profId = filtroDeProfissional(escopo, q.professionalId);

  const date = q.date ?? todayInTz(tz);
  let from = date;
  let to = date;

  if (q.view === 'week') {
    const [y, m, d] = date.split('-').map(Number);
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    from = addDays(date, -weekday);
    to = addDays(from, 6);
  } else if (q.view === 'month') {
    from = `${date.slice(0, 7)}-01`;
    const [y, m] = date.split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    to = `${date.slice(0, 7)}-${String(daysInMonth).padStart(2, '0')}`;
  }

  const rangeStart = zonedToUtc(from, 0, tz);
  const rangeEnd = zonedToUtc(addDays(to, 1), 0, tz);

  const [{ items }, blocks, weeklyBreaks, hours] = await Promise.all([
    listAppointments({
      tenantId: session.tenantId,
      from: rangeStart.toISOString(),
      to: rangeEnd.toISOString(),
      professionalId: profId,
      limit: 500,
    }),
    query(
      `SELECT b.id, b.professional_id AS "professionalId", p.name AS "professionalName",
              b.starts_at AS "startsAt", b.ends_at AS "endsAt", b.reason, b.kind
         FROM blocked_periods b
         LEFT JOIN professionals p ON p.id = b.professional_id
        WHERE b.tenant_id = $1 AND b.ends_at > $2 AND b.starts_at < $3
          AND ($4::uuid IS NULL OR b.professional_id IS NULL OR b.professional_id = $4)
        ORDER BY b.starts_at`,
      [session.tenantId, rangeStart, rangeEnd, profId ?? null]
    ),
    query(
      `SELECT b.id, b.professional_id AS "professionalId", p.name AS "professionalName",
              b.weekday, b.starts_at::text AS "startsAt", b.ends_at::text AS "endsAt", b.label
         FROM business_breaks b
         LEFT JOIN professionals p ON p.id = b.professional_id
        WHERE b.tenant_id = $1
          AND ($2::uuid IS NULL OR b.professional_id IS NULL OR b.professional_id = $2)
        ORDER BY b.weekday, b.starts_at`,
      [session.tenantId, profId ?? null]
    ),
    query(
      `SELECT professional_id AS "professionalId", weekday,
              opens_at::text AS "opensAt", closes_at::text AS "closesAt"
         FROM business_hours WHERE tenant_id = $1 AND active
         ORDER BY weekday, opens_at`,
      [session.tenantId]
    ),
  ]);

  return ok({ view: q.view, from, to, timezone: tz, items, blocks, weeklyBreaks, hours });
});
