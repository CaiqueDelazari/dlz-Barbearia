import { z } from 'zod';
import { ok, parseQuery, route } from '@/lib/http';
import { requireAuth } from '@/lib/auth';
import { getTenantContext } from '@/server/repositories/tenant.repo';
import { getDashboard, stripFinancials } from '@/server/services/dashboard.service';
import { resolvePeriod } from '@/server/services/period';

export const dynamic = 'force-dynamic';

const schema = z.object({
  range: z.enum(['today', 'week', 'month', 'custom']).default('today'),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const GET = route(async (req: Request) => {
  const session = await requireAuth(req);
  const q = parseQuery(req, schema);
  const { tenant } = await getTenantContext(session.tenantId);
  const period = resolvePeriod(q.range ?? "today", tenant.timezone, q.from, q.to);
  const dashboard = await getDashboard(session.tenantId, period);

  // STAFF ve a agenda do dia, nao o caixa da empresa
  return ok(session.role === 'STAFF' ? stripFinancials(dashboard) : dashboard);
});
