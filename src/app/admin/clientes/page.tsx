'use client';

import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Loader2, Phone, Search, UserPlus, X } from 'lucide-react';
import { api, ApiClientError, money } from '@/lib/api-client';
import { formatDateTimeBR, formatPhoneBR } from '@/lib/format';
import { Pagination } from '@/components/admin/Pagination';

/** Uma tela cheia de clientes; o resto vem pela navegação, nunca cortado em silêncio. */
const POR_PAGINA = 50;

type ClientRow = {
  id: string;
  name: string;
  phone: string;
  blocked: boolean;
  no_show_count: number;
  total_appointments: number | null;
  total_spent: number | null;
  last_visit: string | null;
  next_visit: string | null;
};

export default function ClientesPage() {
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<ClientRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.get<{ items: ClientRow[]; total: number }>(
        `/clients?limit=${POR_PAGINA}&offset=${page * POR_PAGINA}` +
          (search ? `&search=${encodeURIComponent(search)}` : '')
      );
      setItems(result.items);
      setTotal(result.total);
    } finally {
      setLoading(false);
    }
  }, [search, page]);

  useEffect(() => {
    const timer = setTimeout(load, search ? 350 : 0);
    return () => clearTimeout(timer);
  }, [load, search]);

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-100">Clientes</h1>
          <p className="text-sm text-ink-400">Ficha, histórico e gasto de cada um</p>
        </div>
        <button type="button" onClick={() => setCreating(true)} className="btn-primary">
          <UserPlus size={16} /> Novo
        </button>
      </header>

      <div className="relative">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-500" />
        <input
          className="input pl-9"
          placeholder="Buscar por nome ou telefone"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
        />
      </div>

      {loading ? (
        <div className="flex justify-center py-16 text-ink-500">
          <Loader2 className="animate-spin" />
        </div>
      ) : items.length === 0 ? (
        <p className="card p-10 text-center text-sm text-ink-500">Nenhum cliente encontrado.</p>
      ) : (
        <ul className="space-y-2">
          {items.map((client) => (
            <li key={client.id}>
              <button
                type="button"
                onClick={() => setSelectedId(client.id)}
                className="card flex w-full items-center gap-3 p-4 text-left hover:border-ink-700"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-ink-100">
                    {client.name}
                    {client.blocked && <span className="badge ml-2 bg-state-bad/10 text-state-bad">bloqueado</span>}
                  </span>
                  <span className="block text-xs text-ink-500">{formatPhoneBR(client.phone)}</span>
                </span>
                <span className="text-right text-xs text-ink-400">
                  <span className="block text-ink-100">{client.total_appointments ?? 0} atendimentos</span>
                  <span>{money(client.total_spent ?? 0)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {items.length > 0 && (
        <Pagination
          page={page}
          pageSize={POR_PAGINA}
          total={total}
          onChange={setPage}
          labelSingular="cliente cadastrado"
          labelPlural="clientes cadastrados"
        />
      )}

      {selectedId && <ClientDrawer id={selectedId} onClose={() => setSelectedId(null)} onChanged={load} />}
      {creating && <NewClientDialog onClose={() => setCreating(false)} onCreated={load} />}
    </div>
  );
}

function ClientDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [data, setData] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get(`/clients/${id}`).then(setData).catch(() => onClose());
  }, [id, onClose]);

  async function toggleBlock() {
    setBusy(true);
    try {
      await api.patch(`/clients/${id}`, { blocked: !data.client.blocked });
      toast.success(data.client.blocked ? 'Cliente desbloqueado' : 'Cliente bloqueado');
      setData({ ...data, client: { ...data.client, blocked: !data.client.blocked } });
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Falha ao atualizar');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink-950/80 sm:items-center sm:p-4">
      <div className="flex max-h-[92dvh] w-full max-w-md flex-col rounded-t-2xl border border-ink-800 bg-ink-900 sm:rounded-2xl">
        <header className="flex items-center justify-between border-b border-ink-800 px-5 py-4">
          <h2 className="text-[15px] font-semibold text-ink-100">Ficha do cliente</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-ink-400 hover:bg-ink-800">
            <X size={18} />
          </button>
        </header>

        {!data ? (
          <div className="flex justify-center py-16 text-ink-500">
            <Loader2 className="animate-spin" />
          </div>
        ) : (
          <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
            <div>
              <p className="text-lg font-semibold text-ink-100">{data.client.name}</p>
              <a
                href={`https://wa.me/55${data.client.phone.replace(/\D/g, '')}`}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex items-center gap-1.5 text-sm text-brand-500 hover:underline"
              >
                <Phone size={13} /> {formatPhoneBR(data.client.phone)}
              </a>
            </div>

            <div className="grid grid-cols-2 gap-2 text-sm">
              <Stat label="Atendimentos" value={String(data.summary?.total_appointments ?? 0)} />
              <Stat label="Total gasto" value={money(data.summary?.total_spent ?? 0)} />
              <Stat
                label="Último corte"
                value={data.summary?.last_visit ? formatDateTimeBR(data.summary.last_visit) : '—'}
              />
              <Stat
                label="Próximo horário"
                value={data.summary?.next_visit ? formatDateTimeBR(data.summary.next_visit) : '—'}
              />
              <Stat label="Faltas" value={String(data.summary?.no_shows ?? 0)} />
            </div>

            {data.services?.length > 0 && (
              <div>
                <p className="label">Serviços mais usados</p>
                <ul className="space-y-1 text-sm text-ink-300">
                  {data.services.map((s: any) => (
                    <li key={s.name} className="flex justify-between">
                      <span>
                        {s.times}× {s.name}
                      </span>
                      <span className="text-ink-500">{money(s.total)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {data.appointments?.length > 0 && (
              <div>
                <p className="label">Histórico</p>
                <ul className="divide-y divide-ink-800 text-sm">
                  {data.appointments.slice(0, 12).map((a: any) => (
                    <li key={a.id} className="flex items-center justify-between py-2">
                      <span className="min-w-0">
                        <span className="block truncate text-ink-200">{a.services}</span>
                        <span className="block text-xs text-ink-500">{formatDateTimeBR(a.starts_at)}</span>
                      </span>
                      <span className="shrink-0 text-xs text-ink-400">{money(a.total_amount)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <button
              type="button"
              disabled={busy}
              onClick={toggleBlock}
              className={data.client.blocked ? 'btn-ghost w-full' : 'btn-danger w-full'}
            >
              {data.client.blocked ? 'Desbloquear cliente' : 'Bloquear cliente'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function NewClientDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({ name: '', phone: '', notes: '' });
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await api.post('/clients', { name: form.name, phone: form.phone, notes: form.notes || null });
      toast.success('Cliente cadastrado');
      onCreated();
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Falha ao cadastrar');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/80 p-4">
      <div className="w-full max-w-sm rounded-2xl border border-ink-800 bg-ink-900 p-5">
        <h2 className="mb-4 text-[15px] font-semibold text-ink-100">Novo cliente</h2>
        <div className="space-y-3">
          <div>
            <label className="label">Nome</label>
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <label className="label">Telefone</label>
            <input
              className="input"
              inputMode="tel"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
          </div>
          <div>
            <label className="label">Observações</label>
            <input className="input" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
        </div>
        <div className="mt-5 flex gap-2">
          <button type="button" onClick={onClose} className="btn-ghost flex-1">
            Cancelar
          </button>
          <button type="button" disabled={busy} onClick={submit} className="btn-primary flex-1">
            {busy && <Loader2 size={15} className="animate-spin" />} Salvar
          </button>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-ink-850 p-3">
      <p className="text-[11px] uppercase tracking-wide text-ink-500">{label}</p>
      <p className="mt-0.5 text-sm font-semibold text-ink-100">{value}</p>
    </div>
  );
}
