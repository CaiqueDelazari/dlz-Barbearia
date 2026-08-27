import type { Config } from 'tailwindcss';

/**
 * Paleta neutra quente. Sem cor de destaque gritante: o "acento" e a luz
 * (bone) e um champanhe dessaturado usado com parcimonia. Os tons de status
 * existem, mas com croma baixo para nao brigar com o resto da tela.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#0e0d0c', // fundo
          900: '#141312', // superficie
          850: '#171614', // superficie elevada
          800: '#232120', // hairline / borda
          700: '#2e2b29',
          600: '#3d3936',
          500: '#5b554f',
          400: '#8a8279', // texto terciario
          300: '#a79e93', // texto secundario
          200: '#d8d2c9', // texto
          100: '#ede8e0', // texto forte
        },
        bone: {
          DEFAULT: '#ede8e0',
          soft: '#d8d2c9',
        },
        // champanhe: unico toque de cor, propositalmente contido
        brand: {
          DEFAULT: '#c2ae93',
          400: '#cbbaa2',
          500: '#c2ae93',
          600: '#a8957c',
          700: '#8b7b66',
        },
        state: {
          ok: '#8b9b86',   // sage
          warn: '#b7a173', // areia
          bad: '#a8756c',  // tijolo
        },
      },
      borderRadius: { xl: '0.65rem', '2xl': '0.85rem' },
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        display: ['var(--font-display)', 'Georgia', 'serif'],
      },
      letterSpacing: { wider: '0.08em', widest: '0.22em' },
      keyframes: {
        'fade-up': { '0%': { opacity: '0', transform: 'translateY(4px)' }, '100%': { opacity: '1', transform: 'none' } },
        'draw-x': { '0%': { transform: 'scaleX(0)' }, '100%': { transform: 'scaleX(1)' } },
      },
      animation: {
        'fade-up': 'fade-up .28s cubic-bezier(.2,.7,.3,1) both',
        'draw-x': 'draw-x .4s cubic-bezier(.2,.7,.3,1) both',
      },
    },
  },
  plugins: [],
};
export default config;
