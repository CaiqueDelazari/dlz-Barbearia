import { timingSafeEqual } from 'node:crypto';
import { ApiError, ok, route } from '@/lib/http';
import { env } from '@/lib/env';
import { expireHolds } from '@/server/services/appointment.service';
import { dispatchDueNotifications, scheduleReturnReminders } from '@/server/services/notification.service';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function assertCronSecret(req: Request): void {
  if (!env.cronSecret) throw ApiError.forbidden('CRON_SECRET nao configurado');
  const header = req.headers.get('authorization') ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : new URL(req.url).searchParams.get('secret') ?? '';
  const a = Buffer.from(provided);
  const b = Buffer.from(env.cronSecret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw ApiError.forbidden('Segredo invalido');
}

/**
 * Worker unico chamado pelo cron (Vercel Cron, cron do servidor ou o proprio
 * scripts/run-jobs.mjs). Nenhum aviso depende de alguem com a pagina aberta.
 */
async function runJobs() {
  const expired = await expireHolds();
  const returns = await scheduleReturnReminders();
  const dispatched = await dispatchDueNotifications(80);

  return {
    reservasExpiradas: expired,
    lembretesRetornoCriados: returns,
    mensagensEnviadas: dispatched.sent,
    mensagensComFalha: dispatched.failed,
    executadoEm: new Date().toISOString(),
  };
}

export const POST = route(async (req: Request) => {
  assertCronSecret(req);
  return ok(await runJobs());
});

// Vercel Cron chama via GET
export const GET = route(async (req: Request) => {
  assertCronSecret(req);
  return ok(await runJobs());
});
