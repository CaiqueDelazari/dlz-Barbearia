import { z } from 'zod';
import { clientIp, ok, parseBody, parseQuery, route } from '@/lib/http';
import { audit, requireAuth } from '@/lib/auth';
import { queryOne } from '@/lib/db';
import { listClients, normalizePhone } from '@/server/repositories/client.repo';

export const dynamic = 'force-dynamic';

const listSchema = z.object({
  search: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const GET = route(async (req: Request) => {
  const session = await requireAuth(req);
  const q = parseQuery(req, listSchema);
  const result = await listClients({ tenantId: session.tenantId, ...q });
  return ok(result);
});

const schema = z.object({
  name: z.string().min(2).max(120),
  phone: z.string().min(10),
  email: z.string().email().nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});

export const POST = route(async (req: Request) => {
  const session = await requireAuth(req);
  const body = await parseBody(req, schema);
  const phone = normalizePhone(body.phone);

  const client = await queryOne(
    `INSERT INTO clients (tenant_id, name, phone, email, notes)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (tenant_id, phone)
     DO UPDATE SET name = EXCLUDED.name, email = COALESCE(EXCLUDED.email, clients.email),
                   notes = COALESCE(EXCLUDED.notes, clients.notes), updated_at = now()
     RETURNING id, name, phone, email, notes, blocked, no_show_count AS "noShowCount"`,
    [session.tenantId, body.name, phone, body.email ?? null, body.notes ?? null]
  );

  await audit({
    tenantId: session.tenantId,
    userId: session.userId,
    action: 'client.upsert',
    entity: 'client',
    entityId: (client as { id: string }).id,
    after: { name: body.name, phone },
    ip: clientIp(req),
  });

  return ok({ client }, 201);
});
