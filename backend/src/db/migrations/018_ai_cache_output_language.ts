/**
 * Migration: Add output_language to ai_suggestions_cache.
 * Cache key becomes (user_id, canonical_url, output_language) so suggestions
 * are cached per user's preferred language.
 */

import { execute } from '../index.js';

export const migrationId = '018';
export const migrationName = 'AI suggestions cache output_language';

export async function up() {
  const DB_TYPE = process.env.DB_TYPE || 'sqlite';

  if (DB_TYPE === 'postgresql') {
    await execute(
      `ALTER TABLE ai_suggestions_cache ADD COLUMN IF NOT EXISTS output_language VARCHAR(10) DEFAULT 'en'`,
      []
    );
    await execute(`ALTER TABLE ai_suggestions_cache DROP CONSTRAINT IF EXISTS ai_suggestions_cache_pkey`, []);
    await execute(
      `ALTER TABLE ai_suggestions_cache ADD PRIMARY KEY (user_id, canonical_url, output_language)`,
      []
    );
  } else {
    await execute(
      `CREATE TABLE ai_suggestions_cache_new (
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
      `INSERT INTO ai_suggestions_cache_new (user_id, canonical_url, output_language, title, slug, tags, language, confidence, created_at)
       SELECT user_id, canonical_url, 'en', title, slug, tags, language, confidence, created_at FROM ai_suggestions_cache`,
      []
    );
    await execute(`DROP TABLE ai_suggestions_cache`, []);
    await execute(`ALTER TABLE ai_suggestions_cache_new RENAME TO ai_suggestions_cache`, []);
    await execute(`CREATE INDEX IF NOT EXISTS idx_ai_suggestions_cache_user ON ai_suggestions_cache(user_id)`, []);
  }
}

export async function down() {
  const DB_TYPE = process.env.DB_TYPE || 'sqlite';

  if (DB_TYPE === 'postgresql') {
    await execute(`ALTER TABLE ai_suggestions_cache DROP CONSTRAINT IF EXISTS ai_suggestions_cache_pkey`, []);
    await execute(
      `ALTER TABLE ai_suggestions_cache ADD PRIMARY KEY (user_id, canonical_url)`,
      []
    );
    await execute(`ALTER TABLE ai_suggestions_cache DROP COLUMN IF EXISTS output_language`, []);
  } else {
    await execute(
      `CREATE TABLE ai_suggestions_cache_old (
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
      )`,
      []
    );
    await execute(
      `INSERT OR IGNORE INTO ai_suggestions_cache_old (user_id, canonical_url, title, slug, tags, language, confidence, created_at)
       SELECT user_id, canonical_url, title, slug, tags, language, confidence, created_at FROM ai_suggestions_cache`,
      []
    );
    await execute(`DROP TABLE ai_suggestions_cache`, []);
    await execute(`ALTER TABLE ai_suggestions_cache_old RENAME TO ai_suggestions_cache`, []);
    await execute(`CREATE INDEX IF NOT EXISTS idx_ai_suggestions_cache_user ON ai_suggestions_cache(user_id)`, []);
  }
}
