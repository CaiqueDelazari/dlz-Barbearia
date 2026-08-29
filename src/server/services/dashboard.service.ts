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

  const [entradas, porMetodo, despesas, porCategoria, produtos, estornos] = await Promise.all([
    queryOne<{ total: number; quantidade: number }>(
      // `status IN ('paid','refunded')`: um pagamento estornado por inteiro vira
      // 'refunded', e some daqui se so olharmos 'paid' -- o dinheiro sumiria do
      // periodo em que de fato entrou, e o mes fechado mudaria sozinho depois.
      // Entradas continua sendo o bruto que entrou; o estorno sai na linha dele.
      `SELECT COALESCE(sum(amount), 0)::float8 AS total, count(*)::int AS quantidade
         FROM payments
        WHERE tenant_id = $1 AND status IN ('paid','refunded')
          AND paid_at >= $2 AND paid_at < $3`,
      [tenantId, start, end]
    ),
    query(
      `SELECT COALESCE(method::text, 'nao_informado') AS metodo,
              sum(amount)::float8 AS total, count(*)::int AS quantidade
         FROM payments
        WHERE tenant_id = $1 AND status IN ('paid','refunded')
          AND paid_at >= $2 AND paid_at < $3
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
    // Conta por `refunded_at`, nao por `paid_at`: a devolucao e' um fato do dia
    // em que aconteceu. Descontar do mes do pagamento original mudaria um mes ja
    // fechado -- o dono olharia de novo um numero que ele ja tinha conferido.
    queryOne<{ total: number; quantidade: number }>(
      `SELECT COALESCE(sum(refunded_amount), 0)::float8 AS total, count(*)::int AS quantidade
         FROM payments
        WHERE tenant_id = $1 AND refunded_amount > 0
          AND refunded_at >= $2 AND refunded_at < $3`,
      [tenantId, start, end]
    ),
  ]);

  const entrada = Number(entradas?.total ?? 0);
  const saida = Number(despesas?.total ?? 0);
  const estornado = Number(estornos?.total ?? 0);

  return {
    period: { from, to },
    entradas: entrada,
    despesas: saida,
    estornos: estornado,
    resultado: Math.round((entrada - saida - estornado) * 100) / 100,
    pagamentosPorMetodo: porMetodo,
    despesasPorCategoria: porCategoria,
    produtosVendidos: produtos,
    quantidadePagamentos: entradas?.quantidade ?? 0,
    quantidadeEstornos: estornos?.quantidade ?? 0,
  };
}

const centavos = (v: number) => Math.round(v * 100) / 100;

/**
 * Quanto cada profissional gerou no periodo e quanto tem a receber.
 *
 * Tres decisoes que mudam o numero, escritas aqui porque quem le a tela precisa
 * saber qual conta esta vendo:
 *
 * 1. **So atendimento `completed`.** Comissao se paga por servico prestado, nao
 *    por horario marcado. Um `confirmed` no futuro entraria como trabalho feito
 *    e o dono pagaria adiantado por corte que ainda nao aconteceu.
 * 2. **A base e o servico, nao o produto.** O percentual do profissional e um
 *    campo so, e aplicar o mesmo numero ao xampu que ele vendeu seria chute:
 *    margem de produto e margem de servico nao se parecem. Os produtos vendidos
 *    no atendimento dele vao no relatorio como informacao, fora da base -- se um
 *    dia houver comissao de produto, ela precisa do seu proprio percentual.
 * 3. **Conta pela data do atendimento** (`starts_at`), igual a "servicos
 *    realizados". O profissional ganha quando faz, nao quando o cliente paga.
 *
 * Por isso `naoRecebido` existe: e a fatia da base cujo atendimento ainda nao
 * esta pago. O dono precisa ver essa coluna antes de pagar a comissao, senao
 * paga do proprio bolso por dinheiro que nao entrou. Somar as duas coisas numa
 * linha so esconderia exatamente a pergunta que ele esta fazendo.
 *
 * Profissional inativo aparece se trabalhou no periodo -- quem saiu no dia 10
 * ainda tem a receber pelos dez primeiros dias.
 */
export async function getCommissionReport(tenantId: string, period?: Partial<Period>) {
  const { from, to, start, end } = await resolveRange(tenantId, period);

  type Linha = {
    id: string;
    name: string;
    active: boolean;
    percentual: number;
    atendimentos: number;
    servicos: number;
    base: number;
    naoRecebido: number;
  };

  // Servicos e produtos vem em consultas separadas de proposito: juntar as duas
  // tabelas ao mesmo `appointments` multiplica as linhas (tres servicos e dois
  // produtos viram seis), e a soma sairia inflada sem dar erro nenhum.
  const [linhas, produtosPorProfissional] = await Promise.all([
    query<Linha>(
      `SELECT p.id, p.name, p.active,
              p.commission_percent::float8                       AS percentual,
              count(DISTINCT a.id)::int                          AS atendimentos,
              count(s.id)::int                                   AS servicos,
              COALESCE(sum(s.price), 0)::float8                  AS base,
              COALESCE(sum(s.price) FILTER (
                WHERE a.payment_status <> 'paid'), 0)::float8    AS "naoRecebido"
         FROM professionals p
         LEFT JOIN appointments a
                ON a.professional_id = p.id
               AND a.tenant_id = p.tenant_id
               AND a.status = 'completed'
               AND a.starts_at >= $2 AND a.starts_at < $3
         LEFT JOIN appointment_services s ON s.appointment_id = a.id
        WHERE p.tenant_id = $1
        GROUP BY p.id, p.name, p.active, p.commission_percent
       HAVING p.active OR count(s.id) > 0
        ORDER BY base DESC, p.name`,
      [tenantId, start, end]
    ),
    query<{ professional_id: string; total: number; itens: number }>(
      `SELECT a.professional_id,
              COALESCE(sum(ap.total), 0)::float8   AS total,
              COALESCE(sum(ap.quantity), 0)::int   AS itens
         FROM appointment_products ap
         JOIN appointments a ON a.id = ap.appointment_id
        WHERE ap.tenant_id = $1 AND a.status = 'completed'
          AND a.starts_at >= $2 AND a.starts_at < $3
          AND a.professional_id IS NOT NULL
        GROUP BY a.professional_id`,
      [tenantId, start, end]
    ),
  ]);

  const produtoDe = new Map(
    produtosPorProfissional.map((r) => [r.professional_id, r])
  );

  const itens = linhas.map((l) => {
    const base = centavos(Number(l.base));
    const naoRecebido = centavos(Number(l.naoRecebido));
    const percentual = Number(l.percentual);
    const produto = produtoDe.get(l.id);
    return {
      id: l.id,
      nome: l.name,
      ativo: l.active,
      percentual,
      atendimentos: l.atendimentos,
      servicos: l.servicos,
      base,
      comissao: centavos((base * percentual) / 100),
      naoRecebido,
      comissaoNaoRecebida: centavos((naoRecebido * percentual) / 100),
      produtosValor: centavos(Number(produto?.total ?? 0)),
      produtosItens: Number(produto?.itens ?? 0),
    };
  });

  const somar = (campo: 'base' | 'comissao' | 'naoRecebido' | 'comissaoNaoRecebida') =>
    centavos(itens.reduce((t, i) => t + i[campo], 0));

  return {
    period: { from, to },
    itens,
    totais: {
      base: somar('base'),
      comissao: somar('comissao'),
      naoRecebido: somar('naoRecebido'),
      comissaoNaoRecebida: somar('comissaoNaoRecebida'),
      atendimentos: itens.reduce((t, i) => t + i.atendimentos, 0),
    },
    /** Quem trabalhou no periodo mas esta com 0% -- provavelmente falta configurar. */
    semPercentual: itens.filter((i) => i.percentual === 0 && i.base > 0).map((i) => i.nome),
  };
}
