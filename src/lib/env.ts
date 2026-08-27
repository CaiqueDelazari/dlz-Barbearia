/** Leitura centralizada de variaveis de ambiente. Nenhum segredo no frontend. */

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Variavel de ambiente ausente: ${name}`);
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
    return required('JWT_SECRET');
  },
  accessTtlMin: Number(process.env.JWT_ACCESS_TTL_MIN ?? 30),
  refreshTtlDays: Number(process.env.JWT_REFRESH_TTL_DAYS ?? 30),

  appUrl: process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000',
  defaultTimezone: process.env.DEFAULT_TIMEZONE ?? 'America/Sao_Paulo',
  cronSecret: process.env.CRON_SECRET ?? '',

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
