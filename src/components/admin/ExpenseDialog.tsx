'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { Loader2, X } from 'lucide-react';
import { api, ApiClientError } from '@/lib/api-client';

/** Categorias que aparecem toda semana no salão — um toque em vez de digitar. */
const CATEGORIAS = ['Produtos', 'Aluguel', 'Energia', 'Água', 'Internet', 'Salário', 'Impostos', 'Marketing', 'Outros'];

const METODOS = [
  { value: 'cash', label: 'Dinheiro' },
  { value: 'pix', label: 'Pix' },
  { value: 'card', label: 'Cartão' },
  { value: 'transfer', label: 'Transferência' },
  { value: 'other', label: 'Outro' },
] as const;

export function ExpenseDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    description: '',
    category: '',
    amount: '',
    date: new Date().toISOString().slice(0, 10),
    paymentMethod: 'cash' as (typeof METODOS)[number]['value'],
  });
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!form.description.trim()) return toast.error('Descreva a despesa');
    if (!Number(form.amount)) return toast.error('Informe o valor');

    setBusy(true);
    try {
      await api.post('/expenses', {
        description: form.description.trim(),
        category: form.category || null,
        amount: Number(form.amount),
        date: form.date,
        paymentMethod: form.paymentMethod,
      });
      toast.success('Despesa lançada');
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Não foi possível lançar');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet-overlay z-50 flex items-end justify-center bg-ink-950/80 sm:items-center sm:p-4">
      <div className="flex max-h-full w-full max-w-sm flex-col rounded-t-2xl border border-ink-800 bg-ink-900 sm:rounded-2xl">
        <header className="flex items-center justify-between border-b border-ink-800 px-5 py-4">
          <h2 className="text-[15px] text-ink-100">Nova despesa</h2>
          <button
            type="button"
            onClick={onClose}
            className="-mr-1.5 rounded-lg p-1.5 text-ink-400 transition-colors hover:text-ink-100"
            aria-label="Fechar"
          >
            <X size={18} strokeWidth={1.5} />
          </button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
          <div>
            <label className="label" htmlFor="desc">O que foi</label>
            <input
              id="desc"
              className="input"
              autoFocus
              placeholder="Compra de coloração, conta de luz..."
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="valor">Valor</label>
              <input
                id="valor"
                className="input tnum"
                inputMode="decimal"
                placeholder="0,00"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value.replace(',', '.') })}
              />
            </div>
            <div>
              <label className="label" htmlFor="data">Quando</label>
              <input
                id="data"
                type="date"
                className="input tnum"
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
              />
            </div>
          </div>

          <div>
            <p className="label">Categoria</p>
            <div className="flex flex-wrap gap-2">
              {CATEGORIAS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setForm({ ...form, category: form.category === c ? '' : c })}
                  className={clsx(
                    'rounded-lg border px-3 py-1.5 text-[13px] transition-colors',
                    form.category === c
                      ? 'border-brand-500 bg-brand-500/10 text-ink-100'
                      : 'border-ink-800 text-ink-400 hover:border-ink-700 hover:text-ink-200'
                  )}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="label" htmlFor="metodo">Como pagou</label>
            <select
              id="metodo"
              className="input"
              value={form.paymentMethod}
              onChange={(e) =>
                setForm({ ...form, paymentMethod: e.target.value as typeof form.paymentMethod })
              }
            >
              {METODOS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <footer className="safe-bottom flex gap-2 border-t border-ink-800 px-5 pt-4">
          <button type="button" onClick={onClose} className="btn-ghost flex-1">
            Cancelar
          </button>
          <button type="button" disabled={busy} onClick={submit} className="btn-primary flex-1">
            {busy && <Loader2 size={15} className="animate-spin" />} Lançar
          </button>
        </footer>
      </div>
    </div>
  );
}
