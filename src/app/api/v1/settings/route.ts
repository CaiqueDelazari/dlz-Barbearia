import { z } from 'zod';
import { clientIp, ok, parseBody, route } from '@/lib/http';
import { imageUrlSchema } from '@/lib/security';
import { audit, requireRole } from '@/lib/auth';
import { query, transaction } from '@/lib/db';
import { getTenantContext } from '@/server/repositories/tenant.repo';

export const dynamic = 'force-dynamic';

export const GET = route(async (req: Request) => {
  const session = await requireRole(req, 'ADMIN');
  const { tenant, settings } = await getTenantContext(session.tenantId);

  const [hours, breaks] = await Promise.all([
    query(
      `SELECT id, professional_id AS "professionalId", weekday,
              opens_at::text AS "opensAt", closes_at::text AS "closesAt", active
         FROM business_hours WHERE tenant_id = $1 ORDER BY weekday, opens_at`,
      [session.tenantId]
    ),
    query(
      `SELECT id, professional_id AS "professionalId", weekday,
              starts_at::text AS "startsAt", ends_at::text AS "endsAt", label
         FROM business_breaks WHERE tenant_id = $1 ORDER BY weekday, starts_at`,
      [session.tenantId]
    ),
  ]);

  return ok({ tenant, settings, hours, breaks });
});

const timeRe = /^\d{2}:\d{2}(:\d{2})?$/;

const schema = z.object({
  tenant: z
    .object({
      name: z.string().min(2).max(120).optional(),
      phone: z.string().max(30).nullable().optional(),
      whatsapp: z.string().max(30).nullable().optional(),
      instagram: z.string().max(120).nullable().optional(),
      address: z.string().max(300).nullable().optional(),
      logoUrl: imageUrlSchema.nullable().optional(),
      coverUrl: imageUrlSchema.nullable().optional(),
      timezone: z.string().max(60).optional(),
    })
    .optional(),
  settings: z
    .object({
      slotIntervalMinutes: z.number().int().min(5).max(240).optional(),
      minAdvanceMinutes: z.number().int().min(0).max(10080).optional(),
      maxAdvanceDays: z.number().int().min(1).max(365).optional(),
      minimumRescheduleNoticeMinutes: z.number().int().min(0).max(10080).optional(),
      allowClientCancel: z.boolean().optional(),
      onlinePaymentRequired: z.boolean().optional(),
      allowDeposit: z.boolean().optional(),
      allowFullPayment: z.boolean().optional(),
      depositPercent: z.number().min(1).max(100).optional(),
      forfeitDepositOnNoShow: z.boolean().optional(),
      holdExpirationMinutes: z.number().int().min(3).max(240).optional(),
      allowSplitAppointments: z.boolean().optional(),
      allowProfessionalChoice: z.boolean().optional(),
      reminder24hEnabled: z.boolean().optional(),
      reminder1hEnabled: z.boolean().optional(),
      returnReminderEnabled: z.boolean().optional(),
      returnReminderDays: z.number().int().min(1).max(365).optional(),
      manageLinkTtlHours: z.number().int().min(1).max(8760).optional(),
      paymentMethods: z.array(z.enum(['pix', 'card', 'cash', 'transfer', 'other'])).optional(),
      whatsappSessionId: z.string().max(60).nullable().optional(),
      ownerNotifyPhone: z.string().max(30).nullable().optional(),
      ownerNotifyEnabled: z.boolean().optional(),
    })
    .optional(),
  /** Substitui a grade toda de horarios da empresa quando enviada. */
  hours: z
    .array(
      z.object({
        professionalId: z.string().uuid().nullable().optional(),
        weekday: z.number().int().min(0).max(6),
        opensAt: z.string().regex(timeRe),
        closesAt: z.string().regex(timeRe),
      })
    )
    .optional(),
  breaks: z
    .array(
      z.object({
        professionalId: z.string().uuid().nullable().optional(),
        weekday: z.number().int().min(0).max(6),
        startsAt: z.string().regex(timeRe),
        endsAt: z.string().regex(timeRe),
        label: z.string().max(60).nullable().optional(),
      })
    )
    .optional(),
});

const TENANT_COLUMNS: Record<string, string> = {
  name: 'name',
  phone: 'phone',
  whatsapp: 'whatsapp',
  instagram: 'instagram',
  address: 'address',
  logoUrl: 'logo_url',
  coverUrl: 'cover_url',
  timezone: 'timezone',
};

const SETTINGS_COLUMNS: Record<string, string> = {
  slotIntervalMinutes: 'slot_interval_minutes',
  minAdvanceMinutes: 'min_advance_minutes',
  maxAdvanceDays: 'max_advance_days',
  minimumRescheduleNoticeMinutes: 'minimum_reschedule_notice_minutes',
  allowClientCancel: 'allow_client_cancel',
  onlinePaymentRequired: 'online_payment_required',
  allowDeposit: 'allow_deposit',
  allowFullPayment: 'allow_full_payment',
  depositPercent: 'deposit_percent',
  forfeitDepositOnNoShow: 'forfeit_deposit_on_no_show',
  holdExpirationMinutes: 'hold_expiration_minutes',
  allowSplitAppointments: 'allow_split_appointments',
  allowProfessionalChoice: 'allow_professional_choice',
  reminder24hEnabled: 'reminder_24h_enabled',
  reminder1hEnabled: 'reminder_1h_enabled',
  returnReminderEnabled: 'return_reminder_enabled',
  returnReminderDays: 'return_reminder_days',
  manageLinkTtlHours: 'manage_link_ttl_hours',
  paymentMethods: 'payment_methods',
  whatsappSessionId: 'whatsapp_session_id',
  // `payment_provider` NAO entra aqui de proposito. E' configuracao de
  // plataforma, nao de loja: um ADMIN que pudesse escrever o nome de um gateway
  // aqui passaria a cobrar para a conta de quem contratou a cobranca online.
  // Ver a migration 007.
  ownerNotifyPhone: 'owner_notify_phone',
  ownerNotifyEnabled: 'owner_notify_enabled',
};

function buildUpdate(
  table: string,
  map: Record<string, string>,
  payload: Record<string, unknown>,
  tenantId: string,
  keyColumn: string
): { sql: string; values: unknown[] } | null {
  const sets: string[] = [];
  const values: unknown[] = [tenantId];
  for (const [key, column] of Object.entries(map)) {
    if (payload[key] === undefined) continue;
    values.push(payload[key]);
    sets.push(`${column} = $${values.length}`);
  }
  if (!sets.length) return null;
  return { sql: `UPDATE ${table} SET ${sets.join(', ')} WHERE ${keyColumn} = $1`, values };
}

export const PATCH = route(async (req: Request) => {
  const session = await requireRole(req, 'ADMIN');
  const body = await parseBody(req, schema);

  await transaction(async (tx) => {
    if (body.tenant) {
      const update = buildUpdate('tenants', TENANT_COLUMNS, body.tenant, session.tenantId, 'id');
      if (update) await tx.query(update.sql, update.values);
    }

    if (body.settings) {
      const update = buildUpdate('business_settings', SETTINGS_COLUMNS, body.settings, session.tenantId, 'tenant_id');
      if (update) await tx.query(update.sql, update.values);
    }

    /**
     * Troca a grade apenas do escopo que veio no payload.
     *
     * A tela de Configurações edita o horário da empresa (professional_id NULL).
     * Um DELETE geral levaria junto as pausas por profissional criadas em
     * "Fechar agenda" — que esta tela nem mostra.
     */
    const escopos = (rows: { professionalId?: string | null }[]) => [
      ...new Set(rows.map((r) => r.professionalId ?? null)),
    ];

    if (body.hours) {
      for (const professionalId of escopos(body.hours)) {
        await tx.query(
          'DELETE FROM business_hours WHERE tenant_id = $1 AND professional_id IS NOT DISTINCT FROM $2',
          [session.tenantId, professionalId]
        );
      }
      for (const h of body.hours) {
        await tx.query(
          `INSERT INTO business_hours (tenant_id, professional_id, weekday, opens_at, closes_at)
           VALUES ($1,$2,$3,$4::time,$5::time)`,
          [session.tenantId, h.professionalId ?? null, h.weekday, h.opensAt, h.closesAt]
        );
      }
    }

    if (body.breaks) {
      for (const professionalId of escopos(body.breaks)) {
        await tx.query(
          'DELETE FROM business_breaks WHERE tenant_id = $1 AND professional_id IS NOT DISTINCT FROM $2',
          [session.tenantId, professionalId]
        );
      }
      for (const b of body.breaks) {
        await tx.query(
          `INSERT INTO business_breaks (tenant_id, professional_id, weekday, starts_at, ends_at, label)
           VALUES ($1,$2,$3,$4::time,$5::time,$6)`,
          [session.tenantId, b.professionalId ?? null, b.weekday, b.startsAt, b.endsAt, b.label ?? null]
        );
      }
    }
  });

  await audit({
    tenantId: session.tenantId,
    userId: session.userId,
    action: 'settings.update',
    entity: 'tenant',
    entityId: session.tenantId,
    after: body,
    ip: clientIp(req),
  });

  const { tenant, settings } = await getTenantContext(session.tenantId);
  return ok({ tenant, settings });
});
