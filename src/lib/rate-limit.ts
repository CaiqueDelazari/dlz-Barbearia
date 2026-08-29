import { ApiError } from './http';

/**
 * Contador de requisições por chave.
 *
 * Duas implementações atrás da mesma função. Com Redis configurado, todas as
 * instâncias contam no mesmo lugar — que é o único jeito de o limite valer o
 * número que ele diz. Sem Redis, cai para um `Map` do processo: continua
 * segurando abuso bobo numa instância só, mas em serverless cada instância
 * conta sozinha e o teto se multiplica pelo número delas.
 *
 * A escolha é por variável de ambiente, não por código: em desenvolvimento
 * ninguém precisa subir Redis para trabalhar.
 */

// ---------------------------------------------------------------- config
/**
 * Aceita os dois nomes de propósito: a integração Upstash da Vercel injeta
 * `KV_REST_API_*` em projetos antigos e `UPSTASH_REDIS_REST_*` nos novos.
 * Procurar só por um seria garantir uma tarde perdida achando que "o Redis não
 * funciona" quando ele estava lá com o outro nome.
 */
function redisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL ?? '';
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN ?? '';
  return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}

/**
 * Ajuste por ambiente, lido a cada chamada para dar para testar o mecanismo.
 *
 * O desligamento SÓ vale fora de produção: mesmo que a variável vaze para o
 * ambiente de produção, o limite continua de pé.
 */
function limiteConfig() {
  const disabled =
    process.env.RATE_LIMIT_DISABLED === 'true' && process.env.NODE_ENV !== 'production';
  const factor = Math.max(1, Number(process.env.RATE_LIMIT_FACTOR) || 1);
  return { disabled, factor };
}

/** Está usando o contador compartilhado? Serve para a tela de diagnóstico e para teste. */
export function rateLimitBackend(): 'redis' | 'memoria' {
  return redisConfig() ? 'redis' : 'memoria';
}

// ---------------------------------------------------------------- memória
const buckets = new Map<string, { count: number; resetAt: number }>();

function contarNaMemoria(key: string, windowMs: number): number {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return 1;
  }

  bucket.count++;

  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
  }
  return bucket.count;
}

// ---------------------------------------------------------------- redis
/**
 * INCR e PEXPIRE precisam ser um passo só.
 *
 * Feitos em dois comandos, existe a janela em que a chave é criada e o processo
 * morre antes de marcar a validade: a chave fica **para sempre**, e aquele IP
 * nunca mais consegue fazer login. O script roda inteiro dentro do Redis, então
 * ou acontecem os dois ou nenhum.
 */
const SCRIPT = `
local atual = redis.call('INCR', KEYS[1])
if atual == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return atual
`;

let avisouFalha = false;

/** Devolve a contagem, ou `null` quando o Redis não respondeu. */
async function contarNoRedis(key: string, windowMs: number): Promise<number | null> {
  const cfg = redisConfig();
  if (!cfg) return null;

  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cfg.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(['EVAL', SCRIPT, '1', `rl:${key}`, String(windowMs)]),
      cache: 'no-store',
      // um Redis lento não pode virar uma página lenta: passou disso, seguimos
      // com o contador local em vez de segurar a requisição do cliente
      signal: AbortSignal.timeout(1000),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const body = (await res.json()) as { result?: unknown; error?: string };
    if (body.error) throw new Error(body.error);

    const count = Number(body.result);
    return Number.isFinite(count) ? count : null;
  } catch (err) {
    // Redis fora não pode derrubar o agendamento. Cai para a memória, que é
    // pior mas não é nada — e avisa uma vez só para não inundar o log.
    if (!avisouFalha) {
      avisouFalha = true;
      console.error('[rate-limit] Redis indisponivel, usando contador local:', err);
    }
    return null;
  }
}

// ---------------------------------------------------------------- api
/**
 * Conta mais uma batida na porta e joga 429 quando passar do teto.
 *
 * @param key    quem está batendo — `login:<ip>`, `ai:<sessao>:<telefone>`...
 * @param limit  quantas batidas cabem na janela
 * @param windowMs tamanho da janela em milissegundos
 */
export async function rateLimit(key: string, limit: number, windowMs: number): Promise<void> {
  const { disabled, factor } = limiteConfig();
  if (disabled) return;

  const teto = Math.ceil(limit * factor);

  const compartilhado = await contarNoRedis(key, windowMs);
  const count = compartilhado ?? contarNaMemoria(key, windowMs);

  if (count > teto) throw ApiError.tooMany();
}

/** Zera o contador local. Só existe para os testes não se contaminarem. */
export function resetRateLimitMemory(): void {
  buckets.clear();
  avisouFalha = false;
}
