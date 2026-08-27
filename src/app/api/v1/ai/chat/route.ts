import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ApiError, ok, parseBody, rateLimit, route } from '@/lib/http';
import { env } from '@/lib/env';
import { queryOne } from '@/lib/db';
import { normalizePhone } from '@/server/repositories/client.repo';
import { replyToMessage } from '@/server/services/ai/agent';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const schema = z.object({
  /** sessao do bot = slug da empresa (ou o whatsapp_session_id configurado) */
  session: z.string().min(1),
  phone: z.string().min(10),
  message: z.string().min(1).max(2000),
});

/**
 * Entrada de mensagem recebida no WhatsApp.
 * O bot Baileys chama esta rota; a resposta volta para ele enviar.
 * Protegida pelo mesmo segredo do gateway - nao e uma rota publica.
 */
export const POST = route(async (req: Request) => {
  const header = req.headers.get('authorization') ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  const expected = env.whatsapp.token;
  if (!expected) throw ApiError.forbidden('WHATSAPP_TOKEN nao configurado');
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw ApiError.unauthorized();

  const body = await parseBody(req, schema);
  rateLimit(`ai:${body.session}:${body.phone}`, 20, 60_000);

  const tenant = await queryOne<{ id: string }>(
    `SELECT t.id FROM tenants t
       LEFT JOIN business_settings bs ON bs.tenant_id = t.id
      WHERE t.active AND (bs.whatsapp_session_id = $1 OR t.slug = $1)
      LIMIT 1`,
    [body.session]
  );
  if (!tenant) throw ApiError.notFound('Sessao nao vinculada a nenhuma empresa');

  const result = await replyToMessage({
    tenantId: tenant.id,
    phone: normalizePhone(body.phone),
    message: body.message,
  });

  return ok(result);
});
