import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { env } from './env';

/**
 * Pool unico por processo. Em dev o Next recarrega os modulos a cada edicao,
 * entao guardamos no globalThis para nao vazar conexao a cada hot reload.
 */
const globalForDb = globalThis as unknown as { __pgPool?: Pool };

function criarPool(): Pool {
  const p = new Pool({
    connectionString: env.databaseUrl,
    ssl: env.databaseSsl ? { rejectUnauthorized: false } : undefined,
    max: Number(process.env.PG_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  const schema = env.dbSchema;
  if (schema !== 'public') {
    // Em cada conexao nova, e nao uma vez so: o pool abre e fecha conexoes ao
    // longo da vida do processo, e uma conexao aberta depois nasceria em
    // `public`. O sintoma seria das piores: funciona no comeco e comeca a dar
    // "relation does not exist" quando o pool cresce.
    //
    // `public` e `extensions` ficam no fim do caminho porque e' onde moram
    // gen_random_uuid e btree_gist -- sem eles, o DEFAULT gen_random_uuid() das
    // tabelas para de resolver. `extensions` e' onde o Supabase poe as suas (o
    // search_path padrao dele e' `public, extensions`); num Postgres comum esse
    // schema nao existe, e nome inexistente em search_path e' ignorado sem erro.
    p.on('connect', (client) => {
      client.query(`SET search_path TO "${schema}", public, extensions`).catch((err) => {
        console.error(`[db] falha ao apontar para o schema ${schema}:`, err);
      });
    });
  }

  return p;
}

export const pool: Pool = globalForDb.__pgPool ?? criarPool();

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
