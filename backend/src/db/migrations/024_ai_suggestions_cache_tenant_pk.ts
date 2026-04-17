/**
 * Migration: Include tenant_id in ai_suggestions_cache primary key so cache rows
 * are unique per tenant (aligns with tenant_id column added in 020).
 */

import { execute } from '../index.js';

export const migrationId = '024';
export const migrationName = 'AI suggestions cache tenant-scoped primary key';

export async function up() {
  const DB_TYPE = process.env.DB_TYPE || 'sqlite';

  if (DB_TYPE === 'postgresql') {
    await execute(`ALTER TABLE ai_suggestions_cache DROP CONSTRAINT IF EXISTS ai_suggestions_cache_pkey`, []);
    await execute(
      `ALTER TABLE ai_suggestions_cache ADD PRIMARY KEY (tenant_id, user_id, canonical_url, output_language)`,
      []
    );
  } else {
    await execute(
      `CREATE TABLE IF NOT EXISTS ai_suggestions_cache_new (
        tenant_id TEXT NOT NULL DEFAULT 'default',
        user_id TEXT NOT NULL,
        canonical_url TEXT NOT NULL,
        output_language TEXT NOT NULL DEFAULT 'en',
        title TEXT NOT NULL,
        slug TEXT,
        tags TEXT NOT NULL,
        language TEXT,
        confidence REAL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (tenant_id, user_id, canonical_url, output_language),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`,
      []
    );
    await execute(
      `INSERT INTO ai_suggestions_cache_new (tenant_id, user_id, canonical_url, output_language, title, slug, tags, language, confidence, created_at)
       SELECT tenant_id, user_id, canonical_url, output_language, title, slug, tags, language, confidence, created_at FROM ai_suggestions_cache`,
      []
    );
    await execute(`DROP TABLE ai_suggestions_cache`, []);
    await execute(`ALTER TABLE ai_suggestions_cache_new RENAME TO ai_suggestions_cache`, []);
    await execute(`CREATE INDEX IF NOT EXISTS idx_ai_suggestions_cache_user ON ai_suggestions_cache(user_id)`, []);
    await execute(
      `CREATE INDEX IF NOT EXISTS idx_ai_suggestions_cache_tenant_user ON ai_suggestions_cache(tenant_id, user_id)`,
      []
    );
  }
}

export async function down() {
  const DB_TYPE = process.env.DB_TYPE || 'sqlite';

  if (DB_TYPE === 'postgresql') {
    await execute(`ALTER TABLE ai_suggestions_cache DROP CONSTRAINT IF EXISTS ai_suggestions_cache_pkey`, []);
    await execute(
      `ALTER TABLE ai_suggestions_cache ADD PRIMARY KEY (user_id, canonical_url, output_language)`,
      []
    );
  } else {
    await execute(
      `CREATE TABLE IF NOT EXISTS ai_suggestions_cache_old (
        tenant_id TEXT NOT NULL DEFAULT 'default',
        user_id TEXT NOT NULL,
        canonical_url TEXT NOT NULL,
        output_language TEXT NOT NULL DEFAULT 'en',
        title TEXT NOT NULL,
        slug TEXT,
        tags TEXT NOT NULL,
        language TEXT,
        confidence REAL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, canonical_url, output_language),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`,
      []
    );
    await execute(
      `INSERT OR REPLACE INTO ai_suggestions_cache_old (user_id, canonical_url, output_language, title, slug, tags, language, confidence, created_at, tenant_id)
       SELECT user_id, canonical_url, output_language, title, slug, tags, language, confidence, created_at, tenant_id FROM ai_suggestions_cache`,
      []
    );
    await execute(`DROP TABLE ai_suggestions_cache`, []);
    await execute(`ALTER TABLE ai_suggestions_cache_old RENAME TO ai_suggestions_cache`, []);
    await execute(`CREATE INDEX IF NOT EXISTS idx_ai_suggestions_cache_user ON ai_suggestions_cache(user_id)`, []);
    await execute(
      `CREATE INDEX IF NOT EXISTS idx_ai_suggestions_cache_tenant_user ON ai_suggestions_cache(tenant_id, user_id)`,
      []
    );
  }
}
