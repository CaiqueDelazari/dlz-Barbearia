import { query, queryOne } from '@/lib/db';
import { addDays, todayInTz, zonedToUtc } from '@/lib/datetime';
import { getTenantContext } from '../repositories/tenant.repo';

export type Period = { from: string; to: string }; // datas locais YYYY-MM-DD

/** Traduz o periodo local da empresa para instantes absolutos. */
async function resolveRange(tenantId: string, period?: Partial<Period>) {
  const { tenant } = await getTenantContext(tenantId);
  const tz = tenant.timezone;
  const today = todayInTz(tz);
  const from = period?.from ?? today;
  const to = period?.to ?? from;
  return {
    tz,
    from,
    to,
    start: zonedToUtc(from, 0, tz),
    end: zonedToUtc(addDays(to, 1), 0, tz),
  };
}

export async function getDashboard(tenantId: string, period?: Partial<Period>) {
  const { from, to, start, end, tz } = await resolveRange(tenantId, period);
  const today = todayInTz(tz);
  const todayStart = zonedToUtc(today, 0, tz);
  const todayEnd = zonedToUtc(addDays(today, 1), 0, tz);

  const [counters, todayCount, services, revenue, expenses, upcoming, produtos, despesasRecentes, estoqueBaixo] = await Promise.all([
    queryOne<Record<string, number>>(
      `SELECT
         count(*) FILTER (WHERE status IN ('confirmed','completed','pending'))::int AS agendamentos,
         count(*) FILTER (WHERE status = 'completed')::int AS concluidos,
         count(*) FILTER (WHERE status = 'cancelled')::int AS cancelados,
         count(*) FILTER (WHERE status = 'no_show')::int AS faltas,
         COALESCE(sum(total_amount) FILTER (WHERE status IN ('confirmed','completed')), 0)::float8 AS faturamento_previsto,
         COALESCE(sum(paid_amount) FILTER (WHERE status IN ('confirmed','completed')), 0)::float8 AS recebido,
         COALESCE(sum(total_amount - paid_amount) FILTER (WHERE status IN ('confirmed','completed')), 0)::float8 AS pendente
       FROM appointments
      WHERE tenant_id = $1 AND starts_at >= $2 AND starts_at < $3`,
      [tenantId, start, end]
    ),
    queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM appointments
        WHERE tenant_id = $1 AND starts_at >= $2 AND starts_at < $3
          AND status IN ('confirmed','completed','pending')`,
      [tenantId, todayStart, todayEnd]
    ),
    query(
      `SELECT s.service_name AS name, count(*)::int AS quantidade, sum(s.price)::float8 AS total
         FROM appointment_services s
         JOIN appointments a ON a.id = s.appointment_id
        WHERE a.tenant_id = $1 AND a.starts_at >= $2 AND a.starts_at < $3
          AND a.status IN ('confirmed','completed')
        GROUP BY s.service_name ORDER BY quantidade DESC`,
      [tenantId, start, end]
    ),
    query(
      `SELECT to_char(a.starts_at AT TIME ZONE $4, 'YYYY-MM-DD') AS dia,
              sum(a.paid_amount)::float8 AS recebido,
              sum(a.total_amount)::float8 AS previsto,
              count(*)::int AS atendimentos
         FROM appointments a
        WHERE a.tenant_id = $1 AND a.starts_at >= $2 AND a.starts_at < $3
          AND a.status IN ('confirmed','completed')
        GROUP BY dia ORDER BY dia`,
      [tenantId, start, end, tz]
    ),
    queryOne<{ total: number }>(
      `SELECT COALESCE(sum(amount), 0)::float8 AS total FROM expenses
        WHERE tenant_id = $1 AND date >= $2::date AND date <= $3::date`,
      [tenantId, from, to]
    ),
    query(
      `SELECT a.id, a.starts_at, a.status, c.name AS client_name, c.phone AS client_phone,
              p.name AS professional_name,
              COALESCE((SELECT string_agg(s.service_name, ' + ' ORDER BY s.position)
                          FROM appointment_services s WHERE s.appointment_id = a.id), '') AS services
         FROM appointments a
         JOIN clients c ON c.id = a.client_id
         LEFT JOIN professionals p ON p.id = a.professional_id
        WHERE a.tenant_id = $1 AND a.starts_at >= now() AND a.status IN ('pending','confirmed')
        ORDER BY a.starts_at LIMIT 8`,
      [tenantId]
    ),
    // Produtos vendidos no período, das duas portas: dentro do atendimento (pela
    // data do atendimento) e no balcão sem agendamento (pela data da venda).
    queryOne<{ total: number; itens: number }>(
      `SELECT COALESCE(sum(total), 0)::float8 AS total,
              COALESCE(sum(quantidade), 0)::int AS itens
         FROM (
           SELECT ap.total, ap.quantity AS quantidade
             FROM appointment_products ap
             JOIN appointments a ON a.id = ap.appointment_id
            WHERE ap.tenant_id = $1 AND a.starts_at >= $2 AND a.starts_at < $3
              AND a.status IN ('confirmed','completed')
           UNION ALL
           SELECT si.total, si.quantity AS quantidade
             FROM product_sale_items si
             JOIN product_sales s ON s.id = si.sale_id
            WHERE si.tenant_id = $1 AND s.created_at >= $2 AND s.created_at < $3
              AND s.cancelled_at IS NULL
         ) vendidos`,
      [tenantId, start, end]
    ),
    query(
      `SELECT id, description, category, amount::float8 AS amount, date::text AS date
         FROM expenses WHERE tenant_id = $1
        ORDER BY date DESC, created_at DESC LIMIT 5`,
      [tenantId]
    ),
    query(
      `SELECT id, name, stock_quantity AS "stockQuantity", min_stock AS "minStock"
         FROM products
        WHERE tenant_id = $1 AND active AND track_stock AND stock_quantity <= min_stock
        ORDER BY stock_quantity, name LIMIT 8`,
      [tenantId]
    ),
  ]);

  const received = Number(counters?.recebido ?? 0);
  const expenseTotal = Number(expenses?.total ?? 0);
  const done = Number(counters?.concluidos ?? 0);

  return {
    period: { from, to },
    cards: {
      agendamentosHoje: todayCount?.count ?? 0,
      agendamentosPeriodo: counters?.agendamentos ?? 0,
      concluidos: done,
      cancelados: counters?.cancelados ?? 0,
      faltas: counters?.faltas ?? 0,
      faturamentoPrevisto: Number(counters?.faturamento_previsto ?? 0),
      recebido: received,
      pendente: Number(counters?.pendente ?? 0),
      despesas: expenseTotal,
      resultado: Math.round((received - expenseTotal) * 100) / 100,
      ticketMedio: done ? Math.round((received / done) * 100) / 100 : 0,
      produtos: Number(produtos?.total ?? 0),
      produtosItens: Number(produtos?.itens ?? 0),
    },
    servicos: services,
    porDia: revenue,
    proximos: upcoming,
    despesasRecentes,
    estoqueBaixo,
  };
}

/**
 * Tira do dashboard tudo que e dinheiro.
 *
 * `/financial/summary` sempre exigiu ADMIN, mas o dashboard entregava
 * faturamento, despesas, resultado e ticket medio para qualquer sessao - entao
 * bastava a um STAFF abrir a pagina inicial para ver exatamente o que a tela de
 * Financeiro escondia dele. A regra de quem ve dinheiro passa a ser uma so.
 */
export function stripFinancials<T extends { cards: Record<string, unknown> }>(dashboard: T): T {
  const {
    faturamentoPrevisto: _a,
    recebido: _b,
    pendente: _c,
    despesas: _d,
    resultado: _e,
    ticketMedio: _f,
    produtos: _g,
    ...cards
  } = dashboard.cards;

  return {
    ...dashboard,
    cards,
    servicos: [],
    porDia: [],
    despesasRecentes: [],
  };
}

export async function getFinancialSummary(tenantId: string, period?: Partial<Period>) {
  const { from, to, start, end } = await resolveRange(tenantId, period);

  const [entradas, porMetodo, despesas, porCategoria, produtos] = await Promise.all([
    queryOne<{ total: number; quantidade: number }>(
      `SELECT COALESCE(sum(amount), 0)::float8 AS total, count(*)::int AS quantidade
         FROM payments
        WHERE tenant_id = $1 AND status = 'paid' AND paid_at >= $2 AND paid_at < $3`,
      [tenantId, start, end]
    ),
    query(
      `SELECT COALESCE(method::text, 'nao_informado') AS metodo,
              sum(amount)::float8 AS total, count(*)::int AS quantidade
         FROM payments
        WHERE tenant_id = $1 AND status = 'paid' AND paid_at >= $2 AND paid_at < $3
        GROUP BY metodo ORDER BY total DESC`,
      [tenantId, start, end]
    ),
    queryOne<{ total: number }>(
      `SELECT COALESCE(sum(amount), 0)::float8 AS total FROM expenses
        WHERE tenant_id = $1 AND date >= $2::date AND date <= $3::date`,
      [tenantId, from, to]
    ),
    query(
      `SELECT COALESCE(category, 'Outros') AS categoria, sum(amount)::float8 AS total
         FROM expenses
        WHERE tenant_id = $1 AND date >= $2::date AND date <= $3::date
        GROUP BY categoria ORDER BY total DESC`,
      [tenantId, from, to]
    ),
    query(
      `SELECT produto, sum(quantidade)::int AS quantidade, sum(total)::float8 AS total,
              sum(avulso)::int AS avulsos
         FROM (
           SELECT ap.product_name AS produto, ap.quantity AS quantidade, ap.total, 0 AS avulso
             FROM appointment_products ap
             JOIN appointments a ON a.id = ap.appointment_id
            WHERE ap.tenant_id = $1 AND a.starts_at >= $2 AND a.starts_at < $3
              AND a.status IN ('confirmed','completed')
           UNION ALL
           SELECT si.product_name AS produto, si.quantity AS quantidade, si.total,
                  si.quantity AS avulso
             FROM product_sale_items si
             JOIN product_sales s ON s.id = si.sale_id
            WHERE si.tenant_id = $1 AND s.created_at >= $2 AND s.created_at < $3
              AND s.cancelled_at IS NULL
         ) vendidos
        GROUP BY produto ORDER BY total DESC`,
      // só os parâmetros que a query usa: o Postgres não infere tipo de placeholder solto
      [tenantId, start, end]
    ),
  ]);

  const entrada = Number(entradas?.total ?? 0);
  const saida = Number(despesas?.total ?? 0);

  return {
    period: { from, to },
    entradas: entrada,
    despesas: saida,
    resultado: Math.round((entrada - saida) * 100) / 100,
    pagamentosPorMetodo: porMetodo,
    despesasPorCategoria: porCategoria,
    produtosVendidos: produtos,
    quantidadePagamentos: entradas?.quantidade ?? 0,
  };
}
