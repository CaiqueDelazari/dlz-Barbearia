'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { Loader2, Scissors } from 'lucide-react';
import { api, ApiClientError } from '@/lib/api-client';

/**
 * Para onde ir depois de entrar.
 *
 * O middleware manda `?next=` com a pagina que a pessoa tentou abrir antes de
 * ser barrada, e o login ignorava: quem clicava num link direto do painel
 * caia sempre no Dashboard e tinha que navegar de novo.
 *
 * So caminho interno do painel entra. Um `next` sem essa trava aceita
 * `//site-de-fora.com` -- que o navegador le como outro dominio -- e a pagina
 * de login vira trampolim para uma copia dela, com a credencial ja digitada.
 *
 * Lido de `window.location` no clique, e nao por `useSearchParams`, para a
 * pagina continuar estatica: ela e' o healthcheck do container justamente por
 * nao depender de nada.
 */
function destinoSeguro(): string {
  if (typeof window === 'undefined') return '/admin';
  const alvo = new URLSearchParams(window.location.search).get('next') ?? '';
  return /^\/admin(\/|$)/.test(alvo) ? alvo : '/admin';
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tenant, setTenant] = useState('');
  const [needsTenant, setNeedsTenant] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api.post('/auth/login', {
        email: email.trim(),
        password,
        ...(tenant.trim() ? { tenant: tenant.trim() } : {}),
      });
      router.push(destinoSeguro());
      router.refresh();
    } catch (err) {
      if (err instanceof ApiClientError && err.code === 'tenant_required') {
        setNeedsTenant(true);
        toast('Informe qual empresa você quer acessar');
      } else {
        toast.error(err instanceof ApiClientError ? err.message : 'Falha ao entrar');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex screen-min w-full max-w-sm flex-col justify-center px-5">
      <div className="mb-8 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-ink-850">
          <Scissors size={20} className="text-brand-500" />
        </div>
        <h1 className="display text-2xl tracking-wide text-ink-100">Entrar no painel</h1>
        <p className="mt-1 text-sm text-ink-400">Gerencie a agenda da sua empresa</p>
      </div>

      <form onSubmit={submit} className="card space-y-4 p-5">
        <div>
          <label className="label" htmlFor="email">E-mail</label>
          <input
            id="email"
            type="email"
            className="input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
        </div>

        <div>
          <label className="label" htmlFor="senha">Senha</label>
          <input
            id="senha"
            type="password"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </div>

        {needsTenant && (
          <div>
            <label className="label" htmlFor="empresa">Identificador da empresa</label>
            <input
              id="empresa"
              className="input"
              value={tenant}
              onChange={(e) => setTenant(e.target.value)}
              placeholder="barbearia-do-joao"
            />
          </div>
        )}

        <button type="submit" disabled={busy} className="btn-primary w-full py-3">
          {busy && <Loader2 size={16} className="animate-spin" />} Entrar
        </button>
      </form>

      <p className="mt-5 text-center text-sm text-ink-400">
        Ainda não tem conta?{' '}
        <Link href="/cadastro" className="text-brand-500 hover:underline">
          Cadastrar empresa
        </Link>
      </p>
    </main>
  );
}
