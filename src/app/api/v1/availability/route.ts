import { z } from 'zod';
import { ok, parseQuery, route } from '@/lib/http';
import { requireAuth } from '@/lib/auth';
import { getDayAvailability, getMonthAvailability } from '@/server/services/availability.service';

export const dynamic = 'force-dynamic';

const schema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  services: z.string().min(1),
  professional: z.string().uuid().optional(),
});

/** Mesma disponibilidade do fluxo publico, para o agendamento manual do painel. */
export const GET = route(async (req: Request) => {
  const session = await requireAuth(req);
  const q = parseQuery(req, schema);
  const serviceIds = q.services.split(',').filter(Boolean);

  if (q.month) {
    return ok(
      await getMonthAvailability({
        tenantId: session.tenantId,
        month: q.month,
        serviceIds,
        professionalId: q.professional ?? null,
      })
    );
  }

  return ok(
    await getDayAvailability({
      tenantId: session.tenantId,
      date: q.date ?? new Date().toISOString().slice(0, 10),
      serviceIds,
      professionalId: q.professional ?? null,
    })
  );
});
