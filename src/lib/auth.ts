import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';
import { env } from './env';
import { ApiError } from './http';
import { query, queryOne } from './db';

export type Role = 'OWNER' | 'ADMIN' | 'STAFF';

export type Session = {
  userId: string;
  tenantId: string;
  tenantSlug: string;
  role: Role;
  name: string;
  email: string;
};

export const ACCESS_COOKIE = 'ag_access';
export const REFRESH_COOKIE = 'ag_refresh';

const secret = () => new TextEncoder().encode(env.jwtSecret);

// ------------------------------------------------------------------ senhas
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// ------------------------------------------------------------------ tokens
export async function signAccessToken(session: Session): Promise<string> {
  return new SignJWT({ ...session })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(session.userId)
    .setIssuedAt()
    .setExpirationTime(`${env.accessTtlMin}m`)
    .sign(secret());
}

export async function verifyAccessToken(token: string): Promise<Session> {
  try {
    const { payload } = await jwtVerify(token, secret());
    return {
      userId: String(payload.userId),
      tenantId: String(payload.tenantId),
      tenantSlug: String(payload.tenantSlug),
      role: payload.role as Role,
      name: String(payload.name),
      email: String(payload.email),
    };
  } catch {
    throw ApiError.unauthorized('Sessao expirada. Faca login novamente.');
  }
}

/** Refresh token: valor aleatorio no cookie, hash no banco (nunca o valor cru). */
export function generateRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(48).toString('base64url');
  return { token, hash: sha256(token) };
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Token opaco para o link de gerenciamento do cliente (sem senha, com prazo). */
export function generateManageToken(): string {
  return randomBytes(32).toString('base64url');
}

// ------------------------------------------------------------- sessao HTTP
function bearerFrom(req: Request): string | null {
  const header = req.headers.get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return null;
}

export async function getSession(req: Request): Promise<Session | null> {
  const token = bearerFrom(req) ?? cookies().get(ACCESS_COOKIE)?.value ?? null;
  if (!token) return null;
  try {
    return await verifyAccessToken(token);
  } catch {
    return null;
  }
}

/**
 * O acesso ainda vale AGORA? Pergunta ao banco, nao ao token.
 *
 * O JWT e' assinado e valido por `JWT_ACCESS_TTL_MIN` (30 minutos por padrao).
 * So verificar a assinatura significa que desativar alguem so tem efeito quando
 * o token dele expira -- ate meia hora de acesso completo depois de voce ter
 * cortado. Para um barbeiro que parou de pagar, meia hora e' tempo de sobra
 * para exportar contato de cliente.
 *
 * O refresh ja recusa quem esta inativo, entao a janela era limitada; esta
 * checagem a fecha de vez: `users.active = false` corta no proximo clique.
 *
 * Custa uma consulta por requisicao autenticada, por chave primaria. E' o preco
 * de poder desligar alguem na hora, e e' pequeno perto do que cada rota ja faz.
 */
async function assertAcessoAindaValido(session: Session): Promise<void> {
  const row = await queryOne<{ ok: boolean }>(
    `SELECT true AS ok
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
      WHERE u.id = $1 AND u.tenant_id = $2 AND u.active AND t.active`,
    [session.userId, session.tenantId]
  );
  if (!row) throw ApiError.unauthorized();
}

export async function requireAuth(req: Request): Promise<Session> {
  const session = await getSession(req);
  if (!session) throw ApiError.unauthorized();
  await assertAcessoAindaValido(session);
  return session;
}

const ROLE_RANK: Record<Role, number> = { STAFF: 1, ADMIN: 2, OWNER: 3 };

export async function requireRole(req: Request, minimum: Role): Promise<Session> {
  const session = await requireAuth(req);
  if (ROLE_RANK[session.role] < ROLE_RANK[minimum]) {
    throw ApiError.forbidden();
  }
  return session;
}

/**
 * Barreira de tenant. Qualquer recurso carregado por id passa por aqui antes de
 * ser devolvido ou alterado - e o que impede uma empresa de ver dados de outra.
 */
export function assertSameTenant(session: Session, tenantId: string | null | undefined): void {
  if (!tenantId || tenantId !== session.tenantId) {
    throw ApiError.notFound();
  }
}

// ------------------------------------------------------------------ cookies
export function setAuthCookies(access: string, refresh: string): void {
  const isProd = process.env.NODE_ENV === 'production';
  const jar = cookies();
  jar.set(ACCESS_COOKIE, access, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: env.accessTtlMin * 60,
  });
  jar.set(REFRESH_COOKIE, refresh, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: env.refreshTtlDays * 86_400,
  });
}

export function clearAuthCookies(): void {
  const jar = cookies();
  jar.delete(ACCESS_COOKIE);
  jar.delete(REFRESH_COOKIE);
}

// -------------------------------------------------------------- auditoria
export async function audit(input: {
  tenantId: string | null;
  userId?: string | null;
  actor?: string;
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string;
}): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_logs (tenant_id, user_id, actor, action, entity, entity_id, before, after, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        input.tenantId,
        input.userId ?? null,
        input.actor ?? (input.userId ? `user:${input.userId}` : 'system'),
        input.action,
        input.entity,
        input.entityId ?? null,
        input.before ? JSON.stringify(input.before) : null,
        input.after ? JSON.stringify(input.after) : null,
        input.ip ?? null,
      ]
    );
  } catch (err) {
    // auditoria nunca derruba a operacao principal
    console.error('[audit] falha ao registrar:', err);
  }
}

/** Resolve o tenant pelo slug publico (ou dominio proprio, no futuro). */
export async function tenantBySlug(slug: string) {
  return queryOne<{ id: string; slug: string; name: string; timezone: string; active: boolean }>(
    `SELECT id, slug, name, timezone, active FROM tenants WHERE slug = $1 AND active`,
    [slug]
  );
}
