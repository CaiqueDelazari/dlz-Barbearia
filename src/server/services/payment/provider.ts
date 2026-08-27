/**
 * Contrato do gateway. Nenhuma regra de negocio conhece Mercado Pago, Asaas ou
 * qualquer outro: trocar de gateway e escrever uma classe nova aqui e mudar
 * PAYMENT_PROVIDER no ambiente.
 */

export type ChargeMethod = 'pix' | 'card';

export type CreateChargeInput = {
  paymentId: string;          // id interno, vai como external_reference
  amount: number;
  description: string;
  method: ChargeMethod;
  payer: { name: string; phone: string; email?: string | null };
  returnUrl: string;
  webhookUrl: string;
  expiresInMinutes: number;
};

export type CreateChargeResult = {
  providerPaymentId: string | null;
  checkoutUrl: string | null;
  qrCode: string | null;         // copia e cola do Pix
  qrCodeBase64: string | null;
  status: 'pending' | 'processing' | 'paid' | 'failed';
  expiresAt: Date | null;
  raw?: unknown;
};

export type WebhookResult = {
  /** identificador unico do EVENTO - e o que garante idempotencia */
  externalId: string;
  eventType: string;
  providerPaymentId: string | null;
  /** id interno enviado no external_reference */
  paymentId: string | null;
  status: 'pending' | 'processing' | 'paid' | 'failed' | 'refunded' | 'cancelled';
  amount: number | null;
  raw: unknown;
};

export interface PaymentProvider {
  readonly name: string;
  createCharge(input: CreateChargeInput): Promise<CreateChargeResult>;
  /** Le e valida o webhook. Deve lancar se a assinatura nao conferir. */
  parseWebhook(req: Request, rawBody: string): Promise<WebhookResult | null>;
}
