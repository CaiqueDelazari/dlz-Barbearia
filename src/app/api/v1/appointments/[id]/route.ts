import { z } from 'zod';
import { clientIp, ok, parseBody, route } from '@/lib/http';
import { requireAuth } from '@/lib/auth';
import { getAppointment, rescheduleAppointment, setStatus } from '@/server/services/appointment.service';

export const dynamic = 'force-dynamic';

export const GET = route(async (req: Request, { params }: { params: { id: string } }) => {
  const session = await requireAuth(req);
  const appointment = await getAppointment(session.tenantId, params.id);
  return ok({ appointment });
});

const patchSchema = z.object({
  status: z.enum(['pending', 'confirmed', 'completed', 'cancelled', 'no_show']).optional(),
  startsAt: z.string().optional(),
  professionalId: z.string().uuid().nullable().optional(),
  reason: z.string().max(300).optional(),
});

/** Painel: muda status e/ou remarca. Aqui a janela minima do cliente nao se aplica. */
export const PATCH = route(async (req: Request, { params }: { params: { id: string } }) => {
  const session = await requireAuth(req);
  const ip = clientIp(req);
  const body = await parseBody(req, patchSchema);

  let appointment = await getAppointment(session.tenantId, params.id);

  if (body.startsAt) {
    appointment = await rescheduleAppointment({
      tenantId: session.tenantId,
      appointmentId: params.id,
      startsAt: body.startsAt,
      professionalId: body.professionalId ?? undefined,
      userId: session.userId,
      enforceNotice: false,
      ip,
    });
  }

  if (body.status) {
    appointment = await setStatus({
      tenantId: session.tenantId,
      appointmentId: params.id,
      status: body.status,
      userId: session.userId,
      reason: body.reason ?? null,
      ip,
    });
  }

  return ok({ appointment });
});

export const DELETE = route(async (req: Request, { params }: { params: { id: string } }) => {
  const session = await requireAuth(req);
  const url = new URL(req.url);
  const appointment = await setStatus({
    tenantId: session.tenantId,
    appointmentId: params.id,
    status: 'cancelled',
    userId: session.userId,
    reason: url.searchParams.get('reason') ?? 'Cancelado pelo painel',
    ip: clientIp(req),
  });
  return ok({ appointment });
});
