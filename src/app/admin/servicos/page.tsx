'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { Loader2, Pencil, Plus, Scissors, Trash2, X } from 'lucide-react';
import { api, ApiClientError, money } from '@/lib/api-client';

type Service = {
  id: string;
  name: string;
  description: string | null;
  price: number;
  durationMinutes: number;
  imageUrl: string | null;
  category: string | null;
  displayOrder: number;
  active: boolean;
};

const EMPTY = {
  name: '',
  description: '',
  price: '',
  durationMinutes: '30',
  imageUrl: '',
  category: '',
  active: true,
};

export default function ServicosPage() {
  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Service | 'new' | null>(null);

  // categorias já usadas: viram as abas da página pública e a sugestão do form
  const categories = useMemo(() => {
    const found: string[] = [];
    for (const service of services) {
      const value = service.category?.trim();
      if (value && !found.includes(value)) found.push(value);
    }
    return found.sort();
  }, [services]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.get<{ services: Service[] }>('/services');
      setServices(result.services);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function remove(service: Service) {
    if (!confirm(`Remover "${service.name}"?`)) return;
    try {
      const result = await api.delete<{ softDeleted: boolean }>(`/services/${service.id}`);
      toast.success(result.softDeleted ? 'Serviço desativado (tem histórico)' : 'Serviço removido');
      load();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Falha ao remover');
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-100">Serviços</h1>
          <p className="text-sm text-ink-400">Preço e duração aparecem para o cliente</p>
        </div>
        <button type="button" onClick={() => setEditing('new')} className="btn-primary">
          <Plus size={16} /> Novo serviço
        </button>
      </header>

      {loading ? (
        <div className="flex justify-center py-16 text-ink-500">
          <Loader2 className="animate-spin" />
        </div>
      ) : services.length === 0 ? (
        <div className="card flex flex-col items-center gap-3 p-10 text-center">
          <Scissors size={28} className="text-ink-600" />
          <p className="text-sm text-ink-400">
            Cadastre seus serviços para a página de agendamento funcionar.
          </p>
          <button type="button" onClick={() => setEditing('new')} className="btn-ghost">
            Cadastrar primeiro serviço
          </button>
        </div>
      ) : (
        <ul className="space-y-2">
          {services.map((service) => (
            <li key={service.id} className="card flex items-center gap-3 p-4">
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold text-ink-100">{service.name}</span>
                  {!service.active && <span className="badge text-ink-400">inativo</span>}
                </span>
                <span className="block text-xs text-ink-500">
                  {money(service.price)} · {service.durationMinutes} min
                  {service.category ? ` · ${service.category}` : ''}
                </span>
              </span>
              <button
                type="button"
                onClick={() => setEditing(service)}
                className="rounded-lg p-2 text-ink-400 hover:bg-ink-800 hover:text-ink-100"
              >
                <Pencil size={15} />
              </button>
              <button
                type="button"
                onClick={() => remove(service)}
                className="rounded-lg p-2 text-ink-400 hover:bg-ink-800 hover:text-state-bad"
              >
                <Trash2 size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <ServiceDialog
          service={editing === 'new' ? null : editing}
          categories={categories}
          onClose={() => setEditing(null)}
          onSaved={load}
        />
      )}
    </div>
  );
}

function ServiceDialog({
  service,
  categories,
  onClose,
  onSaved,
}: {
  service: Service | null;
  categories: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState(
    service
      ? {
          name: service.name,
          description: service.description ?? '',
          price: String(service.price),
          durationMinutes: String(service.durationMinutes),
          imageUrl: service.imageUrl ?? '',
          category: service.category ?? '',
          active: service.active,
        }
      : EMPTY
  );
  const [professionals, setProfessionals] = useState<{ id: string; name: string; serviceIds: string[] }[]>([]);
  const [linked, setLinked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<{ professionals: { id: string; name: string; serviceIds: string[] }[] }>('/professionals')
      .then((r) => {
        setProfessionals(r.professionals);
        if (service) {
          setLinked(r.professionals.filter((p) => p.serviceIds?.includes(service.id)).map((p) => p.id));
        }
      })
      .catch(() => setProfessionals([]));
  }, [service]);

  async function submit() {
    const payload = {
      name: form.name.trim(),
      description: form.description || null,
      price: Number(form.price),
      durationMinutes: Number(form.durationMinutes),
      imageUrl: form.imageUrl.trim() || null,
      category: form.category || null,
      active: form.active,
      // vazio = todos os profissionais atendem
      professionalIds: linked,
    };

    if (!payload.name || Number.isNaN(payload.price) || !payload.durationMinutes) {
      return toast.error('Preencha nome, preço e duração');
    }

    setBusy(true);
    try {
      if (service) await api.patch(`/services/${service.id}`, payload);
      else await api.post('/services', payload);
      toast.success('Serviço salvo');
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Falha ao salvar');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet-overlay z-50 flex items-end justify-center bg-ink-950/80 sm:items-center sm:p-4">
      <div className="flex max-h-full w-full max-w-md flex-col rounded-t-2xl border border-ink-800 bg-ink-900 sm:rounded-2xl">
        <header className="flex items-center justify-between border-b border-ink-800 px-5 py-4">
          <h2 className="text-[15px] font-semibold text-ink-100">{service ? 'Editar serviço' : 'Novo serviço'}</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-ink-400 hover:bg-ink-800">
            <X size={18} />
          </button>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-5">
          <div>
            <label className="label">Nome</label>
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Preço (R$)</label>
              <input
                className="input"
                inputMode="decimal"
                value={form.price}
                onChange={(e) => setForm({ ...form, price: e.target.value.replace(',', '.') })}
              />
            </div>
            <div>
              <label className="label">Duração (min)</label>
              <input
                className="input"
                inputMode="numeric"
                value={form.durationMinutes}
                onChange={(e) => setForm({ ...form, durationMinutes: e.target.value })}
              />
            </div>
          </div>

          <div>
            <label className="label">Descrição</label>
            <input
              className="input"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>

          <div>
            <label className="label">Categoria</label>
            <input
              className="input"
              list="categorias-existentes"
              placeholder="Cabelo, Coloração, Barba..."
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
            />
            <datalist id="categorias-existentes">
              {categories.map((category) => (
                <option key={category} value={category} />
              ))}
            </datalist>
            <p className="mt-2 text-xs text-ink-500">
              Vira uma aba na página de agendamento. Deixe vazio para não separar.
            </p>
          </div>

          <div>
            <label className="label">Imagem (URL)</label>
            <input
              className="input"
              placeholder="https://..."
              value={form.imageUrl}
              onChange={(e) => setForm({ ...form, imageUrl: e.target.value })}
            />
          </div>

          {professionals.length > 1 && (
            <div>
              <p className="label">Quem realiza (vazio = todos)</p>
              <div className="flex flex-wrap gap-2">
                {professionals.map((p) => {
                  const active = linked.includes(p.id);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() =>
                        setLinked((current) =>
                          current.includes(p.id) ? current.filter((id) => id !== p.id) : [...current, p.id]
                        )
                      }
                      className={clsx(
                        'rounded-lg border px-3 py-1.5 text-sm',
                        active
                          ? 'border-brand-500 bg-brand-500/10 text-ink-100'
                          : 'border-ink-700 bg-ink-850 text-ink-400'
                      )}
                    >
                      {p.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <label className="flex items-center gap-2 pt-1 text-sm text-ink-300">
            <input
              type="checkbox"
              checked={form.active}
              onChange={(e) => setForm({ ...form, active: e.target.checked })}
              className="h-4 w-4 accent-brand-500"
            />
            Serviço ativo (aparece para o cliente)
          </label>
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
