'use client';

import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { Loader2, Minus, Plus, Search, X } from 'lucide-react';
import { api, ApiClientError, money } from '@/lib/api-client';
import { formatPhoneBR } from '@/lib/format';

/**
 * Venda de balcão: o cliente entra só para levar um produto.
 *
 * Não abre agendamento — é o caminho de receita que faltava para quem não vem
 * ser atendido. Nasce paga, porque o dinheiro entra na hora.
 */

export type SaleProduct = {
  id: string;
  name: string;
  brand: string | null;
  price: number;
  trackStock: boolean;
  stockQuantity: number;
  active: boolean;
};

type ClientRow = { id: string; name: string; phone: string };

const METODOS = [
  { value: 'cash', label: 'Dinheiro' },
  { value: 'pix', label: 'Pix' },
  { value: 'card', label: 'Cartão' },
  { value: 'transfer', label: 'Transferência' },
  { value: 'other', label: 'Outro' },
] as const;

type Metodo = (typeof METODOS)[number]['value'];

export function NewSaleDialog({
  products,
  onClose,
  onSaved,
}: {
  products: SaleProduct[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busca, setBusca] = useState('');
  const [carrinho, setCarrinho] = useState<Record<string, number>>({});
  const [metodo, setMetodo] = useState<Metodo>('cash');
  const [notas, setNotas] = useState('');
  const [busy, setBusy] = useState(false);

  const [buscaCliente, setBuscaCliente] = useState('');
  const [clientes, setClientes] = useState<ClientRow[]>([]);
  const [cliente, setCliente] = useState<ClientRow | null>(null);

  const disponiveis = useMemo(() => products.filter((p) => p.active), [products]);

  const visiveis = useMemo(() => {
    const termo = busca.trim().toLowerCase();
    if (!termo) return disponiveis;
    return disponiveis.filter((p) =>
      [p.name, p.brand].some((v) => v?.toLowerCase().includes(termo))
    );
  }, [disponiveis, busca]);

  const itens = useMemo(
    () =>
      Object.entries(carrinho)
        .filter(([, qtd]) => qtd > 0)
        .map(([id, quantidade]) => ({
          product: disponiveis.find((p) => p.id === id)!,
          quantidade,
        }))
        .filter((i) => i.product),
    [carrinho, disponiveis]
  );

  const total = itens.reduce((soma, i) => soma + i.product.price * i.quantidade, 0);

  /** Quem não se cadastrou não precisa se cadastrar para levar um xampu. */
  useEffect(() => {
    const termo = buscaCliente.trim();
    if (termo.length < 2) {
      setClientes([]);
      return;
    }
    const timer = setTimeout(() => {
      api
        .get<{ items: ClientRow[] }>(`/clients?limit=5&search=${encodeURIComponent(termo)}`)
        .then((r) => setClientes(r.items))
        .catch(() => setClientes([]));
    }, 300);
    return () => clearTimeout(timer);
  }, [buscaCliente]);

  function ajustar(product: SaleProduct, delta: number) {
    setCarrinho((atual) => {
      const proximo = Math.max(0, (atual[product.id] ?? 0) + delta);
      if (product.trackStock && proximo > product.stockQuantity) {
        toast.error(
          product.stockQuantity > 0
            ? `Só há ${product.stockQuantity} de ${product.name} em estoque.`
            : `${product.name} está sem estoque.`
        );
        return atual;
      }
      return { ...atual, [product.id]: proximo };
    });
  }

  async function submit() {
    if (!itens.length) return toast.error('Adicione ao menos um produto');

    setBusy(true);
    try {
      await api.post('/sales', {
        clientId: cliente?.id ?? null,
        items: itens.map((i) => ({ productId: i.product.id, quantity: i.quantidade })),
        method: metodo,
        notes: notas.trim() || null,
      });
      toast.success(`Venda de ${money(total)} registrada`);
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Não foi possível registrar');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink-950/80 sm:items-center sm:p-4">
      <div className="flex max-h-[92dvh] w-full max-w-md flex-col rounded-t-2xl border border-ink-800 bg-ink-900 sm:rounded-2xl">
        <header className="flex items-center justify-between border-b border-ink-800 px-5 py-4">
          <div>
            <h2 className="text-[15px] text-ink-100">Venda avulsa</h2>
            <p className="text-xs text-ink-500">Produto vendido fora do atendimento</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="-mr-1.5 shrink-0 rounded-lg p-1.5 text-ink-400 transition-colors hover:text-ink-100"
            aria-label="Fechar"
          >
            <X size={18} strokeWidth={1.5} />
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
          {disponiveis.length === 0 ? (
            <p className="py-8 text-center text-sm leading-relaxed text-ink-500">
              Nenhum produto ativo no catálogo. Cadastre um produto antes de vender.
            </p>
          ) : (
            <>
              <div>
                <p className="label">Produtos</p>
                {disponiveis.length > 5 && (
                  <div className="relative mb-2">
                    <Search
                      size={15}
                      strokeWidth={1.5}
                      className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-500"
                    />
                    <input
                      className="input pl-9"
                      placeholder="Buscar produto"
                      value={busca}
                      onChange={(e) => setBusca(e.target.value)}
                    />
                  </div>
                )}

                <ul className="divide-y divide-ink-800">
                  {visiveis.map((product) => {
                    const quantidade = carrinho[product.id] ?? 0;
                    const semEstoque = product.trackStock && product.stockQuantity <= 0;
                    return (
                      <li key={product.id} className="flex items-center gap-3 py-2.5">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-ink-100">{product.name}</span>
                          <span className="tnum block truncate text-xs text-ink-500">
                            {money(product.price)}
                            {product.trackStock && ` · ${product.stockQuantity} em estoque`}
                          </span>
                        </span>

                        {quantidade > 0 ? (
                          <span className="flex shrink-0 items-center gap-1">
                            <button
                              type="button"
                              onClick={() => ajustar(product, -1)}
                              className="rounded-lg border border-ink-800 p-1.5 text-ink-300 transition-colors hover:border-ink-700"
                              aria-label={`Tirar um ${product.name}`}
                            >
                              <Minus size={14} strokeWidth={1.5} />
                            </button>
                            <span className="tnum w-6 text-center text-sm text-ink-100">
                              {quantidade}
                            </span>
                            <button
                              type="button"
                              onClick={() => ajustar(product, 1)}
                              className="rounded-lg border border-ink-800 p-1.5 text-ink-300 transition-colors hover:border-ink-700"
                              aria-label={`Somar um ${product.name}`}
                            >
                              <Plus size={14} strokeWidth={1.5} />
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            disabled={semEstoque}
                            onClick={() => ajustar(product, 1)}
                            className="shrink-0 rounded-lg border border-ink-800 px-3 py-1.5 text-[13px] text-ink-300 transition-colors hover:border-ink-700 hover:text-ink-100 disabled:cursor-not-allowed disabled:opacity-30"
                          >
                            {semEstoque ? 'sem estoque' : 'Adicionar'}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {visiveis.length === 0 && (
                  <p className="py-4 text-center text-xs text-ink-500">
                    Nenhum produto com esse termo.
                  </p>
                )}
              </div>

              <div>
                <p className="label">Pagamento</p>
                <div className="flex flex-wrap gap-2">
                  {METODOS.map((m) => (
                    <button
                      key={m.value}
                      type="button"
                      onClick={() => setMetodo(m.value)}
                      className={clsx(
                        'rounded-lg border px-3 py-1.5 text-[13px] transition-colors',
                        metodo === m.value
                          ? 'border-brand-500 bg-brand-500/10 text-ink-100'
                          : 'border-ink-800 text-ink-400 hover:border-ink-700 hover:text-ink-200'
                      )}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <p className="label">Cliente (opcional)</p>
                {cliente ? (
                  <div className="flex items-center justify-between gap-3 rounded-xl border border-ink-800 px-3 py-2.5">
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-ink-100">{cliente.name}</span>
                      <span className="block text-xs text-ink-500">
                        {formatPhoneBR(cliente.phone)}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setCliente(null);
                        setBuscaCliente('');
                      }}
                      className="shrink-0 rounded-lg p-1.5 text-ink-400 transition-colors hover:text-ink-100"
                      aria-label="Tirar cliente"
                    >
                      <X size={15} strokeWidth={1.5} />
                    </button>
                  </div>
                ) : (
                  <>
                    <input
                      className="input"
                      placeholder="Nome ou telefone — deixe vazio se não souber"
                      value={buscaCliente}
                      onChange={(e) => setBuscaCliente(e.target.value)}
                    />
                    {clientes.length > 0 && (
                      <ul className="mt-1 divide-y divide-ink-800 rounded-xl border border-ink-800">
                        {clientes.map((c) => (
                          <li key={c.id}>
                            <button
                              type="button"
                              onClick={() => setCliente(c)}
                              className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-ink-850"
                            >
                              <span className="truncate text-sm text-ink-200">{c.name}</span>
                              <span className="tnum shrink-0 text-xs text-ink-500">
                                {formatPhoneBR(c.phone)}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </div>

              <div>
                <label className="label">Observação</label>
                <input
                  className="input"
                  placeholder="Desconto combinado, presente..."
                  value={notas}
                  onChange={(e) => setNotas(e.target.value)}
                />
              </div>
            </>
          )}
        </div>

        <footer className="safe-bottom border-t border-ink-800 px-5 pt-4">
          <div className="mb-3 flex items-baseline justify-between">
            <span className="eyebrow">Total</span>
            <span className="tnum text-2xl font-light text-ink-100">{money(total)}</span>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="btn-ghost flex-1">
              Cancelar
            </button>
            <button
              type="button"
              disabled={busy || !itens.length}
              onClick={submit}
              className="btn-primary flex-1"
            >
              {busy && <Loader2 size={15} className="animate-spin" />} Registrar venda
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
