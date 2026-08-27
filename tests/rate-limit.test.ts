/**
 * O limitador de requisições é a única proteção do fluxo público contra abuso,
 * e agora tem chave de configuração — então precisa de teste próprio,
 * principalmente a trava que impede desligá-lo em produção.
 */
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { ApiError, rateLimit } from '@/lib/http';

const chave = () => `teste-${Math.random().toString(36).slice(2)}`;

/** NODE_ENV é readonly nos tipos do Next; aqui precisamos mexer de propósito. */
const env = process.env as Record<string, string | undefined>;

const original = {
  RATE_LIMIT_DISABLED: env.RATE_LIMIT_DISABLED,
  RATE_LIMIT_FACTOR: env.RATE_LIMIT_FACTOR,
  NODE_ENV: env.NODE_ENV,
};

afterEach(() => {
  for (const [k, v] of Object.entries(original)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
});

function comAmbiente(valores: Record<string, string | undefined>, fn: () => void) {
  for (const [k, v] of Object.entries(valores)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  fn();
}

test('bloqueia depois de estourar o limite', () => {
  comAmbiente({ RATE_LIMIT_DISABLED: 'false', RATE_LIMIT_FACTOR: '1' }, () => {
    const k = chave();
    for (let i = 0; i < 3; i++) rateLimit(k, 3, 60_000);

    assert.throws(
      () => rateLimit(k, 3, 60_000),
      (err: unknown) => err instanceof ApiError && err.status === 429
    );
  });
});

test('chaves diferentes não se atrapalham', () => {
  comAmbiente({ RATE_LIMIT_DISABLED: 'false', RATE_LIMIT_FACTOR: '1' }, () => {
    const a = chave();
    const b = chave();
    for (let i = 0; i < 3; i++) rateLimit(a, 3, 60_000);
    assert.doesNotThrow(() => rateLimit(b, 3, 60_000), 'outro IP tem cota própria');
  });
});

test('a janela zera o contador', () => {
  comAmbiente({ RATE_LIMIT_DISABLED: 'false', RATE_LIMIT_FACTOR: '1' }, () => {
    const k = chave();
    const janela = 5;
    rateLimit(k, 1, janela);

    // a janela só zera quando o relógio passa dela; esperar exatamente o
    // mesmo milissegundo não basta
    const limite = Date.now() + janela + 1;
    while (Date.now() <= limite) {
      /* espera a janela vencer */
    }

    assert.doesNotThrow(() => rateLimit(k, 1, janela), 'janela vencida libera de novo');
  });
});

test('o fator multiplica o teto', () => {
  comAmbiente({ RATE_LIMIT_DISABLED: 'false', RATE_LIMIT_FACTOR: '10' }, () => {
    const k = chave();
    for (let i = 0; i < 30; i++) rateLimit(k, 3, 60_000);
    assert.throws(() => rateLimit(k, 3, 60_000), ApiError, 'com fator 10, o teto de 3 vira 30');
  });
});

test('desligar funciona fora de produção', () => {
  comAmbiente({ RATE_LIMIT_DISABLED: 'true', NODE_ENV: 'development' }, () => {
    const k = chave();
    for (let i = 0; i < 50; i++) rateLimit(k, 1, 60_000);
    assert.ok(true, 'nenhuma exceção');
  });
});

test('em produção o limite NUNCA desliga, mesmo com a variável ligada', () => {
  comAmbiente({ RATE_LIMIT_DISABLED: 'true', NODE_ENV: 'production', RATE_LIMIT_FACTOR: '1' }, () => {
    const k = chave();
    rateLimit(k, 1, 60_000);
    assert.throws(
      () => rateLimit(k, 1, 60_000),
      (err: unknown) => err instanceof ApiError && err.status === 429,
      'variável vazada para produção não pode abrir a porteira'
    );
  });
});
