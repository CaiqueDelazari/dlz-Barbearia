import { z } from 'zod';
import { clientIp, ok, parseBody, route } from '@/lib/http';
import { audit, requireRole } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';

export const dynamic = 'force-dynamic';

const SELECT = `p.id, p.name, p.bio, p.photo_url AS "photoUrl", p.phone,
                p.commission_percent::float8 AS "commissionPercent",
                p.display_order AS "displayOrder", p.active`;

export const GET = route(async (req: Request) => {
  const session = await requireRole(req, 'STAFF');
  const professionals = await query(
    `SELECT ${SELECT},
            COALESCE((SELECT json_agg(ps.service_id) FROM professional_services ps
                       WHERE ps.professional_id = p.id), '[]'::json) AS "serviceIds"
       FROM professionals p
      WHERE p.tenant_id = $1
      ORDER BY p.display_order, p.name`,
    [session.tenantId]
  );
  return ok({ professionals });
});

const schema = z.object({
  name: z.string().min(2).max(120),
  bio: z.string().max(500).nullable().optional(),
  photoUrl: z.string().url().nullable().optional(),
  phone: z.string().max(30).nullable().optional(),
  commissionPercent: z.number().min(0).max(100).optional(),
  displayOrder: z.number().int().optional(),
  serviceIds: z.array(z.string().uuid()).optional(),
});

export const POST = route(async (req: Request) => {
  const session = await requireRole(req, 'ADMIN');
  const body = await parseBody(req, schema);

  const professional = await queryOne<{ id: string }>(
    `INSERT INTO professionals (tenant_id, name, bio, photo_url, phone, commission_percent, display_order)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6,0),COALESCE($7,0))
     RETURNING id, name, bio, photo_url AS "photoUrl", phone,
               commission_percent::float8 AS "commissionPercent", display_order AS "displayOrder", active`,
    [
      session.tenantId,
      body.name,
      body.bio ?? null,
      body.photoUrl ?? null,
      body.phone ?? null,
      body.commissionPercent ?? null,
      body.displayOrder ?? null,
    ]
  );

  for (const serviceId of body.serviceIds ?? []) {
    await query(
      `INSERT INTO professional_services (tenant_id, professional_id, service_id)
       SELECT $1, $2, $3 WHERE EXISTS (SELECT 1 FROM services WHERE id = $3 AND tenant_id = $1)
       ON CONFLICT DO NOTHING`,
      [session.tenantId, professional!.id, serviceId]
    );
  }

  await audit({
    tenantId: session.tenantId,
    userId: session.userId,
    action: 'professional.create',
    entity: 'professional',
    entityId: professional!.id,
    after: body,
    ip: clientIp(req),
  });

  return ok({ professional }, 201);
});
