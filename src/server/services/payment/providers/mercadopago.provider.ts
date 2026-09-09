import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/env';
import { ApiError } from '@/lib/http';
import type { CreateChargeInput, CreateChargeResult, PaymentProvider, WebhookResult } from '../provider';

const API = 'https://api.mercadopago.com';

/**
 * Mercado Pago: Pix via /v1/payments e cartao via Checkout Pro (/checkout/preferences).
 * O webhook chega so com o id; buscamos o pagamento na API antes de acreditar
 * em qualquer status - nunca confiamos no corpo recebido.
 */
export class MercadoPagoProvider implements PaymentProvider {
  readonly name = 'mercadopago';

  private get token(): string {
    if (!env.payment.mercadopagoToken) {
      throw new ApiError(500, 'MERCADOPAGO_ACCESS_TOKEN nao configurado', 'payment_not_configured');
    }
    return env.payment.mercadopagoToken;
  }

  private async call<T>(path: string, init: RequestInit & { idempotencyKey?: string } = {}): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
        ...(init.idempotencyKey ? { 'X-Idempotency-Key': init.idempotencyKey } : {}),
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = (body as { message?: string }).message ?? `erro ${res.status}`;
      throw new ApiError(502, `Falha no gateway de pagamento: ${message}`, 'payment_gateway_error');
    }
    return body as T;
  }

  async createCharge(input: CreateChargeInput): Promise<CreateChargeResult> {
    const expiresAt = new Date(Date.now() + input.expiresInMinutes * 60_000);

    if (input.method === 'pix') {
      const body = await this.call<{
        id: number;
        status: string;
        point_of_interaction?: { transaction_data?: { qr_code?: string; qr_code_base64?: string; ticket_url?: string } };
      }>('/v1/payments', {
        method: 'POST',
        idempotencyKey: input.paymentId,
        body: JSON.stringify({
          transaction_amount: Number(input.amount.toFixed(2)),
          description: input.description,
          payment_method_id: 'pix',
          external_reference: input.paymentId,
          notification_url: input.webhookUrl,
          date_of_expiration: expiresAt.toISOString(),
          payer: {
            email: input.payer.email || `cliente+${input.paymentId}@agendamento.app`,
            first_name: input.payer.name.split(' ')[0],
          },
        }),
      });

      const data = body.point_of_interaction?.transaction_data;
      return {
        providerPaymentId: String(body.id),
        checkoutUrl: data?.ticket_url ?? null,
        qrCode: data?.qr_code ?? null,
        qrCodeBase64: data?.qr_code_base64 ?? null,
        status: body.status === 'approved' ? 'paid' : 'pending',
        expiresAt,
        raw: body,
      };
    }

    const pref = await this.call<{ id: string; init_point: string; sandbox_init_point: string }>(
      '/checkout/preferences',
      {
        method: 'POST',
        idempotencyKey: input.paymentId,
        body: JSON.stringify({
          items: [
            {
              title: input.description,
              quantity: 1,
              currency_id: 'BRL',
              unit_price: Number(input.amount.toFixed(2)),
            },
          ],
          external_reference: input.paymentId,
          notification_url: input.webhookUrl,
          back_urls: { success: input.returnUrl, pending: input.returnUrl, failure: input.returnUrl },
          auto_return: 'approved',
          expires: true,
          expiration_date_to: expiresAt.toISOString(),
          payment_methods: { excluded_payment_types: [{ id: 'ticket' }] },
        }),
      }
    );

    return {
      providerPaymentId: pref.id,
      checkoutUrl: pref.init_point ?? pref.sandbox_init_point,
      qrCode: null,
      qrCodeBase64: null,
      status: 'pending',
      expiresAt,
      raw: pref,
    };
  }

  /** Valida a assinatura x-signature antes de olhar o conteudo. */
  private assertSignature(req: Request, dataId: string): void {
    const secret = env.payment.mercadopagoWebhookSecret;
    if (!secret) {
      /**
       * Em producao, sem segredo o webhook nao entra.
       *
       * Seguir "so com a consulta na API" protege o STATUS (quem manda e' a
       * resposta do gateway, nao o corpo recebido), mas nao protege o resto:
       * o endpoint fica aberto a qualquer um, e cada POST vira uma chamada
       * autenticada a API do Mercado Pago com o token da loja. Recusar aqui e'
       * barulhento de proposito -- pagamento chegando e nao sendo confirmado
       * aparece na hora, enquanto um endpoint aberto nao aparece nunca.
       *
       * Fora de producao continua passando: e' o que deixa testar o fluxo com
       * a sandbox sem ter o segredo configurado.
       */
      if (process.env.NODE_ENV === 'production') {
        throw ApiError.forbidden('MERCADOPAGO_WEBHOOK_SECRET nao configurado');
      }
      return;
    }

    const signature = req.headers.get('x-signature') ?? '';
    const requestId = req.headers.get('x-request-id') ?? '';
    const parts = Object.fromEntries(
      signature.split(',').map((p) => p.split('=').map((s) => s.trim()) as [string, string])
    );
    const ts = parts.ts;
    const v1 = parts.v1;
    if (!ts || !v1) throw ApiError.forbidden('Assinatura do webhook ausente');

    const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
    const expected = createHmac('sha256', secret).update(manifest).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(v1);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw ApiError.forbidden('Assinatura do webhook invalida');
    }
  }

  async parseWebhook(req: Request, rawBody: string): Promise<WebhookResult | null> {
    const payload = JSON.parse(rawBody || '{}') as {
      id?: number | string;
      type?: string;
      action?: string;
      data?: { id?: string };
    };
    const url = new URL(req.url);
    const dataId = payload.data?.id ?? url.searchParams.get('data.id') ?? url.searchParams.get('id');
    const type = payload.type ?? url.searchParams.get('type') ?? 'payment';
    if (!dataId || type !== 'payment') return null;

    /**
     * O id do pagamento no Mercado Pago e' um numero, e aqui ele so pode ser
     * isso.
     *
     * Ele entra montando a URL da consulta (`/v1/payments/${id}`), e o `fetch`
     * normaliza `..` como qualquer navegador: um `data.id` valendo
     * `../../v1/users/me` deixava de consultar um pagamento e passava a chamar
     * outro endpoint do gateway -- com o token da loja no cabecalho e a
     * resposta gravada em `payment_webhook_events.payload`. Quem escolhe o
     * caminho e' este arquivo, nao o corpo do POST.
     */
    if (!/^\d+$/.test(String(dataId))) return null;

    this.assertSignature(req, String(dataId));

    // fonte da verdade: a API, nunca o corpo do webhook
    const payment = await this.call<{
      id: number;
      status: string;
      status_detail: string;
      transaction_amount: number;
      external_reference: string | null;
    }>(`/v1/payments/${dataId}`);

    const map: Record<string, WebhookResult['status']> = {
      approved: 'paid',
      authorized: 'processing',
      in_process: 'processing',
      pending: 'pending',
      rejected: 'failed',
      cancelled: 'cancelled',
      refunded: 'refunded',
      charged_back: 'refunded',
    };

    return {
      externalId: `mp:${payment.id}:${payment.status}`,
      eventType: payload.action ?? 'payment.updated',
      providerPaymentId: String(payment.id),
      paymentId: payment.external_reference,
      status: map[payment.status] ?? 'pending',
      amount: payment.transaction_amount ?? null,
      raw: payment,
    };
  }
}
