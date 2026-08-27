import { z } from 'zod';
import { clientIp, ok, parseBody, parseQuery, route } from '@/lib/http';
import { audit, requireRole } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';

export const dynamic = 'force-dynamic';

const listSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  category: z.string().optional(),
});

export const GET = route(async (req: Request) => {
  const session = await requireRole(req, 'ADMIN');
  const q = parseQuery(req, listSchema);

  const values: unknown[] = [session.tenantId];
  const where = ['tenant_id = $1'];
  if (q.from) {
    values.push(q.from);
    where.push(`date >= $${values.length}::date`);
  }
  if (q.to) {
    values.push(q.to);
    where.push(`date <= $${values.length}::date`);
  }
  if (q.category) {
    values.push(q.category);
    where.push(`category = $${values.length}`);
  }

  const expenses = await query(
    `SELECT id, description, category, amount::float8 AS amount, date::text AS date,
            payment_method AS "paymentMethod", notes, recurring
       FROM expenses WHERE ${where.join(' AND ')} ORDER BY date DESC, created_at DESC`,
    values
  );

  const total = await queryOne<{ total: number }>(
    `SELECT COALESCE(sum(amount), 0)::float8 AS total FROM expenses WHERE ${where.join(' AND ')}`,
    values
  );

  return ok({ expenses, total: total?.total ?? 0 });
});

const schema = z.object({
  description: z.string().min(2).max(200),
  category: z.string().max(60).nullable().optional(),
  amount: z.number().positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  paymentMethod: z.enum(['pix', 'card', 'cash', 'transfer', 'other']).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
  recurring: z.boolean().optional(),
});

export const POST = route(async (req: Request) => {
  const session = await requireRole(req, 'ADMIN');
  const body = await parseBody(req, schema);

  const expense = await queryOne(
    `INSERT INTO expenses (tenant_id, description, category, amount, date, payment_method, notes, recurring, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5::date,$6::payment_method,$7,COALESCE($8,false),$9)
     RETURNING id, description, category, amount::float8 AS amount, date::text AS date,
               payment_method AS "paymentMethod", notes, recurring`,
    [
      session.tenantId,
      body.description,
      body.category ?? null,
      body.amount,
      body.date,
      body.paymentMethod ?? null,
      body.notes ?? null,
      body.recurring ?? null,
      session.userId,
    ]
  );

  await audit({
    tenantId: session.tenantId,
    userId: session.userId,
    action: 'expense.create',
    entity: 'expense',
    entityId: (expense as { id: string }).id,
    after: body,
    ip: clientIp(req),
  });

  return ok({ expense }, 201);
});
