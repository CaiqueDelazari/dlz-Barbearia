import { ApiError, clientIp, ok, route, uuidParam } from '@/lib/http';
import { audit, requireAuth } from '@/lib/auth';
import { query } from '@/lib/db';
import { escopoDeAgenda } from '@/server/services/escopo.service';

export const dynamic = 'force-dynamic';

/**
 * Reabre a agenda.
 * `?type=weekly` remove a pausa fixa da semana; sem isso, remove o bloqueio pontual.
 */
export const DELETE = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const session = await requireAuth(req);
  const weekly = new URL(req.url).searchParams.get('type') === 'weekly';

  const table = weekly ? 'business_breaks' : 'blocked_periods';

  // Quem so fecha a propria agenda tambem so reabre a propria: sem isto, um
  // STAFF apagava o feriado da loja (`professional_id IS NULL`) e a casa
  // reabria sem ninguem ter decidido isso.
  const escopo = await escopoDeAgenda(session);
  if (escopo === '') {
    throw ApiError.forbidden('Seu login ainda nao esta ligado a um profissional.');
  }

  const removed = await query<{ id: string }>(
    `DELETE FROM ${table}
      WHERE tenant_id = $1 AND id = $2
        AND ($3::uuid IS NULL OR professional_id = $3)
      RETURNING id`,
    [session.tenantId, uuidParam((await params).id), escopo]
  );
  if (!removed.length) throw ApiError.notFound('Bloqueio não encontrado');

  await audit({
    tenantId: session.tenantId,
    userId: session.userId,
    action: weekly ? 'block.weekly.delete' : 'block.delete',
    entity: weekly ? 'business_break' : 'blocked_period',
    entityId: uuidParam((await params).id),
    ip: clientIp(req),
  });

  return ok({ deleted: true });
});
