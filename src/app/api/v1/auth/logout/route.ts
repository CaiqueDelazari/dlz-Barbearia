import { cookies } from 'next/headers';
import { ok, route } from '@/lib/http';
import { query } from '@/lib/db';
import { REFRESH_COOKIE, clearAuthCookies, sha256 } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export const POST = route(async () => {
  const token = cookies().get(REFRESH_COOKIE)?.value;
  if (token) {
    await query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1', [sha256(token)]);
  }
  clearAuthCookies();
  return ok({ loggedOut: true });
});
