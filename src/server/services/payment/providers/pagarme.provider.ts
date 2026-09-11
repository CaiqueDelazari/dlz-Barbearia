import { env } from '@/lib/env';
import { ApiError } from '@/lib/http';
import type { CreateChargeInput, CreateChargeResult, PaymentProvider, WebhookResult } from '../provider';

/** Conta Ton/Stone: pagamentos online pela API Pagar.me V5. */
export class PagarmeProvider implements PaymentProvider {
  readonly name = 'pagarme';

  private get secretKey(): string {
    if (!env.payment.pagarmeSecretKey) {
      throw new ApiError(500, 'PAGARME_SECRET_KEY nao configurada', 'payment_not_configured');
    }
    return env.payment.pagarmeSecretKey;
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${env.payment.pagarmeBaseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Basic ${Buffer.from(`${this.secretKey}:`).toString('base64')}`,
        'content-type': 'application/json',
        'user-agent': 'dlz-barbearia/1.0',
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const errors = (body as { errors?: Array<{ message?: string }>; message?: string }).errors;
      const message = errors?.map((error) => error.message).filter(Boolean).join('; ')
        || (body as { message?: string }).message || `erro ${res.status}`;
      throw new ApiError(502, `Falha no gateway Ton/Pagar.me: ${message}`, 'payment_gateway_error');
    }
    return body as T;
  }

  async createCharge(input: CreateChargeInput): Promise<CreateChargeResult> {
    const expiresAt = new Date(Date.now() + input.expiresInMinutes * 60_000);
    const amount = Math.round(input.amount * 100);
    const method = input.method === 'card' ? 'credit_card' : 'pix';
    const checkout = await this.call<{ id: string; url: string }>('/paymentlinks', {
      method: 'POST',
      body: JSON.stringify({
        is_building: false,
        name: input.description.slice(0, 64),
        order_code: input.paymentId,
        type: 'order',
        expires_in: input.expiresInMinutes,
        max_paid_sessions: 1,
        payment_settings: {
          accepted_payment_methods: [method],
          ...(method === 'pix'
            ? { pix_settings: { expires_in: input.expiresInMinutes * 60 } }
            : { credit_card_settings: {
                operation_type: 'auth_and_capture',
                installments: [{ number: 1, total: amount }],
              } }),
        },
        cart_settings: { items: [{
          name: input.description.slice(0, 128),
          description: input.description.slice(0, 256),
          amount,
          default_quantity: 1,
        }] },
      }),
    });
    return {
      providerPaymentId: checkout.id,
      checkoutUrl: checkout.url,
      qrCode: null,
      qrCodeBase64: null,
      status: 'pending',
      expiresAt,
      raw: checkout,
    };
  }

  private assertWebhookToken(req: Request): void {
    const configured = env.payment.pagarmeWebhookToken;
    const received = new URL(req.url).searchParams.get('token') ?? '';
    if (!configured || received !== configured) {
      throw ApiError.forbidden('Token do webhook Ton/Pagar.me invalido');
    }
  }

  async parseWebhook(req: Request, rawBody: string): Promise<WebhookResult | null> {
    this.assertWebhookToken(req);
    const payload = JSON.parse(rawBody || '{}') as {
      id?: string;
      type?: string;
      data?: { id?: string };
    };
    const eventType = payload.type ?? '';
    const orderId = payload.data?.id ?? '';
    if (!eventType.startsWith('order.') || !/^or_[A-Za-z0-9]+$/.test(orderId)) return null;

    // Status, valor e referencia sempre vem da API autenticada, nao do webhook.
    const order = await this.call<{ id: string; code: string | null; status: string; amount: number }>(
      `/orders/${orderId}`
    );
    const statuses: Record<string, WebhookResult['status']> = {
      paid: 'paid', pending: 'pending', canceled: 'cancelled',
      cancelled: 'cancelled', failed: 'failed',
    };
    return {
      externalId: payload.id || `pagarme:${order.id}:${order.status}`,
      eventType,
      providerPaymentId: order.id,
      paymentId: order.code,
      status: statuses[order.status.toLowerCase()] ?? 'pending',
      amount: Number(order.amount) / 100,
      raw: order,
    };
  }
}
