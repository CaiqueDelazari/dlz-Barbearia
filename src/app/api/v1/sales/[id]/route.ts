import { z } from 'zod';
import { clientIp, ok, parseQuery, route } from '@/lib/http';
import { requireAuth, requireRole } from '@/lib/auth';
import { cancelSale, getSale } from '@/server/services/sale.service';

export const dynamic = 'force-dynamic';

export const GET = route(async (req: Request, { params }: { params: { id: string } }) => {
  const session = await requireAuth(req);
  const sale = await getSale(session.tenantId, params.id);
  return ok({ sale });
});

const cancelSchema = z.object({ reason: z.string().max(200).optional() });

/**
 * Cancelar devolve o estoque e tira o valor do caixa. A venda continua na
 * lista, marcada — errar de digitação e apagar o rastro é pior que o erro.
 *
 * Exige ADMIN de propósito: registrar venda é trabalho de balcão (STAFF), mas
 * tirar dinheiro do caixa é a operação que alguém usaria para encobrir um
 * desvio. Fica com quem responde pelo caixa, e o audit log guarda quem foi.
 */
export const DELETE = route(async (req: Request, { params }: { params: { id: string } }) => {
  const session = await requireRole(req, 'ADMIN');
  const { reason } = parseQuery(req, cancelSchema);

  const sale = await cancelSale({
    tenantId: session.tenantId,
    userId: session.userId,
    id: params.id,
    reason: reason ?? null,
    ip: clientIp(req),
  });

  return ok({ sale });
});
