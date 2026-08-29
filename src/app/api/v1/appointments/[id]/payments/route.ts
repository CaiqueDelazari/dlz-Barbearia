import { z } from 'zod';
import { clientIp, ok, parseBody, route } from '@/lib/http';
import { requireAuth } from '@/lib/auth';
import { query } from '@/lib/db';
import { getAppointment } from '@/server/services/appointment.service';
import { registerManualPayment } from '@/server/services/payment/payment.service';

export const dynamic = 'force-dynamic';

export const GET = route(async (req: Request, { params }: { params: { id: string } }) => {
  const session = await requireAuth(req);
  const appointment = await getAppointment(session.tenantId, params.id);

  const payments = await query(
    `SELECT id, amount::float8 AS amount, kind, method, status, provider, paid_at, created_at,
            refunded_amount::float8 AS "refundedAmount", refunded_at AS "refundedAt",
            refund_reason AS "refundReason"
       FROM payments
      WHERE tenant_id = $1 AND booking_group_id = $2
      ORDER BY created_at`,
    [session.tenantId, appointment.booking_group_id]
  );

  return ok({
    payments,
    resumo: {
      total: appointment.total_amount,
      pago: appointment.paid_amount,
      restante: Math.max(0, appointment.total_amount - appointment.paid_amount),
      status: appointment.payment_status,
    },
  });
});

const schema = z.object({
  amount: z.number().positive('Valor invalido'),
  method: z.enum(['pix', 'card', 'cash', 'transfer', 'other']),
});

/** Registro de pagamento presencial (dinheiro, maquininha, Pix na hora). */
export const POST = route(async (req: Request, { params }: { params: { id: string } }) => {
  const session = await requireAuth(req);
  const body = await parseBody(req, schema);

  await registerManualPayment({
    tenantId: session.tenantId,
    appointmentId: params.id,
    amount: body.amount,
    method: body.method,
    userId: session.userId,
    ip: clientIp(req),
  });

  const appointment = await getAppointment(session.tenantId, params.id);
  return ok({ appointment }, 201);
});
