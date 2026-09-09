import { z } from 'zod';
import { ok, parseBody, route, uuidParam } from '@/lib/http';
import { imageUrlSchema } from '@/lib/security';
import { requireRole } from '@/lib/auth';
import { deleteProduct, getProduct, stockHistory, updateProduct } from '@/server/services/product.service';

export const dynamic = 'force-dynamic';

export const GET = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const session = await requireRole(req, 'STAFF');
  const [product, movements] = await Promise.all([
    getProduct(session.tenantId, uuidParam((await params).id)),
    stockHistory(session.tenantId, uuidParam((await params).id)),
  ]);
  return ok({ product, movements });
});

const schema = z.object({
  name: z.string().min(2).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  brand: z.string().max(80).nullable().optional(),
  category: z.string().max(60).nullable().optional(),
  sku: z.string().max(60).nullable().optional(),
  price: z.number().min(0).optional(),
  costPrice: z.number().min(0).optional(),
  trackStock: z.boolean().optional(),
  minStock: z.number().int().min(0).optional(),
  imageUrl: imageUrlSchema.nullable().optional(),
  displayOrder: z.number().int().optional(),
  active: z.boolean().optional(),
});

export const PATCH = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const session = await requireRole(req, 'ADMIN');
  const data = await parseBody(req, schema);
  const product = await updateProduct({
    tenantId: session.tenantId,
    userId: session.userId,
    id: uuidParam((await params).id),
    data,
  });
  return ok({ product });
});

export const DELETE = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const session = await requireRole(req, 'ADMIN');
  return ok(await deleteProduct(session.tenantId, session.userId, uuidParam((await params).id)));
});
