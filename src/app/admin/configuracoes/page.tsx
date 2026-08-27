'use client';

import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { Loader2, Plus, Save, Trash2 } from 'lucide-react';
import { api, ApiClientError } from '@/lib/api-client';
import { WEEKDAY_LABELS } from '@/lib/datetime';

type Settings = Record<string, any>;
type Hour = { professionalId: string | null; weekday: number; opensAt: string; closesAt: string };
type Break = { professionalId: string | null; weekday: number; startsAt: string; endsAt: string; label: string | null };

const trim = (t: string) => t.slice(0, 5); // '09:00:00' -> '09:00'

export default function ConfiguracoesPage() {
  const [tenant, setTenant] = useState<Settings>({});
  const [settings, setSettings] = useState<Settings>({});
  const [hours, setHours] = useState<Hour[]>([]);
  const [breaks, setBreaks] = useState<Break[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<{ tenant: Settings; settings: Settings; hours: Hour[]; breaks: Break[] }>('/settings');
      setTenant(data.tenant);
      setSettings(data.settings);
      setHours(
        data.hours
          .filter((h) => !h.professionalId)
          .map((h) => ({ ...h, opensAt: trim(h.opensAt), closesAt: trim(h.closesAt) }))
      );
      setBreaks(
        data.breaks
          .filter((b) => !b.professionalId)
          .map((b) => ({ ...b, startsAt: trim(b.startsAt), endsAt: trim(b.endsAt) }))
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    setSaving(true);
    try {
      await api.patch('/settings', {
        tenant: {
          name: tenant.name,
          phone: tenant.phone || null,
          whatsapp: tenant.whatsapp || null,
          instagram: tenant.instagram || null,
          address: tenant.address || null,
          logoUrl: tenant.logo_url || null,
          timezone: tenant.timezone,
        },
        settings: {
          slotIntervalMinutes: Number(settings.slot_interval_minutes),
          minAdvanceMinutes: Number(settings.min_advance_minutes),
          maxAdvanceDays: Number(settings.max_advance_days),
          minimumRescheduleNoticeMinutes: Number(settings.minimum_reschedule_notice_minutes),
          allowClientCancel: Boolean(settings.allow_client_cancel),
          onlinePaymentRequired: Boolean(settings.online_payment_required),
          allowDeposit: Boolean(settings.allow_deposit),
          allowFullPayment: Boolean(settings.allow_full_payment),
          depositPercent: Number(settings.deposit_percent),
          forfeitDepositOnNoShow: Boolean(settings.forfeit_deposit_on_no_show),
          holdExpirationMinutes: Number(settings.hold_expiration_minutes),
          allowSplitAppointments: Boolean(settings.allow_split_appointments),
          allowProfessionalChoice: Boolean(settings.allow_professional_choice),
          reminder24hEnabled: Boolean(settings.reminder_24h_enabled),
          reminder1hEnabled: Boolean(settings.reminder_1h_enabled),
          returnReminderEnabled: Boolean(settings.return_reminder_enabled),
          returnReminderDays: Number(settings.return_reminder_days),
          paymentMethods: settings.payment_methods,
          whatsappSessionId: settings.whatsapp_session_id || null,
        },
        hours: hours.map((h) => ({ weekday: h.weekday, opensAt: h.opensAt, closesAt: h.closesAt })),
        breaks: breaks.map((b) => ({
          weekday: b.weekday,
          startsAt: b.startsAt,
          endsAt: b.endsAt,
          label: b.label,
        })),
      });
      toast.success('Configurações salvas');
      load();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Falha ao salvar');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-20 text-ink-500">
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  const setS = (key: string, value: unknown) => setSettings((s) => ({ ...s, [key]: value }));
  const setT = (key: string, value: unknown) => setTenant((t) => ({ ...t, [key]: value }));

  return (
    <div className="space-y-5 pb-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-100">Configurações</h1>
          <p className="text-sm text-ink-400">Tudo que muda o comportamento da agenda</p>
        </div>
        <button type="button" disabled={saving} onClick={save} className="btn-primary">
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Salvar
        </button>
      </header>

      {/* ------------------------------------------------------- empresa */}
      <Section title="Dados da empresa">
        <Field label="Nome" value={tenant.name ?? ''} onChange={(v) => setT('name', v)} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Telefone" value={tenant.phone ?? ''} onChange={(v) => setT('phone', v)} />
          <Field label="WhatsApp" value={tenant.whatsapp ?? ''} onChange={(v) => setT('whatsapp', v)} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Instagram" value={tenant.instagram ?? ''} onChange={(v) => setT('instagram', v)} />
          <Field label="Fuso horário" value={tenant.timezone ?? ''} onChange={(v) => setT('timezone', v)} />
        </div>
        <Field label="Endereço" value={tenant.address ?? ''} onChange={(v) => setT('address', v)} />
        <Field label="Logo (URL)" value={tenant.logo_url ?? ''} onChange={(v) => setT('logo_url', v)} />
      </Section>

      {/* -------------------------------------------------------- agenda */}
      <Section title="Regras da agenda">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Intervalo entre horários (min)"
            value={String(settings.slot_interval_minutes ?? '')}
            onChange={(v) => setS('slot_interval_minutes', v)}
            numeric
          />
          <Field
            label="Antecedência mínima (min)"
            value={String(settings.min_advance_minutes ?? '')}
            onChange={(v) => setS('min_advance_minutes', v)}
            numeric
          />
          <Field
            label="Agendar com até (dias)"
            value={String(settings.max_advance_days ?? '')}
            onChange={(v) => setS('max_advance_days', v)}
            numeric
          />
          <Field
            label="Alterar/cancelar até (min antes)"
            value={String(settings.minimum_reschedule_notice_minutes ?? '')}
            onChange={(v) => setS('minimum_reschedule_notice_minutes', v)}
            numeric
          />
        </div>
        <Toggle
          label="Cliente pode cancelar pelo link"
          checked={Boolean(settings.allow_client_cancel)}
          onChange={(v) => setS('allow_client_cancel', v)}
        />
        <Toggle
          label="Cliente escolhe o profissional"
          checked={Boolean(settings.allow_professional_choice)}
          onChange={(v) => setS('allow_professional_choice', v)}
        />
        <Toggle
          label="Permitir serviços em horários separados"
          checked={Boolean(settings.allow_split_appointments)}
          onChange={(v) => setS('allow_split_appointments', v)}
        />
      </Section>

      {/* ---------------------------------------------------- pagamento */}
      <Section title="Pagamento">
        <Toggle
          label="Exigir pagamento online para confirmar"
          checked={Boolean(settings.online_payment_required)}
          onChange={(v) => setS('online_payment_required', v)}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Percentual do sinal (%)"
            value={String(settings.deposit_percent ?? '')}
            onChange={(v) => setS('deposit_percent', v)}
            numeric
          />
          <Field
            label="Reserva expira em (min)"
            value={String(settings.hold_expiration_minutes ?? '')}
            onChange={(v) => setS('hold_expiration_minutes', v)}
            numeric
          />
        </div>
        <Toggle
          label="Aceitar pagamento de sinal"
          checked={Boolean(settings.allow_deposit)}
          onChange={(v) => setS('allow_deposit', v)}
        />
        <Toggle
          label="Aceitar pagamento integral"
          checked={Boolean(settings.allow_full_payment)}
          onChange={(v) => setS('allow_full_payment', v)}
        />
        <Toggle
          label="Sinal é perdido em caso de falta"
          checked={Boolean(settings.forfeit_deposit_on_no_show)}
          onChange={(v) => setS('forfeit_deposit_on_no_show', v)}
        />

        <div>
          <p className="label">Formas aceitas</p>
          <div className="flex flex-wrap gap-2">
            {['pix', 'card'].map((method) => {
              const active = (settings.payment_methods ?? []).includes(method);
              return (
                <button
                  key={method}
                  type="button"
                  onClick={() =>
                    setS(
                      'payment_methods',
                      active
                        ? (settings.payment_methods ?? []).filter((m: string) => m !== method)
                        : [...(settings.payment_methods ?? []), method]
                    )
                  }
                  className={clsx(
                    'rounded-lg border px-3 py-1.5 text-sm',
                    active ? 'border-brand-500 bg-brand-500/10 text-ink-100' : 'border-ink-700 bg-ink-850 text-ink-400'
                  )}
                >
                  {method === 'pix' ? 'Pix' : 'Cartão'}
                </button>
              );
            })}
          </div>
        </div>
      </Section>

      {/* ------------------------------------------------ notificacoes */}
      <Section title="Lembretes automáticos">
        <Toggle
          label="Lembrete 24 horas antes"
          checked={Boolean(settings.reminder_24h_enabled)}
          onChange={(v) => setS('reminder_24h_enabled', v)}
        />
        <Toggle
          label="Lembrete 1 hora antes"
          checked={Boolean(settings.reminder_1h_enabled)}
          onChange={(v) => setS('reminder_1h_enabled', v)}
        />
        <Toggle
          label="Convite de retorno para clientes sumidos"
          checked={Boolean(settings.return_reminder_enabled)}
          onChange={(v) => setS('return_reminder_enabled', v)}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Dias sem voltar para o convite"
            value={String(settings.return_reminder_days ?? '')}
            onChange={(v) => setS('return_reminder_days', v)}
            numeric
          />
          <Field
            label="Sessão do WhatsApp"
            value={settings.whatsapp_session_id ?? ''}
            onChange={(v) => setS('whatsapp_session_id', v)}
          />
        </div>
      </Section>

      {/* ---------------------------------------------- funcionamento */}
      <Section title="Horário de funcionamento">
        <div className="space-y-2">
          {WEEKDAY_LABELS.map((label, weekday) => {
            const dayHours = hours.filter((h) => h.weekday === weekday);
            return (
              <div key={weekday} className="rounded-xl bg-ink-850 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-medium text-ink-100">{label}</span>
                  <button
                    type="button"
                    onClick={() =>
                      setHours([...hours, { professionalId: null, weekday, opensAt: '09:00', closesAt: '18:00' }])
                    }
                    className="inline-flex items-center gap-1 text-xs text-brand-500 hover:underline"
                  >
                    <Plus size={12} /> Adicionar
                  </button>
                </div>

                {dayHours.length === 0 ? (
                  <p className="text-xs text-ink-500">Fechado</p>
                ) : (
                  <div className="space-y-2">
                    {dayHours.map((hour) => {
                      const index = hours.indexOf(hour);
                      return (
                        <div key={index} className="flex items-center gap-2">
                          <input
                            type="time"
                            className="input py-2"
                            value={hour.opensAt}
                            onChange={(e) => {
                              const next = [...hours];
                              next[index] = { ...hour, opensAt: e.target.value };
                              setHours(next);
                            }}
                          />
                          <span className="text-ink-500">às</span>
                          <input
                            type="time"
                            className="input py-2"
                            value={hour.closesAt}
                            onChange={(e) => {
                              const next = [...hours];
                              next[index] = { ...hour, closesAt: e.target.value };
                              setHours(next);
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => setHours(hours.filter((_, i) => i !== index))}
                            className="rounded-lg p-2 text-ink-500 hover:text-state-bad"
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Section>

      {/* ------------------------------------------------------ pausas */}
      <Section title="Intervalos (almoço, pausa)">
        <button
          type="button"
          onClick={() =>
            setBreaks([...breaks, { professionalId: null, weekday: 1, startsAt: '12:00', endsAt: '13:00', label: 'Almoço' }])
          }
          className="btn-ghost w-full sm:w-auto"
        >
          <Plus size={15} /> Adicionar intervalo
        </button>

        <div className="space-y-2">
          {breaks.map((item, index) => (
            <div key={index} className="flex flex-wrap items-center gap-2 rounded-xl bg-ink-850 p-3">
              <select
                className="input w-32 py-2"
                value={item.weekday}
                onChange={(e) => {
                  const next = [...breaks];
                  next[index] = { ...item, weekday: Number(e.target.value) };
                  setBreaks(next);
                }}
              >
                {WEEKDAY_LABELS.map((label, w) => (
                  <option key={w} value={w}>
                    {label}
                  </option>
                ))}
              </select>
              <input
                type="time"
                className="input w-28 py-2"
                value={item.startsAt}
                onChange={(e) => {
                  const next = [...breaks];
                  next[index] = { ...item, startsAt: e.target.value };
                  setBreaks(next);
                }}
              />
              <input
                type="time"
                className="input w-28 py-2"
                value={item.endsAt}
                onChange={(e) => {
                  const next = [...breaks];
                  next[index] = { ...item, endsAt: e.target.value };
                  setBreaks(next);
                }}
              />
              <button
                type="button"
                onClick={() => setBreaks(breaks.filter((_, i) => i !== index))}
                className="rounded-lg p-2 text-ink-500 hover:text-state-bad"
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      </Section>

      <button type="button" disabled={saving} onClick={save} className="btn-primary w-full py-3">
        {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Salvar configurações
      </button>
    </div>
  );
}

// ------------------------------------------------------------ primitivos
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card space-y-4 p-5">
      <h2 className="text-sm font-semibold text-ink-100">{title}</h2>
      {children}
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  numeric,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  numeric?: boolean;
}) {
  return (
    <div>
      <label className="label">{label}</label>
      <input
        className="input"
        value={value}
        inputMode={numeric ? 'numeric' : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-xl bg-ink-850 px-3 py-2.5">
      <span className="text-sm text-ink-200">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-5 w-5 shrink-0 accent-brand-500"
      />
    </label>
  );
}
