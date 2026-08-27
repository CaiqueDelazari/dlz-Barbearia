import { NextResponse } from 'next/server';
import { ZodError, type ZodSchema } from 'zod';

/** Erro de negocio com status HTTP. Tudo que o cliente pode ver passa por aqui. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'error',
    public details?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static badRequest(msg: string, code = 'bad_request', details?: unknown) {
    return new ApiError(400, msg, code, details);
  }
  static unauthorized(msg = 'Nao autenticado') {
    return new ApiError(401, msg, 'unauthorized');
  }
  static forbidden(msg = 'Sem permissao para esta acao') {
    return new ApiError(403, msg, 'forbidden');
  }
  static notFound(msg = 'Registro nao encontrado') {
    return new ApiError(404, msg, 'not_found');
  }
  static conflict(msg: string, code = 'conflict', details?: unknown) {
    return new ApiError(409, msg, code, details);
  }
  static tooMany(msg = 'Muitas requisicoes. Tente novamente em instantes.') {
    return new ApiError(429, msg, 'rate_limited');
  }
}

export function ok<T>(data: T, status = 200) {
  return NextResponse.json({ data }, { status });
}

export function fail(status: number, message: string, code = 'error', details?: unknown) {
  return NextResponse.json({ error: { message, code, details } }, { status });
}

/** Converte qualquer excecao em resposta JSON previsivel. */
export function handleError(err: unknown) {
  if (err instanceof ApiError) {
    return fail(err.status, err.message, err.code, err.details);
  }
  if (err instanceof ZodError) {
    return fail(400, 'Dados invalidos', 'validation_error', err.flatten().fieldErrors);
  }
  const pgErr = err as { code?: string; constraint?: string; message?: string };
  if (pgErr?.code === '23505') {
    if (pgErr.constraint === 'excl_appt_overlap') {
      return fail(409, 'Este horario acabou de ser reservado. Escolha outro.', 'slot_taken');
    }
    return fail(409, 'Registro duplicado', 'duplicate');
  }
  if (pgErr?.code === '23P01') {
    return fail(409, 'Este horario acabou de ser reservado. Escolha outro.', 'slot_taken');
  }
  console.error('[api] erro nao tratado:', err);
  return fail(500, 'Erro interno. Tente novamente.', 'internal_error');
}

/** Envelopa um handler de rota com tratamento de erro uniforme. */
export function route<Ctx>(handler: (req: Request, ctx: Ctx) => Promise<Response>) {
  return async (req: Request, ctx: Ctx): Promise<Response> => {
    try {
      return await handler(req, ctx);
    } catch (err) {
      return handleError(err);
    }
  };
}

export async function parseBody<T>(req: Request, schema: ZodSchema<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw ApiError.badRequest('Corpo da requisicao invalido (JSON esperado)');
  }
  return schema.parse(raw);
}

export function parseQuery<T>(req: Request, schema: ZodSchema<T>): T {
  const url = new URL(req.url);
  const obj: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    obj[k] = v;
  });
  return schema.parse(obj);
}

export function clientIp(req: Request): string {
  const h = req.headers;
  return (
    h.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    h.get('x-real-ip') ||
    'desconhecido'
  );
}

/**
 * Rate limit em memoria - suficiente para uma instancia e para conter abuso
 * bobo no fluxo publico. Em multi-instancia, trocar por Redis/Upstash mantendo
 * esta mesma assinatura.
 */
const buckets = new Map<string, { count: number; resetAt: number }>();

/**
 * Ajuste por ambiente, lido a cada chamada para dar para testar o mecanismo.
 *
 * O desligamento SÓ vale fora de producao: mesmo que a variavel vaze para o
 * ambiente de producao, o limite continua de pe.
 */
function limiteConfig() {
  const disabled =
    process.env.RATE_LIMIT_DISABLED === 'true' && process.env.NODE_ENV !== 'production';
  const factor = Math.max(1, Number(process.env.RATE_LIMIT_FACTOR) || 1);
  return { disabled, factor };
}

export function rateLimit(key: string, limit: number, windowMs: number): void {
  const { disabled, factor } = limiteConfig();
  if (disabled) return;
  const teto = Math.ceil(limit * factor);
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  bucket.count++;
  if (bucket.count > teto) throw ApiError.tooMany();
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
  }
}
