import { query } from '@/lib/db';
import type { Session } from '@/lib/auth';

/**
 * Qual profissional este usuario pode enxergar na agenda.
 *
 *   null  -> sem restricao (ADMIN/OWNER veem o salao inteiro)
 *   uuid  -> so a agenda deste profissional
 *   ''    -> nao ve nada
 *
 * O caso do '' e' de proposito e nao e' o mesmo que `null`. Um STAFF sem
 * profissional vinculado nao tem agenda propria; devolver `null` ali seria
 * abrir o salao inteiro para ele -- exatamente o contrario da intencao. Entao
 * ele passa a nao ver nada ate alguem ligar o login ao cadastro.
 *
 * O vinculo e' lido do banco a cada requisicao, nao do token. Se fosse gravado
 * no JWT, desvincular um barbeiro so teria efeito quando o token dele
 * expirasse -- ele continuaria vendo a agenda dos outros ate la.
 */
export async function escopoDeAgenda(session: Session): Promise<string | null> {
  if (session.role === 'ADMIN' || session.role === 'OWNER') return null;

  const rows = await query<{ id: string }>(
    `SELECT id FROM professionals
      WHERE tenant_id = $1 AND user_id = $2 AND active
      ORDER BY created_at
      LIMIT 1`,
    [session.tenantId, session.userId]
  );
  return rows[0]?.id ?? '';
}

/**
 * Junta o escopo com o filtro que veio da tela.
 *
 * Para quem tem escopo, o que o cliente pediu e' ignorado: mandar
 * `?professionalId=<outro>` nao pode virar uma forma de ler a agenda alheia.
 */
export function filtroDeProfissional(
  escopo: string | null,
  pedido: string | undefined
): string | undefined {
  if (escopo === null) return pedido;
  if (escopo === '') return '00000000-0000-0000-0000-000000000000';
  return escopo;
}
