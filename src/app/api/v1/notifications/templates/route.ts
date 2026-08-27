import { z } from 'zod';
import { clientIp, ok, parseBody, route } from '@/lib/http';
import { audit, requireRole } from '@/lib/auth';
import { query } from '@/lib/db';
import { DEFAULT_TEMPLATES, type TemplateKey } from '@/server/services/notification.service';

export const dynamic = 'force-dynamic';

/** Mensagens automaticas da empresa; sem linha cadastrada, vale o padrao do sistema. */
export const GET = route(async (req: Request) => {
  const session = await requireRole(req, 'ADMIN');
  const rows = await query<{ key: string; body: string; enabled: boolean }>(
    `SELECT key, body, enabled FROM notification_templates
      WHERE tenant_id = $1 AND channel = 'whatsapp'`,
    [session.tenantId]
  );

  const templates = Object.entries(DEFAULT_TEMPLATES).map(([key, defaultBody]) => {
    const row = rows.find((r) => r.key === key);
    return {
      key,
      body: row?.body ?? defaultBody,
      enabled: row?.enabled ?? true,
      isDefault: !row,
      defaultBody,
    };
  });

  return ok({
    templates,
    variaveis: [
      'cliente', 'nome_completo', 'empresa', 'data', 'hora', 'servicos', 'profissional',
      'valor_total', 'valor_pago', 'valor_restante', 'link', 'link_agendamento', 'dias',
    ],
  });
});

const schema = z.object({
  templates: z
    .array(
      z.object({
        key: z.enum(['confirmation', 'reminder_24h', 'reminder_1h', 'return', 'cancelled', 'payment_link']),
        body: z.string().min(5).max(2000),
        enabled: z.boolean().optional(),
      })
    )
    .min(1),
});

export const PATCH = route(async (req: Request) => {
  const session = await requireRole(req, 'ADMIN');
  const body = await parseBody(req, schema);

  for (const template of body.templates) {
    await query(
      `INSERT INTO notification_templates (tenant_id, key, channel, body, enabled)
       VALUES ($1,$2,'whatsapp',$3,COALESCE($4,true))
       ON CONFLICT (tenant_id, key, channel)
       DO UPDATE SET body = EXCLUDED.body, enabled = EXCLUDED.enabled, updated_at = now()`,
      [session.tenantId, template.key as TemplateKey, template.body, template.enabled ?? null]
    );
  }

  await audit({
    tenantId: session.tenantId,
    userId: session.userId,
    action: 'notification.template.update',
    entity: 'notification_template',
    entityId: null,
    after: body.templates.map((t) => t.key),
    ip: clientIp(req),
  });

  return ok({ updated: body.templates.length });
});
