import { queryOne } from '@/lib/db';
import { ApiError } from '@/lib/http';

/**
 * O profissional escolhido e' desta empresa?
 *
 * Parece redundante -- o id vem de uma lista que a propria pagina carregou --
 * mas a lista nao e' o que chega ao servidor: `professionalId` e' um campo do
 * corpo, e o fluxo publico de agendamento aceita qualquer uuid.
 *
 * Sem esta checagem, o id de um barbeiro de OUTRA loja atravessava inteiro:
 *
 * - `professionalsForServices` devolve `null` quando nenhum servico tem vinculo
 *   em `professional_services` (o padrao de uma empresa nova), e ai a unica
 *   trava do caminho nao roda;
 * - `loadAgendaContext` filtra profissionais por tenant, entao a lista vem
 *   vazia -- e `hoursFor` interpreta "sem horario proprio" como "vale o horario
 *   da empresa", que e' o horario de quem esta agendando;
 * - a FK aponta so para `professionals(id)`, sem o tenant, entao o banco aceita.
 *
 * O resultado era pior do que dado torto: a constraint `excl_appt_overlap`
 * casava por `professional_id` sem o tenant, entao a reserva feita numa loja
 * ocupava a faixa de horario do barbeiro da outra -- que via a agenda vazia no
 * painel e os clientes recebendo "este horario acabou de ser reservado". Os
 * uuids sao publicos (a pagina de agendamento lista os profissionais), e o
 * cadastro e' aberto, entao bastava criar uma empresa para fechar a agenda de
 * qualquer outra.
 *
 * `active` entra na condicao pelo mesmo motivo: um profissional desativado
 * tambem sai do `loadAgendaContext` e cairia na mesma brecha do horario da
 * empresa -- so que dentro da propria loja.
 */
export async function assertProfissionalDaEmpresa(
  tenantId: string,
  professionalId: string | null | undefined
): Promise<void> {
  if (!professionalId) return;
  const row = await queryOne<{ ok: boolean }>(
    `SELECT true AS ok FROM professionals WHERE id = $1 AND tenant_id = $2 AND active`,
    [professionalId, tenantId]
  );
  if (!row) {
    throw ApiError.badRequest(
      'Profissional nao encontrado nesta empresa',
      'professional_not_found'
    );
  }
}
