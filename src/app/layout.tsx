import type { Metadata, Viewport } from 'next';
import { Cormorant_Garamond, DM_Sans } from 'next/font/google';
import { Toaster } from 'react-hot-toast';
import { ViewportFix } from '@/components/ViewportFix';
import './globals.css';

/** DM Sans conduz a interface; Cormorant aparece só onde a marca fala. */
const sans = DM_Sans({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
const display = Cormorant_Garamond({
  subsets: ['latin'],
  weight: ['300', '400', '500'],
  variable: '--font-display',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Agenda | Agendamento online',
  description: 'Sistema de agendamento para estúdios de beleza, barbearias e salões.',
};

/**
 * Sem `maximumScale`: quem trava o zoom no iPhone nao ganha nada e perde duas
 * coisas. O zoom automatico ao focar um campo o Safari da assim mesmo -- o que
 * evita ele e o campo ter 16px, e isso agora esta no `globals.css`. E, travado,
 * o aparelho as vezes fica preso na escala ampliada, que e justamente a tela
 * que nao desce ate o fim. Deixando pinçar, quem precisa aumenta e volta.
 */
export const viewport: Viewport = {
  themeColor: '#0e0d0c',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className={`${sans.variable} ${display.variable}`}>
      <body className="screen-min bg-ink-950">
        <ViewportFix />
        {children}
        <Toaster
          position="top-center"
          toastOptions={{
            style: {
              background: '#171614',
              color: '#ede8e0',
              border: '1px solid #232120',
              borderRadius: '10px',
              fontSize: '14px',
            },
          }}
        />
      </body>
    </html>
  );
}
