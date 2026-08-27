'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import type { LucideIcon } from 'lucide-react';
import {
  AlertTriangle, CalendarClock, CheckCircle2, Loader2, Package, PackageX, Plus,
  TrendingDown, TrendingUp, Wallet,
} from 'lucide-react';
import { api, money } from '@/lib/api-client';
import { formatDateBR } from '@/lib/datetime';
import { ExpenseDialog } from '@/components/admin/ExpenseDialog';

type Dashboard = {
  period: { from: string; to: string };
  cards: {
    agendamentosHoje: number;
    agendamentosPeriodo: number;
    concluidos: number;
    cancelados: number;
    faltas: number;
    faturamentoPrevisto: number;
    recebido: number;
    pendente: number;
    despesas: number;
    resultado: number;
    ticketMedio: number;
    produtos: number;
    produtosItens: number;
  };
  servicos: { name: string; quantidade: number; total: number }[];
  porDia: { dia: string; recebido: number; previsto: number; atendimentos: number }[];
  proximos: {
    id: string;
    starts_at: string;
    status: string;
    client_name: string;
    client_phone: string;
    professional_name: string | null;
    services: string;
  }[];
  despesasRecentes: { id: string; description: string; category: string | null; amount: number; date: string }[];
  estoqueBaixo: { id: string; name: string; stockQuantity: number; minStock: number }[];
};

const RANGES = [
  { key: 'today', label: 'Hoje' },
  { key: 'week', label: 'Semana' },
  { key: 'month', label: 'Mês' },
] as const;

export default function DashboardPage() {
  const [range, setRange] = useState<(typeof RANGES)[number]['key']>('today');
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [lancando, setLancando] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api
      .get<Dashboard>(`/dashboard?range=${range}`)
      .then(setData)
      .finally(() => setLoading(false));
  }, [range]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="display text-2xl tracking-wide text-ink-100">Dashboard</h1>
          <p className="text-sm text-ink-400">Como o negócio está indo</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-1 rounded-xl border border-ink-800 p-1">
            {RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                onClick={() => setRange(r.key)}
                className={clsx(
                  'rounded-lg px-3 py-1.5 text-sm transition-colors',
                  range === r.key ? 'bg-ink-800 text-ink-100' : 'text-ink-400 hover:text-ink-100'
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
          <button type="button" onClick={() => setLancando(true)} className="btn-primary">
            <Plus size={16} strokeWidth={1.5} /> Despesa
          </button>
        </div>
      </header>

      {loading && !data ? (
        <div className="flex justify-center py-20 text-ink-500">
          <Loader2 className="animate-spin" strokeWidth={1.5} />
        </div>
      ) : (
        data && (
          <>
            <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Card
                icon={CalendarClock}
                label="Agendamentos hoje"
                value={String(data.cards.agendamentosHoje)}
                hint={`${data.cards.agendamentosPeriodo} no período`}
              />
              <Card
                icon={Wallet}
                label="Recebido"
                value={money(data.cards.recebido)}
                hint={`${money(data.cards.pendente)} a receber`}
                tone="brand"
              />
              <Card
                icon={TrendingDown}
                label="Despesas"
                value={money(data.cards.despesas)}
                hint={`Ticket médio ${money(data.cards.ticketMedio)}`}
              />
              <Card
                icon={TrendingUp}
                label="Resultado"
                value={money(data.cards.resultado)}
                hint="Recebido − despesas"
                tone={data.cards.resultado >= 0 ? 'brand' : 'danger'}
              />
            </section>

            <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <MiniCard icon={CheckCircle2} label="Concluídos" value={String(data.cards.concluidos)} tone="ok" />
              <MiniCard icon={AlertTriangle} label="Cancelados" value={String(data.cards.cancelados)} tone="warn" />
              <MiniCard icon={AlertTriangle} label="Faltas" value={String(data.cards.faltas)} tone="bad" />
              <MiniCard
                icon={Package}
                label="Produtos vendidos"
                value={money(data.cards.produtos)}
                hint={`${data.cards.produtosItens} item(ns)`}
                tone="ok"
              />
            </section>

            <div className="grid gap-4 lg:grid-cols-2">
              <section className="card p-5">
                <h2 className="mb-4 text-sm text-ink-100">Próximos atendimentos</h2>
                {data.proximos.length ? (
                  <ul className="divide-y divide-ink-800">
                    {data.proximos.map((appointment) => (
                      <li key={appointment.id} className="flex items-center gap-3 py-3">
                        <span className="tnum w-14 shrink-0 text-sm text-brand-500">
                          {new Date(appointment.starts_at).toLocaleTimeString('pt-BR', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-ink-100">{appointment.client_name}</span>
                          <span className="block truncate text-xs text-ink-500">{appointment.services}</span>
                        </span>
                        <span className="shrink-0 text-xs text-ink-500">{appointment.professional_name}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="py-6 text-center text-sm text-ink-500">Nenhum horário marcado à frente.</p>
                )}
                <Link href="/admin/agenda" className="btn-ghost mt-3 w-full">
                  Abrir agenda
                </Link>
              </section>

              <section className="card p-5">
                <h2 className="mb-4 text-sm text-ink-100">Serviços realizados</h2>
                {data.servicos.length ? (
                  <ul className="space-y-3">
                    {data.servicos.map((service) => {
                      const max = Math.max(...data.servicos.map((s) => s.quantidade));
                      return (
                        <li key={service.name}>
                          <div className="mb-1.5 flex justify-between text-sm">
                            <span className="text-ink-200">{service.name}</span>
                            <span className="tnum text-ink-400">
                              {service.quantidade}× · {money(service.total)}
                            </span>
                          </div>
                          <div className="h-px bg-ink-800">
                            <div
                              className="h-px bg-brand-500"
                              style={{ width: `${(service.quantidade / max) * 100}%` }}
                            />
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="py-6 text-center text-sm text-ink-500">Sem atendimentos no período.</p>
                )}
              </section>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              {/* ------------------------------------------------ despesas */}
              <section className="card p-5">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <h2 className="text-sm text-ink-100">Despesas</h2>
                  <button
                    type="button"
                    onClick={() => setLancando(true)}
                    className="inline-flex items-center gap-1.5 text-xs text-brand-500 transition-colors hover:text-ink-100"
                  >
                    <Plus size={13} strokeWidth={1.5} /> Lançar
                  </button>
                </div>

                <p className="tnum mb-4 text-2xl font-light text-ink-100">{money(data.cards.despesas)}</p>

                {data.despesasRecentes.length ? (
                  <ul className="divide-y divide-ink-800">
                    {data.despesasRecentes.map((expense) => (
                      <li key={expense.id} className="flex items-center gap-3 py-2.5">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-ink-200">{expense.description}</span>
                          <span className="block text-xs text-ink-500">
                            {formatDateBR(expense.date)}
                            {expense.category ? ` · ${expense.category}` : ''}
                          </span>
                        </span>
                        <span className="tnum shrink-0 text-sm text-ink-300">{money(expense.amount)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="py-4 text-sm text-ink-500">
                    Nada lançado ainda. Aluguel, produtos, energia — tudo que sai entra aqui.
                  </p>
                )}

                <Link href="/admin/financeiro" className="btn-ghost mt-3 w-full">
                  Ver financeiro
                </Link>
              </section>

              {/* -------------------------------------------------- estoque */}
              <section className="card p-5">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <h2 className="text-sm text-ink-100">Estoque</h2>
                  <Link
                    href="/admin/produtos"
                    className="text-xs text-brand-500 transition-colors hover:text-ink-100"
                  >
                    Ver produtos
                  </Link>
                </div>

                {data.estoqueBaixo.length ? (
                  <>
                    <p className="mb-3 flex items-center gap-2 text-sm text-state-warn">
                      <PackageX size={15} strokeWidth={1.5} />
                      {data.estoqueBaixo.length} produto(s) no limite ou zerados
                    </p>
                    <ul className="divide-y divide-ink-800">
                      {data.estoqueBaixo.map((product) => (
                        <li key={product.id} className="flex items-center justify-between gap-3 py-2.5">
                          <span className="min-w-0 truncate text-sm text-ink-200">{product.name}</span>
                          <span
                            className={clsx(
                              'tnum shrink-0 text-sm',
                              product.stockQuantity <= 0 ? 'text-state-bad' : 'text-state-warn'
                            )}
                          >
                            {product.stockQuantity} un.
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p className="flex items-center gap-2 py-4 text-sm text-ink-500">
                    <Package size={15} strokeWidth={1.5} /> Estoque em dia.
                  </p>
                )}
              </section>
            </div>
          </>
        )
      )}

      {lancando && <ExpenseDialog onClose={() => setLancando(false)} onSaved={load} />}
    </div>
  );
}

function Card({
  icon: Icon,
  label,
  value,
  hint,
  tone = 'default',
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'brand' | 'danger';
}) {
  return (
    <article className="card p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="eyebrow">{label}</span>
        <Icon
          size={15}
          strokeWidth={1.5}
          className={clsx(
            tone === 'brand' && 'text-brand-500',
            tone === 'danger' && 'text-state-bad',
            tone === 'default' && 'text-ink-500'
          )}
        />
      </div>
      <p className={clsx('tnum text-2xl font-light', tone === 'danger' ? 'text-state-bad' : 'text-ink-100')}>
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-ink-500">{hint}</p>}
    </article>
  );
}

function MiniCard({
  icon: Icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  hint?: string;
  tone: 'ok' | 'warn' | 'bad';
}) {
  const color = tone === 'ok' ? 'text-brand-500' : tone === 'warn' ? 'text-state-warn' : 'text-state-bad';
  return (
    <article className="card flex items-center gap-3 p-4">
      <Icon size={16} strokeWidth={1.5} className={color} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-ink-300">{label}</span>
        {hint && <span className="block text-xs text-ink-500">{hint}</span>}
      </span>
      <span className="tnum shrink-0 text-lg text-ink-100">{value}</span>
    </article>
  );
}
