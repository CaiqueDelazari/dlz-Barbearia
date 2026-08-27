import Anthropic from '@anthropic-ai/sdk';
import { env } from '@/lib/env';
import { ApiError } from '@/lib/http';
import { query, queryOne } from '@/lib/db';
import { getTenantContext } from '@/server/repositories/tenant.repo';
import { TOOL_DEFINITIONS, runTool, type ToolContext } from './tools';

/**
 * Atendente de WhatsApp.
 *
 * A IA so conversa - quem decide se um horario existe, se cabe e se pode ser
 * reservado e o backend, atraves das ferramentas. O prompt reforca isso, mas a
 * garantia real esta na camada de servico.
 */

const MAX_TURNS = 8;

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!env.ai.enabled) throw new ApiError(503, 'Atendimento por IA desabilitado', 'ai_disabled');
  if (!client) client = new Anthropic({ apiKey: env.ai.apiKey || undefined });
  return client;
}

function systemPrompt(businessName: string): string {
  return [
    `Voce e o atendente virtual da ${businessName}, uma barbearia/salao, e conversa com clientes pelo WhatsApp em portugues do Brasil.`,
    '',
    'Como voce trabalha:',
    '- Seja breve, simpatico e direto. Mensagem de WhatsApp, nao e-mail formal.',
    '- NUNCA invente horarios, precos ou servicos. Consulte sempre as ferramentas.',
    '- Antes de sugerir horario, chame get_available_slots. Se nao houver vaga, ofereca outra data.',
    '- Antes de criar o agendamento, confirme com o cliente: servicos, data, horario e nome.',
    '- So chame create_appointment depois do cliente confirmar.',
    '- Se o cliente pedir varios servicos e nao houver horario continuo, ofereca os horarios separados que a ferramenta retornar.',
    '- Se a empresa exigir pagamento antecipado, avise que a reserva so e confirmada apos o pagamento e mande o link.',
    '- Para remarcar ou cancelar, consulte get_customer_appointments primeiro.',
    '- Se a ferramenta devolver erro, explique o motivo com as palavras dela, sem inventar solucao.',
    '- Assunto fora de agendamento: responda curto e traga a conversa de volta.',
    '',
    'Formate valores em reais e horarios como HH:MM. Nao exponha IDs tecnicos ao cliente.',
  ].join('\n');
}

export type AgentReply = { reply: string; toolsUsed: string[] };

export async function replyToMessage(input: {
  tenantId: string;
  phone: string;
  message: string;
}): Promise<AgentReply> {
  const { tenant } = await getTenantContext(input.tenantId);
  const anthropic = getClient();

  const conversation = await ensureConversation(input.tenantId, input.phone);
  await saveMessage(input.tenantId, conversation.id, 'in', input.message);

  const history = await query<{ direction: string; body: string }>(
    `SELECT direction, body FROM whatsapp_messages
      WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [conversation.id]
  );

  const messages: Anthropic.MessageParam[] = history
    .reverse()
    .map((m) => ({ role: m.direction === 'in' ? 'user' : 'assistant', content: m.body }));

  const ctx: ToolContext = { tenantId: input.tenantId, phone: input.phone };
  const toolsUsed: string[] = [];
  let reply = '';

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // thinking adaptativo + effort baixo: respostas rapidas de WhatsApp sem
    // perder o raciocinio das ferramentas. Os tipos do SDK instalado ainda nao
    // conhecem esses campos (a API ja aceita), dai o cast.
    const params = {
      model: env.ai.model,
      max_tokens: 2000,
      system: systemPrompt(tenant.name),
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
      tools: TOOL_DEFINITIONS,
      messages,
    } as unknown as Anthropic.MessageCreateParamsNonStreaming;

    const response = await anthropic.messages.create(params);

    const textBlocks = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text.trim())
      .filter(Boolean);
    if (textBlocks.length) reply = textBlocks.join('\n\n');

    if (response.stop_reason !== 'tool_use') break;

    messages.push({ role: 'assistant', content: response.content });

    // todos os resultados de ferramenta voltam em UMA mensagem de usuario
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      toolsUsed.push(block.name);
      try {
        const result = await runTool(block.name, block.input as Record<string, unknown>, ctx);
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      } catch (err) {
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          is_error: true,
          content: err instanceof Error ? err.message : 'Falha ao executar a acao',
        });
      }
    }
    messages.push({ role: 'user', content: results });
  }

  if (!reply) reply = 'Desculpe, nao consegui processar agora. Pode repetir?';
  await saveMessage(input.tenantId, conversation.id, 'out', reply);

  return { reply, toolsUsed };
}

async function ensureConversation(tenantId: string, phone: string) {
  const row = await queryOne<{ id: string; ai_enabled: boolean }>(
    `INSERT INTO whatsapp_conversations (tenant_id, phone, last_message_at)
     VALUES ($1,$2, now())
     ON CONFLICT (tenant_id, phone)
     DO UPDATE SET last_message_at = now()
     RETURNING id, ai_enabled`,
    [tenantId, phone]
  );
  if (!row) throw new ApiError(500, 'Falha ao abrir conversa');
  if (!row.ai_enabled) throw new ApiError(423, 'Atendimento automatico desativado nesta conversa', 'ai_paused');
  return row;
}

async function saveMessage(tenantId: string, conversationId: string, direction: 'in' | 'out', body: string) {
  await query(
    `INSERT INTO whatsapp_messages (tenant_id, conversation_id, direction, body)
     VALUES ($1,$2,$3,$4)`,
    [tenantId, conversationId, direction, body]
  );
}
