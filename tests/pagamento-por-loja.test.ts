import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * O deploy e' um so e atende varias barbearias, mas as credenciais do gateway
 * sao de UMA -- a que contratou a cobranca online.
 *
 * O cenario que este teste protege: o ambiente TEM um gateway configurado (o da
 * loja que contratou) e uma outra loja, sem contrato, tenta cobrar. Ela precisa
 * cair em `manual`. Se cair no gateway, o Pix do cliente dela sai certo e cai na
 * conta da loja errada -- sem erro em lugar nenhum do caminho.
 *
 * O env e' preparado ANTES do import porque `lib/env` le `process.env` uma vez,
 * na carga do modulo.
 */
describe('gateway de pagamento e por loja, nao por deploy', () => {
  let getProviderForSettings: (s: { payment_provider: string }) => { name: string };
  let getProviderByName: (n: string) => { name: string } | null;

  before(async () => {
    process.env.PAYMENT_PROVIDER = 'mercadopago';
    process.env.MERCADOPAGO_ACCESS_TOKEN = 'token-de-teste';
    const mod = await import('../src/server/services/payment/payment.service');
    getProviderForSettings = mod.getProviderForSettings;
    getProviderByName = mod.getProviderByName;
  });

  it('loja sem contrato nao alcanca o gateway de quem contratou', () => {
    assert.equal(getProviderForSettings({ payment_provider: 'manual' }).name, 'manual');
  });

  it('loja que contratou usa o gateway', () => {
    assert.equal(getProviderForSettings({ payment_provider: 'mercadopago' }).name, 'mercadopago');
  });

  it('valor desconhecido nao vira gateway por engano', () => {
    assert.equal(getProviderForSettings({ payment_provider: 'pagarme' }).name, 'manual');
    assert.equal(getProviderForSettings({ payment_provider: '' }).name, 'manual');
  });

  it('webhook so aceita provider que este deploy conhece', () => {
    assert.equal(getProviderByName('manual')?.name, 'manual');
    assert.equal(getProviderByName('mercadopago')?.name, 'mercadopago');
    assert.equal(getProviderByName('pagarme'), null);
    assert.equal(getProviderByName('qualquer-coisa'), null);
  });
});
