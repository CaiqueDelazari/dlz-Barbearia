'use client';

import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { AlertCircle, CalendarDays, Check, Clock, Loader2, MapPin, Phone, Scissors, X } from 'lucide-react';
import { Calendar } from '@/components/Calendar';
import { api, ApiClientError, shortMoney } from '@/lib/api-client';
import { addDays, formatDateLong, todayInTz } from '@/lib/datetime';

type Appointment = {
  id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  payment_status: string;
  total_amount: number;
  paid_amount: number;
  duration_minutes: number;
  professional_id: string | null;
  professional_name: string | null;
  client_name: string;
  services: { id: string; name: string; price: number; durationMinutes: number }[];
  canChange: boolean;
};

type Booking = {
  bookingGroupId: string;
  tenant: { slug: string; name: string; phone: string | null; whatsapp: string | null; address: string | null; timezone: string };
  policy: { rescheduleNoticeMinutes: number; allowCancel: boolean };
  appointments: Appointment[];
};

const STATUS_LABEL: Record<string, { text: string; className: string }> = {
  pending: { text: 'Aguardando pagamento', className: 'bg-state-warn/10 text-state-warn' },
  confirmed: { text: 'Confirmado', className: 'bg-brand-500/10 text-brand-500' },
  completed: { text: 'Concluído', className: 'bg-state-ok/10 text-state-ok' },
  cancelled: { text: 'Cancelado', className: 'bg-state-bad/10 text-state-bad' },
  no_show: { text: 'Não compareceu', className: 'bg-state-bad/10 text-state-bad' },
  rescheduled: { text: 'Remarcado', className: 'text-ink-400' },
};

export function ManageBooking({ token }: { token: string }) {
  const [booking, setBooking] = useState<Booking | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [rescheduling, setRescheduling] = useState<Appointment | null>(null);
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [monthDays, setMonthDays] = useState<Record<string, boolean>>({});
  const [date, setDate] = useState<string | null>(null);
  const [slots, setSlots] = useState<{ time: string; startsAt: string; professionalId: string | null }[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setBooking(await api.get<Booking>(`/public/booking/${token}`));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Não foi possível carregar o agendamento');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  async function openReschedule(appointment: Appointment) {
    setRescheduling(appointment);
    setDate(null);
    setSlots([]);
    const current = new Date(appointment.starts_at).toISOString().slice(0, 7);
    setMonth(current);
    await loadMonth(current, appointment);
  }

  async function loadMonth(targetMonth: string, appointment = rescheduling) {
    if (!booking || !appointment) return;
    const services = appointment.services.map((s) => s.id).join(',');
    try {
      const result = await api.get<{ days: { date: string; available: boolean }[] }>(
        `/public/${booking.tenant.slug}/availability?month=${targetMonth}&services=${services}` +
          (appointment.professional_id ? `&professional=${appointment.professional_id}` : '')
      );
      setMonthDays(Object.fromEntries(result.days.map((d) => [d.date, d.available])));
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Falha ao carregar o calendário');
    }
  }

  async function loadDay(targetDate: string) {
    if (!booking || !rescheduling) return;
    const services = rescheduling.services.map((s) => s.id).join(',');
    setDate(targetDate);
    try {
      const result = await api.get<{ slots: typeof slots }>(
        `/public/${booking.tenant.slug}/availability?date=${targetDate}&services=${services}` +
          (rescheduling.professional_id ? `&professional=${rescheduling.professional_id}` : '')
      );
      setSlots(result.slots);
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Falha ao carregar horários');
    }
  }

  async function confirmReschedule(startsAt: string, professionalId: string | null) {
    if (!rescheduling) return;
    setBusy(true);
    try {
      await api.patch(`/public/booking/${token}`, {
        appointmentId: rescheduling.id,
        startsAt,
        professionalId,
      });
      toast.success('Horário remarcado');
      setRescheduling(null);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Não foi possível remarcar');
    } finally {
      setBusy(false);
    }
  }

  async function cancel(appointmentId: string) {
    if (!confirm('Deseja realmente cancelar este horário?')) return;
    setBusy(true);
    try {
      await api.delete(`/public/booking/${token}?appointmentId=${appointmentId}`);
      toast.success('Agendamento cancelado');
      await load();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Não foi possível cancelar');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center text-ink-400">
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  if (error || !booking) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-lg flex-col items-center justify-center gap-3 px-6 text-center">
        <AlertCircle size={36} className="text-state-bad" />
        <p className="text-ink-100">{error}</p>
        <p className="text-sm text-ink-400">
          Se o link expirou, entre em contato com a empresa para ver seu horário.
        </p>
      </div>
    );
  }

  const noticeHours = Math.round(booking.policy.rescheduleNoticeMinutes / 60);

  return (
    <div className="mx-auto min-h-dvh w-full max-w-lg px-4 py-6">
      <header className="mb-6 text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-ink-850">
          <Scissors size={20} className="text-brand-500" />
        </div>
        <h1 className="display text-2xl tracking-wide text-ink-100">{booking.tenant.name}</h1>
        <p className="text-sm text-ink-400">Seu agendamento</p>
      </header>

      {!rescheduling && (
        <div className="space-y-4">
          {booking.appointments.map((appointment) => {
            const status = STATUS_LABEL[appointment.status] ?? STATUS_LABEL.pending;
            const restante = Math.max(0, appointment.total_amount - appointment.paid_amount);

            return (
              <article key={appointment.id} className="card overflow-hidden">
                <div className="flex items-center justify-between border-b border-ink-800 px-4 py-3">
                  <span className={clsx('badge', status.className)}>{status.text}</span>
                  <span className="text-xs text-ink-500">
                    {appointment.services.length} serviço{appointment.services.length > 1 ? 's' : ''}
                  </span>
                </div>

                <div className="space-y-3 p-4">
                  <p className="flex items-center gap-2 text-[15px] font-semibold capitalize text-ink-100">
                    <CalendarDays size={16} className="text-ink-500" />
                    {formatDateLong(new Date(appointment.starts_at).toLocaleDateString('sv-SE', { timeZone: booking.tenant.timezone }))}
                  </p>
                  <p className="flex items-center gap-2 text-sm text-ink-300">
                    <Clock size={15} className="text-ink-500" />
                    {new Date(appointment.starts_at).toLocaleTimeString('pt-BR', {
                      hour: '2-digit',
                      minute: '2-digit',
                      timeZone: booking.tenant.timezone,
                    })}
                    {appointment.professional_name ? ` · ${appointment.professional_name}` : ''}
                  </p>

                  <ul className="space-y-1 border-t border-ink-800 pt-3 text-sm">
                    {appointment.services.map((service) => (
                      <li key={service.id} className="flex justify-between text-ink-300">
                        <span>{service.name}</span>
                        <span>{shortMoney(service.price)}</span>
                      </li>
                    ))}
                  </ul>

                  <div className="space-y-1 border-t border-ink-800 pt-3 text-sm">
                    <div className="flex justify-between text-ink-300">
                      <span>Total</span>
                      <span className="font-semibold text-ink-100">{shortMoney(appointment.total_amount)}</span>
                    </div>
                    <div className="flex justify-between text-ink-400">
                      <span>Pago</span>
                      <span>{shortMoney(appointment.paid_amount)}</span>
                    </div>
                    {restante > 0 && (
                      <div className="flex justify-between text-state-warn">
                        <span>A pagar no atendimento</span>
                        <span>{shortMoney(restante)}</span>
                      </div>
                    )}
                  </div>

                  {appointment.canChange ? (
                    <div className="flex gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => openReschedule(appointment)}
                        className="btn-ghost flex-1"
                        disabled={busy}
                      >
                        Remarcar
                      </button>
                      {booking.policy.allowCancel && (
                        <button
                          type="button"
                          onClick={() => cancel(appointment.id)}
                          className="btn-danger flex-1"
                          disabled={busy}
                        >
                          Cancelar
                        </button>
                      )}
                    </div>
                  ) : (
                    ['pending', 'confirmed'].includes(appointment.status) && (
                      <p className="flex items-start gap-2 rounded-xl bg-ink-850 p-3 text-xs text-ink-400">
                        <AlertCircle size={14} className="mt-0.5 shrink-0" />
                        Alterações são permitidas até {noticeHours}h antes do horário. Entre em contato
                        com a empresa para mudar agora.
                      </p>
                    )
                  )}
                </div>
              </article>
            );
          })}

          <div className="card space-y-2 p-4 text-sm text-ink-400">
            {booking.tenant.address && (
              <p className="flex items-center gap-2">
                <MapPin size={14} className="text-ink-500" /> {booking.tenant.address}
              </p>
            )}
            {booking.tenant.phone && (
              <p className="flex items-center gap-2">
                <Phone size={14} className="text-ink-500" /> {booking.tenant.phone}
              </p>
            )}
          </div>

          <a href={`/agendar/${booking.tenant.slug}`} className="btn-ghost w-full">
            Agendar outro horário
          </a>
        </div>
      )}

      {/* --------------------------------------------------------- remarcar */}
      {rescheduling && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-ink-100">Escolha o novo horário</p>
            <button
              type="button"
              onClick={() => setRescheduling(null)}
              className="rounded-lg p-1.5 text-ink-400 hover:bg-ink-800"
              aria-label="Fechar"
            >
              <X size={18} />
            </button>
          </div>

          <Calendar
            month={month}
            selected={date}
            availability={monthDays}
            minDate={todayInTz(booking.tenant.timezone)}
            maxDate={addDays(todayInTz(booking.tenant.timezone), 90)}
            onMonthChange={(m) => {
              setMonth(m);
              loadMonth(m);
            }}
            onSelect={loadDay}
          />

          {date && (
            <div className="card p-4">
              {slots.length ? (
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {slots.map((s) => (
                    <button
                      key={s.startsAt}
                      type="button"
                      disabled={busy}
                      onClick={() => confirmReschedule(s.startsAt, s.professionalId)}
                      className="rounded-xl border border-ink-700 bg-ink-850 py-2.5 text-sm font-medium text-ink-100 transition-colors hover:border-brand-500 hover:bg-brand-500 hover:text-ink-950"
                    >
                      {s.time}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="py-4 text-center text-sm text-ink-400">Sem horários livres neste dia.</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export { Check };
