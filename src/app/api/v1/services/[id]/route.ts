import { z } from 'zod';
import { ApiError, clientIp, ok, parseBody, route } from '@/lib/http';
import { imageUrlSchema } from '@/lib/security';
import { audit, requireRole } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';

export const dynamic = 'force-dynamic';

const SELECT = `id, name, description, price::float8 AS price, duration_minutes AS "durationMinutes",
                image_url AS "imageUrl", category, display_order AS "displayOrder", active`;

const schema = z.object({
  name: z.string().min(2).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  price: z.number().min(0).optional(),
  durationMinutes: z.number().int().positive().max(600).optional(),
  imageUrl: imageUrlSchema.nullable().optional(),
  category: z.string().max(60).nullable().optional(),
  displayOrder: z.number().int().optional(),
  active: z.boolean().optional(),
  professionalIds: z.array(z.string().uuid()).optional(),
});

export const PATCH = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const session = await requireRole(req, 'ADMIN');
  const body = await parseBody(req, schema);

  const before = await queryOne(
    `SELECT ${SELECT} FROM services WHERE tenant_id = $1 AND id = $2`,
    [session.tenantId, (await params).id]
  );
  if (!before) throw ApiError.notFound('Servico nao encontrado');

  const map: Record<string, string> = {
    name: 'name',
    description: 'description',
    price: 'price',
    durationMinutes: 'duration_minutes',
    imageUrl: 'image_url',
    category: 'category',
    displayOrder: 'display_order',
    active: 'active',
  };

  const sets: string[] = [];
  const values: unknown[] = [session.tenantId, (await params).id];
  for (const [key, column] of Object.entries(map)) {
    const value = (body as Record<string, unknown>)[key];
    if (value !== undefined) {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    }
  }

  const service = sets.length
    ? await queryOne(
        `UPDATE services SET ${sets.join(', ')} WHERE tenant_id = $1 AND id = $2 RETURNING ${SELECT}`,
        values
      )
    : before;

  if (body.professionalIds) {
    await query('DELETE FROM professional_services WHERE tenant_id = $1 AND service_id = $2', [
      session.tenantId,
      (await params).id,
    ]);
    for (const professionalId of body.professionalIds) {
      await query(
        `INSERT INTO professional_services (tenant_id, professional_id, service_id)
         SELECT $1, $2, $3 WHERE EXISTS (SELECT 1 FROM professionals WHERE id = $2 AND tenant_id = $1)
         ON CONFLICT DO NOTHING`,
        [session.tenantId, professionalId, (await params).id]
      );
    }
  }

  await audit({
    tenantId: session.tenantId,
    userId: session.userId,
    action: 'service.update',
    entity: 'service',
    entityId: (await params).id,
    before,
    after: body,
    ip: clientIp(req),
  });

  return ok({ service });
});

/** Servico com historico nunca some: vira inativo para nao quebrar relatorios. */
export const DELETE = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const session = await requireRole(req, 'ADMIN');

  const used = await queryOne<{ count: string }>(
    `SELECT count(*)::text AS count FROM appointment_services
      WHERE tenant_id = $1 AND service_id = $2`,
    [session.tenantId, (await params).id]
  );

  if (Number(used?.count ?? 0) > 0) {
    await query('UPDATE services SET active = false WHERE tenant_id = $1 AND id = $2', [
      session.tenantId,
      (await params).id,
    ]);
  } else {
    await query('DELETE FROM services WHERE tenant_id = $1 AND id = $2', [session.tenantId, (await params).id]);
  }

  await audit({
    tenantId: session.tenantId,
    userId: session.userId,
    action: 'service.delete',
    entity: 'service',
    entityId: (await params).id,
    ip: clientIp(req),
  });

  return ok({ deleted: true, softDeleted: Number(used?.count ?? 0) > 0 });
});
