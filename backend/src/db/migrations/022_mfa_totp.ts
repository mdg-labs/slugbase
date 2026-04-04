/**
 * Migration: MFA (TOTP) columns on users and mfa_backup_codes table.
 * Backup codes store SHA-256 hashes only; TOTP secret is encrypted app-side in mfa_totp_secret_enc.
 */

import { execute } from '../index.js';

export const migrationId = '022';
export const migrationName = 'MFA TOTP columns and backup codes table';

async function addUsersMfaColumns() {
  const DB_TYPE = process.env.DB_TYPE || 'sqlite';

  if (DB_TYPE === 'postgresql') {
    await execute(
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN DEFAULT FALSE',
      []
    );
    await execute(
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_totp_secret_enc TEXT',
      []
    );
    await execute(
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enrolled_at TIMESTAMP',
      []
    );
  } else {
    const columns: { sql: string; duplicateHint: string }[] = [
      {
        sql: 'ALTER TABLE users ADD COLUMN mfa_enabled INTEGER DEFAULT 0',
        duplicateHint: 'duplicate column name',
      },
      {
        sql: 'ALTER TABLE users ADD COLUMN mfa_totp_secret_enc TEXT',
        duplicateHint: 'duplicate column name',
      },
      {
        sql: 'ALTER TABLE users ADD COLUMN mfa_enrolled_at TEXT',
        duplicateHint: 'duplicate column name',
      },
    ];
    for (const { sql, duplicateHint } of columns) {
      try {
        await execute(sql, []);
      } catch (error: any) {
        if (!error.message?.includes(duplicateHint)) throw error;
      }
    }
  }
}

export async function up() {
  const DB_TYPE = process.env.DB_TYPE || 'sqlite';

  await addUsersMfaColumns();

  if (DB_TYPE === 'postgresql') {
    await execute(
      `
      CREATE TABLE IF NOT EXISTS mfa_backup_codes (
        id VARCHAR(255) PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        code_hash VARCHAR(255) NOT NULL,
        used_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE (user_id, code_hash)
      )
    `,
      []
    );
    await execute(
      'CREATE INDEX IF NOT EXISTS idx_mfa_backup_codes_user_id ON mfa_backup_codes(user_id)',
      []
    );
  } else {
    await execute(
      `
      CREATE TABLE IF NOT EXISTS mfa_backup_codes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE (user_id, code_hash)
      )
    `,
      []
    );
    await execute(
      'CREATE INDEX IF NOT EXISTS idx_mfa_backup_codes_user_id ON mfa_backup_codes(user_id)',
      []
    );
  }
}

export async function down() {
  const DB_TYPE = process.env.DB_TYPE || 'sqlite';

  await execute('DROP INDEX IF EXISTS idx_mfa_backup_codes_user_id', []);
  await execute('DROP TABLE IF EXISTS mfa_backup_codes', []);

  if (DB_TYPE === 'postgresql') {
    await execute('ALTER TABLE users DROP COLUMN IF EXISTS mfa_enrolled_at', []);
    await execute('ALTER TABLE users DROP COLUMN IF EXISTS mfa_totp_secret_enc', []);
    await execute('ALTER TABLE users DROP COLUMN IF EXISTS mfa_enabled', []);
  } else {
    console.warn(
      'SQLite: down migration does not remove mfa_* columns on users (requires table recreation)'
    );
  }
}
