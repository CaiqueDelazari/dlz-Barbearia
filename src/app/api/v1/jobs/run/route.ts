import { timingSafeEqual } from 'node:crypto';
import { ApiError, ok, route } from '@/lib/http';
import { env } from '@/lib/env';
import { expireHolds } from '@/server/services/appointment.service';
import { dispatchDueNotifications, scheduleReturnReminders } from '@/server/services/notification.service';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * So aceita o segredo no cabecalho. Aceitar `?secret=` era pratico e caro: query
 * string entra em log de acesso, em Referer e no historico do navegador, entao o
 * segredo do cron vazaria em texto puro em lugares que ninguem audita. O Vercel
 * Cron ja manda `Authorization: Bearer $CRON_SECRET` sozinho.
 */
function assertCronSecret(req: Request): void {
  if (!env.cronSecret) throw ApiError.forbidden('CRON_SECRET nao configurado');
  const header = req.headers.get('authorization') ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(provided);
  const b = Buffer.from(env.cronSecret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw ApiError.forbidden('Segredo invalido');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `?tenant=<uuid>` limita a rodada a uma empresa. Sem o parametro a varredura
 * e' global, que e' como o cron chama e como producao precisa ser.
 *
 * Nao e' uma brecha: quem chega aqui ja provou saber o CRON_SECRET, ou seja
 * ja podia rodar o worker no sistema inteiro. Restringir o alcance nao concede
 * nada a mais. Validar o formato de uuid e' so para o parametro nao chegar
 * cru ao banco.
 */
function tenantScope(req: Request): string | undefined {
  const bruto = new URL(req.url).searchParams.get('tenant');
  if (!bruto) return undefined;
  if (!UUID.test(bruto)) throw ApiError.badRequest('tenant precisa ser um uuid');
  return bruto;
}

/**
 * Worker unico chamado pelo cron (Vercel Cron, cron do servidor ou o proprio
 * scripts/run-jobs.mjs). Nenhum aviso depende de alguem com a pagina aberta.
 */
async function runJobs(tenantId?: string) {
  const expired = await expireHolds(tenantId);
  const returns = await scheduleReturnReminders(tenantId);
  const dispatched = await dispatchDueNotifications(80, tenantId);

  return {
    reservasExpiradas: expired,
    lembretesRetornoCriados: returns,
    mensagensEnviadas: dispatched.sent,
    mensagensComFalha: dispatched.failed,
    escopo: tenantId ?? 'todas as empresas',
    executadoEm: new Date().toISOString(),
  };
}

export const POST = route(async (req: Request) => {
  assertCronSecret(req);
  return ok(await runJobs(tenantScope(req)));
});

// Vercel Cron chama via GET
export const GET = route(async (req: Request) => {
  assertCronSecret(req);
  return ok(await runJobs(tenantScope(req)));
});
