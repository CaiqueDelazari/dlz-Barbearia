import { queryOne } from '@/lib/db';
import { ApiError } from '@/lib/http';
import type { BusinessSettings, Tenant } from '../types';

const TENANT_COLUMNS = `
  id, slug, name, phone, whatsapp, instagram, address, logo_url, cover_url,
  timezone, currency, active
`;

const SETTINGS_COLUMNS = `
  tenant_id, slot_interval_minutes, min_advance_minutes, max_advance_days,
  minimum_reschedule_notice_minutes, allow_client_cancel, online_payment_required,
  allow_deposit, allow_full_payment, deposit_percent::float8 AS deposit_percent,
  forfeit_deposit_on_no_show, hold_expiration_minutes, allow_split_appointments,
  allow_professional_choice, reminder_24h_enabled, reminder_1h_enabled,
  return_reminder_enabled, return_reminder_days, manage_link_ttl_hours,
  payment_methods, whatsapp_session_id, payment_provider,
  owner_notify_phone, owner_notify_enabled
`;

export async function getTenantById(tenantId: string): Promise<Tenant> {
  const tenant = await queryOne<Tenant>(
    `SELECT ${TENANT_COLUMNS} FROM tenants WHERE id = $1`,
    [tenantId]
  );
  if (!tenant) throw ApiError.notFound('Empresa nao encontrada');
  return tenant;
}

export async function getTenantBySlug(slug: string): Promise<Tenant> {
  const tenant = await queryOne<Tenant>(
    `SELECT ${TENANT_COLUMNS} FROM tenants WHERE slug = $1`,
    [slug]
  );
  if (!tenant || !tenant.active) throw ApiError.notFound('Pagina de agendamento nao encontrada');
  return tenant;
}

export async function getSettings(tenantId: string): Promise<BusinessSettings> {
  let settings = await queryOne<BusinessSettings>(
    `SELECT ${SETTINGS_COLUMNS} FROM business_settings WHERE tenant_id = $1`,
    [tenantId]
  );
  if (!settings) {
    // empresa recem-criada: garante a linha com os defaults do schema
    settings = await queryOne<BusinessSettings>(
      `INSERT INTO business_settings (tenant_id) VALUES ($1)
       ON CONFLICT (tenant_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id
       RETURNING ${SETTINGS_COLUMNS}`,
      [tenantId]
    );
  }
  if (!settings) throw ApiError.notFound('Configuracoes da empresa nao encontradas');
  return settings;
}

export async function getTenantContext(
  tenantId: string
): Promise<{ tenant: Tenant; settings: BusinessSettings }> {
  const [tenant, settings] = await Promise.all([getTenantById(tenantId), getSettings(tenantId)]);
  return { tenant, settings };
}
