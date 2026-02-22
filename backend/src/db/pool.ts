/**
 * Create a DB pool from config. Used by initDatabase and by @slugbase/core/backend consumers.
 */

import Database from 'better-sqlite3';
import { Pool } from 'pg';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { chmodSync } from 'fs';
import type { DbConfig } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type DbPool = Database.Database | Pool;

/**
 * Create a database pool or SQLite connection from config.
 * Caller is responsible for setting this as the global db (e.g. via setDb) if using backend modules that depend on it.
 */
export function createDbPool(config: DbConfig): DbPool {
  if (config.type === 'postgresql') {
    if (config.connectionString) {
      return new Pool({ connectionString: config.connectionString });
    }
    return new Pool({
      host: config.host || 'localhost',
      port: config.port ?? 5432,
      database: config.database || 'slugbase',
      user: config.user || 'postgres',
      password: config.password || '',
    });
  }
  const dbPath = config.path || join(__dirname, '../../data/slugbase.db');
  const db = new Database(dbPath);
  if (dbPath !== ':memory:') {
    try {
      chmodSync(dbPath, 0o600);
    } catch {
      // ignore
    }
  }
  return db;
}
