import { z } from 'zod';
import { ok, parseQuery, route } from '@/lib/http';
import { requireRole } from '@/lib/auth';
import { getTenantContext } from '@/server/repositories/tenant.repo';
import { getFinancialSummary } from '@/server/services/dashboard.service';
import { resolvePeriod } from '@/server/services/period';

export const dynamic = 'force-dynamic';

const schema = z.object({
  range: z.enum(['today', 'week', 'month', 'custom']).default('month'),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const GET = route(async (req: Request) => {
  const session = await requireRole(req, 'ADMIN');
  const q = parseQuery(req, schema);
  const { tenant } = await getTenantContext(session.tenantId);
  const period = resolvePeriod(q.range ?? "today", tenant.timezone, q.from, q.to);
  return ok(await getFinancialSummary(session.tenantId, period));
});
