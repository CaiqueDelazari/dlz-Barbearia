import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { env } from './env';

/**
 * Pool unico por processo. Em dev o Next recarrega os modulos a cada edicao,
 * entao guardamos no globalThis para nao vazar conexao a cada hot reload.
 */
const globalForDb = globalThis as unknown as { __pgPool?: Pool };

export const pool: Pool =
  globalForDb.__pgPool ??
  new Pool({
    connectionString: env.databaseUrl,
    ssl: env.databaseSsl ? { rejectUnauthorized: false } : undefined,
    max: Number(process.env.PG_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

if (process.env.NODE_ENV !== 'production') globalForDb.__pgPool = pool;

// numeric do Postgres chega como string; para dinheiro e melhor tratar como number
// no app e arredondar na borda. Fazemos isso nas queries com ::float onde precisa.

export type Sql = { text: string; values: unknown[] };

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = []
): Promise<T[]> {
  const res = await pool.query<T>(text, values);
  return res.rows;
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = []
): Promise<T | null> {
  const rows = await query<T>(text, values);
  return rows[0] ?? null;
}

/** Executa em transacao; faz rollback em qualquer erro. */
export async function transaction<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Lock consultivo por tenant+profissional. Serializa a criacao de agendamentos
 * concorrentes do mesmo profissional sem travar a tabela inteira. Some sozinho
 * no fim da transacao.
 */
export async function lockProfessionalAgenda(
  tx: PoolClient,
  tenantId: string,
  professionalId: string | null
): Promise<void> {
  const key = `${tenantId}:${professionalId ?? 'any'}`;
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
}

export type { PoolClient };
