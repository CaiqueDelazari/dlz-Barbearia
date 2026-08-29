import { cookies } from 'next/headers';
import { ApiError, clientIp, ok, rateLimit, route } from '@/lib/http';
import { query, queryOne } from '@/lib/db';
import { env } from '@/lib/env';
import {
  REFRESH_COOKIE,
  generateRefreshToken,
  setAuthCookies,
  sha256,
  signAccessToken,
  type Role,
} from '@/lib/auth';

export const dynamic = 'force-dynamic';

/** Rotaciona o refresh token a cada uso: token usado e token queimado. */
export const POST = route(async (req: Request) => {
  // sem isto, um cookie roubado (ou chutado) pode ser testado a vontade
  await rateLimit(`refresh:${clientIp(req)}`, 60, 5 * 60_000);

  const provided = cookies().get(REFRESH_COOKIE)?.value ?? '';
  if (!provided) throw ApiError.unauthorized('Sessao nao encontrada');

  const stored = await queryOne<{
    id: string;
    user_id: string;
    tenant_id: string;
    name: string;
    email: string;
    role: Role;
    tenant_slug: string;
  }>(
    `SELECT rt.id, rt.user_id, rt.tenant_id, u.name, u.email, u.role, t.slug AS tenant_slug
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id AND u.active
       JOIN tenants t ON t.id = rt.tenant_id AND t.active
      WHERE rt.token_hash = $1 AND rt.revoked_at IS NULL AND rt.expires_at > now()`,
    [sha256(provided)]
  );
  if (!stored) throw ApiError.unauthorized('Sessao expirada. Faca login novamente.');

  const session = {
    userId: stored.user_id,
    tenantId: stored.tenant_id,
    tenantSlug: stored.tenant_slug,
    role: stored.role,
    name: stored.name,
    email: stored.email,
  };

  const access = await signAccessToken(session);
  const next = generateRefreshToken();

  await query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [stored.id]);
  await query(
    `INSERT INTO refresh_tokens (user_id, tenant_id, token_hash, expires_at, user_agent)
     VALUES ($1,$2,$3, now() + ($4 || ' days')::interval, $5)`,
    [stored.user_id, stored.tenant_id, next.hash, String(env.refreshTtlDays), req.headers.get('user-agent') ?? null]
  );

  setAuthCookies(access, next.token);
  return ok({ user: session, accessToken: access });
});
