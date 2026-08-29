#!/usr/bin/env node
/**
 * Runner de migrations. Cada arquivo .sql de database/migrations roda uma vez
 * e fica registrado em schema_migrations.
 *
 * Mora no schema de `DB_SCHEMA` (ou `SUPABASE_SCHEMA`), `public` por padrao.
 * Isso existe porque um projeto Supabase costuma hospedar mais de um sistema
 * da casa, e duas instalacoes em `public` colidem na primeira tabela de nome
 * repetido -- `clients`, `payments` e `products` se repetem em todos.
 *
 * `--reset` derruba e recria **esse** schema. Antes ele fazia
 * `DROP SCHEMA public CASCADE` fixo, o que num projeto compartilhado levava
 * junto o sistema do vizinho: um comando de dev apagando dado de producao
 * alheio, sem perguntar nada.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'database', 'migrations');

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) {
  console.error('DATABASE_URL nao definida. Copie .env.example para .env e preencha.');
  process.exit(1);
}

const SCHEMA = (process.env.DB_SCHEMA ?? process.env.SUPABASE_SCHEMA ?? 'public').trim();
if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(SCHEMA)) {
  console.error(`DB_SCHEMA invalido: ${JSON.stringify(SCHEMA)}`);
  process.exit(1);
}

const needsSsl = process.env.DATABASE_SSL !== 'false' && /sslmode=require|neon\.tech|supabase|render\.com/.test(DATABASE_URL);
const client = new pg.Client({
  connectionString: DATABASE_URL,
  ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
});

async function main() {
  const reset = process.argv.includes('--reset');
  await client.connect();

  if (SCHEMA !== 'public') {
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
  }
  // `public` e `extensions` no fim: e' onde moram gen_random_uuid e btree_gist,
  // e sem eles o DEFAULT gen_random_uuid() das tabelas para de resolver. O
  // Supabase poe as extensoes em `extensions`; num Postgres comum esse schema
  // nao existe, e nome inexistente em search_path e' ignorado sem erro.
  await client.query(`SET search_path TO "${SCHEMA}", public, extensions`);
  console.log(`schema: ${SCHEMA}`);

  if (reset) {
    if (process.env.NODE_ENV === 'production') {
      console.error('--reset recusado: NODE_ENV=production. Isto apaga tudo.');
      process.exit(1);
    }
    console.log(`--reset: recriando o schema ${SCHEMA}`);
    await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE; CREATE SCHEMA "${SCHEMA}"`);
    await client.query(`SET search_path TO "${SCHEMA}", public, extensions`);
  }

  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const applied = new Set(
    (await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name)
  );

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    process.stdout.write(`-> ${file} ... `);
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log('ok');
      ran++;
    } catch (err) {
      await client.query('ROLLBACK');
      console.log('FALHOU');
      console.error(err.message);
      process.exit(1);
    }
  }

  console.log(ran ? `${ran} migration(s) aplicada(s).` : 'Banco ja esta atualizado.');
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
