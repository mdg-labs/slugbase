import Database from 'better-sqlite3';
import { Pool } from 'pg';
import { readFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_TYPE = process.env.DB_TYPE || 'sqlite';
let db: Database.Database | Pool;

/**
 * Convert boolean to database-compatible value
 * SQLite needs 0/1, PostgreSQL can use true/false
 */
function boolToDb(value: boolean | undefined | null): number | boolean | null {
  if (value === null || value === undefined) return null;
  if (DB_TYPE === 'postgresql') {
    return value;
  }
  return value ? 1 : 0;
}

/** Convert ? placeholders to $1, $2, ... for PostgreSQL */
function toPg(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

if (DB_TYPE === 'postgresql') {
  db = process.env.DATABASE_URL
    ? new Pool({ connectionString: process.env.DATABASE_URL })
    : new Pool({
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432'),
        database: process.env.DB_NAME || 'slugbase',
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || '',
      });
} else {
  const dbPath = process.env.DB_PATH || join(__dirname, '../../data/slugbase.db');
  db = new Database(dbPath);

  // Set secure file permissions (600 = read/write for owner only); skip for in-memory DB
  if (dbPath !== ':memory:') {
  try {
    chmodSync(dbPath, 0o600);
  } catch (error) {
    // Ignore errors if file doesn't exist yet or permissions can't be set
    console.warn('Could not set database file permissions:', error);
  }
  }
}

export async function initDatabase() {
  let schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
  
  if (DB_TYPE === 'postgresql') {
    const pool = db as Pool;
    // Convert to PostgreSQL-compatible syntax
    schema = schema
      .replace(/VARCHAR\((\d+)\)/g, 'VARCHAR($1)');
    // Note: TIMESTAMP DEFAULT CURRENT_TIMESTAMP is already PostgreSQL-compatible, no replacement needed
    
    // Split schema by semicolons and execute each statement
    const statements = schema.split(';').filter((s: string) => s.trim().length > 0);
    for (const statement of statements) {
      if (statement.trim()) {
        try {
          await pool.query(statement);
        } catch (error: any) {
          // Ignore "already exists" errors
          if (!error.message.includes('already exists') && !error.message.includes('duplicate')) {
            console.error('Schema error:', error.message, 'Statement:', statement.substring(0, 100));
          }
        }
      }
    }
  } else {
    const sqlite = db as Database.Database;
    // Convert to SQLite-compatible syntax
    schema = schema
      .replace(/VARCHAR\((\d+)\)/g, 'TEXT')
      .replace(/TIMESTAMP/g, 'DATETIME');
    sqlite.exec(schema);
  }
  
  // Run migrations after initial schema setup
  try {
    const { runMigrations } = await import('./migrations/index.js');
    await runMigrations();
  } catch (error) {
    console.error('Error running migrations:', error);
    throw error;
  }
}

export async function query(sql: string, params: any[] = []) {
  if (DB_TYPE === 'postgresql') {
    const pool = db as Pool;
    const result = await pool.query(toPg(sql), params);
    return result.rows;
  } else {
    const sqlite = db as Database.Database;
    return sqlite.prepare(sql).all(...params);
  }
}

export async function queryOne(sql: string, params: any[] = []) {
  if (DB_TYPE === 'postgresql') {
    const pool = db as Pool;
    const result = await pool.query(toPg(sql), params);
    return result.rows[0] || null;
  } else {
    const sqlite = db as Database.Database;
    return sqlite.prepare(sql).get(...params) || null;
  }
}

export async function execute(sql: string, params: any[] = []) {
  // Convert boolean values for SQLite compatibility
  const processedParams = params.map(param => {
    if (typeof param === 'boolean') {
      return boolToDb(param);
    }
    return param;
  });

  if (DB_TYPE === 'postgresql') {
    const pool = db as Pool;
    const result = await pool.query(toPg(sql), processedParams);
    return { changes: result.rowCount || 0, lastInsertRowid: null };
  } else {
    const sqlite = db as Database.Database;
    return sqlite.prepare(sql).run(...processedParams);
  }
}

export async function isInitialized(): Promise<boolean> {
  try {
    // Check if there are any users in the system
    // System is initialized only after at least one user exists
    const result = await queryOne("SELECT COUNT(*) as count FROM users", []);
    return result && parseInt((result as any).count) > 0;
  } catch {
    // If table doesn't exist or query fails, system is not initialized
    return false;
  }
}

export { db };
