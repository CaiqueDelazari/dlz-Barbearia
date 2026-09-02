import { ok, route } from '@/lib/http';
import { requireRole } from '@/lib/auth';
import { sessionIdFor, sessionSnapshot, sessionStatus } from '@/server/services/whatsapp.service';

export const dynamic = 'force-dynamic';

/** Estado da sessao no gateway (bot Baileys) para a tela de WhatsApp do painel. */
export const GET = route(async (req: Request) => {
  const session = await requireRole(req, 'ADMIN');
  const sessionId = await sessionIdFor(session.tenantId);
  const status = await sessionStatus(sessionId);
  // O retrato traz o QR quando a sessao esta esperando leitura. Vem junto para
  // a tela nao precisar de uma segunda ida ao servidor so para descobrir isso.
  const snapshot = await sessionSnapshot(sessionId);
  return ok({ sessionId, status, session: snapshot });
});
