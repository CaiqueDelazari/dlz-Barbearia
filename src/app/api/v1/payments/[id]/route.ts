import { ok, route } from '@/lib/http';
import { getPaymentPublic } from '@/server/services/payment/payment.service';

export const dynamic = 'force-dynamic';

/** Status da cobranca. A tela de pagamento consulta aqui enquanto espera o Pix cair. */
export const GET = route(async (_req: Request, { params }: { params: { id: string } }) => {
  const payment = await getPaymentPublic(params.id);
  return ok({ payment });
});
