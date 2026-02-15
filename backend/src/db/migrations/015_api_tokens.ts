/**
 * Migration: Add api_tokens table for personal API token management.
 * Tokens are stored as SHA-256 hashes only; plaintext is never persisted.
 */

import { execute } from '../index.js';

export const migrationId = '015';
export const migrationName = 'Add api_tokens table for personal API tokens';

export async function up() {
  const DB_TYPE = process.env.DB_TYPE || 'sqlite';

  if (DB_TYPE === 'postgresql') {
    await execute(`
      CREATE TABLE IF NOT EXISTS api_tokens (
        id VARCHAR(255) PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        token_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_used_at TIMESTAMP,
        revoked_at TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `, []);
    await execute(`CREATE INDEX IF NOT EXISTS idx_api_tokens_token_hash ON api_tokens(token_hash)`, []);
    await execute(`CREATE INDEX IF NOT EXISTS idx_api_tokens_user_id ON api_tokens(user_id)`, []);
  } else {
    await execute(`
      CREATE TABLE IF NOT EXISTS api_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        last_used_at TEXT,
        revoked_at TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `, []);
    await execute(`CREATE INDEX IF NOT EXISTS idx_api_tokens_token_hash ON api_tokens(token_hash)`, []);
    await execute(`CREATE INDEX IF NOT EXISTS idx_api_tokens_user_id ON api_tokens(user_id)`, []);
  }
}

export async function down() {
  await execute(`DROP INDEX IF EXISTS idx_api_tokens_user_id`, []);
  await execute(`DROP INDEX IF EXISTS idx_api_tokens_token_hash`, []);
  await execute(`DROP TABLE IF EXISTS api_tokens`, []);
}
