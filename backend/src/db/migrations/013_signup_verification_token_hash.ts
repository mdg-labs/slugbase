/**
 * Migration: Add token_hash to signup_verification_tokens; store only hash, not plaintext token.
 * New rows use token_hash for lookup; token column holds placeholder 'h:'+id. Legacy rows
 * (token_hash IS NULL) are looked up by token and migrated on use.
 */

import { execute } from '../index.js';

export const migrationId = '013';
export const migrationName = 'Add signup_verification_tokens.token_hash for secure storage';

export async function up() {
  const DB_TYPE = process.env.DB_TYPE || 'sqlite';

  if (DB_TYPE === 'postgresql') {
    await execute(`
      ALTER TABLE signup_verification_tokens
      ADD COLUMN IF NOT EXISTS token_hash VARCHAR(255)
    `, []);
    await execute(`
      CREATE INDEX IF NOT EXISTS idx_signup_verification_tokens_token_hash
      ON signup_verification_tokens(token_hash)
    `, []);
  } else {
    // SQLite: ADD COLUMN only
    await execute(`
      ALTER TABLE signup_verification_tokens ADD COLUMN token_hash TEXT
    `, []);
    await execute(`
      CREATE INDEX IF NOT EXISTS idx_signup_verification_tokens_token_hash
      ON signup_verification_tokens(token_hash)
    `, []);
  }
}

export async function down() {
  await execute(`DROP INDEX IF EXISTS idx_signup_verification_tokens_token_hash`, []);
  const DB_TYPE = process.env.DB_TYPE || 'sqlite';
  if (DB_TYPE === 'postgresql') {
    await execute(`ALTER TABLE signup_verification_tokens DROP COLUMN IF EXISTS token_hash`, []);
  }
}
