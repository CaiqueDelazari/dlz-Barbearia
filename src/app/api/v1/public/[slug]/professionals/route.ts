import { z } from 'zod';
import { clientIp, ok, parseQuery, rateLimit, route } from '@/lib/http';
import { query } from '@/lib/db';
import { getTenantBySlug } from '@/server/repositories/tenant.repo';
import { professionalsForServices } from '@/server/services/availability.service';

export const dynamic = 'force-dynamic';

const schema = z.object({ services: z.string().optional() });

/** Profissionais que atendem os servicos escolhidos (ou todos, se nao houver filtro). */
export const GET = route(async (req: Request, { params }: { params: Promise<{ slug: string }> }) => {
  await rateLimit(`public-professionals:${clientIp(req)}`, 120, 60_000);

  const tenant = await getTenantBySlug((await params).slug);
  const { services } = parseQuery(req, schema);
  const serviceIds = services ? services.split(',').filter(Boolean) : [];

  const all = await query<{ id: string; name: string; bio: string | null; photoUrl: string | null }>(
    `SELECT id, name, bio, photo_url AS "photoUrl"
       FROM professionals WHERE tenant_id = $1 AND active
       ORDER BY display_order, name`,
    [tenant.id]
  );

  const allowed = serviceIds.length ? await professionalsForServices(tenant.id, serviceIds) : null;
  const professionals = allowed ? all.filter((p) => allowed.has(p.id)) : all;

  return ok({ professionals });
});
