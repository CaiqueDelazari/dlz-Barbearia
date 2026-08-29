import { clientIp, ok, rateLimit, route } from '@/lib/http';
import { query } from '@/lib/db';
import { getTenantBySlug, getSettings } from '@/server/repositories/tenant.repo';

export const dynamic = 'force-dynamic';

/** Dados publicos da pagina de agendamento. Nada de configuracao sensivel aqui. */
export const GET = route(async (req: Request, { params }: { params: { slug: string } }) => {
  await rateLimit(`public-tenant:${clientIp(req)}`, 120, 60_000);

  const tenant = await getTenantBySlug(params.slug);
  const settings = await getSettings(tenant.id);

  const hours = await query(
    `SELECT weekday, opens_at::text AS opens_at, closes_at::text AS closes_at
       FROM business_hours
      WHERE tenant_id = $1 AND professional_id IS NULL AND active
      ORDER BY weekday, opens_at`,
    [tenant.id]
  );

  return ok({
    tenant: {
      slug: tenant.slug,
      name: tenant.name,
      phone: tenant.phone,
      whatsapp: tenant.whatsapp,
      instagram: tenant.instagram,
      address: tenant.address,
      logoUrl: tenant.logo_url,
      coverUrl: tenant.cover_url,
      timezone: tenant.timezone,
    },
    hours,
    booking: {
      depositPercent: Number(settings.deposit_percent),
      allowDeposit: settings.allow_deposit,
      allowFullPayment: settings.allow_full_payment,
      paymentRequired: settings.online_payment_required,
      paymentMethods: settings.payment_methods,
      allowProfessionalChoice: settings.allow_professional_choice,
      allowSplit: settings.allow_split_appointments,
      maxAdvanceDays: settings.max_advance_days,
      holdMinutes: settings.hold_expiration_minutes,
      rescheduleNoticeMinutes: settings.minimum_reschedule_notice_minutes,
    },
  });
});
