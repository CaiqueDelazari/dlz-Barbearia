#!/usr/bin/env node
/**
 * Runner de migrations. Cada arquivo .sql de database/migrations roda uma vez
 * e fica registrado em schema_migrations. `--reset` derruba o schema publico
 * antes (so use em dev).
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

const needsSsl = process.env.DATABASE_SSL !== 'false' && /sslmode=require|neon\.tech|supabase|render\.com/.test(DATABASE_URL);
const client = new pg.Client({
  connectionString: DATABASE_URL,
  ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
});

async function main() {
  const reset = process.argv.includes('--reset');
  await client.connect();

  if (reset) {
    console.log('--reset: recriando schema public');
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
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
