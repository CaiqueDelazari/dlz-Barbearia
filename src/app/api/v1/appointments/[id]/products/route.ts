import { z } from 'zod';
import { ok, parseBody, route } from '@/lib/http';
import { audit, requireAuth } from '@/lib/auth';
import { getAppointment } from '@/server/services/appointment.service';
import {
  addProductToAppointment,
  listAppointmentProducts,
  removeProductFromAppointment,
} from '@/server/services/product.service';

export const dynamic = 'force-dynamic';

export const GET = route(async (req: Request, { params }: { params: { id: string } }) => {
  const session = await requireAuth(req);
  await getAppointment(session.tenantId, params.id); // valida o tenant
  return ok({ products: await listAppointmentProducts(session.tenantId, params.id) });
});

const schema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().positive().max(99).default(1),
  allowNegativeStock: z.boolean().optional(),
});

/** Vende um produto dentro do atendimento: soma no total e baixa o estoque. */
export const POST = route(async (req: Request, { params }: { params: { id: string } }) => {
  const session = await requireAuth(req);
  const body = await parseBody(req, schema);

  const sale = await addProductToAppointment({
    tenantId: session.tenantId,
    userId: session.userId,
    appointmentId: params.id,
    productId: body.productId,
    quantity: body.quantity ?? 1,
    allowNegativeStock: body.allowNegativeStock,
  });

  await audit({
    tenantId: session.tenantId,
    userId: session.userId,
    action: 'product.sale',
    entity: 'appointment',
    entityId: params.id,
    after: { productId: body.productId, quantity: body.quantity, total: sale.total },
  });

  const appointment = await getAppointment(session.tenantId, params.id);
  return ok({ sale, appointment }, 201);
});

/** Desfaz a venda: devolve ao estoque e tira do total. */
export const DELETE = route(async (req: Request, { params }: { params: { id: string } }) => {
  const session = await requireAuth(req);
  const saleId = new URL(req.url).searchParams.get('saleId');
  if (!saleId) return ok({ error: 'informe saleId' }, 400);

  await removeProductFromAppointment({
    tenantId: session.tenantId,
    userId: session.userId,
    appointmentId: params.id,
    saleId,
  });

  await audit({
    tenantId: session.tenantId,
    userId: session.userId,
    action: 'product.sale.remove',
    entity: 'appointment',
    entityId: params.id,
    after: { saleId },
  });

  const appointment = await getAppointment(session.tenantId, params.id);
  return ok({ appointment });
});
