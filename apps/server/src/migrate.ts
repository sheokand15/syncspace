import { readFile, readdir } from 'node:fs/promises';
import { pool } from './db.js';
const folder = new URL('../../../database/migrations/', import.meta.url);
const files = (await readdir(folder)).filter(name => /^\d+_.+\.sql$/.test(name)).sort();
await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
for (const file of files) {
  const exists = await pool.query('SELECT 1 FROM schema_migrations WHERE version=$1', [file]);
  if (exists.rowCount) continue;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(await readFile(new URL(file, folder), 'utf8'));
    await client.query('INSERT INTO schema_migrations(version) VALUES($1)', [file]);
    await client.query('COMMIT');
    console.log(`Applied ${file}`);
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
await pool.end();
