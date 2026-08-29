/**
 * O limitador contra um Redis de verdade.
 *
 * O ponto do Redis é um só: o contador deixa de morar dentro de uma instância.
 * Testar isso exige um Redis — então este arquivo **pula sozinho** quando não
 * há um à mão, para nunca virar aquele teste vermelho que todo mundo ignora.
 *
 * Para rodar de verdade (o proxy fala o protocolo REST da Upstash, igual ao
 * que roda em produção):
 *
 *   docker run -d --name agenda-redis -p 6380:6379 redis:7-alpine
 *   docker run -d --name agenda-srh -p 8079:80 \
 *     -e SRH_MODE=env -e SRH_TOKEN=teste-local \
 *     -e SRH_CONNECTION_STRING="redis://host.docker.internal:6380" \
 *     hiett/serverless-redis-http:latest
 */
import assert from 'node:assert/strict';
import test, { after, describe } from 'node:test';
import { ApiError, rateLimit, rateLimitBackend, resetRateLimitMemory } from '@/lib/http';

const URL_REDIS = process.env.TEST_REDIS_REST_URL ?? 'http://localhost:8079';
const TOKEN_REDIS = process.env.TEST_REDIS_REST_TOKEN ?? 'teste-local';

const env = process.env as Record<string, string | undefined>;
const anterior = {
  UPSTASH_REDIS_REST_URL: env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: env.UPSTASH_REDIS_REST_TOKEN,
  RATE_LIMIT_DISABLED: env.RATE_LIMIT_DISABLED,
  RATE_LIMIT_FACTOR: env.RATE_LIMIT_FACTOR,
};

const chave = () => `teste-${Math.random().toString(36).slice(2)}`;
const eh429 = (err: unknown) => err instanceof ApiError && err.status === 429;

/**
 * Cada teste decide se pula, em vez do `describe`.
 *
 * O `skip` do `describe` é avaliado quando o arquivo carrega — cedo demais para
 * saber se o Redis atende, e um `before()` não ajuda porque roda depois dessa
 * decisão. Descobrir isso lá em cima exigiria top-level await, que o `tsx` não
 * aceita neste projeto (a saída é CJS). Então a checagem vira uma promessa
 * feita uma vez e consultada por cada teste.
 */
async function redisAtende(): Promise<boolean> {
  try {
    const res = await fetch(URL_REDIS, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN_REDIS}`, 'content-type': 'application/json' },
      body: JSON.stringify(['PING']),
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const preparado = redisAtende().then((atende) => {
  if (atende) {
    env.UPSTASH_REDIS_REST_URL = URL_REDIS;
    env.UPSTASH_REDIS_REST_TOKEN = TOKEN_REDIS;
    env.RATE_LIMIT_DISABLED = 'false';
    env.RATE_LIMIT_FACTOR = '1';
  }
  return atende;
});

const MOTIVO = `nenhum Redis REST em ${URL_REDIS} — veja o cabeçalho do arquivo`;

after(() => {
  for (const [k, v] of Object.entries(anterior)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  resetRateLimitMemory();
});

describe('contador compartilhado', () => {
  test('usa o Redis quando ele está configurado', async (t) => {
    if (!(await preparado)) return t.skip(MOTIVO);
    assert.equal(rateLimitBackend(), 'redis');
  });

  test('bloqueia ao estourar o teto', async (t) => {
    if (!(await preparado)) return t.skip(MOTIVO);

    const k = chave();
    for (let i = 0; i < 3; i++) await rateLimit(k, 3, 60_000);
    await assert.rejects(() => rateLimit(k, 3, 60_000), eh429);
  });

  test('chaves diferentes têm cota própria', async (t) => {
    if (!(await preparado)) return t.skip(MOTIVO);

    const a = chave();
    const b = chave();
    for (let i = 0; i < 3; i++) await rateLimit(a, 3, 60_000);
    await assert.doesNotReject(() => rateLimit(b, 3, 60_000));
  });

  /**
   * Este é o teste que justifica o Redis existir.
   *
   * Limpar a memória local é o que acontece quando a Vercel sobe uma instância
   * nova — ou quando o atacante cai numa instância diferente da anterior. Com o
   * contador em memória, isso zerava a contagem e o limite de 5 tentativas
   * virava 5 *por instância*. Com Redis, a contagem continua de onde parou.
   */
  test('trocar de instância não zera a contagem', async (t) => {
    if (!(await preparado)) return t.skip(MOTIVO);

    const k = chave();

    for (let i = 0; i < 5; i++) await rateLimit(k, 5, 60_000);

    resetRateLimitMemory(); // instância nova, memória vazia

    await assert.rejects(
      () => rateLimit(k, 5, 60_000),
      eh429,
      'a contagem tem que sobreviver à troca de instância'
    );
  });

  test('a janela vence e libera de novo', async (t) => {
    if (!(await preparado)) return t.skip(MOTIVO);

    const k = chave();
    const janela = 1200;

    await rateLimit(k, 1, janela);
    await assert.rejects(() => rateLimit(k, 1, janela), eh429);

    // se o PEXPIRE não tivesse sido aplicado, a chave ficaria para sempre e
    // aquele IP nunca mais conseguiria entrar
    await new Promise((r) => setTimeout(r, janela + 300));

    await assert.doesNotReject(() => rateLimit(k, 1, janela), 'janela vencida libera');
  });
});
