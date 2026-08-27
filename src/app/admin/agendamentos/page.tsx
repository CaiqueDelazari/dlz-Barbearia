'use client';

import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { Loader2, Search } from 'lucide-react';
import { api, money } from '@/lib/api-client';
import { formatDateTimeBR } from '@/lib/format';
import { AppointmentDetails, STATUS_META, type AdminAppointment } from '@/components/admin/AppointmentDetails';

const STATUSES = [
  { value: '', label: 'Todos' },
  { value: 'pending', label: 'Aguardando' },
  { value: 'confirmed', label: 'Confirmados' },
  { value: 'completed', label: 'Concluídos' },
  { value: 'cancelled', label: 'Cancelados' },
  { value: 'no_show', label: 'Faltas' },
];

export default function AgendamentosPage() {
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [items, setItems] = useState<AdminAppointment[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<AdminAppointment | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ limit: '100' });
    if (status) params.set('status', status);
    if (search) params.set('search', search);
    if (from) params.set('from', new Date(`${from}T00:00:00`).toISOString());
    if (to) params.set('to', new Date(`${to}T23:59:59`).toISOString());

    try {
      const result = await api.get<{ items: AdminAppointment[]; total: number }>(`/appointments?${params}`);
      setItems(result.items);
      setTotal(result.total);
    } finally {
      setLoading(false);
    }
  }, [status, search, from, to]);

  useEffect(() => {
    const timer = setTimeout(load, search ? 350 : 0);
    return () => clearTimeout(timer);
  }, [load, search]);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold text-ink-100">Agendamentos</h1>
        <p className="text-sm text-ink-400">{total} registro(s)</p>
      </header>

      <div className="card space-y-3 p-4">
        <div className="relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-500" />
          <input
            className="input pl-9"
            placeholder="Buscar por cliente ou telefone"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="flex flex-wrap gap-2">
          {STATUSES.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => setStatus(s.value)}
              className={clsx(
                'rounded-lg border px-3 py-1.5 text-sm transition-colors',
                status === s.value
                  ? 'border-brand-500 bg-brand-500/10 text-ink-100'
                  : 'border-ink-700 bg-ink-850 text-ink-400 hover:text-ink-100'
              )}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label">De</label>
            <input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label className="label">Até</label>
            <input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-16 text-ink-500">
          <Loader2 className="animate-spin" />
        </div>
      ) : items.length === 0 ? (
        <p className="card p-10 text-center text-sm text-ink-500">Nenhum agendamento encontrado.</p>
      ) : (
        <ul className="space-y-2">
          {items.map((appointment) => {
            const meta = STATUS_META[appointment.status] ?? STATUS_META.pending;
            const restante = Math.max(0, appointment.total_amount - appointment.paid_amount);
            return (
              <li key={appointment.id}>
                <button
                  type="button"
                  onClick={() => setSelected(appointment)}
                  className="card flex w-full flex-wrap items-center gap-3 p-4 text-left hover:border-ink-700"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-ink-100">
                      {appointment.client_name}
                    </span>
                    <span className="block truncate text-xs text-ink-500">
                      {formatDateTimeBR(appointment.starts_at)} ·{' '}
                      {appointment.services.map((s) => s.name).join(' + ')}
                    </span>
                  </span>
                  <span className={clsx('badge', meta.className)}>{meta.label}</span>
                  <span className="text-right text-xs text-ink-400">
                    <span className="block text-sm text-ink-100">{money(appointment.total_amount)}</span>
                    {restante > 0 ? (
                      <span className="text-state-warn">falta {money(restante)}</span>
                    ) : (
                      <span className="text-brand-500">quitado</span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {selected && (
        <AppointmentDetails appointment={selected} onClose={() => setSelected(null)} onChanged={load} />
      )}
    </div>
  );
}
