/**
 * Migration: Add indexes for stats endpoint timeseries queries.
 */

import { execute } from '../index.js';

export const migrationId = '014';
export const migrationName = 'Add stats indexes for created_at timeseries';

export async function up() {
  await execute('CREATE INDEX IF NOT EXISTS idx_bookmarks_created_at ON bookmarks(created_at)', []);
  await execute('CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at)', []);
  await execute('CREATE INDEX IF NOT EXISTS idx_folders_created_at ON folders(created_at)', []);
  await execute('CREATE INDEX IF NOT EXISTS idx_tags_created_at ON tags(created_at)', []);
}

export async function down() {
  await execute('DROP INDEX IF EXISTS idx_bookmarks_created_at', []);
  await execute('DROP INDEX IF EXISTS idx_users_created_at', []);
  await execute('DROP INDEX IF EXISTS idx_folders_created_at', []);
  await execute('DROP INDEX IF EXISTS idx_tags_created_at', []);
}
