/**
 * Migration: Add token_hash to password_reset_tokens; store only hash, not plaintext token.
 * New rows use token_hash for lookup; token column holds placeholder 'h:'+id. Legacy rows
 * (token_hash IS NULL) are looked up by token and migrated on use.
 */

import { execute } from '../index.js';

export const migrationId = '007_password_reset_token_hash';
export const migrationName = 'Add password_reset_tokens.token_hash for secure storage';

export async function up() {
  const DB_TYPE = process.env.DB_TYPE || 'sqlite';

  if (DB_TYPE === 'postgresql') {
    await execute(`
      ALTER TABLE password_reset_tokens
      ADD COLUMN IF NOT EXISTS token_hash VARCHAR(255)
    `, []);
    await execute(`
      CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_token_hash
      ON password_reset_tokens(token_hash)
    `, []);
  } else {
    // SQLite: ADD COLUMN only
    await execute(`
      ALTER TABLE password_reset_tokens ADD COLUMN token_hash TEXT
    `, []);
    await execute(`
      CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_token_hash
      ON password_reset_tokens(token_hash)
    `, []);
  }
}

export async function down() {
  await execute(`DROP INDEX IF EXISTS idx_password_reset_tokens_token_hash`, []);
  // SQLite does not support DROP COLUMN easily; leave column for safety
  const DB_TYPE = process.env.DB_TYPE || 'sqlite';
  if (DB_TYPE === 'postgresql') {
    await execute(`ALTER TABLE password_reset_tokens DROP COLUMN IF EXISTS token_hash`, []);
  }
}
