import { z } from 'zod';
import { ok, parseQuery, rateLimit, route, clientIp } from '@/lib/http';
import { getTenantBySlug } from '@/server/repositories/tenant.repo';
import { getDayAvailability, getMonthAvailability } from '@/server/services/availability.service';

export const dynamic = 'force-dynamic';

const schema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  services: z.string().min(1, 'Informe os servicos'),
  professional: z.string().uuid().optional(),
});

/**
 * Disponibilidade calculada na hora. `date` devolve os horarios do dia;
 * `month` devolve quais dias tem vaga (alimenta o calendario).
 */
export const GET = route(async (req: Request, { params }: { params: { slug: string } }) => {
  rateLimit(`avail:${clientIp(req)}`, 120, 60_000);

  const tenant = await getTenantBySlug(params.slug);
  const q = parseQuery(req, schema);
  const serviceIds = q.services.split(',').filter(Boolean);

  if (q.month) {
    const result = await getMonthAvailability({
      tenantId: tenant.id,
      month: q.month,
      serviceIds,
      professionalId: q.professional ?? null,
    });
    return ok(result);
  }

  if (!q.date) {
    return ok({ error: 'informe date ou month' }, 400);
  }

  const result = await getDayAvailability({
    tenantId: tenant.id,
    date: q.date,
    serviceIds,
    professionalId: q.professional ?? null,
  });
  return ok(result);
});
