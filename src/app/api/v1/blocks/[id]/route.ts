import { ApiError, clientIp, ok, route } from '@/lib/http';
import { audit, requireAuth } from '@/lib/auth';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Reabre a agenda.
 * `?type=weekly` remove a pausa fixa da semana; sem isso, remove o bloqueio pontual.
 */
export const DELETE = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const session = await requireAuth(req);
  const weekly = new URL(req.url).searchParams.get('type') === 'weekly';

  const table = weekly ? 'business_breaks' : 'blocked_periods';
  const removed = await query<{ id: string }>(
    `DELETE FROM ${table} WHERE tenant_id = $1 AND id = $2 RETURNING id`,
    [session.tenantId, (await params).id]
  );
  if (!removed.length) throw ApiError.notFound('Bloqueio não encontrado');

  await audit({
    tenantId: session.tenantId,
    userId: session.userId,
    action: weekly ? 'block.weekly.delete' : 'block.delete',
    entity: weekly ? 'business_break' : 'blocked_period',
    entityId: (await params).id,
    ip: clientIp(req),
  });

  return ok({ deleted: true });
});
