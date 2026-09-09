import { clientIp, ok, route, uuidParam } from '@/lib/http';
import { audit, requireRole } from '@/lib/auth';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

export const DELETE = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const session = await requireRole(req, 'ADMIN');
  await query('DELETE FROM expenses WHERE tenant_id = $1 AND id = $2', [session.tenantId, uuidParam((await params).id)]);
  await audit({
    tenantId: session.tenantId,
    userId: session.userId,
    action: 'expense.delete',
    entity: 'expense',
    entityId: uuidParam((await params).id),
    ip: clientIp(req),
  });
  return ok({ deleted: true });
});
