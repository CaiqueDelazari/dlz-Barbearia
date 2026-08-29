'use client';

import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { Loader2, Plus, Trash2, TrendingDown, TrendingUp, Wallet, X } from 'lucide-react';
import { api, ApiClientError, money } from '@/lib/api-client';
import { ExpenseDialog } from '@/components/admin/ExpenseDialog';
import { formatDateBR } from '@/lib/datetime';

type Summary = {
  period: { from: string; to: string };
  entradas: number;
  despesas: number;
  estornos: number;
  quantidadeEstornos: number;
  resultado: number;
  pagamentosPorMetodo: { metodo: string; total: number; quantidade: number }[];
  despesasPorCategoria: { categoria: string; total: number }[];
  produtosVendidos: { produto: string; quantidade: number; total: number }[];
};

type Expense = {
  id: string;
  description: string;
  category: string | null;
  amount: number;
  date: string;
  paymentMethod: string | null;
};

type Commissions = {
  itens: {
    id: string;
    nome: string;
    ativo: boolean;
    percentual: number;
    atendimentos: number;
    servicos: number;
    base: number;
    comissao: number;
    naoRecebido: number;
    comissaoNaoRecebida: number;
    produtosValor: number;
    produtosItens: number;
  }[];
  totais: {
    base: number;
    comissao: number;
    naoRecebido: number;
    comissaoNaoRecebida: number;
    atendimentos: number;
  };
  semPercentual: string[];
};

const METHOD_LABEL: Record<string, string> = {
  pix: 'Pix',
  card: 'Cartão',
  cash: 'Dinheiro',
  transfer: 'Transferência',
  other: 'Outro',
  nao_informado: 'Não informado',
};

export default function FinanceiroPage() {
  const [range, setRange] = useState<'today' | 'week' | 'month'>('month');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [comissoes, setComissoes] = useState<Commissions | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.get<Summary>(`/financial/summary?range=${range}`);
      setSummary(result);
      const list = await api.get<{ expenses: Expense[] }>(
        `/expenses?from=${result.period.from}&to=${result.period.to}`
      );
      setExpenses(list.expenses);
      // Separado do resto: se a comissão falhar, o Financeiro ainda abre. O
      // dono precisa do caixa do dia mesmo quando um relatório novo quebra.
      try {
        setComissoes(await api.get<Commissions>(`/financial/commissions?range=${range}`));
      } catch {
        setComissoes(null);
      }
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Falha ao carregar');
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    load();
  }, [load]);

  async function removeExpense(id: string) {
    if (!confirm('Remover esta despesa?')) return;
    await api.delete(`/expenses/${id}`);
    toast.success('Despesa removida');
    load();
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-100">Financeiro</h1>
          <p className="text-sm text-ink-400">Entradas, despesas e resultado</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-1 rounded-xl border border-ink-800 bg-ink-900 p-1">
            {(['today', 'week', 'month'] as const).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRange(r)}
                className={clsx(
                  'rounded-lg px-3 py-1.5 text-sm',
                  range === r ? 'bg-ink-800 font-semibold text-ink-100' : 'text-ink-400 hover:text-ink-100'
                )}
              >
                {r === 'today' ? 'Hoje' : r === 'week' ? 'Semana' : 'Mês'}
              </button>
            ))}
          </div>
          <button type="button" onClick={() => setCreating(true)} className="btn-primary">
            <Plus size={16} /> Despesa
          </button>
        </div>
      </header>

      {loading && !summary ? (
        <div className="flex justify-center py-16 text-ink-500">
          <Loader2 className="animate-spin" />
        </div>
      ) : (
        summary && (
          <>
            <section className="grid gap-3 sm:grid-cols-3">
              <article className="card p-4">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs uppercase tracking-wide text-ink-500">Entradas</span>
                  <TrendingUp size={16} className="text-brand-500" />
                </div>
                <p className="tnum text-2xl font-light text-ink-100">{money(summary.entradas)}</p>
                {summary.estornos > 0 && (
                  <p className="tnum mt-1 text-xs text-state-warn">
                    −{money(summary.estornos)} estornado
                    <span className="ml-1 text-ink-500">({summary.quantidadeEstornos})</span>
                  </p>
                )}
              </article>
              <article className="card p-4">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs uppercase tracking-wide text-ink-500">Despesas</span>
                  <TrendingDown size={16} className="text-state-bad" />
                </div>
                <p className="tnum text-2xl font-light text-ink-100">{money(summary.despesas)}</p>
              </article>
              <article className="card p-4">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs uppercase tracking-wide text-ink-500">Resultado</span>
                  <Wallet size={16} className={summary.resultado >= 0 ? 'text-brand-500' : 'text-state-bad'} />
                </div>
                <p
                  className={clsx(
                    'text-2xl font-bold',
                    summary.resultado >= 0 ? 'text-brand-500' : 'text-state-bad'
                  )}
                >
                  {money(summary.resultado)}
                </p>
              </article>
            </section>

            <div className="grid gap-4 lg:grid-cols-2">
              <section className="card p-5">
                <h2 className="mb-3 text-sm font-semibold text-ink-100">Recebimentos por forma</h2>
                {summary.pagamentosPorMetodo.length ? (
                  <ul className="space-y-2 text-sm">
                    {summary.pagamentosPorMetodo.map((row) => (
                      <li key={row.metodo} className="flex justify-between">
                        <span className="text-ink-300">
                          {METHOD_LABEL[row.metodo] ?? row.metodo}
                          <span className="ml-1.5 text-xs text-ink-500">({row.quantidade})</span>
                        </span>
                        <span className="tnum text-ink-100">{money(row.total)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="py-4 text-center text-sm text-ink-500">Nenhum pagamento no período.</p>
                )}
              </section>

              <section className="card p-5">
                <h2 className="mb-3 text-sm font-semibold text-ink-100">Despesas por categoria</h2>
                {summary.despesasPorCategoria.length ? (
                  <ul className="space-y-2 text-sm">
                    {summary.despesasPorCategoria.map((row) => (
                      <li key={row.categoria} className="flex justify-between">
                        <span className="text-ink-300">{row.categoria}</span>
                        <span className="tnum text-ink-100">{money(row.total)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="py-4 text-center text-sm text-ink-500">Nenhuma despesa no período.</p>
                )}
              </section>
            </div>

            {summary.produtosVendidos?.length > 0 && (
              <section className="card p-5">
                <h2 className="mb-3 text-sm text-ink-100">Produtos vendidos</h2>
                <ul className="space-y-2 text-sm">
                  {summary.produtosVendidos.map((row) => (
                    <li key={row.produto} className="flex justify-between">
                      <span className="text-ink-300">
                        {row.produto}
                        <span className="tnum ml-1.5 text-xs text-ink-500">({row.quantidade})</span>
                      </span>
                      <span className="tnum text-ink-100">{money(row.total)}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-xs leading-relaxed text-ink-500">
                  O valor do produto entra no total do atendimento — aparece em Entradas quando o
                  cliente paga.
                </p>
              </section>
            )}

            {comissoes && comissoes.itens.length > 0 && (
              <section className="card">
                <div className="border-b border-ink-800 px-5 py-4">
                  <h2 className="text-sm font-semibold text-ink-100">Comissões</h2>
                  <p className="mt-0.5 text-xs text-ink-500">
                    Sobre serviços realizados no período. Produto não entra na base.
                  </p>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] text-sm">
                    <thead>
                      <tr className="border-b border-ink-800 text-left text-xs uppercase tracking-wide text-ink-500">
                        <th className="px-5 py-2.5 font-medium">Profissional</th>
                        <th className="px-3 py-2.5 text-right font-medium">Atend.</th>
                        <th className="px-3 py-2.5 text-right font-medium">Serviços</th>
                        <th className="px-3 py-2.5 text-right font-medium">%</th>
                        <th className="px-5 py-2.5 text-right font-medium">A receber</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-ink-800">
                      {comissoes.itens.map((p) => (
                        <tr key={p.id}>
                          <td className="px-5 py-3">
                            <span className="block text-ink-100">
                              {p.nome}
                              {!p.ativo && (
                                <span className="ml-1.5 text-xs text-ink-500">(inativo)</span>
                              )}
                            </span>
                            {p.produtosItens > 0 && (
                              <span className="block text-xs text-ink-500">
                                vendeu {money(p.produtosValor)} em produto ({p.produtosItens})
                              </span>
                            )}
                          </td>
                          <td className="tnum px-3 py-3 text-right text-ink-300">{p.atendimentos}</td>
                          <td className="tnum px-3 py-3 text-right text-ink-300">{money(p.base)}</td>
                          <td className="tnum px-3 py-3 text-right text-ink-300">
                            {p.percentual === 0 && p.base > 0 ? (
                              <span className="text-state-warn">0%</span>
                            ) : (
                              `${p.percentual}%`
                            )}
                          </td>
                          <td className="px-5 py-3 text-right">
                            <span className="tnum block text-ink-100">{money(p.comissao)}</span>
                            {p.comissaoNaoRecebida > 0 && (
                              <span className="tnum block text-xs text-state-warn">
                                {money(p.comissaoNaoRecebida)} não recebido
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-ink-800 font-semibold">
                        <td className="px-5 py-3 text-ink-300">Total</td>
                        <td className="tnum px-3 py-3 text-right text-ink-300">
                          {comissoes.totais.atendimentos}
                        </td>
                        <td className="tnum px-3 py-3 text-right text-ink-300">
                          {money(comissoes.totais.base)}
                        </td>
                        <td />
                        <td className="tnum px-5 py-3 text-right text-ink-100">
                          {money(comissoes.totais.comissao)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>

                <div className="space-y-2 border-t border-ink-800 px-5 py-4 text-xs leading-relaxed text-ink-500">
                  {comissoes.totais.comissaoNaoRecebida > 0 && (
                    <p className="text-state-warn">
                      {money(comissoes.totais.comissaoNaoRecebida)} do total é de atendimento
                      ainda não pago — confira antes de acertar.
                    </p>
                  )}
                  {comissoes.semPercentual.length > 0 && (
                    <p>
                      Sem percentual configurado: {comissoes.semPercentual.join(', ')}. Ajuste em
                      Profissionais.
                    </p>
                  )}
                  <p>
                    Conta pela data do atendimento e só o que está concluído — quem marcou
                    horário mas ainda não foi atendido não entra.
                  </p>
                </div>
              </section>
            )}

            <section className="card">
              <h2 className="border-b border-ink-800 px-5 py-4 text-sm text-ink-100">
                Despesas lançadas
              </h2>
              {expenses.length ? (
                <ul className="divide-y divide-ink-800">
                  {expenses.map((expense) => (
                    <li key={expense.id} className="flex items-center gap-3 px-5 py-3">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-ink-100">{expense.description}</span>
                        <span className="block text-xs text-ink-500">
                          {formatDateBR(expense.date)}
                          {expense.category ? ` · ${expense.category}` : ''}
                        </span>
                      </span>
                      <span className="tnum text-sm text-ink-200">{money(expense.amount)}</span>
                      <button
                        type="button"
                        onClick={() => removeExpense(expense.id)}
                        className="rounded-lg p-2 text-ink-500 hover:bg-ink-800 hover:text-state-bad"
                      >
                        <Trash2 size={15} />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-5 py-8 text-center text-sm text-ink-500">Nenhuma despesa lançada.</p>
              )}
            </section>
          </>
        )
      )}

      {creating && <ExpenseDialog onClose={() => setCreating(false)} onSaved={load} />}
    </div>
  );
}
