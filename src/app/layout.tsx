import type { Metadata, Viewport } from 'next';
import { Cormorant_Garamond, DM_Sans } from 'next/font/google';
import { Toaster } from 'react-hot-toast';
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

export const viewport: Viewport = {
  themeColor: '#0e0d0c',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1, // evita o zoom automático do iOS ao focar um input
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className={`${sans.variable} ${display.variable}`}>
      <body className="min-h-dvh bg-ink-950">
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
