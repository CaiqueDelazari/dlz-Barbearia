import { env } from '@/lib/env';
import { query } from '@/lib/db';
import { toWhatsappNumber } from '../repositories/client.repo';

/**
 * Integracao com o gateway de WhatsApp (o bot Baileys ja existente).
 * Fica isolada de proposito: as regras de agenda nao sabem que WhatsApp existe,
 * so pedem "envie esta mensagem para este telefone".
 *
 * O bot e multi-sessao (POST /send { session, phone, message }), entao cada
 * empresa usa a propria sessao - o slug serve de identificador padrao.
 */

export type SendResult = { ok: boolean; skipped?: boolean; error?: string };

export async function sendWhatsapp(input: {
  sessionId: string;
  phone: string;
  message: string;
}): Promise<SendResult> {
  if (!env.whatsapp.enabled) {
    console.info('[whatsapp] desabilitado; mensagem nao enviada:', input.phone);
    return { ok: false, skipped: true, error: 'whatsapp_disabled' };
  }
  if (!env.whatsapp.apiUrl || !env.whatsapp.token) {
    return { ok: false, skipped: true, error: 'whatsapp_nao_configurado' };
  }

  try {
    const res = await fetch(`${env.whatsapp.apiUrl.replace(/\/$/, '')}/send`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.whatsapp.token}`,
      },
      body: JSON.stringify({
        session: input.sessionId,
        phone: toWhatsappNumber(input.phone),
        message: input.message,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `gateway ${res.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'falha desconhecida' };
  }
}

/** Sessao do bot para a empresa: configurada no painel ou o proprio slug. */
export async function sessionIdFor(tenantId: string): Promise<string> {
  const rows = await query<{ session: string }>(
    `SELECT COALESCE(bs.whatsapp_session_id, t.slug) AS session
       FROM tenants t
       LEFT JOIN business_settings bs ON bs.tenant_id = t.id
      WHERE t.id = $1`,
    [tenantId]
  );
  return rows[0]?.session ?? tenantId;
}

/** Status da sessao, para exibir no painel (tela WhatsApp). */
export async function sessionStatus(sessionId: string): Promise<Record<string, unknown>> {
  if (!env.whatsapp.enabled || !env.whatsapp.apiUrl) {
    return { configured: false, connected: false };
  }
  try {
    const res = await fetch(
      `${env.whatsapp.apiUrl.replace(/\/$/, '')}/status/${encodeURIComponent(sessionId)}`,
      {
        headers: { authorization: `Bearer ${env.whatsapp.token}` },
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (!res.ok) return { configured: true, connected: false, error: `status ${res.status}` };
    return { configured: true, ...(await res.json()) };
  } catch (err) {
    return { configured: true, connected: false, error: err instanceof Error ? err.message : 'erro' };
  }
}

/** URL da tela de pareamento (QR) do bot, usada pelo painel. */
export function connectUrl(sessionId: string): string | null {
  if (!env.whatsapp.apiUrl) return null;
  return `${env.whatsapp.apiUrl.replace(/\/$/, '')}/connect/${encodeURIComponent(sessionId)}`;
}
