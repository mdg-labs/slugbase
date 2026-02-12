/**
 * Migration: Add refresh_tokens table for CLOUD mode auth (short-lived access JWT + refresh cookie).
 * Used only in CLOUD mode; table is harmless when empty in SELFHOSTED.
 */

import { execute } from '../index.js';

export const migrationId = '006_refresh_tokens';
export const migrationName = 'Add refresh_tokens table for CLOUD mode';

export async function up() {
  const DB_TYPE = process.env.DB_TYPE || 'sqlite';

  if (DB_TYPE === 'postgresql') {
    await execute(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id VARCHAR(255) PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        token_hash VARCHAR(255) NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        revoked BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `, []);
    await execute(`
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token_hash ON refresh_tokens(token_hash)
    `, []);
    await execute(`
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id)
    `, []);
    await execute(`
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires_at ON refresh_tokens(expires_at)
    `, []);
  } else {
    await execute(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `, []);
    await execute(`
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token_hash ON refresh_tokens(token_hash)
    `, []);
    await execute(`
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id)
    `, []);
    await execute(`
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires_at ON refresh_tokens(expires_at)
    `, []);
  }
}

export async function down() {
  await execute(`DROP INDEX IF EXISTS idx_refresh_tokens_expires_at`, []);
  await execute(`DROP INDEX IF EXISTS idx_refresh_tokens_user_id`, []);
  await execute(`DROP INDEX IF EXISTS idx_refresh_tokens_token_hash`, []);
  await execute(`DROP TABLE IF EXISTS refresh_tokens`, []);
}
