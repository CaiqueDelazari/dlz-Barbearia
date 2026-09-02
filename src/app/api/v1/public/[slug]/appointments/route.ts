import { z } from 'zod';
import { clientIp, ok, parseBody, rateLimit, route } from '@/lib/http';
import { getSettings, getTenantBySlug } from '@/server/repositories/tenant.repo';
import { createBooking } from '@/server/services/appointment.service';

export const dynamic = 'force-dynamic';

const schema = z.object({
  items: z
    .array(
      z.object({
        startsAt: z.string().min(1),
        serviceIds: z.array(z.string().uuid()).min(1),
        professionalId: z.string().uuid().nullable().optional(),
      })
    )
    .min(1)
    .max(5),
  client: z.object({
    name: z.string().min(2, 'Informe seu nome').max(120),
    phone: z.string().min(10, 'Informe um telefone valido'),
  }),
  notes: z.string().max(500).optional(),
});

/**
 * Cria a reserva do cliente. Se a empresa exige pagamento online, nasce como
 * 'pending' com prazo de expiracao - so o webhook do gateway confirma.
 */
export const POST = route(async (req: Request, { params }: { params: Promise<{ slug: string }> }) => {
  const ip = clientIp(req);
  await rateLimit(`booking:${ip}`, 10, 60_000);

  const tenant = await getTenantBySlug((await params).slug);
  const settings = await getSettings(tenant.id);
  const body = await parseBody(req, schema);

  const result = await createBooking({
    tenantId: tenant.id,
    items: body.items,
    client: body.client,
    source: 'online',
    requirePayment: settings.online_payment_required,
    notes: body.notes ?? null,
    ip,
  });

  return ok(
    {
      ...result,
      requiresPayment: settings.online_payment_required,
      manageUrl: `/agendamento/${result.manageToken}`,
    },
    201
  );
});
