'use client';

import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { Ban, Check, Loader2, Package, Phone, Plus, Trash2, UserX, Wallet, X } from 'lucide-react';
import { api, ApiClientError, money } from '@/lib/api-client';
import { formatPhoneBR } from '@/lib/format';

export type AdminAppointment = {
  id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  payment_status: string;
  total_amount: number;
  paid_amount: number;
  client_name: string;
  client_phone: string;
  professional_name: string | null;
  notes: string | null;
  services: { id: string; name: string; price: number; durationMinutes: number }[];
};

type Sale = {
  id: string;
  productId: string | null;
  productName: string;
  unitPrice: number;
  quantity: number;
  total: number;
};

type CatalogProduct = {
  id: string;
  name: string;
  price: number;
  trackStock: boolean;
  stockQuantity: number;
};

export const STATUS_META: Record<string, { label: string; className: string }> = {
  pending: { label: 'Aguardando pagamento', className: 'bg-state-warn/10 text-state-warn' },
  confirmed: { label: 'Confirmado', className: 'bg-brand-500/10 text-brand-500' },
  completed: { label: 'Concluído', className: 'bg-state-ok/10 text-state-ok' },
  cancelled: { label: 'Cancelado', className: 'bg-state-bad/10 text-state-bad' },
  no_show: { label: 'Faltou', className: 'bg-state-bad/10 text-state-bad' },
  rescheduled: { label: 'Remarcado', className: 'text-ink-400' },
};

export function AppointmentDetails({
  appointment,
  onClose,
  onChanged,
}: {
  appointment: AdminAppointment;
  onClose: () => void;
  onChanged: () => void;
}) {
  // o total muda quando entra produto, entao guardamos a versao viva aqui
  const [current, setCurrent] = useState(appointment);
  const [busy, setBusy] = useState(false);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<'cash' | 'pix' | 'card'>('cash');
  const [sales, setSales] = useState<Sale[]>([]);
  const [catalog, setCatalog] = useState<CatalogProduct[]>([]);
  const [picking, setPicking] = useState(false);
  const [payments, setPayments] = useState<{ id: string; amount: number; method: string | null; status: string; kind: string; refundedAmount: number; refundReason: string | null }[]>([]);
  const [estornando, setEstornando] = useState<string | null>(null);

  const restante = Math.max(0, current.total_amount - current.paid_amount);

  const recarregar = useCallback(async () => {
    const [vendas, produtos] = await Promise.all([
      api.get<{ products: Sale[] }>(`/appointments/${appointment.id}/products`),
      api.get<{ products: CatalogProduct[] }>('/products?active=true'),
    ]);
    setSales(vendas.products);
    setCatalog(produtos.products);
  }, [appointment.id]);

  useEffect(() => {
    api
      .get<{ payments: typeof payments }>(`/appointments/${appointment.id}/payments`)
      .then((r) => setPayments(r.payments))
      .catch(() => setPayments([]));
    recarregar().catch(() => {
      setSales([]);
      setCatalog([]);
    });
  }, [appointment.id, recarregar]);

  // o campo de pagamento sempre sugere o que falta, inclusive depois de vender produto
  useEffect(() => {
    setAmount(restante ? String(restante.toFixed(2)) : '');
  }, [restante]);

  async function venderProduto(product: CatalogProduct) {
    setBusy(true);
    try {
      const r = await api.post<{ appointment: AdminAppointment }>(
        `/appointments/${appointment.id}/products`,
        { productId: product.id, quantity: 1 }
      );
      setCurrent(r.appointment);
      await recarregar();
      setPicking(false);
      toast.success(`${product.name} lançado`);
      onChanged();
    } catch (err) {
      // sem estoque o backend recusa e diz quanto sobrou
      toast.error(err instanceof ApiClientError ? err.message : 'Não foi possível lançar');
    } finally {
      setBusy(false);
    }
  }

  async function removerVenda(sale: Sale) {
    setBusy(true);
    try {
      const r = await api.delete<{ appointment: AdminAppointment }>(
        `/appointments/${appointment.id}/products?saleId=${sale.id}`
      );
      setCurrent(r.appointment);
      await recarregar();
      toast.success('Produto removido');
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Não foi possível remover');
    } finally {
      setBusy(false);
    }
  }

  async function changeStatus(status: string) {
    setBusy(true);
    try {
      await api.patch(`/appointments/${appointment.id}`, { status });
      toast.success('Status atualizado');
      onChanged();
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Falha ao atualizar');
    } finally {
      setBusy(false);
    }
  }

  async function registerPayment() {
    const value = Number(amount);
    if (!value || value <= 0) return toast.error('Informe o valor recebido');
    setBusy(true);
    try {
      await api.post(`/appointments/${appointment.id}/payments`, { amount: value, method });
      toast.success('Pagamento registrado');
      onChanged();
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Falha ao registrar');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Registra a devolução. O dinheiro sai pelo Pix ou pela maquininha, na mão do
   * dono — aqui só fica o registro, que é o que faz o caixa e o horário
   * voltarem a bater. Por isso o texto do confirm fala em "registrar", e não
   * em "estornar": prometer que o sistema devolve o dinheiro seria mentira.
   */
  async function estornar(paymentId: string, disponivel: number) {
    const bruto = prompt(
      `Quanto devolver? Restam ${money(disponivel)} neste pagamento.\n\n` +
        'O dinheiro você devolve pelo Pix ou pela maquininha — aqui fica o registro, ' +
        'que tira do caixa e volta o horário para não pago.',
      String(disponivel.toFixed(2))
    );
    if (bruto === null) return;

    const valor = Number(bruto.replace(',', '.'));
    if (!valor || valor <= 0) return toast.error('Informe um valor maior que zero');
    if (valor > disponivel) return toast.error(`O máximo é ${money(disponivel)}`);

    const motivo = prompt('Motivo (opcional) — fica no histórico:') ?? undefined;

    setEstornando(paymentId);
    try {
      await api.post(`/payments/${paymentId}/refund`, { amount: valor, reason: motivo || undefined });
      toast.success('Estorno registrado');
      const r = await api.get<{ payments: typeof payments }>(
        `/appointments/${appointment.id}/payments`
      );
      setPayments(r.payments);
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Falha ao estornar');
    } finally {
      setEstornando(null);
    }
  }

  const status = STATUS_META[current.status] ?? STATUS_META.pending;
  const finished = ['cancelled', 'completed', 'no_show'].includes(current.status);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink-950/80 sm:items-center sm:p-4">
      <div className="flex max-h-[92dvh] w-full max-w-md flex-col rounded-t-2xl border border-ink-800 bg-ink-900 sm:rounded-2xl">
        <header className="flex items-center justify-between border-b border-ink-800 px-5 py-4">
          <span className={clsx('badge', status.className)}>{status.label}</span>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-ink-400 hover:bg-ink-800">
            <X size={18} />
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
          <div>
            <p className="text-lg font-semibold text-ink-100">{appointment.client_name}</p>
            <a
              href={`https://wa.me/55${appointment.client_phone.replace(/\D/g, '')}`}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-flex items-center gap-1.5 text-sm text-brand-500 hover:underline"
            >
              <Phone size={13} /> {formatPhoneBR(appointment.client_phone)}
            </a>
          </div>

          <div className="space-y-1 text-sm">
            <p className="text-ink-300">
              {new Date(appointment.starts_at).toLocaleString('pt-BR', {
                weekday: 'long',
                day: '2-digit',
                month: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
              })}
              {' – '}
              {new Date(appointment.ends_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
            </p>
            {appointment.professional_name && (
              <p className="text-ink-400">Profissional: {appointment.professional_name}</p>
            )}
            {appointment.notes && <p className="text-ink-400">Obs.: {appointment.notes}</p>}
          </div>

          <ul className="space-y-1 border-t border-ink-800 pt-4 text-sm">
            {appointment.services.map((service) => (
              <li key={service.id} className="flex justify-between text-ink-300">
                <span>{service.name}</span>
                <span>{money(service.price)}</span>
              </li>
            ))}
          </ul>

          {/* ------------------------------------------------- produtos */}
          <div className="border-t border-ink-800 pt-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="eyebrow">Produtos</p>
              {!finished && (
                <button
                  type="button"
                  onClick={() => setPicking((v) => !v)}
                  className="inline-flex items-center gap-1.5 text-xs text-brand-500 transition-colors hover:text-ink-100"
                >
                  <Plus size={13} strokeWidth={1.5} /> {picking ? 'Fechar' : 'Vender produto'}
                </button>
              )}
            </div>

            {sales.length > 0 && (
              <ul className="mb-2 space-y-1 text-sm">
                {sales.map((sale) => (
                  <li key={sale.id} className="flex items-center gap-2 text-ink-300">
                    <span className="min-w-0 flex-1 truncate">
                      {sale.quantity > 1 && <span className="tnum text-ink-500">{sale.quantity}x </span>}
                      {sale.productName}
                    </span>
                    <span className="tnum shrink-0">{money(sale.total)}</span>
                    {!finished && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => removerVenda(sale)}
                        className="shrink-0 rounded p-1 text-ink-600 transition-colors hover:text-state-bad"
                        aria-label="Remover produto"
                      >
                        <Trash2 size={13} strokeWidth={1.5} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {picking && (
              <div className="max-h-56 overflow-y-auto rounded-xl border border-ink-800">
                {catalog.length ? (
                  <ul className="divide-y divide-ink-800">
                    {catalog.map((product) => {
                      const semEstoque = product.trackStock && product.stockQuantity <= 0;
                      return (
                        <li key={product.id}>
                          <button
                            type="button"
                            disabled={busy || semEstoque}
                            onClick={() => venderProduto(product)}
                            className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-ink-850 disabled:opacity-40"
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm text-ink-100">{product.name}</span>
                              <span className="block text-xs text-ink-500">
                                {product.trackStock
                                  ? semEstoque
                                    ? 'sem estoque'
                                    : `${product.stockQuantity} em estoque`
                                  : 'sem controle de estoque'}
                              </span>
                            </span>
                            <span className="tnum shrink-0 text-sm text-ink-300">{money(product.price)}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="flex items-center gap-2 px-3 py-4 text-xs text-ink-500">
                    <Package size={14} strokeWidth={1.5} /> Nenhum produto cadastrado ainda.
                  </p>
                )}
              </div>
            )}

            {!sales.length && !picking && (
              <p className="text-xs text-ink-500">Nada vendido neste atendimento.</p>
            )}
          </div>

          <div className="space-y-1 rounded-xl bg-ink-850 p-3 text-sm">
            <div className="flex justify-between">
              <span className="text-ink-400">Total</span>
              <span className="tnum font-semibold text-ink-100">{money(current.total_amount)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink-400">Pago</span>
              <span className="tnum text-brand-500">{money(current.paid_amount)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink-400">Restante</span>
              <span className={clsx('tnum', restante > 0 ? 'text-state-warn' : 'text-ink-300')}>
                {money(restante)}
              </span>
            </div>
          </div>

          {payments.length > 0 && (
            <div>
              <p className="label">Pagamentos</p>
              <ul className="space-y-2 text-xs text-ink-400">
                {payments.map((payment) => {
                  const devolvido = Number(payment.refundedAmount ?? 0);
                  const disponivel = Math.round((payment.amount - devolvido) * 100) / 100;
                  const podeEstornar =
                    disponivel > 0 && (payment.status === 'paid' || payment.status === 'refunded');
                  return (
                    <li key={payment.id}>
                      <div className="flex justify-between">
                        <span>
                          {payment.kind === 'deposit' ? 'Sinal' : payment.kind === 'onsite' ? 'Presencial' : 'Integral'}
                          {payment.method ? ` · ${payment.method}` : ''}
                        </span>
                        <span className={payment.status === 'paid' ? 'text-brand-500' : ''}>
                          {money(payment.amount)} · {payment.status}
                        </span>
                      </div>
                      {devolvido > 0 && (
                        <div className="mt-0.5 text-state-warn">
                          {money(devolvido)} devolvido
                          {payment.refundReason ? ` · ${payment.refundReason}` : ''}
                        </div>
                      )}
                      {podeEstornar && (
                        <button
                          type="button"
                          disabled={estornando === payment.id}
                          onClick={() => estornar(payment.id, disponivel)}
                          className="mt-1 text-xs text-ink-500 underline underline-offset-2 hover:text-state-warn disabled:opacity-50"
                        >
                          {estornando === payment.id ? 'Registrando…' : 'Registrar devolução'}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {!finished && (
            <div className="border-t border-ink-800 pt-4">
              <p className="label">Registrar pagamento recebido</p>
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <input
                  className="input"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(',', '.'))}
                  placeholder="0,00"
                />
                <select
                  className="input w-32"
                  value={method}
                  onChange={(e) => setMethod(e.target.value as typeof method)}
                >
                  <option value="cash">Dinheiro</option>
                  <option value="pix">Pix</option>
                  <option value="card">Cartão</option>
                </select>
              </div>
              <button type="button" disabled={busy} onClick={registerPayment} className="btn-ghost mt-2 w-full">
                <Wallet size={15} /> Registrar
              </button>
            </div>
          )}
        </div>

        {!finished && (
          <footer className="safe-bottom grid grid-cols-3 gap-2 border-t border-ink-800 px-5 pt-4">
            <button type="button" disabled={busy} onClick={() => changeStatus('completed')} className="btn-primary">
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Concluir
            </button>
            <button type="button" disabled={busy} onClick={() => changeStatus('no_show')} className="btn-ghost">
              <UserX size={15} /> Faltou
            </button>
            <button type="button" disabled={busy} onClick={() => changeStatus('cancelled')} className="btn-danger">
              <Ban size={15} /> Cancelar
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}
