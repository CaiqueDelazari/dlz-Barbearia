import { env } from '@/lib/env';
import type { CreateChargeInput, CreateChargeResult, PaymentProvider, WebhookResult } from '../provider';

/**
 * Provider de desenvolvimento / pagamento presencial.
 * Nao movimenta dinheiro: devolve um link interno de simulacao para dar para
 * rodar o fluxo completo (reserva -> pagamento -> webhook -> confirmacao)
 * antes de plugar o gateway real.
 */
export class ManualProvider implements PaymentProvider {
  readonly name = 'manual';

  async createCharge(input: CreateChargeInput): Promise<CreateChargeResult> {
    return {
      providerPaymentId: `manual_${input.paymentId}`,
      checkoutUrl: `${env.appUrl}/pagamento/simulado/${input.paymentId}`,
      qrCode: null,
      qrCodeBase64: null,
      status: 'pending',
      expiresAt: new Date(Date.now() + input.expiresInMinutes * 60_000),
    };
  }

  async parseWebhook(_req: Request, rawBody: string): Promise<WebhookResult | null> {
    const payload = JSON.parse(rawBody || '{}') as {
      paymentId?: string;
      status?: string;
      amount?: number;
      eventId?: string;
    };
    if (!payload.paymentId) return null;
    return {
      externalId: payload.eventId ?? `manual:${payload.paymentId}:${payload.status ?? 'paid'}`,
      eventType: 'payment.updated',
      providerPaymentId: `manual_${payload.paymentId}`,
      paymentId: payload.paymentId,
      status: (payload.status as WebhookResult['status']) ?? 'paid',
      amount: payload.amount ?? null,
      raw: payload,
    };
  }
}
