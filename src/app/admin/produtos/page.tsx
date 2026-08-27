'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import {
  Loader2, Minus, Package, PackageX, Pencil, Plus, Search, Trash2, X,
} from 'lucide-react';
import { api, ApiClientError, money } from '@/lib/api-client';
import { formatDateTimeBR } from '@/lib/format';

type Product = {
  id: string;
  name: string;
  description: string | null;
  brand: string | null;
  category: string | null;
  sku: string | null;
  price: number;
  costPrice: number;
  trackStock: boolean;
  stockQuantity: number;
  minStock: number;
  imageUrl: string | null;
  displayOrder: number;
  active: boolean;
};

const EMPTY = {
  name: '',
  brand: '',
  category: '',
  sku: '',
  price: '',
  costPrice: '',
  trackStock: true,
  stockQuantity: '0',
  minStock: '0',
  description: '',
  active: true,
};

export default function ProdutosPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const [stockOf, setStockOf] = useState<Product | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.get<{ products: Product[] }>('/products');
      setProducts(result.products);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const categorias = useMemo(() => {
    const found: string[] = [];
    for (const p of products) {
      const c = p.category?.trim();
      if (c && !found.includes(c)) found.push(c);
    }
    return found.sort();
  }, [products]);

  const visiveis = useMemo(() => {
    const termo = search.trim().toLowerCase();
    if (!termo) return products;
    return products.filter((p) =>
      [p.name, p.brand, p.sku, p.category].some((v) => v?.toLowerCase().includes(termo))
    );
  }, [products, search]);

  const semEstoque = products.filter((p) => p.active && p.trackStock && p.stockQuantity <= p.minStock);
  const valorEstoque = products
    .filter((p) => p.active && p.trackStock)
    .reduce((sum, p) => sum + p.stockQuantity * p.costPrice, 0);

  async function remover(product: Product) {
    if (!confirm(`Remover "${product.name}"?`)) return;
    try {
      const r = await api.delete<{ softDeleted: boolean }>(`/products/${product.id}`);
      toast.success(r.softDeleted ? 'Produto desativado (já foi vendido)' : 'Produto removido');
      load();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Não foi possível remover');
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="display text-2xl tracking-wide text-ink-100">Produtos</h1>
          <p className="text-sm text-ink-400">Revenda no balcão e controle de estoque</p>
        </div>
        <button type="button" onClick={() => setEditing('new')} className="btn-primary">
          <Plus size={16} strokeWidth={1.5} /> Novo produto
        </button>
      </header>

      {products.length > 0 && (
        <section className="grid gap-3 sm:grid-cols-3">
          <article className="card p-4">
            <p className="eyebrow">Itens ativos</p>
            <p className="tnum mt-1 text-xl font-light text-ink-100">
              {products.filter((p) => p.active).length}
            </p>
          </article>
          <article className="card p-4">
            <p className="eyebrow">Valor em estoque (custo)</p>
            <p className="tnum mt-1 text-xl font-light text-ink-100">{money(valorEstoque)}</p>
          </article>
          <article className="card p-4">
            <p className="eyebrow">Precisa repor</p>
            <p
              className={clsx(
                'tnum mt-1 text-xl font-light',
                semEstoque.length ? 'text-state-warn' : 'text-ink-100'
              )}
            >
              {semEstoque.length}
            </p>
          </article>
        </section>
      )}

      {products.length > 4 && (
        <div className="relative">
          <Search size={15} strokeWidth={1.5} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-500" />
          <input
            className="input pl-9"
            placeholder="Buscar por nome, marca ou código"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16 text-ink-500">
          <Loader2 className="animate-spin" strokeWidth={1.5} />
        </div>
      ) : visiveis.length === 0 ? (
        <div className="card flex flex-col items-center gap-3 p-10 text-center">
          <Package size={26} strokeWidth={1.25} className="text-ink-600" />
          <p className="max-w-xs text-sm leading-relaxed text-ink-400">
            {products.length
              ? 'Nenhum produto encontrado com esse termo.'
              : 'Cadastre o que você revende — xampu, máscara, óleo. Depois é só somar no atendimento na hora de fechar a conta.'}
          </p>
          {!products.length && (
            <button type="button" onClick={() => setEditing('new')} className="btn-ghost">
              Cadastrar primeiro produto
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-6">
          {(categorias.length ? [...categorias, 'Sem categoria'] : ['Sem categoria']).map((categoria) => {
            const doGrupo = visiveis.filter((p) =>
              categoria === 'Sem categoria' ? !p.category?.trim() : p.category?.trim() === categoria
            );
            if (!doGrupo.length) return null;

            return (
              <section key={categoria}>
                {categorias.length > 0 && <p className="eyebrow mb-2">{categoria}</p>}
                <ul className="divide-y divide-ink-800">
                  {doGrupo.map((product) => {
                    const baixo = product.trackStock && product.stockQuantity <= product.minStock;
                    const margem = product.price - product.costPrice;
                    return (
                      <li key={product.id} className="flex items-center gap-3 py-3">
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="truncate text-[15px] text-ink-100">{product.name}</span>
                            {!product.active && <span className="badge text-ink-500">inativo</span>}
                          </span>
                          <span className="block truncate text-xs text-ink-500">
                            {product.brand ? `${product.brand} · ` : ''}
                            {money(product.price)}
                            {product.costPrice > 0 && ` · margem ${money(margem)}`}
                          </span>
                        </span>

                        {product.trackStock ? (
                          <button
                            type="button"
                            onClick={() => setStockOf(product)}
                            className={clsx(
                              'tnum shrink-0 rounded-lg border px-2.5 py-1 text-xs transition-colors',
                              baixo
                                ? 'border-state-warn/40 text-state-warn hover:bg-state-warn/10'
                                : 'border-ink-800 text-ink-300 hover:border-ink-700'
                            )}
                            title="Ajustar estoque"
                          >
                            {product.stockQuantity} un.
                          </button>
                        ) : (
                          <span className="shrink-0 text-xs text-ink-600">sem controle</span>
                        )}

                        <button
                          type="button"
                          onClick={() => setEditing(product)}
                          className="shrink-0 rounded-lg p-2 text-ink-400 transition-colors hover:text-ink-100"
                          aria-label="Editar"
                        >
                          <Pencil size={15} strokeWidth={1.5} />
                        </button>
                        <button
                          type="button"
                          onClick={() => remover(product)}
                          className="shrink-0 rounded-lg p-2 text-ink-400 transition-colors hover:text-state-bad"
                          aria-label="Remover"
                        >
                          <Trash2 size={15} strokeWidth={1.5} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      )}

      {editing && (
        <ProductDialog
          product={editing === 'new' ? null : editing}
          categorias={categorias}
          onClose={() => setEditing(null)}
          onSaved={load}
        />
      )}
      {stockOf && <StockDialog product={stockOf} onClose={() => setStockOf(null)} onSaved={load} />}
    </div>
  );
}

// ------------------------------------------------------------- cadastro
function ProductDialog({
  product,
  categorias,
  onClose,
  onSaved,
}: {
  product: Product | null;
  categorias: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState(
    product
      ? {
          name: product.name,
          brand: product.brand ?? '',
          category: product.category ?? '',
          sku: product.sku ?? '',
          price: String(product.price),
          costPrice: String(product.costPrice),
          trackStock: product.trackStock,
          stockQuantity: String(product.stockQuantity),
          minStock: String(product.minStock),
          description: product.description ?? '',
          active: product.active,
        }
      : EMPTY
  );
  const [busy, setBusy] = useState(false);

  const margem = Number(form.price || 0) - Number(form.costPrice || 0);

  async function submit() {
    if (!form.name.trim()) return toast.error('Informe o nome');
    if (Number.isNaN(Number(form.price)) || form.price === '') return toast.error('Informe o preço de venda');

    const payload: Record<string, unknown> = {
      name: form.name.trim(),
      brand: form.brand || null,
      category: form.category || null,
      sku: form.sku || null,
      price: Number(form.price),
      costPrice: Number(form.costPrice) || 0,
      trackStock: form.trackStock,
      minStock: Number(form.minStock) || 0,
      description: form.description || null,
    };
    if (product) payload.active = form.active;
    else payload.stockQuantity = Number(form.stockQuantity) || 0;

    setBusy(true);
    try {
      if (product) await api.patch(`/products/${product.id}`, payload);
      else await api.post('/products', payload);
      toast.success('Produto salvo');
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Não foi possível salvar');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell titulo={product ? 'Editar produto' : 'Novo produto'} onClose={onClose}>
      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
        <div>
          <label className="label">Nome</label>
          <input
            className="input"
            autoFocus
            placeholder="Xampu hidratante 300ml"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Marca</label>
            <input className="input" value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} />
          </div>
          <div>
            <label className="label">Categoria</label>
            <input
              className="input"
              list="categorias-produtos"
              placeholder="Cabelo, Finalizadores..."
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
            />
            <datalist id="categorias-produtos">
              {categorias.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Preço de venda</label>
            <input
              className="input tnum"
              inputMode="decimal"
              placeholder="0,00"
              value={form.price}
              onChange={(e) => setForm({ ...form, price: e.target.value.replace(',', '.') })}
            />
          </div>
          <div>
            <label className="label">Quanto você paga</label>
            <input
              className="input tnum"
              inputMode="decimal"
              placeholder="0,00"
              value={form.costPrice}
              onChange={(e) => setForm({ ...form, costPrice: e.target.value.replace(',', '.') })}
            />
          </div>
        </div>

        {Number(form.price) > 0 && Number(form.costPrice) > 0 && (
          <p className={clsx('text-xs', margem >= 0 ? 'text-ink-400' : 'text-state-bad')}>
            Margem por unidade: {money(margem)}
            {margem < 0 && ' — você está vendendo abaixo do custo.'}
          </p>
        )}

        <label className="flex items-start justify-between gap-3 rounded-xl border border-ink-800 px-3 py-3">
          <span>
            <span className="block text-sm text-ink-200">Controlar estoque</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-ink-500">
              Baixa sozinho a cada venda e avisa quando estiver acabando.
            </span>
          </span>
          <input
            type="checkbox"
            checked={form.trackStock}
            onChange={(e) => setForm({ ...form, trackStock: e.target.checked })}
            className="mt-0.5 h-5 w-5 shrink-0 accent-brand-500"
          />
        </label>

        {form.trackStock && (
          <div className="grid grid-cols-2 gap-3">
            {!product && (
              <div>
                <label className="label">Quantidade inicial</label>
                <input
                  className="input tnum"
                  inputMode="numeric"
                  value={form.stockQuantity}
                  onChange={(e) => setForm({ ...form, stockQuantity: e.target.value })}
                />
              </div>
            )}
            <div>
              <label className="label">Avisar quando chegar em</label>
              <input
                className="input tnum"
                inputMode="numeric"
                value={form.minStock}
                onChange={(e) => setForm({ ...form, minStock: e.target.value })}
              />
            </div>
          </div>
        )}

        {product && (
          <label className="flex items-center gap-2 text-sm text-ink-300">
            <input
              type="checkbox"
              checked={form.active}
              onChange={(e) => setForm({ ...form, active: e.target.checked })}
              className="h-4 w-4 accent-brand-500"
            />
            Produto ativo
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
    </Shell>
  );
}

// ---------------------------------------------------------------- estoque
function StockDialog({
  product,
  onClose,
  onSaved,
}: {
  product: Product;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [quantidade, setQuantidade] = useState('1');
  const [motivo, setMotivo] = useState<'restock' | 'adjustment' | 'loss'>('restock');
  const [notas, setNotas] = useState('');
  const [busy, setBusy] = useState(false);
  const [movimentos, setMovimentos] = useState<
    { id: string; quantity: number; reason: string; notes: string | null; createdAt: string; clientName: string | null }[]
  >([]);

  useEffect(() => {
    api
      .get<{ movements: typeof movimentos }>(`/products/${product.id}`)
      .then((r) => setMovimentos(r.movements))
      .catch(() => setMovimentos([]));
  }, [product.id]);

  const sinal = motivo === 'restock' ? 1 : motivo === 'loss' ? -1 : 1;
  const delta = (Number(quantidade) || 0) * sinal;
  const resultado = product.stockQuantity + (motivo === 'adjustment' ? 0 : delta);

  async function submit() {
    const qtd = Number(quantidade);
    if (!qtd) return toast.error('Informe a quantidade');

    // ajuste é contagem: manda a diferença até o número informado
    const quantity = motivo === 'adjustment' ? qtd - product.stockQuantity : qtd * sinal;
    if (!quantity) return toast.error('O estoque já está nesse número');

    setBusy(true);
    try {
      await api.post(`/products/${product.id}/stock`, {
        quantity,
        reason: motivo,
        notes: notas || null,
      });
      toast.success('Estoque atualizado');
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Não foi possível atualizar');
    } finally {
      setBusy(false);
    }
  }

  const REASONS = [
    { value: 'restock', label: 'Entrada', hint: 'Chegou mercadoria' },
    { value: 'adjustment', label: 'Contagem', hint: 'Corrigir para o número real' },
    { value: 'loss', label: 'Perda', hint: 'Quebrou, venceu, sumiu' },
  ] as const;

  return (
    <Shell titulo={product.name} onClose={onClose}>
      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
        <div className="flex items-baseline justify-between">
          <span className="eyebrow">Estoque atual</span>
          <span className="tnum text-2xl font-light text-ink-100">{product.stockQuantity} un.</span>
        </div>

        <div>
          <p className="label">O que aconteceu</p>
          <div className="flex flex-wrap gap-2">
            {REASONS.map((r) => (
              <button
                key={r.value}
                type="button"
                onClick={() => setMotivo(r.value)}
                className={clsx(
                  'rounded-lg border px-3 py-1.5 text-[13px] transition-colors',
                  motivo === r.value
                    ? 'border-brand-500 bg-brand-500/10 text-ink-100'
                    : 'border-ink-800 text-ink-400 hover:border-ink-700 hover:text-ink-200'
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-ink-500">
            {REASONS.find((r) => r.value === motivo)?.hint}
          </p>
        </div>

        <div>
          <label className="label">
            {motivo === 'adjustment' ? 'Quantidade contada' : 'Quantidade'}
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setQuantidade(String(Math.max(0, (Number(quantidade) || 0) - 1)))}
              className="btn-ghost px-3"
              aria-label="Diminuir"
            >
              <Minus size={15} strokeWidth={1.5} />
            </button>
            <input
              className="input tnum text-center"
              inputMode="numeric"
              value={quantidade}
              onChange={(e) => setQuantidade(e.target.value.replace(/\D/g, ''))}
            />
            <button
              type="button"
              onClick={() => setQuantidade(String((Number(quantidade) || 0) + 1))}
              className="btn-ghost px-3"
              aria-label="Aumentar"
            >
              <Plus size={15} strokeWidth={1.5} />
            </button>
          </div>
          <p className="mt-2 text-xs text-ink-400">
            {motivo === 'adjustment'
              ? `O estoque passa de ${product.stockQuantity} para ${Number(quantidade) || 0} un.`
              : `O estoque fica com ${resultado} un.`}
          </p>
        </div>

        <div>
          <label className="label">Observação</label>
          <input
            className="input"
            placeholder="Nota fiscal, fornecedor, motivo..."
            value={notas}
            onChange={(e) => setNotas(e.target.value)}
          />
        </div>

        {movimentos.length > 0 && (
          <div>
            <p className="label">Últimas movimentações</p>
            <ul className="divide-y divide-ink-800">
              {movimentos.slice(0, 8).map((m) => (
                <li key={m.id} className="flex items-center gap-3 py-2">
                  <span
                    className={clsx(
                      'tnum w-10 shrink-0 text-sm',
                      m.quantity > 0 ? 'text-brand-500' : 'text-ink-400'
                    )}
                  >
                    {m.quantity > 0 ? `+${m.quantity}` : m.quantity}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-ink-500">
                    {MOVIMENTO_LABEL[m.reason] ?? m.reason}
                    {m.clientName ? ` · ${m.clientName}` : ''}
                    {m.notes ? ` · ${m.notes}` : ''}
                  </span>
                  <span className="shrink-0 text-[11px] text-ink-600">
                    {formatDateTimeBR(m.createdAt).slice(0, 10)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <footer className="safe-bottom flex gap-2 border-t border-ink-800 px-5 pt-4">
        <button type="button" onClick={onClose} className="btn-ghost flex-1">
          Cancelar
        </button>
        <button type="button" disabled={busy} onClick={submit} className="btn-primary flex-1">
          {busy && <Loader2 size={15} className="animate-spin" />} Atualizar estoque
        </button>
      </footer>
    </Shell>
  );
}

const MOVIMENTO_LABEL: Record<string, string> = {
  sale: 'Venda',
  restock: 'Entrada',
  adjustment: 'Contagem',
  loss: 'Perda',
  return: 'Devolução',
};

function Shell({
  titulo,
  onClose,
  children,
}: {
  titulo: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink-950/80 sm:items-center sm:p-4">
      <div className="flex max-h-[92dvh] w-full max-w-md flex-col rounded-t-2xl border border-ink-800 bg-ink-900 sm:rounded-2xl">
        <header className="flex items-center justify-between border-b border-ink-800 px-5 py-4">
          <h2 className="truncate text-[15px] text-ink-100">{titulo}</h2>
          <button
            type="button"
            onClick={onClose}
            className="-mr-1.5 shrink-0 rounded-lg p-1.5 text-ink-400 transition-colors hover:text-ink-100"
            aria-label="Fechar"
          >
            <X size={18} strokeWidth={1.5} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
