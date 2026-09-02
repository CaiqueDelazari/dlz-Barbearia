import type { PoolClient } from 'pg';
import { query, queryOne } from '@/lib/db';
import { ApiError } from '@/lib/http';
import type { Client } from '../types';

/** Guardamos so digitos: o mesmo numero digitado de 5 jeitos vira um cadastro so. */
export function normalizePhone(raw: string): string {
  const digits = (raw ?? '').replace(/\D/g, '');
  const withoutCountry = digits.startsWith('55') && digits.length > 11 ? digits.slice(2) : digits;
  if (withoutCountry.length < 10 || withoutCountry.length > 11) {
    throw ApiError.badRequest('Telefone invalido. Use DDD + numero.');
  }
  return withoutCountry;
}

export function formatPhone(phone: string): string {
  const d = phone.replace(/\D/g, '');
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return phone;
}

/** Numero pronto para o WhatsApp (bot resolve o JID). */
export function toWhatsappNumber(phone: string): string {
  const d = phone.replace(/\D/g, '');
  return d.startsWith('55') ? d : `55${d}`;
}

type UpsertInput = { id?: string; name?: string; phone?: string; notes?: string | null };

export async function upsertClientByPhone(
  tx: PoolClient,
  tenantId: string,
  input: UpsertInput
): Promise<Client> {
  if (input.id) {
    const existing = await tx.query<Client>(
      `SELECT id, tenant_id, name, phone, email, notes, blocked, no_show_count
         FROM clients WHERE id = $1 AND tenant_id = $2`,
      [input.id, tenantId]
    );
    if (!existing.rowCount) throw ApiError.notFound('Cliente nao encontrado');
    return existing.rows[0];
  }

  if (!input.name?.trim()) throw ApiError.badRequest('Informe o nome');
  if (!input.phone) throw ApiError.badRequest('Informe o telefone');
  const phone = normalizePhone(input.phone);

  const res = await tx.query<Client>(
    `INSERT INTO clients (tenant_id, name, phone, notes)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (tenant_id, phone)
     DO UPDATE SET name = EXCLUDED.name, updated_at = now()
     RETURNING id, tenant_id, name, phone, email, notes, blocked, no_show_count`,
    [tenantId, input.name.trim(), phone, input.notes ?? null]
  );
  return res.rows[0];
}

export async function listClients(params: {
  tenantId: string;
  search?: string;
  limit?: number;
  offset?: number;
  /**
   * Quando presente, so os clientes que ja marcaram com ESTE profissional.
   *
   * A carteira e' do salao, nao do barbeiro: ele atende quem aparece na agenda
   * dele e nao tem por que levar embora a lista inteira de contatos da casa --
   * que e' o ativo mais facil de copiar que existe num negocio desses.
   */
  somenteDoProfissional?: string;
}) {
  const values: unknown[] = [params.tenantId];
  let searchSql = '';
  let escopoSql = '';
  if (params.somenteDoProfissional !== undefined) {
    values.push(params.somenteDoProfissional);
    escopoSql = ` AND EXISTS (SELECT 1 FROM appointments a2
                               WHERE a2.client_id = c.id AND a2.tenant_id = c.tenant_id
                                 AND a2.professional_id = $${values.length})`;
  }
  if (params.search) {
    values.push(`%${params.search.replace(/\D/g, '') || params.search}%`);
    values.push(`%${params.search}%`);
    searchSql = ` AND (c.phone ILIKE $${values.length - 1} OR c.name ILIKE $${values.length})`;
  }
  const limit = Math.min(params.limit ?? 50, 200);
  const offset = params.offset ?? 0;

  const items = await query(
    `SELECT c.id, c.name, c.phone, c.email, c.blocked, c.no_show_count, c.created_at,
            stats.total_appointments, stats.total_spent, stats.last_visit, stats.next_visit
       FROM clients c
       LEFT JOIN LATERAL (
         SELECT count(*) FILTER (WHERE a.status = 'completed')::int AS total_appointments,
                COALESCE(sum(a.paid_amount) FILTER (WHERE a.status IN ('completed','confirmed')), 0)::float8 AS total_spent,
                max(a.starts_at) FILTER (WHERE a.status = 'completed') AS last_visit,
                min(a.starts_at) FILTER (WHERE a.status = 'confirmed' AND a.starts_at > now()) AS next_visit
           FROM appointments a WHERE a.client_id = c.id
       ) stats ON true
      WHERE c.tenant_id = $1${escopoSql}${searchSql}
      ORDER BY c.name
      LIMIT ${limit} OFFSET ${offset}`,
    values
  );

  const total = await queryOne<{ count: string }>(
    `SELECT count(*)::text AS count FROM clients c WHERE c.tenant_id = $1${escopoSql}${searchSql}`,
    values
  );
  return { items, total: Number(total?.count ?? 0) };
}

export async function getClientHistory(tenantId: string, clientId: string) {
  const client = await queryOne(
    `SELECT id, name, phone, email, notes, blocked, no_show_count, created_at
       FROM clients WHERE tenant_id = $1 AND id = $2`,
    [tenantId, clientId]
  );
  if (!client) throw ApiError.notFound('Cliente nao encontrado');

  const [summary, services, appointments] = await Promise.all([
    queryOne(
      `SELECT count(*) FILTER (WHERE status = 'completed')::int AS total_appointments,
              count(*) FILTER (WHERE status = 'no_show')::int AS no_shows,
              COALESCE(sum(paid_amount) FILTER (WHERE status IN ('completed','confirmed')), 0)::float8 AS total_spent,
              max(starts_at) FILTER (WHERE status = 'completed') AS last_visit,
              min(starts_at) FILTER (WHERE status = 'confirmed' AND starts_at > now()) AS next_visit
         FROM appointments WHERE tenant_id = $1 AND client_id = $2`,
      [tenantId, clientId]
    ),
    query(
      `SELECT s.service_name AS name, count(*)::int AS times, sum(s.price)::float8 AS total
         FROM appointment_services s
         JOIN appointments a ON a.id = s.appointment_id
        WHERE a.tenant_id = $1 AND a.client_id = $2 AND a.status IN ('completed','confirmed')
        GROUP BY s.service_name ORDER BY times DESC`,
      [tenantId, clientId]
    ),
    query(
      `SELECT a.id, a.starts_at, a.status, a.total_amount::float8 AS total_amount,
              a.paid_amount::float8 AS paid_amount, p.name AS professional_name,
              COALESCE((SELECT string_agg(s.service_name, ' + ' ORDER BY s.position)
                          FROM appointment_services s WHERE s.appointment_id = a.id), '') AS services
         FROM appointments a
         LEFT JOIN professionals p ON p.id = a.professional_id
        WHERE a.tenant_id = $1 AND a.client_id = $2
        ORDER BY a.starts_at DESC LIMIT 50`,
      [tenantId, clientId]
    ),
  ]);

  return { client, summary, services, appointments };
}
