/**
 * Migration: AI suggestions feature - cache table, user flag, org flag.
 * - ai_suggestions_cache: per-user URL cache for AI suggestions
 * - users.ai_suggestions_enabled: user-level opt-out
 * - organizations.ai_enabled: org-level toggle (Cloud)
 */

import { execute } from '../index.js';

export const migrationId = '017';
export const migrationName = 'AI suggestions cache and feature flags';

export async function up() {
  const DB_TYPE = process.env.DB_TYPE || 'sqlite';

  if (DB_TYPE === 'postgresql') {
    await execute(`
      CREATE TABLE IF NOT EXISTS ai_suggestions_cache (
        user_id VARCHAR(255) NOT NULL,
        canonical_url TEXT NOT NULL,
        title TEXT NOT NULL,
        slug VARCHAR(255),
        tags TEXT NOT NULL,
        language VARCHAR(10),
        confidence REAL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, canonical_url),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `, []);
    await execute(`CREATE INDEX IF NOT EXISTS idx_ai_suggestions_cache_user ON ai_suggestions_cache(user_id)`, []);

    await execute('ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_suggestions_enabled BOOLEAN DEFAULT TRUE', []);
    await execute('ALTER TABLE organizations ADD COLUMN IF NOT EXISTS ai_enabled BOOLEAN DEFAULT FALSE', []);
  } else {
    await execute(`
      CREATE TABLE IF NOT EXISTS ai_suggestions_cache (
        user_id TEXT NOT NULL,
        canonical_url TEXT NOT NULL,
        title TEXT NOT NULL,
        slug TEXT,
        tags TEXT NOT NULL,
        language TEXT,
        confidence REAL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, canonical_url),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `, []);
    await execute(`CREATE INDEX IF NOT EXISTS idx_ai_suggestions_cache_user ON ai_suggestions_cache(user_id)`, []);

    try {
      await execute('ALTER TABLE users ADD COLUMN ai_suggestions_enabled INTEGER DEFAULT 1', []);
    } catch (error: any) {
      if (!error.message?.includes('duplicate column name')) throw error;
    }

    try {
      await execute('ALTER TABLE organizations ADD COLUMN ai_enabled INTEGER DEFAULT 0', []);
    } catch (error: any) {
      if (!error.message?.includes('duplicate column name')) throw error;
    }
  }
}

export async function down() {
  const DB_TYPE = process.env.DB_TYPE || 'sqlite';

  if (DB_TYPE === 'postgresql') {
    await execute(`DROP INDEX IF EXISTS idx_ai_suggestions_cache_user`, []);
    await execute(`DROP TABLE IF EXISTS ai_suggestions_cache`, []);
    await execute('ALTER TABLE users DROP COLUMN IF EXISTS ai_suggestions_enabled', []);
    await execute('ALTER TABLE organizations DROP COLUMN IF EXISTS ai_enabled', []);
  } else {
    await execute(`DROP INDEX IF EXISTS idx_ai_suggestions_cache_user`, []);
    await execute(`DROP TABLE IF EXISTS ai_suggestions_cache`, []);
    console.warn('SQLite: down migration does not remove ai_suggestions_enabled or ai_enabled (requires table recreation)');
  }
}
