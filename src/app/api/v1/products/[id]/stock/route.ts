import { z } from 'zod';
import { ok, parseBody, route } from '@/lib/http';
import { audit, requireRole } from '@/lib/auth';
import { moveStock } from '@/server/services/product.service';

export const dynamic = 'force-dynamic';

const schema = z.object({
  /** Positivo entra, negativo sai. */
  quantity: z.number().int().refine((v) => v !== 0, 'Informe a quantidade'),
  reason: z.enum(['restock', 'adjustment', 'loss', 'return']).default('restock'),
  notes: z.string().max(200).nullable().optional(),
});

/** Entrada de mercadoria, ajuste de contagem ou perda. Tudo vira movimento. */
export const POST = route(async (req: Request, { params }: { params: { id: string } }) => {
  const session = await requireRole(req, 'ADMIN');
  const body = await parseBody(req, schema);

  const product = await moveStock({
    tenantId: session.tenantId,
    userId: session.userId,
    productId: params.id,
    quantity: body.quantity,
    reason: body.reason ?? 'restock',
    notes: body.notes ?? null,
  });

  await audit({
    tenantId: session.tenantId,
    userId: session.userId,
    action: 'product.stock',
    entity: 'product',
    entityId: params.id,
    after: body,
  });

  return ok({ product }, 201);
});
