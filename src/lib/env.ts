/** Leitura centralizada de variaveis de ambiente. Nenhum segredo no frontend. */

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Variavel de ambiente ausente: ${name}`);
  return value;
}

/**
 * Segredo de desenvolvimento que subiu junto e ninguem trocou e como nao ter
 * segredo nenhum: quem conhece o valor do repositorio assina o proprio token de
 * acesso e entra como dono de qualquer empresa. Em producao isto derruba o
 * processo na primeira requisicao, que e barulhento de proposito - falhar ao
 * subir e muito melhor do que subir aberto.
 */
const SEGREDOS_DE_EXEMPLO = [
  'dev-local-troque-em-producao-4f8a2c1e9b7d6350a1c2',
  'troque-esta-chave-por-uma-aleatoria-de-48-bytes',
  'troque-este-segredo',
];

function segredoForte(name: string, value: string, minimo = 32): string {
  if (process.env.NODE_ENV !== 'production') return value;
  if (SEGREDOS_DE_EXEMPLO.includes(value)) {
    throw new Error(
      `${name} ainda esta com o valor de exemplo. Gere um novo (openssl rand -base64 48) antes de subir.`
    );
  }
  if (value.length < minimo) {
    throw new Error(`${name} curto demais para producao (minimo ${minimo} caracteres).`);
  }
  return value;
}

export const env = {
  get databaseUrl() {
    return required('DATABASE_URL');
  },
  get databaseSsl() {
    const url = process.env.DATABASE_URL ?? '';
    if (process.env.DATABASE_SSL === 'false') return false;
    if (process.env.DATABASE_SSL === 'true') return true;
    return /sslmode=require|neon\.tech|supabase|render\.com|amazonaws/.test(url);
  },
  get jwtSecret() {
    return segredoForte('JWT_SECRET', required('JWT_SECRET'), 32);
  },
  accessTtlMin: Number(process.env.JWT_ACCESS_TTL_MIN ?? 30),
  refreshTtlDays: Number(process.env.JWT_REFRESH_TTL_DAYS ?? 30),

  appUrl: process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000',
  defaultTimezone: process.env.DEFAULT_TIMEZONE ?? 'America/Sao_Paulo',
  get cronSecret() {
    const value = process.env.CRON_SECRET ?? '';
    return value ? segredoForte('CRON_SECRET', value, 16) : '';
  },

  whatsapp: {
    enabled: process.env.WHATSAPP_ENABLED === 'true',
    apiUrl: process.env.WHATSAPP_API_URL ?? '',
    token: process.env.WHATSAPP_TOKEN ?? '',
  },

  payment: {
    provider: (process.env.PAYMENT_PROVIDER ?? 'manual') as 'manual' | 'mercadopago',
    mercadopagoToken: process.env.MERCADOPAGO_ACCESS_TOKEN ?? '',
    mercadopagoWebhookSecret: process.env.MERCADOPAGO_WEBHOOK_SECRET ?? '',
  },

  ai: {
    enabled: process.env.AI_ENABLED === 'true',
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    model: process.env.AI_MODEL ?? 'claude-opus-5',
  },
};
