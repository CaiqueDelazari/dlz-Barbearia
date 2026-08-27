'use client';

import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { Loader2, Pencil, Plus, UserSquare2, X } from 'lucide-react';
import { api, ApiClientError } from '@/lib/api-client';

type Professional = {
  id: string;
  name: string;
  bio: string | null;
  photoUrl: string | null;
  phone: string | null;
  commissionPercent: number;
  displayOrder: number;
  active: boolean;
  serviceIds: string[];
};

type Service = { id: string; name: string; active: boolean };

export default function ProfissionaisPage() {
  const [professionals, setProfessionals] = useState<Professional[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Professional | 'new' | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, s] = await Promise.all([
        api.get<{ professionals: Professional[] }>('/professionals'),
        api.get<{ services: Service[] }>('/services'),
      ]);
      setProfessionals(p.professionals);
      setServices(s.services.filter((x) => x.active));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function deactivate(professional: Professional) {
    if (!confirm(`Desativar ${professional.name}?`)) return;
    try {
      await api.delete(`/professionals/${professional.id}`);
      toast.success('Profissional desativado');
      load();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Falha ao desativar');
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-100">Profissionais</h1>
          <p className="text-sm text-ink-400">Cada um com sua agenda e seus serviços</p>
        </div>
        <button type="button" onClick={() => setEditing('new')} className="btn-primary">
          <Plus size={16} /> Novo
        </button>
      </header>

      {loading ? (
        <div className="flex justify-center py-16 text-ink-500">
          <Loader2 className="animate-spin" />
        </div>
      ) : professionals.length === 0 ? (
        <div className="card flex flex-col items-center gap-3 p-10 text-center">
          <UserSquare2 size={28} className="text-ink-600" />
          <p className="text-sm text-ink-400">Nenhum profissional cadastrado.</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {professionals.map((professional) => (
            <li key={professional.id} className="card flex items-center gap-3 p-4">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-ink-800 text-sm font-semibold text-ink-300">
                {professional.name.slice(0, 2).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold text-ink-100">{professional.name}</span>
                  {!professional.active && <span className="badge text-ink-400">inativo</span>}
                </span>
                <span className="block text-xs text-ink-500">
                  {professional.serviceIds?.length
                    ? `${professional.serviceIds.length} serviço(s) vinculado(s)`
                    : 'Atende todos os serviços'}
                </span>
              </span>
              <button
                type="button"
                onClick={() => setEditing(professional)}
                className="rounded-lg p-2 text-ink-400 hover:bg-ink-800 hover:text-ink-100"
              >
                <Pencil size={15} />
              </button>
              {professional.active && (
                <button
                  type="button"
                  onClick={() => deactivate(professional)}
                  className="rounded-lg p-2 text-ink-400 hover:bg-ink-800 hover:text-state-bad"
                >
                  <X size={16} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <ProfessionalDialog
          professional={editing === 'new' ? null : editing}
          services={services}
          onClose={() => setEditing(null)}
          onSaved={load}
        />
      )}
    </div>
  );
}

function ProfessionalDialog({
  professional,
  services,
  onClose,
  onSaved,
}: {
  professional: Professional | null;
  services: Service[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: professional?.name ?? '',
    bio: professional?.bio ?? '',
    photoUrl: professional?.photoUrl ?? '',
    phone: professional?.phone ?? '',
    commissionPercent: String(professional?.commissionPercent ?? 0),
    active: professional?.active ?? true,
  });
  const [linked, setLinked] = useState<string[]>(professional?.serviceIds ?? []);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!form.name.trim()) return toast.error('Informe o nome');
    const payload = {
      name: form.name.trim(),
      bio: form.bio || null,
      photoUrl: form.photoUrl.trim() || null,
      phone: form.phone || null,
      commissionPercent: Number(form.commissionPercent) || 0,
      serviceIds: linked,
      ...(professional ? { active: form.active } : {}),
    };

    setBusy(true);
    try {
      if (professional) await api.patch(`/professionals/${professional.id}`, payload);
      else await api.post('/professionals', payload);
      toast.success('Profissional salvo');
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Falha ao salvar');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink-950/80 sm:items-center sm:p-4">
      <div className="flex max-h-[92dvh] w-full max-w-md flex-col rounded-t-2xl border border-ink-800 bg-ink-900 sm:rounded-2xl">
        <header className="flex items-center justify-between border-b border-ink-800 px-5 py-4">
          <h2 className="text-[15px] font-semibold text-ink-100">
            {professional ? 'Editar profissional' : 'Novo profissional'}
          </h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-ink-400 hover:bg-ink-800">
            <X size={18} />
          </button>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-5">
          <div>
            <label className="label">Nome</label>
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <label className="label">Descrição curta</label>
            <input className="input" value={form.bio} onChange={(e) => setForm({ ...form, bio: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Telefone</label>
              <input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </div>
            <div>
              <label className="label">Comissão (%)</label>
              <input
                className="input"
                inputMode="decimal"
                value={form.commissionPercent}
                onChange={(e) => setForm({ ...form, commissionPercent: e.target.value.replace(',', '.') })}
              />
            </div>
          </div>
          <div>
            <label className="label">Foto (URL)</label>
            <input
              className="input"
              placeholder="https://..."
              value={form.photoUrl}
              onChange={(e) => setForm({ ...form, photoUrl: e.target.value })}
            />
          </div>

          <div>
            <p className="label">Serviços que realiza (vazio = todos)</p>
            <div className="flex flex-wrap gap-2">
              {services.map((service) => {
                const active = linked.includes(service.id);
                return (
                  <button
                    key={service.id}
                    type="button"
                    onClick={() =>
                      setLinked((current) =>
                        current.includes(service.id)
                          ? current.filter((id) => id !== service.id)
                          : [...current, service.id]
                      )
                    }
                    className={clsx(
                      'rounded-lg border px-3 py-1.5 text-sm',
                      active ? 'border-brand-500 bg-brand-500/10 text-ink-100' : 'border-ink-700 bg-ink-850 text-ink-400'
                    )}
                  >
                    {service.name}
                  </button>
                );
              })}
            </div>
          </div>

          {professional && (
            <label className="flex items-center gap-2 text-sm text-ink-300">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => setForm({ ...form, active: e.target.checked })}
                className="h-4 w-4 accent-brand-500"
              />
              Ativo
            </label>
          )}
        </div>

        <footer className="safe-bottom flex gap-2 border-t border-ink-800 px-5 pt-4">
          <button type="button" onClick={onClose} className="btn-ghost flex-1">
            Cancelar
          </button>
          <button type="button" disabled={busy} onClick={submit} className="btn-primary flex-1">
            {busy && <Loader2 size={15} className="animate-spin" />} Salvar
          </button>
        </footer>
      </div>
    </div>
  );
}
