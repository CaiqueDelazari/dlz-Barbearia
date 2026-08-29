/**
 * O limitador de requisições é a única proteção do fluxo público contra abuso,
 * e agora tem duas implementações atrás da mesma função — então precisa de
 * teste próprio: a trava que impede desligá-lo em produção, o comportamento do
 * contador local, e a escolha entre local e compartilhado.
 *
 * O teste com Redis de verdade vive em `redis-compartilhado.test.ts`, porque
 * depende de container. Este arquivo roda sempre, sem nada instalado.
 */
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { ApiError, rateLimit, rateLimitBackend, resetRateLimitMemory } from '@/lib/http';

const chave = () => `teste-${Math.random().toString(36).slice(2)}`;

/** NODE_ENV é readonly nos tipos do Next; aqui precisamos mexer de propósito. */
const env = process.env as Record<string, string | undefined>;

const original = {
  RATE_LIMIT_DISABLED: env.RATE_LIMIT_DISABLED,
  RATE_LIMIT_FACTOR: env.RATE_LIMIT_FACTOR,
  NODE_ENV: env.NODE_ENV,
  UPSTASH_REDIS_REST_URL: env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: env.UPSTASH_REDIS_REST_TOKEN,
  KV_REST_API_URL: env.KV_REST_API_URL,
  KV_REST_API_TOKEN: env.KV_REST_API_TOKEN,
};

afterEach(() => {
  for (const [k, v] of Object.entries(original)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  resetRateLimitMemory();
});

async function comAmbiente(
  valores: Record<string, string | undefined>,
  fn: () => Promise<void>
) {
  for (const [k, v] of Object.entries(valores)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  await fn();
}

/** O ambiente de teste não tem Redis; garante que os casos abaixo usam a memória. */
const semRedis = {
  RATE_LIMIT_DISABLED: 'false',
  RATE_LIMIT_FACTOR: '1',
  UPSTASH_REDIS_REST_URL: undefined,
  UPSTASH_REDIS_REST_TOKEN: undefined,
  KV_REST_API_URL: undefined,
  KV_REST_API_TOKEN: undefined,
};

const eh429 = (err: unknown) => err instanceof ApiError && err.status === 429;

test('bloqueia depois de estourar o limite', async () => {
  await comAmbiente(semRedis, async () => {
    const k = chave();
    for (let i = 0; i < 3; i++) await rateLimit(k, 3, 60_000);

    await assert.rejects(() => rateLimit(k, 3, 60_000), eh429);
  });
});

test('chaves diferentes não se atrapalham', async () => {
  await comAmbiente(semRedis, async () => {
    const a = chave();
    const b = chave();
    for (let i = 0; i < 3; i++) await rateLimit(a, 3, 60_000);
    await assert.doesNotReject(() => rateLimit(b, 3, 60_000), 'outro IP tem cota própria');
  });
});

test('a janela zera o contador', async () => {
  await comAmbiente(semRedis, async () => {
    const k = chave();
    const janela = 5;
    await rateLimit(k, 1, janela);

    // a janela só zera quando o relógio passa dela; esperar exatamente o
    // mesmo milissegundo não basta
    const limite = Date.now() + janela + 1;
    while (Date.now() <= limite) {
      /* espera a janela vencer */
    }

    await assert.doesNotReject(() => rateLimit(k, 1, janela), 'janela vencida libera de novo');
  });
});

test('o fator multiplica o teto', async () => {
  await comAmbiente({ ...semRedis, RATE_LIMIT_FACTOR: '10' }, async () => {
    const k = chave();
    for (let i = 0; i < 30; i++) await rateLimit(k, 3, 60_000);
    await assert.rejects(() => rateLimit(k, 3, 60_000), ApiError, 'com fator 10, o teto de 3 vira 30');
  });
});

test('desligar funciona fora de produção', async () => {
  await comAmbiente({ ...semRedis, RATE_LIMIT_DISABLED: 'true', NODE_ENV: 'development' }, async () => {
    const k = chave();
    for (let i = 0; i < 50; i++) await rateLimit(k, 1, 60_000);
    assert.ok(true, 'nenhuma exceção');
  });
});

test('em produção o limite NUNCA desliga, mesmo com a variável ligada', async () => {
  await comAmbiente(
    { ...semRedis, RATE_LIMIT_DISABLED: 'true', NODE_ENV: 'production' },
    async () => {
      const k = chave();
      await rateLimit(k, 1, 60_000);
      await assert.rejects(
        () => rateLimit(k, 1, 60_000),
        eh429,
        'variável vazada para produção não pode abrir a porteira'
      );
    }
  );
});

// ------------------------------------------------------------ escolha do backend
test('sem variável de Redis, conta na memória', async () => {
  await comAmbiente(semRedis, async () => {
    assert.equal(rateLimitBackend(), 'memoria');
  });
});

test('reconhece os dois nomes que a Vercel injeta', async () => {
  await comAmbiente(
    { ...semRedis, UPSTASH_REDIS_REST_URL: 'https://exemplo.upstash.io', UPSTASH_REDIS_REST_TOKEN: 'x' },
    async () => assert.equal(rateLimitBackend(), 'redis')
  );

  // projetos antigos da integração recebem KV_REST_API_*; procurar só por um
  // nome seria garantir uma tarde perdida achando que "o Redis não funciona"
  await comAmbiente(
    { ...semRedis, KV_REST_API_URL: 'https://exemplo.upstash.io', KV_REST_API_TOKEN: 'x' },
    async () => assert.equal(rateLimitBackend(), 'redis')
  );
});

test('Redis fora do ar não derruba o agendamento — cai para a memória e continua limitando', async () => {
  await comAmbiente(
    {
      ...semRedis,
      // porta fechada: a conexão é recusada na hora, sem esperar timeout
      UPSTASH_REDIS_REST_URL: 'http://127.0.0.1:1',
      UPSTASH_REDIS_REST_TOKEN: 'irrelevante',
    },
    async () => {
      const k = chave();

      // o pedido passa: indisponibilidade do Redis não pode virar erro na cara do cliente
      await assert.doesNotReject(() => rateLimit(k, 2, 60_000));
      await rateLimit(k, 2, 60_000);

      // e o limite continua existindo, agora por instância
      await assert.rejects(() => rateLimit(k, 2, 60_000), eh429);
    }
  );
});
