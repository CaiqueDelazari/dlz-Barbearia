import { ok, route } from '@/lib/http';
import { query } from '@/lib/db';
import { getTenantBySlug } from '@/server/repositories/tenant.repo';

export const dynamic = 'force-dynamic';

export const GET = route(async (_req: Request, { params }: { params: { slug: string } }) => {
  const tenant = await getTenantBySlug(params.slug);
  const services = await query(
    `SELECT id, name, description, price::float8 AS price, duration_minutes AS "durationMinutes",
            image_url AS "imageUrl", category
       FROM services
      WHERE tenant_id = $1 AND active
      ORDER BY display_order, name`,
    [tenant.id]
  );
  return ok({ services });
});
