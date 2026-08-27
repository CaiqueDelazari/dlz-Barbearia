import { ok, route } from '@/lib/http';
import { requireAuth } from '@/lib/auth';
import { getTenantContext } from '@/server/repositories/tenant.repo';

export const dynamic = 'force-dynamic';

export const GET = route(async (req: Request) => {
  const session = await requireAuth(req);
  const { tenant } = await getTenantContext(session.tenantId);
  return ok({
    user: session,
    tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name, logoUrl: tenant.logo_url, timezone: tenant.timezone },
  });
});
