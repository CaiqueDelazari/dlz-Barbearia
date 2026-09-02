import { handleError, ok } from '@/lib/http';
import { handleWebhook } from '@/server/services/payment/payment.service';

export const dynamic = 'force-dynamic';

/**
 * Unica fonte de verdade sobre pagamento aprovado.
 * O corpo cru e lido antes de qualquer parse porque a assinatura e calculada
 * sobre ele. Evento repetido cai no UNIQUE de payment_webhook_events e nao
 * processa de novo.
 *
 * Sempre respondemos 200 quando o evento foi recebido: erro nosso nao deve
 * fazer o gateway reenviar em loop - fica registrado para reprocessar.
 */
export async function POST(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const rawBody = await req.text();
  try {
    const result = await handleWebhook((await params).provider, req, rawBody);
    return ok(result);
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 403 || status === 400) return handleError(err);
    console.error('[webhook] falha ao processar:', err);
    return ok({ processed: false, reason: 'erro interno registrado' });
  }
}
