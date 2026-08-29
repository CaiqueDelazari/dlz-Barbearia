import { query, queryOne, transaction } from '@/lib/db';
import { ApiError } from '@/lib/http';
import { audit } from '@/lib/auth';

/**
 * Venda avulsa: o cliente entra só para levar um xampu e vai embora.
 *
 * Não vira agendamento de propósito. Um agendamento falso sujaria a agenda, a
 * contagem de faltas e o ticket médio por atendimento. Aqui a venda tem tabela
 * própria e só encosta no resto do sistema em dois pontos: baixa o estoque
 * (com movimento, como qualquer saída) e grava uma linha paga em `payments` —
 * que é por onde o financeiro lê todas as entradas.
 */

export type SaleItemInput = { productId: string; quantity: number };

export type SaleItem = {
  id: string;
  productId: string | null;
  productName: string;
  unitPrice: number;
  quantity: number;
  total: number;
};

export type Sale = {
  id: string;
  total: number;
  method: string;
  notes: string | null;
  clientId: string | null;
  clientName: string | null;
  sellerName: string | null;
  cancelledAt: string | null;
  createdAt: string;
  items: SaleItem[];
};

const SALE_SELECT = `
  s.id, s.total::float8 AS total, s.method::text AS method, s.notes,
  s.client_id AS "clientId", c.name AS "clientName", u.name AS "sellerName",
  s.cancelled_at AS "cancelledAt", s.created_at AS "createdAt"
`;

const SALE_FROM = `
  FROM product_sales s
  LEFT JOIN clients c ON c.id = s.client_id
  LEFT JOIN users u ON u.id = s.sold_by_user_id
`;

/** Itens de várias vendas em uma query só: a lista não faz N+1. */
async function itemsOf(tenantId: string, saleIds: string[]): Promise<Map<string, SaleItem[]>> {
  const byId = new Map<string, SaleItem[]>();
  if (!saleIds.length) return byId;
  for (const id of saleIds) byId.set(id, []);

  const rows = await query<SaleItem & { saleId: string }>(
    `SELECT sale_id AS "saleId", id, product_id AS "productId", product_name AS "productName",
            unit_price::float8 AS "unitPrice", quantity, total::float8 AS total
       FROM product_sale_items
      WHERE tenant_id = $1 AND sale_id = ANY($2::uuid[])
      ORDER BY created_at`,
    [tenantId, saleIds]
  );
  for (const { saleId, ...item } of rows) byId.get(saleId)?.push(item);
  return byId;
}

export async function listSales(params: {
  tenantId: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}): Promise<{ items: Sale[]; total: number }> {
  const where = ['s.tenant_id = $1'];
  const values: unknown[] = [params.tenantId];

  const push = (clause: (p: string) => string, value: unknown) => {
    values.push(value);
    where.push(clause(`$${values.length}`));
  };
  if (params.from) push((p) => `s.created_at >= ${p}`, new Date(params.from));
  if (params.to) push((p) => `s.created_at < ${p}`, new Date(params.to));

  const whereSql = where.join(' AND ');
  const limit = Math.min(params.limit ?? 50, 200);
  const offset = params.offset ?? 0;

  const [rows, countRow] = await Promise.all([
    query<Sale>(
      `SELECT ${SALE_SELECT} ${SALE_FROM} WHERE ${whereSql}
       ORDER BY s.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      values
    ),
    queryOne<{ count: string }>(
      `SELECT count(*)::text AS count FROM product_sales s WHERE ${whereSql}`,
      values
    ),
  ]);

  const byId = await itemsOf(
    params.tenantId,
    rows.map((r) => r.id)
  );
  for (const sale of rows) sale.items = byId.get(sale.id) ?? [];

  return { items: rows, total: Number(countRow?.count ?? 0) };
}

export async function getSale(tenantId: string, id: string): Promise<Sale> {
  const sale = await queryOne<Sale>(
    `SELECT ${SALE_SELECT} ${SALE_FROM} WHERE s.tenant_id = $1 AND s.id = $2`,
    [tenantId, id]
  );
  if (!sale) throw ApiError.notFound('Venda não encontrada');
  sale.items = (await itemsOf(tenantId, [id])).get(id) ?? [];
  return sale;
}

/** Duas linhas do mesmo produto viram uma só: o estoque é conferido de uma vez. */
function mergeItems(items: SaleItemInput[]): SaleItemInput[] {
  const somado = new Map<string, number>();
  for (const item of items) {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      throw ApiError.badRequest('Quantidade inválida');
    }
    somado.set(item.productId, (somado.get(item.productId) ?? 0) + item.quantity);
  }
  return [...somado].map(([productId, quantity]) => ({ productId, quantity }));
}

export async function createSale(input: {
  tenantId: string;
  userId: string;
  clientId?: string | null;
  items: SaleItemInput[];
  method: 'pix' | 'card' | 'cash' | 'transfer' | 'other';
  notes?: string | null;
  /** Fecha a venda mesmo com estoque zerado (produto que chegou e não foi lançado). */
  allowNegativeStock?: boolean;
  ip?: string;
}): Promise<Sale> {
  const items = mergeItems(input.items);
  if (!items.length) throw ApiError.badRequest('Adicione ao menos um produto');

  const saleId = await transaction(async (tx) => {
    if (input.clientId) {
      const cliente = await tx.query('SELECT id FROM clients WHERE tenant_id = $1 AND id = $2', [
        input.tenantId,
        input.clientId,
      ]);
      if (!cliente.rowCount) throw ApiError.notFound('Cliente não encontrado');
    }

    // ordenado por id: duas vendas simultâneas travam os produtos na mesma
    // sequência e não se abraçam num deadlock
    const travados = await tx.query<{
      id: string;
      name: string;
      price: number;
      trackStock: boolean;
      stockQuantity: number;
    }>(
      `SELECT id, name, price::float8 AS price,
              track_stock AS "trackStock", stock_quantity AS "stockQuantity"
         FROM products
        WHERE tenant_id = $1 AND id = ANY($2::uuid[])
        ORDER BY id
          FOR UPDATE`,
      [input.tenantId, items.map((i) => i.productId)]
    );
    const porId = new Map(travados.rows.map((p) => [p.id, p]));

    let total = 0;
    for (const item of items) {
      const product = porId.get(item.productId);
      if (!product) throw ApiError.notFound('Produto não encontrado');
      if (product.trackStock && product.stockQuantity < item.quantity && !input.allowNegativeStock) {
        throw ApiError.conflict(
          product.stockQuantity > 0
            ? `Só há ${product.stockQuantity} de ${product.name} em estoque.`
            : `${product.name} está sem estoque.`,
          'out_of_stock',
          { productId: product.id, available: product.stockQuantity }
        );
      }
      total += Math.round(product.price * item.quantity * 100) / 100;
    }
    total = Math.round(total * 100) / 100;

    const sale = await tx.query<{ id: string }>(
      `INSERT INTO product_sales (tenant_id, client_id, total, method, notes, sold_by_user_id)
       VALUES ($1,$2,$3,$4::payment_method,$5,$6) RETURNING id`,
      [input.tenantId, input.clientId ?? null, total, input.method, input.notes ?? null, input.userId]
    );
    const id = sale.rows[0].id;

    for (const item of items) {
      const product = porId.get(item.productId)!;
      const subtotal = Math.round(product.price * item.quantity * 100) / 100;

      await tx.query(
        `INSERT INTO product_sale_items
           (tenant_id, sale_id, product_id, product_name, unit_price, quantity, total)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [input.tenantId, id, product.id, product.name, product.price, item.quantity, subtotal]
      );

      if (product.trackStock) {
        await tx.query(
          `UPDATE products SET stock_quantity = stock_quantity - $3 WHERE tenant_id = $1 AND id = $2`,
          [input.tenantId, product.id, item.quantity]
        );
        await tx.query(
          `INSERT INTO product_movements (tenant_id, product_id, quantity, reason, sale_id, user_id)
           VALUES ($1,$2,$3,'sale',$4,$5)`,
          [input.tenantId, product.id, -item.quantity, id, input.userId]
        );
      }
    }

    // a venda já nasce paga: é dinheiro que entrou no balcão agora
    await tx.query(
      `INSERT INTO payments (tenant_id, sale_id, client_id, amount, kind, method, status,
                             provider, idempotency_key, paid_at, created_by_user_id)
       VALUES ($1,$2,$3,$4,'full',$5::payment_method,'paid','onsite',$6, now(), $7)`,
      [input.tenantId, id, input.clientId ?? null, total, input.method, `sale:${id}`, input.userId]
    );

    return id;
  });

  await audit({
    tenantId: input.tenantId,
    userId: input.userId,
    action: 'sale.create',
    entity: 'sale',
    entityId: saleId,
    after: { items, method: input.method, clientId: input.clientId ?? null },
    ip: input.ip,
  });

  return getSale(input.tenantId, saleId);
}

/**
 * Cancelamento: a venda fica no histórico marcada, o estoque volta e o
 * pagamento sai das entradas. Apagar a linha esconderia o erro de digitação
 * em vez de mostrá-lo.
 */
export async function cancelSale(input: {
  tenantId: string;
  userId: string;
  id: string;
  reason?: string | null;
  ip?: string;
}): Promise<Sale> {
  await transaction(async (tx) => {
    const sale = await tx.query<{ id: string; cancelled_at: Date | null }>(
      `SELECT id, cancelled_at FROM product_sales
        WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [input.tenantId, input.id]
    );
    if (!sale.rowCount) throw ApiError.notFound('Venda não encontrada');
    if (sale.rows[0].cancelled_at) throw ApiError.badRequest('Esta venda já foi cancelada');

    const itens = await tx.query<{ product_id: string | null; quantity: number }>(
      `SELECT product_id, quantity FROM product_sale_items WHERE tenant_id = $1 AND sale_id = $2`,
      [input.tenantId, input.id]
    );

    for (const item of itens.rows) {
      if (!item.product_id) continue;
      // devolve ao estoque só o que controla estoque
      const devolvido = await tx.query(
        `UPDATE products SET stock_quantity = stock_quantity + $3
          WHERE tenant_id = $1 AND id = $2 AND track_stock
          RETURNING id`,
        [input.tenantId, item.product_id, item.quantity]
      );
      if (devolvido.rowCount) {
        await tx.query(
          `INSERT INTO product_movements (tenant_id, product_id, quantity, reason, sale_id, user_id, notes)
           VALUES ($1,$2,$3,'return',$4,$5,'Venda cancelada')`,
          [input.tenantId, item.product_id, item.quantity, input.id, input.userId]
        );
      }
    }

    // sai das entradas: `paid_at` é o que o financeiro usa para somar o caixa
    await tx.query(
      `UPDATE payments SET status = 'cancelled', paid_at = NULL
        WHERE tenant_id = $1 AND sale_id = $2`,
      [input.tenantId, input.id]
    );

    await tx.query(
      `UPDATE product_sales SET cancelled_at = now(), cancelled_reason = $3
        WHERE tenant_id = $1 AND id = $2`,
      [input.tenantId, input.id, input.reason ?? null]
    );
  });

  await audit({
    tenantId: input.tenantId,
    userId: input.userId,
    action: 'sale.cancel',
    entity: 'sale',
    entityId: input.id,
    after: { reason: input.reason ?? null },
    ip: input.ip,
  });

  return getSale(input.tenantId, input.id);
}
