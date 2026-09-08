'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import clsx from 'clsx';
import {
  BarChart3, CalendarDays, ClipboardList, LayoutDashboard, LogOut, Menu, MessageCircle, Package,
  Scissors, Settings, Users, UserSquare2, Wallet, X,
} from 'lucide-react';
import { api } from '@/lib/api-client';

/**
 * `adminOnly` não é a proteção — a API recusa sozinha, e é ela que vale. Isto é
 * para o menu parar de oferecer a quem trabalha no balcão portas que só devolvem
 * "sem permissão".
 */
const NAV = [
  { href: '/admin', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/admin/agenda', label: 'Agenda', icon: CalendarDays },
  { href: '/admin/agendamentos', label: 'Agendamentos', icon: ClipboardList },
  { href: '/admin/clientes', label: 'Clientes', icon: Users },
  { href: '/admin/servicos', label: 'Serviços', icon: Scissors, adminOnly: true },
  { href: '/admin/produtos', label: 'Produtos', icon: Package },
  { href: '/admin/profissionais', label: 'Profissionais', icon: UserSquare2, adminOnly: true },
  { href: '/admin/financeiro', label: 'Financeiro', icon: Wallet, adminOnly: true },
  { href: '/admin/relatorios', label: 'Relatórios', icon: BarChart3, adminOnly: true },
  { href: '/admin/notificacoes', label: 'Notificações', icon: MessageCircle },
  { href: '/admin/whatsapp', label: 'WhatsApp', icon: MessageCircle, adminOnly: true },
  { href: '/admin/configuracoes', label: 'Configurações', icon: Settings, adminOnly: true },
];

type Me = {
  user: { name: string; role: string; email: string };
  tenant: { name: string; slug: string };
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    api
      .get<Me>('/auth/me')
      .then(setMe)
      .catch(() => router.push('/login'));
  }, [router]);

  useEffect(() => {
    setOpen(false); // fecha o menu ao navegar no celular
  }, [pathname]);

  const nav = NAV.filter((item) => !item.adminOnly || me?.user.role !== 'STAFF');

  async function logout() {
    await api.post('/auth/logout').catch(() => {});
    router.push('/login');
  }

  return (
    <div className="screen-min lg:flex">
      {/* ------------------------------------------------ topo (celular) */}
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-ink-800 bg-ink-950 px-4 py-3 lg:hidden">
        <button type="button" onClick={() => setOpen((v) => !v)} className="rounded-lg p-1.5 text-ink-300 hover:bg-ink-800">
          {open ? <X size={20} /> : <Menu size={20} />}
        </button>
        <span className="flex-1 truncate text-sm font-semibold text-ink-100">
          {me?.tenant.name ?? 'Painel'}
        </span>
      </header>

      {/* ------------------------------------------------------- sidebar */}
      <aside
        className={clsx(
          'z-20 w-full shrink-0 border-ink-800 bg-ink-900 lg:sticky lg:top-0 lg:block lg:h-dvh lg:w-64 lg:border-r',
          open ? 'block' : 'hidden lg:block'
        )}
      >
        <div className="hidden items-center gap-2 border-b border-ink-800 px-5 py-4 lg:flex">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-ink-850">
            <Scissors size={17} className="text-brand-500" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-ink-100">{me?.tenant.name ?? '...'}</span>
            <span className="block truncate text-xs text-ink-500">/{me?.tenant.slug}</span>
          </span>
        </div>

        <nav className="space-y-0.5 p-3">
          {nav.map(({ href, label, icon: Icon }) => {
            const active = href === '/admin' ? pathname === '/admin' : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={clsx(
                  'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors',
                  active ? 'bg-ink-800 font-semibold text-ink-100' : 'text-ink-300 hover:bg-ink-850 hover:text-ink-100'
                )}
              >
                <Icon size={17} className={active ? 'text-brand-500' : 'text-ink-500'} />
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-ink-800 p-3">
          <a
            href={`/agendar/${me?.tenant.slug ?? ''}`}
            target="_blank"
            rel="noreferrer"
            className="mb-2 block rounded-xl bg-ink-850 px-3 py-2.5 text-xs text-ink-300 hover:bg-ink-800"
          >
            Ver página pública →
          </a>
          <div className="flex items-center gap-2 px-1">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-ink-100">{me?.user.name}</span>
              <span className="block text-xs text-ink-500">{me?.user.role}</span>
            </span>
            <button type="button" onClick={logout} className="rounded-lg p-2 text-ink-400 hover:bg-ink-800" aria-label="Sair">
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 px-4 py-6 lg:px-8">{children}</main>
    </div>
  );
}
