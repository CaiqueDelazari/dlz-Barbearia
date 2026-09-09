import { z } from 'zod';
import { ApiError, clientIp, ok, parseBody, rateLimit, route } from '@/lib/http';
import { query } from '@/lib/db';
import { env } from '@/lib/env';
import {
  audit,
  generateRefreshToken,
  setAuthCookies,
  signAccessToken,
  verifyPassword,
  type Role,
} from '@/lib/auth';

export const dynamic = 'force-dynamic';

/** Hash valido de uma senha que ninguem tem, so para gastar o mesmo tempo de bcrypt. */
const HASH_DESCARTAVEL = '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

const schema = z.object({
  email: z.string().email('E-mail invalido'),
  password: z.string().min(1, 'Informe a senha'),
  tenant: z.string().optional(), // slug, para quando o e-mail existe em mais de uma empresa
});

export const POST = route(async (req: Request) => {
  const ip = clientIp(req);
  await rateLimit(`login:${ip}`, 10, 5 * 60_000);

  const body = await parseBody(req, schema);

  const users = await query<{
    id: string;
    tenant_id: string;
    tenant_slug: string;
    name: string;
    email: string;
    password_hash: string;
    role: Role;
    active: boolean;
    tenant_active: boolean;
  }>(
    `SELECT u.id, u.tenant_id, t.slug AS tenant_slug, u.name, u.email, u.password_hash,
            u.role, u.active, t.active AS tenant_active
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
      WHERE lower(u.email) = lower($1)
        AND ($2::text IS NULL OR t.slug = $2)`,
    [body.email, body.tenant ?? null]
  );

  const candidates = users.filter((u) => u.active && u.tenant_active);

  /**
   * A senha vem ANTES de qualquer resposta que fale das empresas.
   *
   * O erro `tenant_required` saia com a lista de slugs para quem so tinha
   * digitado um e-mail -- e' um diretorio: um POST por endereco e o atacante
   * descobre em quais barbearias aquela pessoa tem conta. O resto desta rota
   * se esforca para nao confirmar nem que a conta existe (mensagem unica, hash
   * descartavel para gastar o mesmo tempo), e essa resposta desmanchava tudo.
   *
   * Comparando primeiro, a escolha de empresa so aparece para quem ja provou
   * a senha -- e' informacao de quem e' dono dela, nao de quem chutou o e-mail.
   *
   * O `for` em serie, e nao `Promise.all`: bcrypt e' caro de proposito, e o
   * mesmo e-mail em N empresas quase sempre repete a mesma senha, entao o
   * caminho comum acerta no primeiro. Sem usuario nenhum, uma comparacao
   * descartavel mantem o relogio parecido com o de quem existe.
   */
  const autenticados: typeof candidates = [];
  for (const candidato of candidates) {
    if (await verifyPassword(body.password, candidato.password_hash)) {
      autenticados.push(candidato);
    }
  }
  if (!candidates.length) await verifyPassword(body.password, HASH_DESCARTAVEL);

  if (!autenticados.length) {
    await rateLimit(`login-fail:${ip}`, 5, 5 * 60_000);
    throw ApiError.unauthorized('E-mail ou senha incorretos');
  }

  if (autenticados.length > 1) {
    throw ApiError.badRequest(
      'Este e-mail pertence a mais de uma empresa. Informe o identificador da empresa.',
      'tenant_required',
      { tenants: autenticados.map((c) => c.tenant_slug) }
    );
  }

  const user = autenticados[0];

  const session = {
    userId: user.id,
    tenantId: user.tenant_id,
    tenantSlug: user.tenant_slug,
    role: user.role,
    name: user.name,
    email: user.email,
  };

  const access = await signAccessToken(session);
  const refresh = generateRefreshToken();

  await query(
    `INSERT INTO refresh_tokens (user_id, tenant_id, token_hash, expires_at, user_agent)
     VALUES ($1,$2,$3, now() + ($4 || ' days')::interval, $5)`,
    [user.id, user.tenant_id, refresh.hash, String(env.refreshTtlDays), req.headers.get('user-agent') ?? null]
  );

  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  await setAuthCookies(access, refresh.token);

  await audit({
    tenantId: user.tenant_id,
    userId: user.id,
    action: 'auth.login',
    entity: 'user',
    entityId: user.id,
    ip,
  });

  return ok({ user: session, accessToken: access });
});
