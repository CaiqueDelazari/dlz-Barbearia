import { z } from 'zod';
import { clientIp, ok, parseBody, rateLimit, route } from '@/lib/http';
import { getBookingByToken } from '@/server/services/appointment.service';
import { createCheckout } from '@/server/services/payment/payment.service';
import { notifyPaymentLink } from '@/server/services/notification.service';
import { getSettings } from '@/server/repositories/tenant.repo';

export const dynamic = 'force-dynamic';

const schema = z.object({
  manageToken: z.string().min(10),
  mode: z.enum(['deposit', 'full']),
  method: z.enum(['pix', 'card']),
});

/**
 * Gera a cobranca da reserva. O acesso e provado pelo manage token da propria
 * reserva - ninguem cria cobranca para o agendamento de outra pessoa.
 */
export const POST = route(async (req: Request) => {
  const ip = clientIp(req);
  await rateLimit(`checkout:${ip}`, 20, 60_000);

  const body = await parseBody(req, schema);
  const booking = await getBookingByToken(body.manageToken);

  const checkout = await createCheckout({
    tenantId: booking.tenantId,
    bookingGroupId: booking.bookingGroupId,
    mode: body.mode,
    method: body.method,
    ip,
  });

  // manda o link tambem pelo WhatsApp: o cliente costuma sair da pagina
  if (checkout.checkoutUrl && booking.appointments[0]) {
    const settings = await getSettings(booking.tenantId);
    await notifyPaymentLink({
      tenantId: booking.tenantId,
      appointmentId: booking.appointments[0].id,
      amount: checkout.amount,
      url: checkout.checkoutUrl,
      minutes: settings.hold_expiration_minutes,
    }).catch((err) => console.error('[pagamento] falha ao enviar link:', err));
  }

  return ok(checkout, 201);
});
