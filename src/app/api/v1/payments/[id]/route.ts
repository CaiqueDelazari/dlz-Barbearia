import { z } from 'zod';
import { clientIp, ok, rateLimit, route } from '@/lib/http';
import { getPaymentPublic } from '@/server/services/payment/payment.service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });

/**
 * Status da cobrança. A tela de pagamento consulta aqui enquanto espera o Pix cair.
 *
 * Rota sem sessão de propósito — quem está pagando ainda não tem login. O que
 * a protege é o id ser um uuid aleatório, então três coisas seguram a porta:
 * o formato é validado antes de chegar no banco (id torto virava 500 com erro
 * do Postgres no log), o limite por IP torna varredura inviável, e o
 * `manageToken` só sai depois que o pagamento é confirmado.
 */
export const GET = route(async (req: Request, { params }: { params: { id: string } }) => {
  await rateLimit(`payment-status:${clientIp(req)}`, 120, 60_000);

  const { id } = paramsSchema.parse(params);
  const payment = await getPaymentPublic(id);
  return ok({ payment });
});
