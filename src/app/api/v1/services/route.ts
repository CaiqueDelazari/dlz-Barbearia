import { z } from 'zod';
import { clientIp, ok, parseBody, route } from '@/lib/http';
import { imageUrlSchema } from '@/lib/security';
import { audit, requireRole } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';

export const dynamic = 'force-dynamic';

const SELECT = `id, name, description, price::float8 AS price, duration_minutes AS "durationMinutes",
                image_url AS "imageUrl", category, display_order AS "displayOrder", active`;

export const GET = route(async (req: Request) => {
  const session = await requireRole(req, 'STAFF');
  const services = await query(
    `SELECT ${SELECT} FROM services WHERE tenant_id = $1 ORDER BY display_order, name`,
    [session.tenantId]
  );
  return ok({ services });
});

const schema = z.object({
  name: z.string().min(2).max(120),
  description: z.string().max(500).nullable().optional(),
  price: z.number().min(0),
  durationMinutes: z.number().int().positive().max(600),
  imageUrl: imageUrlSchema.nullable().optional(),
  category: z.string().max(60).nullable().optional(),
  displayOrder: z.number().int().optional(),
  active: z.boolean().optional(),
  professionalIds: z.array(z.string().uuid()).optional(),
});

export const POST = route(async (req: Request) => {
  const session = await requireRole(req, 'ADMIN');
  const body = await parseBody(req, schema);

  const service = await queryOne<{ id: string }>(
    `INSERT INTO services (tenant_id, name, description, price, duration_minutes, image_url, category, display_order, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,0),COALESCE($9,true))
     RETURNING ${SELECT}`,
    [
      session.tenantId,
      body.name,
      body.description ?? null,
      body.price,
      body.durationMinutes,
      body.imageUrl ?? null,
      body.category ?? null,
      body.displayOrder ?? null,
      body.active ?? null,
    ]
  );

  if (body.professionalIds?.length) {
    for (const professionalId of body.professionalIds) {
      await query(
        `INSERT INTO professional_services (tenant_id, professional_id, service_id)
         SELECT $1, $2, $3 WHERE EXISTS (SELECT 1 FROM professionals WHERE id = $2 AND tenant_id = $1)
         ON CONFLICT DO NOTHING`,
        [session.tenantId, professionalId, service!.id]
      );
    }
  }

  await audit({
    tenantId: session.tenantId,
    userId: session.userId,
    action: 'service.create',
    entity: 'service',
    entityId: service!.id,
    after: body,
    ip: clientIp(req),
  });

  return ok({ service }, 201);
});
