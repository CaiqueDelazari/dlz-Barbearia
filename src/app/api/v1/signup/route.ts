import { z } from 'zod';
import { clientIp, ok, parseBody, rateLimit, route } from '@/lib/http';
import { audit } from '@/lib/auth';
import { createTenant } from '@/server/services/onboarding.service';

export const dynamic = 'force-dynamic';

const schema = z.object({
  businessName: z.string().min(2).max(120),
  slug: z.string().min(2).max(60).optional(),
  ownerName: z.string().min(2).max(120),
  email: z.string().email(),
  password: z.string().min(8, 'A senha precisa ter ao menos 8 caracteres'),
  phone: z.string().optional(),
  timezone: z.string().optional(),
});

/** Cadastro de uma nova empresa no SaaS. */
export const POST = route(async (req: Request) => {
  const ip = clientIp(req);
  await rateLimit(`signup:${ip}`, 5, 60 * 60_000);

  const body = await parseBody(req, schema);
  const result = await createTenant(body);

  await audit({
    tenantId: result.tenantId,
    userId: result.userId,
    action: 'tenant.create',
    entity: 'tenant',
    entityId: result.tenantId,
    after: { slug: result.slug, name: body.businessName },
    ip,
  });

  return ok(
    {
      tenantId: result.tenantId,
      slug: result.slug,
      bookingUrl: `/agendar/${result.slug}`,
    },
    201
  );
});
