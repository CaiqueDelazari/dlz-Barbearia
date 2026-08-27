'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api, money } from '@/lib/api-client';
import { formatDateBR } from '@/lib/datetime';

type Dashboard = {
  cards: {
    agendamentosPeriodo: number;
    concluidos: number;
    cancelados: number;
    faltas: number;
    recebido: number;
    pendente: number;
    despesas: number;
    resultado: number;
    ticketMedio: number;
  };
  servicos: { name: string; quantidade: number; total: number }[];
  porDia: { dia: string; recebido: number; previsto: number; atendimentos: number }[];
};

/** Relatorio por periodo personalizado - o mesmo dado do dashboard, aberto por dia. */
export default function RelatoriosPage() {
  const firstDay = new Date();
  firstDay.setDate(1);

  const [from, setFrom] = useState(firstDay.toISOString().slice(0, 10));
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get<Dashboard>(`/dashboard?range=custom&from=${from}&to=${to}`));
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    load();
  }, [load]);

  const maxDia = Math.max(1, ...(data?.porDia ?? []).map((d) => d.recebido));

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold text-ink-100">Relatórios</h1>
        <p className="text-sm text-ink-400">Escolha o período que quiser analisar</p>
      </header>

      <div className="card grid grid-cols-2 gap-3 p-4 sm:max-w-md">
        <div>
          <label className="label">De</label>
          <input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label className="label">Até</label>
          <input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>

      {loading && !data ? (
        <div className="flex justify-center py-16 text-ink-500">
          <Loader2 className="animate-spin" />
        </div>
      ) : (
        data && (
          <>
            <section className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <Stat label="Atendimentos" value={String(data.cards.agendamentosPeriodo)} />
              <Stat label="Concluídos" value={String(data.cards.concluidos)} />
              <Stat label="Faturamento" value={money(data.cards.recebido)} />
              <Stat label="Ticket médio" value={money(data.cards.ticketMedio)} />
              <Stat label="Resultado" value={money(data.cards.resultado)} />
            </section>

            <section className="card p-5">
              <h2 className="mb-4 text-sm font-semibold text-ink-100">Faturamento por dia</h2>
              {data.porDia.length ? (
                <ul className="space-y-2">
                  {data.porDia.map((row) => (
                    <li key={row.dia} className="flex items-center gap-3">
                      <span className="w-20 shrink-0 text-xs text-ink-500">{formatDateBR(row.dia)}</span>
                      <span className="h-2 flex-1 overflow-hidden rounded-full bg-ink-800">
                        <span
                          className="block h-full rounded-full bg-brand-500"
                          style={{ width: `${(row.recebido / maxDia) * 100}%` }}
                        />
                      </span>
                      <span className="w-24 shrink-0 text-right text-xs text-ink-300">{money(row.recebido)}</span>
                      <span className="w-8 shrink-0 text-right text-xs text-ink-500">{row.atendimentos}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="py-6 text-center text-sm text-ink-500">Sem movimento no período.</p>
              )}
            </section>

            <section className="card p-5">
              <h2 className="mb-4 text-sm font-semibold text-ink-100">Serviços realizados</h2>
              {data.servicos.length ? (
                <ul className="divide-y divide-ink-800 text-sm">
                  {data.servicos.map((service) => (
                    <li key={service.name} className="flex justify-between py-2.5">
                      <span className="text-ink-200">{service.name}</span>
                      <span className="text-ink-400">
                        {service.quantidade}× · <span className="text-ink-100">{money(service.total)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="py-6 text-center text-sm text-ink-500">Nenhum serviço no período.</p>
              )}
            </section>
          </>
        )
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <article className="card p-4">
      <p className="text-[11px] uppercase tracking-wide text-ink-500">{label}</p>
      <p className="mt-1 text-lg font-bold text-ink-100">{value}</p>
    </article>
  );
}
