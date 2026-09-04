import { z } from 'zod';
import { ApiError, clientIp, ok, parseBody, route } from '@/lib/http';
import { audit, requireRole } from '@/lib/auth';
import { query } from '@/lib/db';
import {
  DEFAULT_TEMPLATES,
  TEMPLATE_KEYS,
  WELCOME_VARS,
  syncAutoReply,
  variaveisDoTexto,
  type TemplateKey,
} from '@/server/services/notification.service';

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
        key: z.enum(TEMPLATE_KEYS),
        body: z.string().min(5).max(2000),
        enabled: z.boolean().optional(),
      })
    )
    .min(1),
});


export const PATCH = route(async (req: Request) => {
  const session = await requireRole(req, 'ADMIN');
  const body = await parseBody(req, schema);

  // A auto-resposta sai antes de existir agendamento: o bot so tem a loja em
  // maos quando dispara. Uma variavel de agendamento escrita ali chegaria ao
  // cliente com as chaves na tela -- e quem veria seria ele, nao o dono, entao
  // e' aqui que tem que parar.
  const welcome = body.templates.find((t) => t.key === 'welcome');
  if (welcome) {
    const invalidas = variaveisDoTexto(welcome.body).filter(
      (v) => !WELCOME_VARS.includes(v as (typeof WELCOME_VARS)[number])
    );
    if (invalidas.length) {
      throw ApiError.badRequest(
        `A mensagem de boas-vindas so aceita ${WELCOME_VARS.map((v) => `{${v}}`).join(' e ')}. ` +
          `Tire ${invalidas.map((v) => `{${v}}`).join(', ')}: quem recebe e' quem mandou mensagem, ` +
          'e ali ainda nao existe agendamento nenhum.'
      );
    }
  }

  for (const template of body.templates) {
    await query(
      `INSERT INTO notification_templates (tenant_id, key, channel, body, enabled)
       VALUES ($1,$2,'whatsapp',$3,COALESCE($4,true))
       ON CONFLICT (tenant_id, key, channel)
       DO UPDATE SET body = EXCLUDED.body, enabled = EXCLUDED.enabled, updated_at = now()`,
      [session.tenantId, template.key as TemplateKey, template.body, template.enabled ?? null]
    );
  }

  // O texto da boas-vindas mora no bot, nao aqui: sem empurrar, salvar na tela
  // nao muda o que o cliente recebe. Falhar aqui nao pode derrubar o
  // salvamento -- o texto ja esta gravado, e a proxima sincronizacao (salvar de
  // novo, ou parear) alcanca o bot.
  let autoRespostaSincronizada: boolean | null = null;
  if (welcome) {
    autoRespostaSincronizada = await syncAutoReply(session.tenantId).catch((err) => {
      console.error('[whatsapp] falha ao sincronizar a auto-resposta:', err);
      return false;
    });
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

  return ok({ updated: body.templates.length, autoRespostaSincronizada });
});
