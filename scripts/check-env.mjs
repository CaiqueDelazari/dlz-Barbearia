#!/usr/bin/env node
/**
 * Conferência de ambiente antes do build.
 *
 * Existe porque o jeito mais comum de vazar não é um ataque: é subir com o
 * segredo de exemplo, com o rate limit desligado ou com o banco sem SSL, e
 * ninguém perceber. Aqui o deploy quebra com a mensagem certa, que é o momento
 * barato de descobrir.
 *
 * Fora de um deploy (`VERCEL_ENV` ausente e sem `--strict`) só avisa: não é
 * papel desta checagem atrapalhar quem está desenvolvendo.
 */
import 'dotenv/config';

const alvo = process.env.VERCEL_ENV ?? process.env.APP_ENV ?? '';
const estrito = process.argv.includes('--strict') || alvo === 'production';

const erros = [];
const avisos = [];

const exigir = (cond, msg) => (estrito ? erros : avisos).push(...(cond ? [] : [msg]));
const avisar = (cond, msg) => cond || avisos.push(msg);

const SEGREDOS_DE_EXEMPLO = new Set([
  'dev-local-troque-em-producao-4f8a2c1e9b7d6350a1c2',
  'troque-esta-chave-por-uma-aleatoria-de-48-bytes',
  'troque-este-segredo',
]);

const {
  DATABASE_URL = '',
  DATABASE_SSL = '',
  JWT_SECRET = '',
  CRON_SECRET = '',
  APP_URL = '',
  NEXT_PUBLIC_APP_URL = '',
  RATE_LIMIT_DISABLED = '',
  UPSTASH_REDIS_REST_URL = '',
  UPSTASH_REDIS_REST_TOKEN = '',
  KV_REST_API_URL = '',
  KV_REST_API_TOKEN = '',
  PAYMENT_PROVIDER = 'manual',
  MERCADOPAGO_ACCESS_TOKEN = '',
  MERCADOPAGO_WEBHOOK_SECRET = '',
  WHATSAPP_ENABLED = '',
  WHATSAPP_API_URL = '',
  WHATSAPP_TOKEN = '',
  AI_ENABLED = '',
  ANTHROPIC_API_KEY = '',
} = process.env;

// ---------------------------------------------------------------- banco
exigir(!!DATABASE_URL, 'DATABASE_URL ausente.');
if (DATABASE_URL) {
  const local = /@(localhost|127\.0\.0\.1)/.test(DATABASE_URL);
  exigir(
    local || DATABASE_SSL === 'true' || /sslmode=require/.test(DATABASE_URL),
    'Banco remoto sem SSL: acrescente `?sslmode=require` na DATABASE_URL ou DATABASE_SSL=true.'
  );
  exigir(!local, 'DATABASE_URL aponta para localhost — isso não vai existir no servidor.');
}

// ---------------------------------------------------------------- segredos
exigir(!!JWT_SECRET, 'JWT_SECRET ausente.');
exigir(
  !SEGREDOS_DE_EXEMPLO.has(JWT_SECRET),
  'JWT_SECRET ainda é o valor de exemplo. Quem lê o repositório assina o próprio ' +
    'token e entra como dono. Gere outro: openssl rand -base64 48'
);
exigir(
  !JWT_SECRET || JWT_SECRET.length >= 32,
  `JWT_SECRET tem ${JWT_SECRET.length} caracteres; use ao menos 32.`
);

exigir(
  !!CRON_SECRET,
  'CRON_SECRET ausente: sem ele o worker recusa tudo e nenhum lembrete é enviado.'
);
exigir(
  !SEGREDOS_DE_EXEMPLO.has(CRON_SECRET),
  'CRON_SECRET ainda é o valor de exemplo.'
);

exigir(
  JWT_SECRET !== CRON_SECRET || !JWT_SECRET,
  'JWT_SECRET e CRON_SECRET são iguais: vazar um entrega os dois.'
);

// ---------------------------------------------------------------- app
const url = APP_URL || NEXT_PUBLIC_APP_URL;
exigir(!!url, 'APP_URL/NEXT_PUBLIC_APP_URL ausente: os links enviados ao cliente saem quebrados.');
exigir(
  !url || url.startsWith('https://'),
  `APP_URL precisa ser https em produção (está "${url}").`
);
avisar(
  !APP_URL || !NEXT_PUBLIC_APP_URL || APP_URL === NEXT_PUBLIC_APP_URL,
  'APP_URL e NEXT_PUBLIC_APP_URL estão diferentes — confira qual vai no link do cliente.'
);

// ---------------------------------------------------------------- limites
exigir(
  RATE_LIMIT_DISABLED !== 'true',
  'RATE_LIMIT_DISABLED=true: o código ignora isso em produção, mas a variável não ' +
    'deveria estar aí. Remova para não confundir quem ler depois.'
);

// Aviso, não erro: sem Redis o limite continua existindo, só que por instância.
// Barrar o deploy por causa disso seria pior que o problema — mas ninguém pode
// subir achando que o teto vale o número que está escrito.
const temRedis =
  (UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN) || (KV_REST_API_URL && KV_REST_API_TOKEN);
avisar(
  !!temRedis,
  'Sem Redis: o rate limit conta por instância. Com 4 instâncias, o teto de 5 ' +
    'tentativas de login vira 20. Provisione o Upstash na Vercel, ou ligue rate ' +
    'limiting no Vercel Firewall para /api/v1/auth/login e /api/v1/signup.'
);
avisar(
  !UPSTASH_REDIS_REST_URL || UPSTASH_REDIS_REST_URL.startsWith('https://'),
  'UPSTASH_REDIS_REST_URL deveria ser https.'
);

// ---------------------------------------------------------------- integrações
if (PAYMENT_PROVIDER === 'mercadopago') {
  exigir(!!MERCADOPAGO_ACCESS_TOKEN, 'PAYMENT_PROVIDER=mercadopago sem MERCADOPAGO_ACCESS_TOKEN.');
  exigir(
    !!MERCADOPAGO_WEBHOOK_SECRET,
    'PAYMENT_PROVIDER=mercadopago sem MERCADOPAGO_WEBHOOK_SECRET: qualquer um poderia ' +
      'avisar que um pagamento foi aprovado.'
  );
} else {
  avisar(
    PAYMENT_PROVIDER === 'manual',
    `PAYMENT_PROVIDER="${PAYMENT_PROVIDER}" não é reconhecido (use manual ou mercadopago).`
  );
}

if (WHATSAPP_ENABLED === 'true') {
  exigir(!!WHATSAPP_API_URL, 'WHATSAPP_ENABLED=true sem WHATSAPP_API_URL.');
  exigir(!!WHATSAPP_TOKEN, 'WHATSAPP_ENABLED=true sem WHATSAPP_TOKEN.');
  exigir(
    !WHATSAPP_API_URL || !WHATSAPP_API_URL.includes('localhost'),
    'WHATSAPP_API_URL aponta para localhost — o servidor não alcança a sua máquina.'
  );
} else {
  avisar(false, 'WhatsApp desligado: nenhuma mensagem sai da fila (elas ficam como `skipped`).');
}

if (AI_ENABLED === 'true') {
  exigir(!!ANTHROPIC_API_KEY, 'AI_ENABLED=true sem ANTHROPIC_API_KEY.');
}

// ---------------------------------------------------------------- saída
const rotulo = alvo ? `ambiente "${alvo}"` : 'ambiente local';

for (const a of avisos) console.warn(`  aviso  ${a}`);

if (erros.length) {
  console.error(`\nConferência de ambiente FALHOU (${rotulo}):\n`);
  for (const e of erros) console.error(`  erro   ${e}`);
  console.error('\nCorrija as variáveis e rode de novo.\n');
  process.exit(1);
}

console.log(
  `Conferência de ambiente OK (${rotulo})` +
    (avisos.length ? ` — ${avisos.length} aviso(s) acima.` : '.')
);
