import { ok, route } from '@/lib/http';
import { requireRole } from '@/lib/auth';
import { connectUrl, sessionIdFor, sessionStatus } from '@/server/services/whatsapp.service';

export const dynamic = 'force-dynamic';

/** Estado da sessao no gateway (bot Baileys) para a tela de WhatsApp do painel. */
export const GET = route(async (req: Request) => {
  const session = await requireRole(req, 'ADMIN');
  const sessionId = await sessionIdFor(session.tenantId);
  const status = await sessionStatus(sessionId);
  return ok({ sessionId, status, connectUrl: connectUrl(sessionId) });
});
