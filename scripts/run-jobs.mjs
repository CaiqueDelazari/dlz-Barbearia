#!/usr/bin/env node
/**
 * Dispara o worker de jobs (lembretes, expiracao de reservas, convites de
 * retorno). Util para rodar via cron do servidor quando nao houver Vercel Cron:
 *
 *   * / 5 * * * * node scripts/run-jobs.mjs
 */
import 'dotenv/config';

const url = process.env.APP_URL ?? 'http://localhost:3000';
const secret = process.env.CRON_SECRET;

if (!secret) {
  console.error('CRON_SECRET nao definido.');
  process.exit(1);
}

const res = await fetch(`${url.replace(/\/$/, '')}/api/v1/jobs/run`, {
  method: 'POST',
  headers: { authorization: `Bearer ${secret}` },
});

const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`Falha (${res.status}):`, JSON.stringify(body));
  process.exit(1);
}

console.log(new Date().toISOString(), JSON.stringify(body.data ?? body));
