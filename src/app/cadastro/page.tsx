'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { Check, Loader2, Scissors } from 'lucide-react';
import { api, ApiClientError } from '@/lib/api-client';

export default function CadastroPage() {
  const router = useRouter();
  const [form, setForm] = useState({
    businessName: '',
    ownerName: '',
    email: '',
    phone: '',
    password: '',
  });
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ slug: string } | null>(null);

  const update = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api.post<{ slug: string }>('/signup', form);
      // ja entra logado para cair direto no painel
      await api.post('/auth/login', { email: form.email, password: form.password, tenant: result.slug });
      setCreated(result);
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Não foi possível criar a conta');
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5">
        <div className="card space-y-5 p-6 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-brand-500/15">
            <Check size={26} className="text-brand-500" strokeWidth={3} />
          </div>
          <div>
            <h1 className="display text-2xl tracking-wide text-ink-100">Empresa criada</h1>
            <p className="mt-2 text-sm text-ink-400">Este é o link para enviar aos seus clientes:</p>
            <code className="mt-2 block rounded-xl bg-ink-850 px-3 py-2 text-sm text-brand-500">
              /agendar/{created.slug}
            </code>
          </div>
          <p className="text-xs text-ink-500">
            Próximo passo: cadastre seus serviços e ajuste os horários de funcionamento no painel.
          </p>
          <button type="button" onClick={() => router.push('/admin/servicos')} className="btn-primary w-full py-3">
            Cadastrar serviços
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5 py-10">
      <div className="mb-8 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-ink-850">
          <Scissors size={20} className="text-brand-500" />
        </div>
        <h1 className="display text-2xl tracking-wide text-ink-100">Cadastrar empresa</h1>
        <p className="mt-1 text-sm text-ink-400">14 dias para testar, sem cartão</p>
      </div>

      <form onSubmit={submit} className="card space-y-4 p-5">
        <div>
          <label className="label" htmlFor="empresa">Nome da empresa</label>
          <input id="empresa" className="input" value={form.businessName} onChange={update('businessName')} required minLength={2} />
        </div>
        <div>
          <label className="label" htmlFor="dono">Seu nome</label>
          <input id="dono" className="input" value={form.ownerName} onChange={update('ownerName')} required minLength={2} />
        </div>
        <div>
          <label className="label" htmlFor="email">E-mail</label>
          <input id="email" type="email" className="input" value={form.email} onChange={update('email')} required autoComplete="email" />
        </div>
        <div>
          <label className="label" htmlFor="tel">WhatsApp</label>
          <input id="tel" className="input" value={form.phone} onChange={update('phone')} inputMode="tel" />
        </div>
        <div>
          <label className="label" htmlFor="senha">Senha</label>
          <input
            id="senha"
            type="password"
            className="input"
            value={form.password}
            onChange={update('password')}
            required
            minLength={8}
            autoComplete="new-password"
          />
          <p className="mt-1.5 text-xs text-ink-500">Mínimo de 8 caracteres.</p>
        </div>

        <button type="submit" disabled={busy} className="btn-primary w-full py-3">
          {busy && <Loader2 size={16} className="animate-spin" />} Criar minha conta
        </button>
      </form>

      <p className="mt-5 text-center text-sm text-ink-400">
        Já tem conta?{' '}
        <Link href="/login" className="text-brand-500 hover:underline">
          Entrar
        </Link>
      </p>
    </main>
  );
}
