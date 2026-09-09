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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * O `[id]` da URL, conferido antes de virar consulta.
 *
 * Sem isto o texto ia cru para um `WHERE id = $1` de coluna uuid, e o Postgres
 * respondia 22P02 -- que chega aqui como excecao desconhecida e sai como 500
 * com rastro no log. Um id que nao tem a forma de um id nao e' erro nosso: e'
 * registro que nao existe, e 404 e' o que ele merece. De quebra, tira do log
 * de erro qualquer varredura de URL.
 */
export function uuidParam(value: string): string {
  if (!UUID.test(value)) throw ApiError.notFound();
  return value;
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
 * O limitador mora em `./rate-limit`. Fica reexportado aqui porque toda rota ja
 * importa `rateLimit` junto de `ok`/`route`/`parseBody`, e trocar o caminho em
 * quinze arquivos so mudaria a linha de import sem mudar nada de verdade.
 */
export { rateLimit, rateLimitBackend, resetRateLimitMemory } from './rate-limit';
