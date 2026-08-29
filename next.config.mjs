const isProd = process.env.NODE_ENV === 'production';

/**
 * Content-Security-Policy.
 *
 * `'unsafe-inline'` em script-src não é descuido: o App Router injeta os dados
 * de hidratação em <script> inline, e sem nonce por requisição (que exigiria
 * middleware em toda rota) o app simplesmente não sobe com a política estrita.
 * O que dá para fechar de verdade está fechado — nada de `eval` em produção,
 * nada de plugin, nada de iframe, e o formulário só posta para nós mesmos.
 *
 * As imagens vêm de qualquer https porque logo, foto do profissional e foto do
 * produto ainda são URL colada pelo dono (o upload é pendência). Quem escreve
 * essa URL já passou por `imageUrlSchema`, que barra endereço interno.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  ...(isProd ? ['upgrade-insecure-requests'] : []),
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  // clickjacking: ninguém embute o painel num iframe para roubar clique
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // o link de gerenciamento do cliente vai por WhatsApp; o token não pode
  // vazar no Referer quando ele clicar em algo a partir da página
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
  ...(isProd
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' }]
    : []),
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // a versão do Next não é assunto do atacante
  poweredByHeader: false,
  images: {
    remotePatterns: [{ protocol: 'https', hostname: '**' }],
    // SVG remoto é script disfarçado de imagem; fica desligado
    dangerouslyAllowSVG: false,
    // se algo que não é imagem passar, o navegador baixa em vez de renderizar
    contentDispositionType: 'attachment',
    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;",
    minimumCacheTTL: 3600,
  },
  eslint: { ignoreDuringBuilds: true },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
