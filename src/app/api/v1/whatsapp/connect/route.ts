import { ok, route } from '@/lib/http';
import { requireRole } from '@/lib/auth';
import { sessionIdFor, startPairing } from '@/server/services/whatsapp.service';

export const dynamic = 'force-dynamic';

/**
 * Comeca o pareamento e devolve o QR para o painel desenhar.
 *
 * E' POST porque abre a sessao no bot -- nao e' leitura. O token do bot fica no
 * servidor: o navegador do dono recebe so a imagem do QR ja pronta.
 */
export const POST = route(async (req: Request) => {
  const session = await requireRole(req, 'ADMIN');
  const sessionId = await sessionIdFor(session.tenantId);
  const snapshot = await startPairing(sessionId);
  return ok({ sessionId, session: snapshot });
});
