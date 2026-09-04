import { ok, route } from '@/lib/http';
import { requireRole } from '@/lib/auth';
import { sessionIdFor, startPairing } from '@/server/services/whatsapp.service';
import { syncAutoReply } from '@/server/services/notification.service';

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

  // A sessao acabou de nascer no bot, e config de sessao nova nasce vazia: sem
  // isto, parear deixaria a auto-resposta desligada mesmo com a mensagem
  // cadastrada aqui -- e o dono nao teria como saber, porque a tela dele
  // mostraria o texto certo. Falhar aqui nao pode atrapalhar o pareamento, que
  // e' o que o dono esta esperando ver.
  await syncAutoReply(session.tenantId).catch((err) =>
    console.error('[whatsapp] falha ao sincronizar a auto-resposta:', err)
  );

  return ok({ sessionId, session: snapshot });
});
