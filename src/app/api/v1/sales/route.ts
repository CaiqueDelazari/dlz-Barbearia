import { z } from 'zod';
import { clientIp, ok, parseBody, parseQuery, route } from '@/lib/http';
import { requireAuth } from '@/lib/auth';
import { createSale, listSales } from '@/server/services/sale.service';

export const dynamic = 'force-dynamic';

const listSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const GET = route(async (req: Request) => {
  const session = await requireAuth(req);
  const q = parseQuery(req, listSchema);
  const result = await listSales({ tenantId: session.tenantId, ...q });
  return ok(result);
});

const createSchema = z.object({
  /** Cliente é opcional: quem passa só para comprar costuma não se cadastrar. */
  clientId: z.string().uuid().nullable().optional(),
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity: z.number().int().positive(),
      })
    )
    .min(1),
  method: z.enum(['pix', 'card', 'cash', 'transfer', 'other']),
  notes: z.string().max(300).nullable().optional(),
  allowNegativeStock: z.boolean().optional(),
});

/** Venda de balcão, sem agendamento. Nasce paga — o dinheiro entrou agora. */
export const POST = route(async (req: Request) => {
  const session = await requireAuth(req);
  const body = await parseBody(req, createSchema);

  const sale = await createSale({
    tenantId: session.tenantId,
    userId: session.userId,
    clientId: body.clientId ?? null,
    items: body.items,
    method: body.method,
    notes: body.notes ?? null,
    allowNegativeStock: body.allowNegativeStock,
    ip: clientIp(req),
  });

  return ok({ sale }, 201);
});
