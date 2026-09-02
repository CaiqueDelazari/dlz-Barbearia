import { z } from 'zod';
import { ApiError, clientIp, ok, parseBody, route } from '@/lib/http';
import { audit, requireAuth } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';
import { getClientHistory, normalizePhone } from '@/server/repositories/client.repo';
import { escopoDeAgenda } from '@/server/services/escopo.service';

export const dynamic = 'force-dynamic';

/** Ficha completa: historico, servicos mais usados, total gasto, proximo horario. */
export const GET = route(async (req: Request, { params }: { params: { id: string } }) => {
  const session = await requireAuth(req);

  // Filtrar a lista nao basta: com o id na mao, um STAFF abriria a ficha de
  // qualquer cliente da casa -- historico, telefone e quanto ja gastou.
  const escopo = await escopoDeAgenda(session);
  if (escopo !== null) {
    const atendeu = await query(
      `SELECT 1 FROM appointments
        WHERE tenant_id = $1 AND client_id = $2 AND professional_id = $3
        LIMIT 1`,
      [session.tenantId, params.id, escopo || '00000000-0000-0000-0000-000000000000']
    );
    if (atendeu.length === 0) throw ApiError.notFound('Cliente nao encontrado');
  }

  return ok(await getClientHistory(session.tenantId, params.id));
});

const schema = z.object({
  name: z.string().min(2).max(120).optional(),
  phone: z.string().min(10).optional(),
  email: z.string().email().nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
  blocked: z.boolean().optional(),
});

export const PATCH = route(async (req: Request, { params }: { params: { id: string } }) => {
  const session = await requireAuth(req);
  const body = await parseBody(req, schema);

  const map: Record<string, string> = {
    name: 'name',
    phone: 'phone',
    email: 'email',
    notes: 'notes',
    blocked: 'blocked',
  };

  const sets: string[] = [];
  const values: unknown[] = [session.tenantId, params.id];
  for (const [key, column] of Object.entries(map)) {
    let value = (body as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (key === 'phone') value = normalizePhone(String(value));
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  }
  if (!sets.length) throw ApiError.badRequest('Nada para atualizar');

  const client = await queryOne(
    `UPDATE clients SET ${sets.join(', ')} WHERE tenant_id = $1 AND id = $2
     RETURNING id, name, phone, email, notes, blocked, no_show_count AS "noShowCount"`,
    values
  );
  if (!client) throw ApiError.notFound('Cliente nao encontrado');

  await audit({
    tenantId: session.tenantId,
    userId: session.userId,
    action: 'client.update',
    entity: 'client',
    entityId: params.id,
    after: body,
    ip: clientIp(req),
  });

  return ok({ client });
});
