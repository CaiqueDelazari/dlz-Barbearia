import { z } from 'zod';
import { clientIp, ok, parseBody, route } from '@/lib/http';
import { requireRole } from '@/lib/auth';
import { refundPayment } from '@/server/services/payment/payment.service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });

const bodySchema = z.object({
  /** Omitido = devolve tudo que ainda nao foi devolvido. */
  amount: z.number().positive().optional(),
  reason: z.string().trim().max(300).optional(),
});

/**
 * Registra a devolucao de um pagamento.
 *
 * ADMIN: tirar dinheiro do caixa nao e' operacao de atendente. A rota irma
 * (`GET /payments/{id}`) e' publica porque quem esta pagando ainda nao tem
 * login; esta e' o oposto -- so quem responde pelo caixa.
 *
 * O `tenantId` vem da sessao, nunca do corpo: o servico filtra por ele, entao
 * um id de pagamento de outra empresa da 404 em vez de estornar o caixa alheio.
 */
export const POST = route(async (req: Request, { params }: { params: { id: string } }) => {
  const session = await requireRole(req, 'ADMIN');
  const { id } = paramsSchema.parse(params);
  const body = await parseBody(req, bodySchema);

  const resultado = await refundPayment({
    tenantId: session.tenantId,
    paymentId: id,
    amount: body.amount,
    reason: body.reason,
    userId: session.userId,
    ip: clientIp(req),
  });

  return ok(resultado);
});
