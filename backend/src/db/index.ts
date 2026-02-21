import Database from 'better-sqlite3';
import { Pool } from 'pg';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { getConfig } from '../config.js';
import { createDbPool, type DbPool } from './pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let db: DbPool | null = null;
let dbType: 'sqlite' | 'postgresql' = 'sqlite';

export function setDb(pool: DbPool, type: 'sqlite' | 'postgresql'): void {
  db = pool;
  dbType = type;
}

export function getDb(): DbPool {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
  return db;
}

export function getDbType(): 'sqlite' | 'postgresql' {
  return dbType;
}

/**
 * Convert boolean to database-compatible value
 */
function boolToDb(value: boolean | undefined | null): number | boolean | null {
  if (value === null || value === undefined) return null;
  if (dbType === 'postgresql') return value;
  return value ? 1 : 0;
}

/** Convert ? placeholders to $1, $2, ... for PostgreSQL */
function toPg(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

export async function initDatabase() {
  const config = getConfig(process.env);
  const pool = createDbPool(config.db);
  setDb(pool, config.db.type);

  let schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');

  if (dbType === 'postgresql') {
    const pg = pool as Pool;
    schema = schema.replace(/VARCHAR\((\d+)\)/g, 'VARCHAR($1)');
    const statements = schema.split(';').filter((s: string) => s.trim().length > 0);
    for (const statement of statements) {
      if (statement.trim()) {
        try {
          await pg.query(statement);
        } catch (error: any) {
          if (!error.message?.includes('already exists') && !error.message?.includes('duplicate')) {
            console.error('Schema error:', error.message, 'Statement:', statement.substring(0, 100));
          }
        }
      }
    }
  } else {
    const sqlite = pool as Database.Database;
    schema = schema
      .replace(/VARCHAR\((\d+)\)/g, 'TEXT')
      .replace(/TIMESTAMP/g, 'DATETIME');
    sqlite.exec(schema);
  }

  try {
    const { runMigrations } = await import('./migrations/index.js');
    await runMigrations();
  } catch (error) {
    console.error('Error running migrations:', error);
    throw error;
  }
}

export async function query(sql: string, params: any[] = []) {
  const current = getDb();
  if (dbType === 'postgresql') {
    const result = await (current as Pool).query(toPg(sql), params);
    return result.rows;
  }
  return (current as Database.Database).prepare(sql).all(...params);
}

export async function queryOne(sql: string, params: any[] = []) {
  const current = getDb();
  if (dbType === 'postgresql') {
    const result = await (current as Pool).query(toPg(sql), params);
    return result.rows[0] || null;
  }
  return (current as Database.Database).prepare(sql).get(...params) || null;
}

export async function execute(sql: string, params: any[] = []) {
  const processedParams = params.map((param) => {
    if (typeof param === 'boolean') return boolToDb(param);
    return param;
  });
  const current = getDb();
  if (dbType === 'postgresql') {
    const result = await (current as Pool).query(toPg(sql), processedParams);
    return { changes: result.rowCount || 0, lastInsertRowid: null };
  }
  return (current as Database.Database).prepare(sql).run(...processedParams);
}

export async function isInitialized(): Promise<boolean> {
  try {
    const result = await queryOne('SELECT COUNT(*) as count FROM users', []);
    return result && parseInt((result as any).count) > 0;
  } catch {
    return false;
  }
}

