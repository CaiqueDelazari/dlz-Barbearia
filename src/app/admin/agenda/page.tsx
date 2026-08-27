'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import {
  CalendarOff, ChevronLeft, ChevronRight, Loader2, Plus, RotateCcw, Sun,
} from 'lucide-react';
import { api, ApiClientError, money } from '@/lib/api-client';
import { WEEKDAY_LABELS, addDays, formatDateLong, todayInTz, weekdayOfDate } from '@/lib/datetime';
import { formatTimeBR } from '@/lib/format';
import { NewAppointmentDialog } from '@/components/admin/NewAppointmentDialog';
import { CloseAgendaDialog } from '@/components/admin/CloseAgendaDialog';
import { AppointmentDetails, STATUS_META, type AdminAppointment } from '@/components/admin/AppointmentDetails';

type Block = {
  id: string;
  professionalId: string | null;
  professionalName: string | null;
  startsAt: string;
  endsAt: string;
  reason: string | null;
  kind: 'block' | 'holiday' | 'vacation' | 'dayoff';
};

type WeeklyBreak = {
  id: string;
  professionalId: string | null;
  professionalName: string | null;
  weekday: number;
  startsAt: string;
  endsAt: string;
  label: string | null;
};

type Hour = { professionalId: string | null; weekday: number; opensAt: string; closesAt: string };

type AgendaResponse = {
  view: string;
  from: string;
  to: string;
  timezone: string;
  items: AdminAppointment[];
  blocks: Block[];
  weeklyBreaks: WeeklyBreak[];
  hours: Hour[];
};

const KIND_LABEL: Record<Block['kind'], string> = {
  block: 'Fechado',
  dayoff: 'Folga',
  holiday: 'Feriado',
  vacation: 'Férias',
};

const trim = (t: string) => t.slice(0, 5);

/** Data local (YYYY-MM-DD) de um instante, no fuso da empresa. */
const localDate = (iso: string, tz: string) =>
  new Date(iso).toLocaleDateString('sv-SE', { timeZone: tz });

/**
 * Como o bloqueio aparece dentro de UM dia. Férias de 10 a 20 viram
 * "Dia inteiro" em cada dia, não um intervalo estranho de 240 horas.
 */
function faixaNoDia(block: Block, dia: string, tz: string): string {
  const inicioNoDia = localDate(block.startsAt, tz) < dia ? '00:00' : formatTimeBR(block.startsAt, tz);
  const fimReal = new Date(new Date(block.endsAt).getTime() - 1).toISOString();
  const fimNoDia = localDate(fimReal, tz) > dia ? '24:00' : formatTimeBR(block.endsAt, tz);
  if (inicioNoDia === '00:00' && (fimNoDia === '24:00' || fimNoDia === '00:00')) return 'Dia inteiro';
  return `${inicioNoDia} – ${fimNoDia}`;
}

export default function AgendaPage() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [date, setDate] = useState(() => todayInTz(tz));
  const [view, setView] = useState<'day' | 'week'>('day');
  const [data, setData] = useState<AgendaResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [closing, setClosing] = useState(false);
  const [selected, setSelected] = useState<AdminAppointment | null>(null);

  const hoje = todayInTz(data?.timezone ?? tz);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get<AgendaResponse>(`/agenda?date=${date}&view=${view}`));
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Não foi possível carregar a agenda');
    } finally {
      setLoading(false);
    }
  }, [date, view]);

  useEffect(() => {
    load();
  }, [load]);

  const dias = useMemo(() => {
    if (!data) return [];
    const total = view === 'week' ? 7 : 1;
    return Array.from({ length: total }, (_, i) => addDays(data.from, i));
  }, [data, view]);

  async function reabrir(block: Block) {
    if (!confirm('Reabrir a agenda neste período?')) return;
    try {
      await api.delete(`/blocks/${block.id}`);
      toast.success('Agenda reaberta');
      load();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Não foi possível reabrir');
    }
  }

  async function removerPausa(pausa: WeeklyBreak) {
    if (!confirm(`Remover a pausa fixa de toda ${WEEKDAY_LABELS[pausa.weekday].toLowerCase()}?`)) return;
    try {
      await api.delete(`/blocks/${pausa.id}?type=weekly`);
      toast.success('Pausa fixa removida');
      load();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Não foi possível remover');
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="display text-2xl tracking-wide text-ink-100">Agenda</h1>
          <p className="text-sm capitalize text-ink-400">{formatDateLong(date)}</p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => setClosing(true)} className="btn-ghost">
            <CalendarOff size={15} strokeWidth={1.5} /> Fechar agenda
          </button>
          <button type="button" onClick={() => setCreating(true)} className="btn-primary">
            <Plus size={16} strokeWidth={1.5} /> Novo agendamento
          </button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-xl border border-ink-800 p-1">
          <button
            type="button"
            onClick={() => setDate(addDays(date, view === 'week' ? -7 : -1))}
            className="rounded-lg p-2 text-ink-400 transition-colors hover:text-ink-100"
            aria-label="Anterior"
          >
            <ChevronLeft size={16} strokeWidth={1.5} />
          </button>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="tnum bg-transparent px-2 text-sm text-ink-100 outline-none"
          />
          <button
            type="button"
            onClick={() => setDate(addDays(date, view === 'week' ? 7 : 1))}
            className="rounded-lg p-2 text-ink-400 transition-colors hover:text-ink-100"
            aria-label="Próximo"
          >
            <ChevronRight size={16} strokeWidth={1.5} />
          </button>
        </div>

        <button type="button" onClick={() => setDate(hoje)} className="btn-ghost py-2">
          Hoje
        </button>

        <div className="flex gap-1 rounded-xl border border-ink-800 p-1">
          {(['day', 'week'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={clsx(
                'rounded-lg px-3 py-1.5 text-sm transition-colors',
                view === v ? 'bg-ink-800 text-ink-100' : 'text-ink-400 hover:text-ink-100'
              )}
            >
              {v === 'day' ? 'Dia' : 'Semana'}
            </button>
          ))}
        </div>
      </div>

      {loading && !data ? (
        <div className="flex justify-center py-20 text-ink-500">
          <Loader2 className="animate-spin" strokeWidth={1.5} />
        </div>
      ) : (
        data && (
          <div className="space-y-8">
            {dias.map((dia) => {
              const weekday = weekdayOfDate(dia);
              const expediente = data.hours.filter((h) => h.weekday === weekday && !h.professionalId);
              const agendamentos = data.items.filter(
                (a) => localDate(a.starts_at, data.timezone) === dia
              );
              const bloqueios = data.blocks.filter(
                (b) =>
                  localDate(b.startsAt, data.timezone) <= dia &&
                  localDate(new Date(new Date(b.endsAt).getTime() - 1).toISOString(), data.timezone) >= dia
              );
              const pausas = data.weeklyBreaks.filter((p) => p.weekday === weekday);
              const fechadoODiaTodo =
                !expediente.length ||
                bloqueios.some((b) => faixaNoDia(b, dia, data.timezone) === 'Dia inteiro' && !b.professionalId);

              return (
                <section key={dia}>
                  <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2 border-b border-ink-800 pb-2">
                    <h2 className="text-sm capitalize text-ink-200">
                      {view === 'week' ? formatDateLong(dia) : 'No dia'}
                    </h2>
                    <span className="eyebrow">
                      {expediente.length
                        ? expediente.map((h) => `${trim(h.opensAt)}–${trim(h.closesAt)}`).join(' · ')
                        : 'Sem expediente'}
                    </span>
                  </div>

                  {fechadoODiaTodo && (
                    <p className="mb-3 flex items-center gap-2 rounded-xl border border-ink-800 px-3 py-2.5 text-sm text-ink-300">
                      <CalendarOff size={15} strokeWidth={1.5} className="text-ink-500" />
                      {expediente.length ? 'Agenda fechada neste dia' : 'Dia sem expediente no horário de funcionamento'}
                    </p>
                  )}

                  {/* -------------------------------------------- bloqueios */}
                  {bloqueios.length > 0 && (
                    <ul className="mb-2 space-y-2">
                      {bloqueios.map((b) => (
                        <li
                          key={b.id}
                          className="flex items-center gap-4 rounded-xl border border-dashed border-ink-700 px-4 py-3"
                        >
                          <span className="tnum w-24 shrink-0 text-xs text-ink-400">
                            {faixaNoDia(b, dia, data.timezone)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm text-ink-200">
                              {KIND_LABEL[b.kind]}
                              {b.reason ? ` · ${b.reason}` : ''}
                            </span>
                            <span className="block text-xs text-ink-500">
                              {b.professionalName ? `Só ${b.professionalName}` : 'Todos os profissionais'}
                            </span>
                          </span>
                          <button
                            type="button"
                            onClick={() => reabrir(b)}
                            className="shrink-0 rounded-lg p-2 text-ink-500 transition-colors hover:text-ink-100"
                            title="Reabrir a agenda neste período"
                          >
                            <RotateCcw size={15} strokeWidth={1.5} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}

                  {/* ----------------------------------------- pausas fixas */}
                  {pausas.length > 0 && (
                    <ul className="mb-2 space-y-1">
                      {pausas.map((p) => (
                        <li key={p.id} className="flex items-center gap-4 px-4 py-1.5">
                          <span className="tnum w-24 shrink-0 text-xs text-ink-500">
                            {trim(p.startsAt)} – {trim(p.endsAt)}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-xs text-ink-500">
                            {p.label ?? 'Pausa'} · toda {WEEKDAY_LABELS[p.weekday].toLowerCase()}
                            {p.professionalName ? ` · só ${p.professionalName}` : ''}
                          </span>
                          <button
                            type="button"
                            onClick={() => removerPausa(p)}
                            className="shrink-0 rounded-lg p-1.5 text-ink-600 transition-colors hover:text-ink-300"
                            title="Remover pausa fixa"
                          >
                            <RotateCcw size={13} strokeWidth={1.5} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}

                  {/* ------------------------------------------ atendimentos */}
                  {agendamentos.length > 0 ? (
                    <ul className="space-y-2">
                      {agendamentos.map((appointment) => {
                        const status = STATUS_META[appointment.status] ?? STATUS_META.pending;
                        const restante = Math.max(0, appointment.total_amount - appointment.paid_amount);
                        return (
                          <li key={appointment.id}>
                            <button
                              type="button"
                              onClick={() => setSelected(appointment)}
                              className="card flex w-full items-center gap-4 p-4 text-left transition-colors hover:border-ink-700"
                            >
                              <span className="w-16 shrink-0">
                                <span className="tnum block text-[15px] text-ink-100">
                                  {formatTimeBR(appointment.starts_at, data.timezone)}
                                </span>
                                <span className="tnum block text-[11px] text-ink-500">
                                  {formatTimeBR(appointment.ends_at, data.timezone)}
                                </span>
                              </span>

                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[15px] text-ink-100">
                                  {appointment.client_name}
                                </span>
                                <span className="block truncate text-xs text-ink-500">
                                  {appointment.services.map((s) => s.name).join(' + ')}
                                  {appointment.professional_name ? ` · ${appointment.professional_name}` : ''}
                                </span>
                              </span>

                              <span className="shrink-0 text-right">
                                <span className={clsx('badge mb-1', status.className)}>{status.label}</span>
                                <span className="tnum block text-xs text-ink-400">
                                  {money(appointment.total_amount)}
                                  {restante > 0 && (
                                    <span className="ml-1 text-state-warn">falta {money(restante)}</span>
                                  )}
                                </span>
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    !fechadoODiaTodo && (
                      <p className="flex items-center gap-2 py-6 text-sm text-ink-500">
                        <Sun size={15} strokeWidth={1.5} /> Nenhum atendimento marcado.
                      </p>
                    )
                  )}
                </section>
              );
            })}
          </div>
        )
      )}

      {creating && (
        <NewAppointmentDialog date={date} onClose={() => setCreating(false)} onCreated={load} />
      )}
      {closing && data && (
        <CloseAgendaDialog
          date={date}
          hours={data.hours}
          today={hoje}
          onClose={() => setClosing(false)}
          onDone={load}
        />
      )}
      {selected && (
        <AppointmentDetails appointment={selected} onClose={() => setSelected(null)} onChanged={load} />
      )}
    </div>
  );
}
