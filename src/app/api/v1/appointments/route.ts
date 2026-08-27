import { z } from 'zod';
import { clientIp, ok, parseBody, parseQuery, route } from '@/lib/http';
import { requireAuth } from '@/lib/auth';
import { createBooking, listAppointments } from '@/server/services/appointment.service';
import { registerManualPayment } from '@/server/services/payment/payment.service';

export const dynamic = 'force-dynamic';

const listSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  status: z.string().optional(),
  professionalId: z.string().uuid().optional(),
  clientId: z.string().uuid().optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const GET = route(async (req: Request) => {
  const session = await requireAuth(req);
  const q = parseQuery(req, listSchema);
  const result = await listAppointments({ tenantId: session.tenantId, ...q });
  return ok(result);
});

const createSchema = z.object({
  items: z
    .array(
      z.object({
        startsAt: z.string().min(1),
        serviceIds: z.array(z.string().uuid()).min(1),
        professionalId: z.string().uuid().nullable().optional(),
      })
    )
    .min(1),
  client: z.object({
    id: z.string().uuid().optional(),
    name: z.string().min(2).optional(),
    phone: z.string().min(10).optional(),
  }),
  notes: z.string().max(500).nullable().optional(),
  /** pagamento ja recebido no balcao, opcional */
  payment: z
    .object({
      amount: z.number().positive(),
      method: z.enum(['pix', 'card', 'cash', 'transfer', 'other']),
    })
    .optional(),
});

/**
 * Agendamento manual (balcao/telefone). Nao exige pagamento online: nasce
 * confirmado e o pagamento pode ser registrado junto ou depois.
 */
export const POST = route(async (req: Request) => {
  const session = await requireAuth(req);
  const ip = clientIp(req);
  const body = await parseBody(req, createSchema);

  const booking = await createBooking({
    tenantId: session.tenantId,
    items: body.items,
    client: body.client,
    source: 'manual',
    createdByUserId: session.userId,
    requirePayment: false,
    notes: body.notes ?? null,
    ip,
  });

  if (body.payment && booking.appointments[0]) {
    await registerManualPayment({
      tenantId: session.tenantId,
      appointmentId: booking.appointments[0].id,
      amount: body.payment.amount,
      method: body.payment.method,
      userId: session.userId,
      ip,
    });
  }

  return ok(booking, 201);
});
