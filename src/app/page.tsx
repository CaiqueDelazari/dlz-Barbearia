import Link from 'next/link';
import { CalendarCheck, CreditCard, MessageCircle, Scissors, ShieldCheck, Smartphone } from 'lucide-react';

export const metadata = {
  title: 'Agenda | Agendamento online para barbearias e salões',
};

const features = [
  {
    icon: CalendarCheck,
    title: 'Agenda que não erra',
    text: 'Duração real de cada serviço, horários combinados e nada de dois clientes no mesmo horário.',
  },
  {
    icon: CreditCard,
    title: 'Sinal ou pagamento integral',
    text: 'Pix e cartão com confirmação por webhook. O horário só é confirmado quando o dinheiro entra.',
  },
  {
    icon: MessageCircle,
    title: 'Lembretes no WhatsApp',
    text: 'Confirmação, aviso 24h e 1h antes, e convite de retorno para quem sumiu.',
  },
  {
    icon: Smartphone,
    title: 'Feito para o celular',
    text: 'Seu cliente agenda em menos de um minuto pelo link do Instagram ou WhatsApp.',
  },
  {
    icon: ShieldCheck,
    title: 'Cada empresa isolada',
    text: 'Multi-tenant de verdade: clientes, agenda e financeiro nunca se misturam.',
  },
  {
    icon: Scissors,
    title: 'Configurável por empresa',
    text: 'Serviços, horários, profissionais, políticas e mensagens — tudo no painel, sem tocar em código.',
  },
];

export default function HomePage() {
  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-16">
      <section className="mb-16 text-center">
        <p className="eyebrow mb-6">Agendamento online</p>
        <h1 className="display mx-auto max-w-2xl text-4xl leading-[1.15] tracking-wide text-ink-100 sm:text-6xl">
          A agenda da sua barbearia funcionando sozinha
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-[15px] text-ink-300 sm:text-base">
          Seu cliente escolhe o serviço, vê os horários reais, paga o sinal e recebe a confirmação.
          Você acompanha tudo pelo painel.
        </p>
        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          <Link href="/cadastro" className="btn-primary px-6 py-3 text-base">
            Cadastrar minha empresa
          </Link>
          <Link href="/login" className="btn-ghost px-6 py-3 text-base">
            Entrar no painel
          </Link>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {features.map(({ icon: Icon, title, text }) => (
          <article key={title} className="card p-5">
            <Icon size={22} className="mb-3 text-brand-500" />
            <h2 className="mb-1.5 text-[15px] text-ink-100">{title}</h2>
            <p className="text-sm leading-relaxed text-ink-400">{text}</p>
          </article>
        ))}
      </section>

      <footer className="mt-16 text-center text-xs text-ink-600">
        Cada empresa recebe seu próprio link: <code className="text-ink-400">/agendar/sua-empresa</code>
      </footer>
    </main>
  );
}
