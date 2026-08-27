import { z } from 'zod';
import { clientIp, ok, parseBody, rateLimit, route } from '@/lib/http';
import { getSettings, getTenantById } from '@/server/repositories/tenant.repo';
import {
  cancelByClient,
  getBookingByToken,
  rescheduleAppointment,
} from '@/server/services/appointment.service';

export const dynamic = 'force-dynamic';

/** Consulta do cliente pelo link seguro - sem senha, com token de prazo limitado. */
export const GET = route(async (req: Request, { params }: { params: { token: string } }) => {
  rateLimit(`booking-view:${clientIp(req)}`, 60, 60_000);

  const booking = await getBookingByToken(params.token);
  const [tenant, settings] = await Promise.all([
    getTenantById(booking.tenantId),
    getSettings(booking.tenantId),
  ]);

  const noticeMs = settings.minimum_reschedule_notice_minutes * 60_000;
  const appointments = booking.appointments.map((a) => ({
    ...a,
    canChange:
      ['pending', 'confirmed'].includes(a.status) &&
      new Date(a.starts_at).getTime() - noticeMs > Date.now(),
  }));

  return ok({
    bookingGroupId: booking.bookingGroupId,
    tenant: {
      slug: tenant.slug,
      name: tenant.name,
      phone: tenant.phone,
      whatsapp: tenant.whatsapp,
      address: tenant.address,
      logoUrl: tenant.logo_url,
      timezone: tenant.timezone,
    },
    policy: {
      rescheduleNoticeMinutes: settings.minimum_reschedule_notice_minutes,
      allowCancel: settings.allow_client_cancel,
      forfeitDepositOnNoShow: settings.forfeit_deposit_on_no_show,
    },
    appointments,
  });
});

const patchSchema = z.object({
  appointmentId: z.string().uuid(),
  startsAt: z.string().min(1),
  professionalId: z.string().uuid().nullable().optional(),
});

export const PATCH = route(async (req: Request, { params }: { params: { token: string } }) => {
  const ip = clientIp(req);
  rateLimit(`booking-change:${ip}`, 10, 60_000);

  const booking = await getBookingByToken(params.token);
  const body = await parseBody(req, patchSchema);

  const belongs = booking.appointments.some((a) => a.id === body.appointmentId);
  if (!belongs) return ok({ error: 'Agendamento nao pertence a este link' }, 403);

  const updated = await rescheduleAppointment({
    tenantId: booking.tenantId,
    appointmentId: body.appointmentId,
    startsAt: body.startsAt,
    professionalId: body.professionalId ?? undefined,
    enforceNotice: true, // cliente respeita a janela minima; o painel nao
    ip,
  });

  return ok({ appointment: updated });
});

export const DELETE = route(async (req: Request, { params }: { params: { token: string } }) => {
  const ip = clientIp(req);
  rateLimit(`booking-cancel:${ip}`, 10, 60_000);

  const url = new URL(req.url);
  await cancelByClient({
    token: params.token,
    appointmentId: url.searchParams.get('appointmentId') ?? undefined,
    reason: url.searchParams.get('reason') ?? undefined,
    ip,
  });

  return ok({ cancelled: true });
});
