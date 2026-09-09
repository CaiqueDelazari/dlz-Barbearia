import { z } from 'zod';
import { clientIp, ok, parseBody, rateLimit, route } from '@/lib/http';
import { audit, requireRole } from '@/lib/auth';
import { query } from '@/lib/db';
import { normalizePhone } from '@/server/repositories/client.repo';

export const dynamic = 'force-dynamic';

const schema = z.object({
  phone: z.string().min(10),
  message: z.string().min(1).max(2000),
  clientId: z.string().uuid().nullable().optional(),
  appointmentId: z.string().uuid().nullable().optional(),
  scheduledFor: z.string().datetime().optional(),
});

/**
 * Envio avulso pelo painel. Entra na mesma fila das automaticas - quem envia
 * de verdade e sempre o worker.
 *
 * ADMIN, e com teto por empresa. Isto escreve para QUALQUER numero, saindo do
 * WhatsApp da loja: uma sessao qualquer com acesso a esta rota e' spam
 * assinado pela barbearia, e o preco nao e' a mensagem -- e' o numero da loja
 * ser banido, que e' de onde sai a confirmacao de todo mundo. O limite e' por
 * tenant, e nao por IP, porque o que precisa ser protegido e' a sessao do bot.
 */
export const POST = route(async (req: Request) => {
  const session = await requireRole(req, 'ADMIN');
  await rateLimit(`notify-manual:${session.tenantId}`, 60, 60 * 60_000);

  const body = await parseBody(req, schema);
  const phone = normalizePhone(body.phone);

  const rows = await query<{ id: string }>(
    `INSERT INTO notifications
       (tenant_id, appointment_id, client_id, type, channel, to_phone, body, scheduled_for, dedupe_key)
     VALUES ($1,$2,$3,'manual','whatsapp',$4,$5,COALESCE($6::timestamptz, now()),$7)
     ON CONFLICT (tenant_id, dedupe_key) DO NOTHING
     RETURNING id`,
    [
      session.tenantId,
      body.appointmentId ?? null,
      body.clientId ?? null,
      phone,
      body.message,
      body.scheduledFor ?? null,
      `manual:${session.userId}:${Date.now()}`,
    ]
  );

  await audit({
    tenantId: session.tenantId,
    userId: session.userId,
    action: 'notification.manual',
    entity: 'notification',
    entityId: rows[0]?.id ?? null,
    after: { phone },
    ip: clientIp(req),
  });

  return ok({ queued: rows.length > 0, notificationId: rows[0]?.id ?? null }, 201);
});

/**
 * Fila recente, para acompanhar entregas na tela de Notificacoes.
 *
 * ADMIN como o resto da tela (os templates ja exigiam): a fila lista telefone
 * e texto enviado a cada cliente do salao, que e' a mesma carteira que
 * `listClients` recorta por profissional.
 */
export const GET = route(async (req: Request) => {
  const session = await requireRole(req, 'ADMIN');
  const notifications = await query(
    `SELECT n.id, n.type, n.to_phone AS "toPhone", n.body, n.status,
            n.scheduled_for AS "scheduledFor", n.sent_at AS "sentAt", n.attempts, n.error,
            c.name AS "clientName"
       FROM notifications n
       LEFT JOIN clients c ON c.id = n.client_id
      WHERE n.tenant_id = $1
      ORDER BY n.scheduled_for DESC
      LIMIT 100`,
    [session.tenantId]
  );
  return ok({ notifications });
});
