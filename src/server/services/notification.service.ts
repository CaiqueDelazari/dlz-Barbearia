import { query, queryOne } from '@/lib/db';
import { env } from '@/lib/env';
import { formatDateBR, utcToZoned } from '@/lib/datetime';
import { getTenantContext } from '../repositories/tenant.repo';
import { sendWhatsapp, sessionIdFor, setAutoReply } from './whatsapp.service';

/**
 * Notificacoes sao SEMPRE materializadas em linha na tabela `notifications`
 * com um horario para sair. Quem envia e o worker (/api/v1/jobs/run), nunca a
 * requisicao do cliente - por isso o lembrete de 24h sobrevive a qualquer
 * deploy ou aba fechada.
 */

export type TemplateKey =
  | 'confirmation'
  | 'reminder_24h'
  | 'reminder_1h'
  | 'return'
  | 'cancelled'
  | 'payment_link'
  // Avisos para a propria loja. Vao para `owner_notify_phone`, nao para o
  // cliente, e por isso nao levam link de gerenciamento nenhum.
  | 'owner_new'
  | 'owner_cancelled'
  | 'owner_rescheduled'
  // Auto-resposta de quem manda mensagem no WhatsApp da loja. Unica que nao
  // passa pela fila de `notifications`: quem dispara e' o bot, no instante em
  // que a mensagem chega. Aqui mora so o texto, empurrado para a sessao dele.
  | 'welcome';

export const DEFAULT_TEMPLATES: Record<TemplateKey, string> = {
  confirmation:
    'Olá, {cliente}! ✅ Seu horário na {empresa} está confirmado.\n\n' +
    '🗓️ {data} às {hora}\n💈 {servicos}\n👤 {profissional}\n💰 Total: {valor_total}' +
    '\n\nPara ver, remarcar ou cancelar: {link}',
  reminder_24h:
    'Olá, {cliente}! Passando para lembrar que seu horário na {empresa} é amanhã às {hora}.\n\n' +
    '💈 {servicos}\n\nSe precisar remarcar: {link}',
  reminder_1h: '{cliente}, seu horário na {empresa} é daqui a 1 hora ({hora}). Te esperamos! 💈',
  return:
    'Fala, {cliente}! Já faz {dias} dias desde seu último corte na {empresa}. ' +
    'Que tal agendar seu próximo horário? 💈\n\n{link_agendamento}',
  cancelled:
    'Olá, {cliente}. Seu horário na {empresa} em {data} às {hora} foi cancelado.\n' +
    'Para agendar novamente: {link_agendamento}',
  payment_link:
    'Olá, {cliente}! Para confirmar seu horário na {empresa} em {data} às {hora}, ' +
    'finalize o pagamento de {valor_pagar} aqui: {link_pagamento}\n\n' +
    'A reserva fica guardada por {minutos} minutos.',
  owner_new:
    '📅 Novo agendamento\n\n{nome_completo} — {telefone_cliente}\n' +
    '🗓️ {data} às {hora}\n💈 {servicos}\n👤 {profissional}\n💰 {valor_total}',
  owner_cancelled:
    '❌ Cancelamento\n\n{nome_completo} desmarcou {data} às {hora}\n' +
    '💈 {servicos}\n👤 {profissional}',
  owner_rescheduled:
    '🔄 Remarcação\n\n{nome_completo} mudou para {data} às {hora}\n' +
    '💈 {servicos}\n👤 {profissional}',
  welcome:
    'Olá! 👋 Seja bem-vindo(a) à {empresa}!\n\n' +
    'Para agendar seu corte, é só clicar aqui:\n{link_agendamento}\n\n' +
    'Se preferir, pode falar por aqui mesmo — respondemos assim que der.',
};

/**
 * As únicas variáveis que a auto-resposta consegue preencher.
 *
 * Ela sai antes de existir agendamento, cliente ou horário: quem dispara é o
 * bot, no instante em que uma mensagem chega, e o único contexto que existe ali
 * é a loja. Um `{cliente}` escrito neste texto chegaria ao cliente com as
 * chaves na tela — por isso o salvamento recusa, em vez de deixar passar.
 */
export const WELCOME_VARS = ['empresa', 'link_agendamento'] as const;

/**
 * Toda chave de template que existe, derivada do objeto acima.
 *
 * Fica aqui, e nao numa lista escrita a mao na rota, porque ja aconteceu de as
 * duas divergirem: os avisos do dono entraram no `DEFAULT_TEMPLATES`, a lista da
 * rota ficou nos seis originais, e como a tela manda todos os templates num
 * PATCH so, o zod passou a recusar o array inteiro. A tela de Notificacoes parou
 * de salvar qualquer coisa -- inclusive os seis que continuavam validos.
 */
export const TEMPLATE_KEYS = Object.keys(DEFAULT_TEMPLATES) as [TemplateKey, ...TemplateKey[]];

/** Variaveis escritas num texto, sem repetir. */
export const variaveisDoTexto = (body: string): string[] => [
  ...new Set(Array.from(body.matchAll(/\{(\w+)\}/g), (m) => m[1])),
];

export function render(body: string, vars: Record<string, string | number>): string {
  return body.replace(/\{(\w+)\}/g, (match, key) =>
    key in vars ? String(vars[key]) : match
  );
}

async function templateFor(tenantId: string, key: TemplateKey): Promise<string | null> {
  const row = await queryOne<{ body: string; enabled: boolean }>(
    `SELECT body, enabled FROM notification_templates
      WHERE tenant_id = $1 AND key = $2 AND channel = 'whatsapp'`,
    [tenantId, key]
  );
  if (row && !row.enabled) return null;
  return row?.body ?? DEFAULT_TEMPLATES[key];
}

const money = (value: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value || 0);

type ApptData = {
  id: string;
  starts_at: Date;
  total_amount: number;
  paid_amount: number;
  client_id: string;
  client_name: string;
  client_phone: string;
  professional_name: string | null;
  services: string;
  manage_token: string | null;
  group_token: string | null;
};

async function loadAppointmentData(tenantId: string, appointmentId: string): Promise<ApptData | null> {
  return queryOne<ApptData>(
    `SELECT a.id, a.starts_at, a.total_amount::float8 AS total_amount,
            a.paid_amount::float8 AS paid_amount, a.client_id,
            c.name AS client_name, c.phone AS client_phone,
            p.name AS professional_name,
            COALESCE((SELECT string_agg(s.service_name, ' + ' ORDER BY s.position)
                        FROM appointment_services s WHERE s.appointment_id = a.id), '') AS services,
            a.manage_token,
            (SELECT g.manage_token FROM appointments g
              WHERE g.booking_group_id = a.booking_group_id AND g.manage_token IS NOT NULL
              LIMIT 1) AS group_token
       FROM appointments a
       JOIN clients c ON c.id = a.client_id
       LEFT JOIN professionals p ON p.id = a.professional_id
      WHERE a.tenant_id = $1 AND a.id = $2`,
    [tenantId, appointmentId]
  );
}

async function enqueue(input: {
  tenantId: string;
  appointmentId: string | null;
  clientId: string | null;
  type: string;
  phone: string;
  body: string;
  scheduledFor: Date;
  dedupeKey: string;
}): Promise<void> {
  await query(
    `INSERT INTO notifications
       (tenant_id, appointment_id, client_id, type, channel, to_phone, body, scheduled_for, dedupe_key)
     VALUES ($1,$2,$3,$4,'whatsapp',$5,$6,$7,$8)
     ON CONFLICT (tenant_id, dedupe_key) DO NOTHING`,
    [
      input.tenantId,
      input.appointmentId,
      input.clientId,
      input.type,
      input.phone,
      input.body,
      input.scheduledFor,
      input.dedupeKey,
    ]
  );
}

export async function scheduleAppointmentNotifications(
  tenantId: string,
  appointmentId: string,
  opts: { includeConfirmation?: boolean } = { includeConfirmation: true }
): Promise<void> {
  const { tenant, settings } = await getTenantContext(tenantId);
  const appt = await loadAppointmentData(tenantId, appointmentId);
  if (!appt) return;

  const zoned = utcToZoned(new Date(appt.starts_at), tenant.timezone);
  const token = appt.manage_token ?? appt.group_token;
  const vars: Record<string, string | number> = {
    cliente: appt.client_name.split(' ')[0],
    nome_completo: appt.client_name,
    empresa: tenant.name,
    data: formatDateBR(zoned.dateStr),
    hora: zoned.timeStr,
    servicos: appt.services,
    profissional: appt.professional_name ?? tenant.name,
    valor_total: money(appt.total_amount),
    valor_pago: money(appt.paid_amount),
    valor_restante: money(Math.max(0, appt.total_amount - appt.paid_amount)),
    link: token ? `${env.appUrl}/agendamento/${token}` : `${env.appUrl}/agendar/${tenant.slug}`,
    link_agendamento: `${env.appUrl}/agendar/${tenant.slug}`,
  };

  const startsAt = new Date(appt.starts_at).getTime();
  const now = Date.now();

  if (opts.includeConfirmation !== false) {
    const body = await templateFor(tenantId, 'confirmation');
    if (body) {
      await enqueue({
        tenantId,
        appointmentId,
        clientId: appt.client_id,
        type: 'confirmation',
        phone: appt.client_phone,
        body: render(body, vars),
        scheduledFor: new Date(),
        dedupeKey: `${appointmentId}:confirmation:${startsAt}`,
      });
    }
  }

  if (settings.reminder_24h_enabled) {
    const when = new Date(startsAt - 24 * 3_600_000);
    if (when.getTime() > now) {
      const body = await templateFor(tenantId, 'reminder_24h');
      if (body) {
        await enqueue({
          tenantId,
          appointmentId,
          clientId: appt.client_id,
          type: 'reminder_24h',
          phone: appt.client_phone,
          body: render(body, vars),
          scheduledFor: when,
          dedupeKey: `${appointmentId}:reminder_24h:${startsAt}`,
        });
      }
    }
  }

  if (settings.reminder_1h_enabled) {
    const when = new Date(startsAt - 3_600_000);
    if (when.getTime() > now) {
      const body = await templateFor(tenantId, 'reminder_1h');
      if (body) {
        await enqueue({
          tenantId,
          appointmentId,
          clientId: appt.client_id,
          type: 'reminder_1h',
          phone: appt.client_phone,
          body: render(body, vars),
          scheduledFor: when,
          dedupeKey: `${appointmentId}:reminder_1h:${startsAt}`,
        });
      }
    }
  }
}

/**
 * Aviso para a propria loja -- agendamento novo, cancelamento, remarcacao.
 *
 * Vai para `owner_notify_phone`, nunca para o cliente, entao nao leva link de
 * gerenciamento: quem recebe ja tem o painel. Sem numero cadastrado nao ha para
 * onde mandar e a funcao sai calada, do mesmo jeito que o envio ao cliente sai
 * quando o template esta desligado.
 *
 * Falhar aqui nao pode derrubar o agendamento -- quem chama trata com .catch(),
 * igual aos avisos do cliente.
 */
export async function notifyOwner(
  tenantId: string,
  appointmentId: string,
  key: 'owner_new' | 'owner_cancelled' | 'owner_rescheduled'
): Promise<void> {
  const { tenant, settings } = await getTenantContext(tenantId);
  if (!settings.owner_notify_enabled) return;
  const phone = settings.owner_notify_phone?.trim();
  if (!phone) return;

  const appt = await loadAppointmentData(tenantId, appointmentId);
  if (!appt) return;

  const body = await templateFor(tenantId, key);
  if (!body) return;

  const zoned = utcToZoned(new Date(appt.starts_at), tenant.timezone);
  const startsAt = new Date(appt.starts_at).getTime();

  await enqueue({
    tenantId,
    appointmentId,
    clientId: appt.client_id,
    type: key,
    phone,
    body: render(body, {
      cliente: appt.client_name.split(' ')[0],
      nome_completo: appt.client_name,
      telefone_cliente: appt.client_phone,
      empresa: tenant.name,
      data: formatDateBR(zoned.dateStr),
      hora: zoned.timeStr,
      servicos: appt.services,
      profissional: appt.professional_name ?? tenant.name,
      valor_total: money(appt.total_amount),
    }),
    scheduledFor: new Date(),
    // A hora do atendimento entra na chave para que a remarcacao gere um aviso
    // novo em vez de esbarrar no aviso da hora antiga.
    dedupeKey: `${appointmentId}:${key}:${startsAt}`,
  });
}

/**
 * Empurra a auto-resposta desta loja para a sessão dela no bot.
 *
 * Quem responde é o bot, não a aplicação: ele já guarda um texto por sessão e o
 * dispara para quem manda mensagem — pulando grupo, status, mensagem própria e
 * sincronização de histórico, com um intervalo por contato para não repetir a
 * boas-vindas a cada frase. O que faltava era dizer a ele **qual** texto, e o
 * texto é daqui, porque só este lado sabe o nome da loja e o link dela.
 *
 * Chamar isto é barato e idempotente: grava um arquivo por sessão no bot. Por
 * isso vale chamar sempre que o texto ou a sessão puderem ter mudado (ao parear
 * e ao salvar as mensagens) em vez de tentar adivinhar quando mudou.
 *
 * Template desligado manda `enabled: false` em vez de simplesmente não chamar —
 * desligar na tela precisa desligar no bot, senão o texto antigo continua
 * saindo e ninguém entende por quê.
 */
export async function syncAutoReply(tenantId: string): Promise<boolean> {
  const { tenant } = await getTenantContext(tenantId);
  const sessionId = await sessionIdFor(tenantId);
  const body = await templateFor(tenantId, 'welcome');

  return setAutoReply(sessionId, {
    enabled: Boolean(body),
    message: body
      ? render(body, {
          empresa: tenant.name,
          link_agendamento: `${env.appUrl}/agendar/${tenant.slug}`,
        })
      : '',
  });
}

export async function cancelScheduledNotifications(
  tenantId: string,
  appointmentId: string
): Promise<void> {
  await query(
    `UPDATE notifications SET status = 'cancelled'
      WHERE tenant_id = $1 AND appointment_id = $2 AND status = 'scheduled'`,
    [tenantId, appointmentId]
  );
}

export async function notifyPaymentLink(input: {
  tenantId: string;
  appointmentId: string;
  amount: number;
  url: string;
  minutes: number;
}): Promise<void> {
  const { tenant } = await getTenantContext(input.tenantId);
  const appt = await loadAppointmentData(input.tenantId, input.appointmentId);
  if (!appt) return;
  const body = await templateFor(input.tenantId, 'payment_link');
  if (!body) return;
  const zoned = utcToZoned(new Date(appt.starts_at), tenant.timezone);

  await enqueue({
    tenantId: input.tenantId,
    appointmentId: input.appointmentId,
    clientId: appt.client_id,
    type: 'payment_link',
    phone: appt.client_phone,
    body: render(body, {
      cliente: appt.client_name.split(' ')[0],
      empresa: tenant.name,
      data: formatDateBR(zoned.dateStr),
      hora: zoned.timeStr,
      valor_pagar: money(input.amount),
      link_pagamento: input.url,
      minutos: input.minutes,
    }),
    scheduledFor: new Date(),
    dedupeKey: `${input.appointmentId}:payment_link:${Math.round(input.amount * 100)}`,
  });
}

/**
 * Lembrete de retorno: cliente cujo ultimo atendimento fez exatamente N dias
 * (N vem das configuracoes) e que nao tem horario futuro marcado.
 *
 * `tenantId` limita a uma empresa; sem ele varre todas, que e' o que o cron
 * faz. Ver o comentario de `expireHolds` para o porque do escopo existir.
 */
export async function scheduleReturnReminders(tenantId?: string): Promise<number> {
  const tenants = await query<{ id: string; name: string; slug: string; days: number }>(
    `SELECT t.id, t.name, t.slug, bs.return_reminder_days AS days
       FROM tenants t
       JOIN business_settings bs ON bs.tenant_id = t.id
      WHERE t.active AND bs.return_reminder_enabled
        AND ($1::uuid IS NULL OR t.id = $1)`,
    [tenantId ?? null]
  );

  let created = 0;
  for (const tenant of tenants) {
    const candidates = await query<{ client_id: string; name: string; phone: string; last_visit: Date }>(
      `SELECT c.id AS client_id, c.name, c.phone, max(a.starts_at) AS last_visit
         FROM clients c
         JOIN appointments a ON a.client_id = c.id AND a.status = 'completed'
        WHERE c.tenant_id = $1 AND NOT c.blocked
        GROUP BY c.id, c.name, c.phone
       HAVING max(a.starts_at) < now() - ($2 || ' days')::interval
          AND max(a.starts_at) > now() - (($2::int + 3) || ' days')::interval
          AND NOT EXISTS (
            SELECT 1 FROM appointments f
             WHERE f.client_id = c.id AND f.starts_at > now()
               AND f.status IN ('pending', 'confirmed')
          )`,
      [tenant.id, String(tenant.days)]
    );

    const body = await templateFor(tenant.id, 'return');
    if (!body) continue;

    for (const candidate of candidates) {
      const days = Math.floor(
        (Date.now() - new Date(candidate.last_visit).getTime()) / 86_400_000
      );
      await enqueue({
        tenantId: tenant.id,
        appointmentId: null,
        clientId: candidate.client_id,
        type: 'return',
        phone: candidate.phone,
        body: render(body, {
          cliente: candidate.name.split(' ')[0],
          empresa: tenant.name,
          dias: days,
          link_agendamento: `${env.appUrl}/agendar/${tenant.slug}`,
        }),
        scheduledFor: new Date(),
        // uma cobranca de retorno por ciclo de visita
        dedupeKey: `return:${candidate.client_id}:${new Date(candidate.last_visit).toISOString().slice(0, 10)}`,
      });
      created++;
    }
  }
  return created;
}

/**
 * Worker: envia o que ja venceu. Roda no cron, nunca no request do cliente.
 *
 * `tenantId` limita a uma empresa; sem ele varre todas. Ver `expireHolds`.
 */
export async function dispatchDueNotifications(
  limit = 50,
  tenantId?: string
): Promise<{ sent: number; failed: number }> {
  const due = await query<{
    id: string;
    tenant_id: string;
    to_phone: string;
    body: string;
    attempts: number;
  }>(
    `UPDATE notifications SET status = 'sending', attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM notifications
         WHERE status = 'scheduled' AND scheduled_for <= now() AND attempts < 3
           AND ($2::uuid IS NULL OR tenant_id = $2)
         ORDER BY scheduled_for
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, tenant_id, to_phone, body, attempts`,
    [limit, tenantId ?? null]
  );

  let sent = 0;
  let failed = 0;

  for (const item of due) {
    const session = await sessionIdFor(item.tenant_id);
    const result = await sendWhatsapp({
      sessionId: session,
      phone: item.to_phone,
      message: item.body,
    });

    if (result.ok) {
      await query(`UPDATE notifications SET status = 'sent', sent_at = now(), error = NULL WHERE id = $1`, [item.id]);
      sent++;
    } else if (result.skipped) {
      await query(`UPDATE notifications SET status = 'skipped', error = $2 WHERE id = $1`, [item.id, result.error ?? null]);
    } else {
      const finalAttempt = item.attempts >= 3;
      await query(
        `UPDATE notifications SET status = $2::notification_status, error = $3 WHERE id = $1`,
        [item.id, finalAttempt ? 'failed' : 'scheduled', result.error ?? 'falha no envio']
      );
      failed++;
    }
  }

  return { sent, failed };
}
