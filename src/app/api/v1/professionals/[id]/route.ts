import { z } from 'zod';
import { ApiError, clientIp, ok, parseBody, route } from '@/lib/http';
import { imageUrlSchema } from '@/lib/security';
import { audit, requireRole } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';

export const dynamic = 'force-dynamic';

const SELECT = `id, name, bio, photo_url AS "photoUrl", phone,
                commission_percent::float8 AS "commissionPercent",
                display_order AS "displayOrder", active`;

const schema = z.object({
  name: z.string().min(2).max(120).optional(),
  bio: z.string().max(500).nullable().optional(),
  photoUrl: imageUrlSchema.nullable().optional(),
  phone: z.string().max(30).nullable().optional(),
  commissionPercent: z.number().min(0).max(100).optional(),
  displayOrder: z.number().int().optional(),
  active: z.boolean().optional(),
  serviceIds: z.array(z.string().uuid()).optional(),
});

export const PATCH = route(async (req: Request, { params }: { params: { id: string } }) => {
  const session = await requireRole(req, 'ADMIN');
  const body = await parseBody(req, schema);

  const before = await queryOne(`SELECT ${SELECT} FROM professionals WHERE tenant_id = $1 AND id = $2`, [
    session.tenantId,
    params.id,
  ]);
  if (!before) throw ApiError.notFound('Profissional nao encontrado');

  const map: Record<string, string> = {
    name: 'name',
    bio: 'bio',
    photoUrl: 'photo_url',
    phone: 'phone',
    commissionPercent: 'commission_percent',
    displayOrder: 'display_order',
    active: 'active',
  };

  const sets: string[] = [];
  const values: unknown[] = [session.tenantId, params.id];
  for (const [key, column] of Object.entries(map)) {
    const value = (body as Record<string, unknown>)[key];
    if (value !== undefined) {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    }
  }

  const professional = sets.length
    ? await queryOne(
        `UPDATE professionals SET ${sets.join(', ')} WHERE tenant_id = $1 AND id = $2 RETURNING ${SELECT}`,
        values
      )
    : before;

  if (body.serviceIds) {
    await query('DELETE FROM professional_services WHERE tenant_id = $1 AND professional_id = $2', [
      session.tenantId,
      params.id,
    ]);
    for (const serviceId of body.serviceIds) {
      await query(
        `INSERT INTO professional_services (tenant_id, professional_id, service_id)
         SELECT $1, $2, $3 WHERE EXISTS (SELECT 1 FROM services WHERE id = $3 AND tenant_id = $1)
         ON CONFLICT DO NOTHING`,
        [session.tenantId, params.id, serviceId]
      );
    }
  }

  await audit({
    tenantId: session.tenantId,
    userId: session.userId,
    action: 'professional.update',
    entity: 'professional',
    entityId: params.id,
    before,
    after: body,
    ip: clientIp(req),
  });

  return ok({ professional });
});

/** Desativa em vez de apagar: a agenda passada continua fazendo sentido. */
export const DELETE = route(async (req: Request, { params }: { params: { id: string } }) => {
  const session = await requireRole(req, 'ADMIN');
  await query('UPDATE professionals SET active = false WHERE tenant_id = $1 AND id = $2', [
    session.tenantId,
    params.id,
  ]);
  await audit({
    tenantId: session.tenantId,
    userId: session.userId,
    action: 'professional.deactivate',
    entity: 'professional',
    entityId: params.id,
    ip: clientIp(req),
  });
  return ok({ deactivated: true });
});
