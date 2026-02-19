/**
 * Migration: AI suggestion usage statistics.
 * Table ai_suggestion_usage stores one row per bookmark save where AI suggestions were shown,
 * with booleans for whether the user kept the suggested title, slug, and tags.
 */

import { execute } from '../index.js';

export const migrationId = '019';
export const migrationName = 'AI suggestion usage statistics';

export async function up() {
  const DB_TYPE = process.env.DB_TYPE || 'sqlite';

  if (DB_TYPE === 'postgresql') {
    await execute(`
      CREATE TABLE IF NOT EXISTS ai_suggestion_usage (
        id VARCHAR(255) PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        title_used BOOLEAN NOT NULL DEFAULT FALSE,
        slug_used BOOLEAN NOT NULL DEFAULT FALSE,
        tags_used BOOLEAN NOT NULL DEFAULT FALSE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `, []);
    await execute(`CREATE INDEX IF NOT EXISTS idx_ai_suggestion_usage_user_id ON ai_suggestion_usage(user_id)`, []);
    await execute(`CREATE INDEX IF NOT EXISTS idx_ai_suggestion_usage_created_at ON ai_suggestion_usage(created_at)`, []);
  } else {
    await execute(`
      CREATE TABLE IF NOT EXISTS ai_suggestion_usage (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        title_used INTEGER NOT NULL DEFAULT 0,
        slug_used INTEGER NOT NULL DEFAULT 0,
        tags_used INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `, []);
    await execute(`CREATE INDEX IF NOT EXISTS idx_ai_suggestion_usage_user_id ON ai_suggestion_usage(user_id)`, []);
    await execute(`CREATE INDEX IF NOT EXISTS idx_ai_suggestion_usage_created_at ON ai_suggestion_usage(created_at)`, []);
  }
}

export async function down() {
  await execute(`DROP INDEX IF EXISTS idx_ai_suggestion_usage_created_at`, []);
  await execute(`DROP INDEX IF EXISTS idx_ai_suggestion_usage_user_id`, []);
  await execute(`DROP TABLE IF EXISTS ai_suggestion_usage`, []);
}
