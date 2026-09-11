import { afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('provider Ton/Stone via Pagar.me', () => {
  let PagarmeProvider: typeof import('../src/server/services/payment/providers/pagarme.provider').PagarmeProvider;
  const originalFetch = global.fetch;

  before(async () => {
    process.env.PAGARME_SECRET_KEY = 'sk_test_123';
    process.env.PAGARME_WEBHOOK_TOKEN = 'segredo-do-webhook';
    process.env.PAGARME_BASE_URL = 'https://sdx-api.pagar.me/core/v5';
    ({ PagarmeProvider } = await import('../src/server/services/payment/providers/pagarme.provider'));
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('cria checkout hospedado sem trafegar dados de cartao', async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    global.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      request = { url: String(url), init };
      return new Response(JSON.stringify({ id: 'pl_abc', url: 'https://checkout.pagar.me/pl_abc', status: 'active' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const result = await new PagarmeProvider().createCharge({
      paymentId: '92a55588-87ca-4f1b-9d6b-eb94c427c5cb',
      amount: 40,
      description: 'Riady Cortes - Corte',
      method: 'pix',
      payer: { name: 'Cliente', phone: '14999999999' },
      returnUrl: 'https://dlzbarbearia.com.br/retorno',
      webhookUrl: 'https://dlzbarbearia.com.br/api/v1/payments/webhook/pagarme',
      expiresInMinutes: 20,
    });

    assert.equal(request?.url, 'https://sdx-api.pagar.me/core/v5/paymentlinks');
    const body = JSON.parse(String(request?.init?.body));
    assert.equal(body.order_code, '92a55588-87ca-4f1b-9d6b-eb94c427c5cb');
    assert.equal(body.cart_settings.items[0].amount, 4000, 'a API recebe centavos');
    assert.deepEqual(body.payment_settings.accepted_payment_methods, ['pix']);
    assert.equal(result.checkoutUrl, 'https://checkout.pagar.me/pl_abc');
  });

  it('consulta o pedido autenticado antes de aceitar o status do webhook', async () => {
    global.fetch = (async () => new Response(JSON.stringify({
      id: 'or_abc123',
      code: '92a55588-87ca-4f1b-9d6b-eb94c427c5cb',
      status: 'paid',
      amount: 4000,
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    const event = await new PagarmeProvider().parseWebhook(
      new Request('https://dlzbarbearia.com.br/api/v1/payments/webhook/pagarme?token=segredo-do-webhook'),
      JSON.stringify({ id: 'hook_1', type: 'order.paid', data: { id: 'or_abc123', status: 'failed' } })
    );

    assert.equal(event?.status, 'paid');
    assert.equal(event?.amount, 40);
    assert.equal(event?.paymentId, '92a55588-87ca-4f1b-9d6b-eb94c427c5cb');
  });

  it('recusa webhook sem o token configurado na URL', async () => {
    await assert.rejects(
      () => new PagarmeProvider().parseWebhook(
        new Request('https://dlzbarbearia.com.br/api/v1/payments/webhook/pagarme'),
        JSON.stringify({ type: 'order.paid', data: { id: 'or_abc123' } })
      ),
      /Token do webhook Ton\/Pagar.me invalido/
    );
  });
});
