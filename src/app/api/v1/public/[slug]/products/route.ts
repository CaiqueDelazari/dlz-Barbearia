import { clientIp, ok, rateLimit, route } from '@/lib/http';
import { query } from '@/lib/db';
import { getTenantBySlug } from '@/server/repositories/tenant.repo';

export const dynamic = 'force-dynamic';

/**
 * Vitrine de produtos da página pública. É só mostruário — o cliente vê o que o
 * estúdio revende e pede no balcão; não há carrinho nem pagamento aqui.
 *
 * A lista de campos é curta de propósito. `cost_price` é quanto o estúdio paga
 * ao fornecedor e `stock_quantity` é o giro do negócio: nenhum dos dois é
 * assunto de quem está do lado de fora, e um `SELECT *` distraído entregaria os
 * dois de graça para qualquer um que abrisse a URL.
 */
export const GET = route(async (req: Request, { params }: { params: { slug: string } }) => {
  await rateLimit(`public-products:${clientIp(req)}`, 120, 60_000);

  const tenant = await getTenantBySlug(params.slug);
  const products = await query(
    `SELECT id, name, description, brand, category,
            price::float8 AS price, image_url AS "imageUrl"
       FROM products
      WHERE tenant_id = $1 AND active
      ORDER BY display_order, name`,
    [tenant.id]
  );
  return ok({ products });
});
