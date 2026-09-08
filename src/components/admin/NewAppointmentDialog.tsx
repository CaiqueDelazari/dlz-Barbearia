'use client';

import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { Check, Loader2, Search, X } from 'lucide-react';
import { api, ApiClientError, shortMoney } from '@/lib/api-client';
import { formatDateBR, humanDuration } from '@/lib/datetime';

type Service = { id: string; name: string; price: number; durationMinutes: number; active: boolean };
type Professional = { id: string; name: string; active: boolean };
type Client = { id: string; name: string; phone: string };
type Slot = { time: string; startsAt: string; professionalId: string | null; professionalName: string | null };

type Props = {
  date: string;
  onClose: () => void;
  onCreated: () => void;
};

/**
 * Agendamento manual (cliente que chegou no balcao ou ligou).
 * Usa a mesma disponibilidade do fluxo publico, mas nao exige pagamento online
 * e permite registrar o que ja foi pago na hora.
 */
export function NewAppointmentDialog({ date, onClose, onCreated }: Props) {
  const [services, setServices] = useState<Service[]>([]);
  const [professionals, setProfessionals] = useState<Professional[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [professionalId, setProfessionalId] = useState<string>('');

  const [targetDate, setTargetDate] = useState(date);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [loadingSlots, setLoadingSlots] = useState(false);

  const [search, setSearch] = useState('');
  const [clients, setClients] = useState<Client[]>([]);
  const [client, setClient] = useState<Client | null>(null);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');

  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState<'cash' | 'pix' | 'card'>('cash');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<{ services: Service[] }>('/services').then((r) => setServices(r.services.filter((s) => s.active)));
    api
      .get<{ professionals: Professional[] }>('/professionals')
      .then((r) => setProfessionals(r.professionals.filter((p) => p.active)));
  }, []);

  const selected = useMemo(
    () => selectedIds.map((id) => services.find((s) => s.id === id)).filter(Boolean) as Service[],
    [selectedIds, services]
  );
  const totalAmount = selected.reduce((sum, s) => sum + Number(s.price), 0);
  const totalDuration = selected.reduce((sum, s) => sum + s.durationMinutes, 0);

  useEffect(() => {
    if (!selectedIds.length) {
      setSlots([]);
      return;
    }
    setLoadingSlots(true);
    setSlot(null);
    api
      .get<{ slots: Slot[] }>(
        `/availability?date=${targetDate}&services=${selectedIds.join(',')}` +
          (professionalId ? `&professional=${professionalId}` : '')
      )
      .then((r) => setSlots(r.slots))
      .catch((err) => toast.error(err instanceof ApiClientError ? err.message : 'Falha ao buscar horários'))
      .finally(() => setLoadingSlots(false));
  }, [selectedIds, targetDate, professionalId]);

  useEffect(() => {
    if (search.length < 2) {
      setClients([]);
      return;
    }
    const timer = setTimeout(() => {
      api
        .get<{ items: Client[] }>(`/clients?search=${encodeURIComponent(search)}&limit=6`)
        .then((r) => setClients(r.items))
        .catch(() => setClients([]));
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  async function submit() {
    if (!slot) return toast.error('Escolha um horário');
    if (!client && (!newName.trim() || newPhone.replace(/\D/g, '').length < 10)) {
      return toast.error('Informe o cliente');
    }

    setBusy(true);
    try {
      await api.post('/appointments', {
        items: [{ startsAt: slot.startsAt, serviceIds: selectedIds, professionalId: slot.professionalId }],
        client: client ? { id: client.id } : { name: newName.trim(), phone: newPhone },
        notes: notes || null,
        ...(Number(payAmount) > 0
          ? { payment: { amount: Number(payAmount), method: payMethod } }
          : {}),
      });
      toast.success('Agendamento criado');
      onCreated();
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Não foi possível agendar');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet-overlay z-50 flex items-end justify-center bg-ink-950/80 p-0 sm:items-center sm:p-4">
      <div className="flex max-h-full w-full max-w-lg flex-col rounded-t-2xl border border-ink-800 bg-ink-900 sm:rounded-2xl">
        <header className="flex items-center justify-between border-b border-ink-800 px-5 py-4">
          <h2 className="text-[15px] font-semibold text-ink-100">Novo agendamento</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-ink-400 hover:bg-ink-800">
            <X size={18} />
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
          {/* --------------------------------------------------- servicos */}
          <div>
            <p className="label">Serviços</p>
            <div className="flex flex-wrap gap-2">
              {services.map((service) => {
                const active = selectedIds.includes(service.id);
                return (
                  <button
                    key={service.id}
                    type="button"
                    onClick={() =>
                      setSelectedIds((current) =>
                        current.includes(service.id)
                          ? current.filter((id) => id !== service.id)
                          : [...current, service.id]
                      )
                    }
                    className={clsx(
                      'rounded-xl border px-3 py-2 text-sm transition-colors',
                      active
                        ? 'border-brand-500 bg-brand-500/10 text-ink-100'
                        : 'border-ink-700 bg-ink-850 text-ink-300 hover:border-ink-600'
                    )}
                  >
                    {active && <Check size={13} className="mr-1 inline text-brand-500" />}
                    {service.name}
                    <span className="ml-1.5 text-xs text-ink-500">{service.durationMinutes}min</span>
                  </button>
                );
              })}
            </div>
            {selected.length > 0 && (
              <p className="mt-2 text-xs text-ink-400">
                Total: {shortMoney(totalAmount)} · {humanDuration(totalDuration)}
              </p>
            )}
          </div>

          {/* ----------------------------------------------- data/horario */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="data">Data</label>
              <input
                id="data"
                type="date"
                className="input"
                value={targetDate}
                onChange={(e) => setTargetDate(e.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="prof">Profissional</label>
              <select
                id="prof"
                className="input"
                value={professionalId}
                onChange={(e) => setProfessionalId(e.target.value)}
              >
                <option value="">Qualquer um</option>
                {professionals.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <p className="label">Horário em {formatDateBR(targetDate)}</p>
            {loadingSlots ? (
              <div className="flex justify-center py-4 text-ink-500">
                <Loader2 size={18} className="animate-spin" />
              </div>
            ) : slots.length ? (
              <div className="grid grid-cols-4 gap-2">
                {slots.map((s) => (
                  <button
                    key={s.startsAt}
                    type="button"
                    onClick={() => setSlot(s)}
                    className={clsx(
                      'rounded-xl border py-2 text-sm transition-colors',
                      slot?.startsAt === s.startsAt
                        ? 'border-brand-500 bg-brand-500 text-ink-950'
                        : 'border-ink-700 bg-ink-850 text-ink-100 hover:border-ink-600'
                    )}
                  >
                    {s.time}
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-sm text-ink-500">
                {selectedIds.length ? 'Sem horários livres nesta data.' : 'Selecione os serviços.'}
              </p>
            )}
          </div>

          {/* ----------------------------------------------------- cliente */}
          <div>
            <p className="label">Cliente</p>
            {client ? (
              <div className="flex items-center gap-2 rounded-xl border border-brand-500/50 bg-ink-850 px-3 py-2.5">
                <span className="flex-1 text-sm text-ink-100">
                  {client.name} <span className="text-ink-500">· {client.phone}</span>
                </span>
                <button type="button" onClick={() => setClient(null)} className="text-ink-400 hover:text-ink-100">
                  <X size={16} />
                </button>
              </div>
            ) : (
              <>
                <div className="relative">
                  <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-500" />
                  <input
                    className="input pl-9"
                    placeholder="Buscar por nome ou telefone"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>

                {clients.length > 0 && (
                  <ul className="mt-2 divide-y divide-ink-800 overflow-hidden rounded-xl border border-ink-800">
                    {clients.map((c) => (
                      <li key={c.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setClient(c);
                            setSearch('');
                          }}
                          className="w-full px-3 py-2.5 text-left text-sm text-ink-200 hover:bg-ink-850"
                        >
                          {c.name} <span className="text-ink-500">· {c.phone}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="mt-3 grid grid-cols-2 gap-2">
                  <input
                    className="input"
                    placeholder="Nome do novo cliente"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                  />
                  <input
                    className="input"
                    placeholder="Telefone"
                    inputMode="tel"
                    value={newPhone}
                    onChange={(e) => setNewPhone(e.target.value)}
                  />
                </div>
              </>
            )}
          </div>

          {/* -------------------------------------------------- pagamento */}
          <div>
            <p className="label">Pagamento na hora (opcional)</p>
            <div className="grid grid-cols-2 gap-2">
              <input
                className="input"
                placeholder="0,00"
                inputMode="decimal"
                value={payAmount}
                onChange={(e) => setPayAmount(e.target.value.replace(',', '.'))}
              />
              <select
                className="input"
                value={payMethod}
                onChange={(e) => setPayMethod(e.target.value as typeof payMethod)}
              >
                <option value="cash">Dinheiro</option>
                <option value="pix">Pix</option>
                <option value="card">Cartão</option>
              </select>
            </div>
          </div>

          <div>
            <label className="label" htmlFor="obs">Observações</label>
            <input id="obs" className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>

        <footer className="safe-bottom border-t border-ink-800 px-5 pt-4">
          <button type="button" disabled={busy || !slot} onClick={submit} className="btn-primary w-full py-3">
            {busy && <Loader2 size={16} className="animate-spin" />} Criar agendamento
          </button>
        </footer>
      </div>
    </div>
  );
}
