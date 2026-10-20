import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

// Load local configuration before creating the pool. Existing process environment
// values take precedence, which keeps container and deployment configuration intact.
const envFile = resolve(process.cwd(), '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { Pool } = pg;
export const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10, idleTimeoutMillis: 30_000 });
export type DbClient = pg.PoolClient;
