import { z } from 'zod';
import { ok, parseBody, parseQuery, route } from '@/lib/http';
import { requireRole } from '@/lib/auth';
import { createProduct, listProducts } from '@/server/services/product.service';

export const dynamic = 'force-dynamic';

const listSchema = z.object({
  search: z.string().optional(),
  active: z.enum(['true', 'false']).optional(),
});

export const GET = route(async (req: Request) => {
  const session = await requireRole(req, 'STAFF');
  const q = parseQuery(req, listSchema);
  const result = await listProducts({
    tenantId: session.tenantId,
    search: q.search,
    onlyActive: q.active === 'true',
  });
  return ok({ products: result.items, lowStock: result.lowStock });
});

const schema = z.object({
  name: z.string().min(2).max(120),
  description: z.string().max(500).nullable().optional(),
  brand: z.string().max(80).nullable().optional(),
  category: z.string().max(60).nullable().optional(),
  sku: z.string().max(60).nullable().optional(),
  price: z.number().min(0),
  costPrice: z.number().min(0).optional(),
  trackStock: z.boolean().optional(),
  stockQuantity: z.number().int().min(0).optional(),
  minStock: z.number().int().min(0).optional(),
  imageUrl: z.string().url().nullable().optional(),
  displayOrder: z.number().int().optional(),
});

export const POST = route(async (req: Request) => {
  const session = await requireRole(req, 'ADMIN');
  const data = await parseBody(req, schema);
  const product = await createProduct({
    tenantId: session.tenantId,
    userId: session.userId,
    data,
  });
  return ok({ product }, 201);
});
