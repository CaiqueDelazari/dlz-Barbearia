import type { PoolClient } from 'pg';
import { query, queryOne, transaction } from '@/lib/db';
import { ApiError } from '@/lib/http';
import { audit } from '@/lib/auth';

/**
 * Produtos de revenda (xampu, máscara, óleo) vendidos no fim do atendimento.
 *
 * Duas coisas andam juntas e por isso moram aqui, não na rota: o total do
 * agendamento precisa somar o produto, e o estoque precisa baixar. As duas na
 * mesma transação — senão o dia fecha com o caixa certo e o estoque errado.
 */

export type Product = {
  id: string;
  name: string;
  description: string | null;
  brand: string | null;
  category: string | null;
  sku: string | null;
  price: number;
  costPrice: number;
  trackStock: boolean;
  stockQuantity: number;
  minStock: number;
  imageUrl: string | null;
  displayOrder: number;
  active: boolean;
};

const SELECT = `
  id, name, description, brand, category, sku,
  price::float8 AS price, cost_price::float8 AS "costPrice",
  track_stock AS "trackStock", stock_quantity AS "stockQuantity", min_stock AS "minStock",
  image_url AS "imageUrl", display_order AS "displayOrder", active
`;

export async function listProducts(params: {
  tenantId: string;
  search?: string;
  onlyActive?: boolean;
}): Promise<{ items: Product[]; lowStock: number }> {
  const values: unknown[] = [params.tenantId];
  const where = ['tenant_id = $1'];

  if (params.onlyActive) where.push('active');
  if (params.search) {
    values.push(`%${params.search}%`);
    where.push(`(name ILIKE $${values.length} OR brand ILIKE $${values.length} OR sku ILIKE $${values.length})`);
  }

  const items = await query<Product>(
    `SELECT ${SELECT} FROM products WHERE ${where.join(' AND ')} ORDER BY display_order, name`,
    values
  );

  const lowStock = items.filter(
    (p) => p.active && p.trackStock && p.stockQuantity <= p.minStock
  ).length;

  return { items, lowStock };
}

export async function getProduct(tenantId: string, id: string): Promise<Product> {
  const product = await queryOne<Product>(
    `SELECT ${SELECT} FROM products WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id]
  );
  if (!product) throw ApiError.notFound('Produto não encontrado');
  return product;
}

export async function createProduct(input: {
  tenantId: string;
  userId: string;
  data: Record<string, unknown>;
}): Promise<Product> {
  const d = input.data;
  const product = await queryOne<Product>(
    `INSERT INTO products (tenant_id, name, description, brand, category, sku, price, cost_price,
                           track_stock, stock_quantity, min_stock, image_url, display_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,0),COALESCE($9,true),COALESCE($10,0),COALESCE($11,0),$12,COALESCE($13,0))
     RETURNING ${SELECT}`,
    [
      input.tenantId, d.name, d.description ?? null, d.brand ?? null, d.category ?? null,
      d.sku ?? null, d.price, d.costPrice ?? null, d.trackStock ?? null,
      d.stockQuantity ?? null, d.minStock ?? null, d.imageUrl ?? null, d.displayOrder ?? null,
    ]
  );

  // estoque inicial também é movimento: o histórico começa do zero de verdade
  if (product!.trackStock && product!.stockQuantity > 0) {
    await query(
      `INSERT INTO product_movements (tenant_id, product_id, quantity, reason, notes, user_id)
       VALUES ($1,$2,$3,'restock','Estoque inicial',$4)`,
      [input.tenantId, product!.id, product!.stockQuantity, input.userId]
    );
  }

  await audit({
    tenantId: input.tenantId,
    userId: input.userId,
    action: 'product.create',
    entity: 'product',
    entityId: product!.id,
    after: d,
  });

  return product!;
}

const COLUMNS: Record<string, string> = {
  name: 'name',
  description: 'description',
  brand: 'brand',
  category: 'category',
  sku: 'sku',
  price: 'price',
  costPrice: 'cost_price',
  trackStock: 'track_stock',
  minStock: 'min_stock',
  imageUrl: 'image_url',
  displayOrder: 'display_order',
  active: 'active',
};

export async function updateProduct(input: {
  tenantId: string;
  userId: string;
  id: string;
  data: Record<string, unknown>;
}): Promise<Product> {
  const before = await getProduct(input.tenantId, input.id);

  const sets: string[] = [];
  const values: unknown[] = [input.tenantId, input.id];
  for (const [key, column] of Object.entries(COLUMNS)) {
    if (input.data[key] === undefined) continue;
    values.push(input.data[key]);
    sets.push(`${column} = $${values.length}`);
  }
  // estoque não se edita direto: entra por movimento, para deixar rastro
  if (!sets.length) return before;

  const product = await queryOne<Product>(
    `UPDATE products SET ${sets.join(', ')} WHERE tenant_id = $1 AND id = $2 RETURNING ${SELECT}`,
    values
  );

  await audit({
    tenantId: input.tenantId,
    userId: input.userId,
    action: 'product.update',
    entity: 'product',
    entityId: input.id,
    before,
    after: input.data,
  });

  return product!;
}

/** Produto já vendido nunca some: vira inativo para não furar o histórico. */
export async function deleteProduct(tenantId: string, userId: string, id: string) {
  const sold = await queryOne<{ count: string }>(
    `SELECT count(*)::text AS count FROM appointment_products WHERE tenant_id = $1 AND product_id = $2`,
    [tenantId, id]
  );
  const soft = Number(sold?.count ?? 0) > 0;

  if (soft) {
    await query('UPDATE products SET active = false WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
  } else {
    await query('DELETE FROM products WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
  }

  await audit({
    tenantId,
    userId,
    action: soft ? 'product.deactivate' : 'product.delete',
    entity: 'product',
    entityId: id,
  });

  return { deleted: true, softDeleted: soft };
}

/** Entrada, ajuste ou perda de estoque. `quantity` negativo = saída. */
export async function moveStock(input: {
  tenantId: string;
  userId: string;
  productId: string;
  quantity: number;
  reason: 'restock' | 'adjustment' | 'loss' | 'return';
  notes?: string | null;
}): Promise<Product> {
  if (!input.quantity) throw ApiError.badRequest('Informe a quantidade');

  return transaction(async (tx) => {
    const updated = await tx.query<Product>(
      `UPDATE products SET stock_quantity = stock_quantity + $3
        WHERE tenant_id = $1 AND id = $2
        RETURNING ${SELECT}`,
      [input.tenantId, input.productId, input.quantity]
    );
    if (!updated.rowCount) throw ApiError.notFound('Produto não encontrado');

    await tx.query(
      `INSERT INTO product_movements (tenant_id, product_id, quantity, reason, notes, user_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [input.tenantId, input.productId, input.quantity, input.reason, input.notes ?? null, input.userId]
    );

    return updated.rows[0];
  });
}

export async function stockHistory(tenantId: string, productId: string) {
  return query(
    `SELECT m.id, m.quantity, m.reason, m.notes, m.created_at AS "createdAt",
            u.name AS "userName", c.name AS "clientName"
       FROM product_movements m
       LEFT JOIN users u ON u.id = m.user_id
       LEFT JOIN appointments a ON a.id = m.appointment_id
       LEFT JOIN clients c ON c.id = a.client_id
      WHERE m.tenant_id = $1 AND m.product_id = $2
      ORDER BY m.created_at DESC LIMIT 50`,
    [tenantId, productId]
  );
}

// ------------------------------------------------- venda no atendimento
/** Total do agendamento = serviços + produtos. Roda sempre que produto entra ou sai. */
async function recalcTotal(tx: PoolClient, tenantId: string, appointmentId: string) {
  await tx.query(
    `UPDATE appointments a
        SET total_amount = servicos.total + produtos.total,
            payment_status = CASE
              WHEN a.paid_amount >= servicos.total + produtos.total THEN 'paid'::payment_status
              WHEN a.paid_amount > 0 THEN 'partially_paid'::payment_status
              ELSE 'pending'::payment_status END
       FROM (SELECT COALESCE(sum(price), 0) AS total FROM appointment_services WHERE appointment_id = $2) servicos,
            (SELECT COALESCE(sum(total), 0) AS total FROM appointment_products WHERE appointment_id = $2) produtos
      WHERE a.tenant_id = $1 AND a.id = $2`,
    [tenantId, appointmentId]
  );
}

export async function addProductToAppointment(input: {
  tenantId: string;
  userId: string;
  appointmentId: string;
  productId: string;
  quantity: number;
  /** Permite fechar a venda mesmo com estoque zerado (produto que chegou e não foi lançado). */
  allowNegativeStock?: boolean;
}) {
  if (input.quantity <= 0) throw ApiError.badRequest('Quantidade inválida');

  return transaction(async (tx) => {
    const appt = await tx.query<{ id: string; status: string }>(
      `SELECT id, status FROM appointments WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [input.tenantId, input.appointmentId]
    );
    if (!appt.rowCount) throw ApiError.notFound('Agendamento não encontrado');
    if (appt.rows[0].status === 'cancelled') {
      throw ApiError.badRequest('Não dá para vender em um agendamento cancelado');
    }

    const productRow = await tx.query<Product>(
      `SELECT ${SELECT} FROM products WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [input.tenantId, input.productId]
    );
    if (!productRow.rowCount) throw ApiError.notFound('Produto não encontrado');
    const product = productRow.rows[0];

    if (product.trackStock && product.stockQuantity < input.quantity && !input.allowNegativeStock) {
      throw ApiError.conflict(
        product.stockQuantity > 0
          ? `Só há ${product.stockQuantity} em estoque.`
          : `${product.name} está sem estoque.`,
        'out_of_stock',
        { available: product.stockQuantity }
      );
    }

    const total = Math.round(Number(product.price) * input.quantity * 100) / 100;

    const sale = await tx.query<{ id: string }>(
      `INSERT INTO appointment_products
         (tenant_id, appointment_id, product_id, product_name, unit_price, quantity, total, sold_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        input.tenantId, input.appointmentId, product.id, product.name,
        product.price, input.quantity, total, input.userId,
      ]
    );

    if (product.trackStock) {
      await tx.query(
        `UPDATE products SET stock_quantity = stock_quantity - $3 WHERE tenant_id = $1 AND id = $2`,
        [input.tenantId, product.id, input.quantity]
      );
      await tx.query(
        `INSERT INTO product_movements (tenant_id, product_id, quantity, reason, appointment_id, user_id)
         VALUES ($1,$2,$3,'sale',$4,$5)`,
        [input.tenantId, product.id, -input.quantity, input.appointmentId, input.userId]
      );
    }

    await recalcTotal(tx, input.tenantId, input.appointmentId);
    return { id: sale.rows[0].id, total };
  });
}

export async function removeProductFromAppointment(input: {
  tenantId: string;
  userId: string;
  appointmentId: string;
  saleId: string;
}) {
  return transaction(async (tx) => {
    const removed = await tx.query<{ product_id: string | null; quantity: number }>(
      `DELETE FROM appointment_products
        WHERE tenant_id = $1 AND appointment_id = $2 AND id = $3
        RETURNING product_id, quantity`,
      [input.tenantId, input.appointmentId, input.saleId]
    );
    if (!removed.rowCount) throw ApiError.notFound('Venda não encontrada');

    const { product_id: productId, quantity } = removed.rows[0];
    if (productId) {
      // devolve ao estoque só o que controla estoque
      const back = await tx.query(
        `UPDATE products SET stock_quantity = stock_quantity + $3
          WHERE tenant_id = $1 AND id = $2 AND track_stock
          RETURNING id`,
        [input.tenantId, productId, quantity]
      );
      if (back.rowCount) {
        await tx.query(
          `INSERT INTO product_movements (tenant_id, product_id, quantity, reason, appointment_id, user_id)
           VALUES ($1,$2,$3,'return',$4,$5)`,
          [input.tenantId, productId, quantity, input.appointmentId, input.userId]
        );
      }
    }

    await recalcTotal(tx, input.tenantId, input.appointmentId);
    return { removed: true };
  });
}

export async function listAppointmentProducts(tenantId: string, appointmentId: string) {
  return query(
    `SELECT id, product_id AS "productId", product_name AS "productName",
            unit_price::float8 AS "unitPrice", quantity, total::float8 AS total
       FROM appointment_products
      WHERE tenant_id = $1 AND appointment_id = $2
      ORDER BY created_at`,
    [tenantId, appointmentId]
  );
}
