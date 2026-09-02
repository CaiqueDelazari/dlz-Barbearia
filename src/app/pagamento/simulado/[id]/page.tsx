'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import toast from 'react-hot-toast';
import { Check, CreditCard, Loader2 } from 'lucide-react';
import { api, shortMoney } from '@/lib/api-client';

/**
 * Checkout simulado do provider "manual".
 * Existe para dar para rodar o fluxo inteiro - reserva, pagamento, webhook,
 * confirmacao - antes de plugar o gateway real. Com PAYMENT_PROVIDER=mercadopago
 * o webhook aqui e recusado, entao a pagina fica inofensiva.
 */
export default function SimulatedPaymentPage() {
  const { id } = useParams<{ id: string }>();
  const [payment, setPayment] = useState<{ amount: number; status: string; manage_token: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<{ payment: { amount: number; status: string; manage_token: string | null } }>(`/payments/${id}`)
      .then((r) => setPayment(r.payment))
      .catch(() => toast.error('Pagamento não encontrado'));
  }, [id]);

  async function simulate(status: 'paid' | 'failed') {
    setBusy(true);
    try {
      const res = await fetch('/api/v1/payments/webhook/manual', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paymentId: id, status, eventId: `sim-${id}-${status}` }),
      });
      if (!res.ok) throw new Error('falha');
      toast.success(status === 'paid' ? 'Pagamento aprovado' : 'Pagamento recusado');
      const updated = await api.get<{ payment: typeof payment }>(`/payments/${id}`);
      setPayment(updated.payment);
    } catch {
      toast.error('Não foi possível simular o pagamento');
    } finally {
      setBusy(false);
    }
  }

  if (!payment) {
    return (
      <div className="flex min-h-dvh items-center justify-center text-ink-400">
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  const paid = payment.status === 'paid';

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4">
      <div className="card space-y-5 p-6 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-ink-850">
          {paid ? <Check size={26} className="text-brand-500" /> : <CreditCard size={24} className="text-ink-300" />}
        </div>

        <div>
          <p className="text-xs uppercase tracking-wide text-ink-500">Checkout de teste</p>
          <p className="mt-1 text-3xl font-bold text-ink-100">{shortMoney(payment.amount)}</p>
          <p className="mt-1 text-sm text-ink-400">
            Status atual: <span className="text-ink-100">{payment.status}</span>
          </p>
        </div>

        {!paid ? (
          <div className="space-y-2">
            <button type="button" disabled={busy} onClick={() => simulate('paid')} className="btn-primary w-full py-3">
              {busy && <Loader2 size={16} className="animate-spin" />} Simular pagamento aprovado
            </button>
            <button type="button" disabled={busy} onClick={() => simulate('failed')} className="btn-ghost w-full">
              Simular recusa
            </button>
          </div>
        ) : (
          payment.manage_token && (
            <a href={`/agendamento/${payment.manage_token}`} className="btn-primary w-full py-3">
              Ver meu agendamento
            </a>
          )
        )}
      </div>
    </div>
  );
}
