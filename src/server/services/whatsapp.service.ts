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

/**
 * Prefixo obrigatorio das sessoes deste sistema.
 *
 * O bot e' compartilhado: a mesma instancia atende os restaurantes da casa, cada
 * um numa sessao propria (`espeto-na-brasa`, etc). O identificador da sessao e'
 * a UNICA coisa que separa um numero de WhatsApp do outro dentro dele.
 *
 * `whatsapp_session_id` e' um campo que qualquer ADMIN edita nas Configuracoes,
 * e o valor ia cru para o bot. Um ADMIN de uma empresa que escrevesse
 * `espeto-na-brasa` ali passaria a: mandar mensagem para qualquer numero SAINDO
 * do WhatsApp da Espetaria, ler se aquela sessao esta conectada e -- se ela
 * estivesse fora do ar -- pedir o QR e parear o proprio celular no lugar dela.
 *
 * O prefixo fecha isso na origem: nenhum valor digitado no painel consegue
 * apontar para uma sessao de fora deste sistema, porque toda sessao daqui nasce
 * dentro do namespace. E como o slug do tenant e' UNIQUE, duas empresas deste
 * SaaS tambem nao colidem entre si.
 */
const SESSION_PREFIX = 'barb-';

/** So letras, numeros e hifen: o resto some antes de virar identificador. */
function safeSessionId(raw: string): string {
  const limpo = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
  return `${SESSION_PREFIX}${limpo || 'sem-nome'}`;
}

/**
 * Sessao do bot para a empresa: o que estiver no painel, ou o slug -- sempre
 * dentro do namespace. Ver `SESSION_PREFIX` para o porque.
 */
export async function sessionIdFor(tenantId: string): Promise<string> {
  const rows = await query<{ session: string }>(
    `SELECT COALESCE(NULLIF(btrim(bs.whatsapp_session_id), ''), t.slug) AS session
       FROM tenants t
       LEFT JOIN business_settings bs ON bs.tenant_id = t.id
      WHERE t.id = $1`,
    [tenantId]
  );
  return safeSessionId(rows[0]?.session ?? tenantId);
}

/** Exportada so para o teste de regressao do namespace. */
export const _safeSessionId = safeSessionId;

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

/**
 * Retrato da sessao com o QR pronto, para o painel desenhar o pareamento na
 * propria tela.
 *
 * A tela `/connect/<sessao>` do bot NAO serve: fora do `/health`, toda rota
 * dele passa por um portao que exige o BOT_TOKEN, e o navegador do dono nao
 * manda header nenhum -- o link abria em 401. O bot aceita `?token=` para
 * contornar isso, mas seria pendurar na URL o token que envia mensagem por
 * todas as lojas, onde ele vaza em historico, log e Referer.
 *
 * As rotas /api/sessoes existem exatamente para este caso: quem tem tela
 * propria pede o dado cru e desenha o QR. A chamada sai do servidor, entao o
 * token nunca chega ao navegador.
 */
export type SessionSnapshot = {
  status: 'conectado' | 'aguardando_leitura' | 'desconectado';
  qrcode: string;
  numero: string;
};

async function botJson(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<SessionSnapshot | null> {
  if (!env.whatsapp.enabled || !env.whatsapp.apiUrl || !env.whatsapp.token) return null;
  const { timeoutMs = 20_000, ...rest } = init;
  try {
    const res = await fetch(`${env.whatsapp.apiUrl.replace(/\/$/, '')}${path}`, {
      ...rest,
      headers: { authorization: `Bearer ${env.whatsapp.token}`, ...(rest.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const dados = (await res.json()) as SessionSnapshot;
    // O QR vai direto para um <img> no painel do dono. Aceitar so data:image/
    // impede que uma resposta estranha do gateway vire um endereco externo, que
    // faria o navegador do dono buscar algo de fora sem ele pedir.
    if (dados.qrcode && !/^data:image\//.test(dados.qrcode)) dados.qrcode = '';
    return dados;
  } catch {
    return null;
  }
}

/** Estado atual da sessao, sem forcar conexao. */
export function sessionSnapshot(sessionId: string): Promise<SessionSnapshot | null> {
  return botJson(`/api/sessoes/${encodeURIComponent(sessionId)}`);
}

/**
 * Comeca o pareamento e devolve o QR.
 *
 * O bot espera o QR nascer antes de responder (o Baileys so o emite alguns
 * segundos depois de abrir o socket), por isso o limite aqui e' maior: sem
 * isso a primeira chamada voltaria "desconectado" e a tela concluiria que
 * falhou.
 */
export function startPairing(sessionId: string): Promise<SessionSnapshot | null> {
  return botJson(`/api/sessoes/${encodeURIComponent(sessionId)}/conectar`, {
    method: 'POST',
    timeoutMs: 30_000,
  });
}
