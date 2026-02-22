/**
 * Migration: Add users.ai_suggestions_enabled for user-level AI suggestions opt-out.
 * Core needs this column for /api/auth/me and profile; it was previously only added
 * in legacy cloud migration 017, which is not run in self-hosted.
 */

import { execute } from '../index.js';

export const migrationId = '021';
export const migrationName = 'Users AI suggestions enabled flag';

export async function up() {
  const DB_TYPE = process.env.DB_TYPE || 'sqlite';

  if (DB_TYPE === 'postgresql') {
    await execute('ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_suggestions_enabled BOOLEAN DEFAULT TRUE', []);
  } else {
    try {
      await execute('ALTER TABLE users ADD COLUMN ai_suggestions_enabled INTEGER DEFAULT 1', []);
    } catch (error: any) {
      if (!error.message?.includes('duplicate column name')) throw error;
    }
  }
}

export async function down() {
  const DB_TYPE = process.env.DB_TYPE || 'sqlite';

  if (DB_TYPE === 'postgresql') {
    await execute('ALTER TABLE users DROP COLUMN IF EXISTS ai_suggestions_enabled', []);
  } else {
    console.warn('SQLite: down migration does not remove ai_suggestions_enabled (requires table recreation)');
  }
}
