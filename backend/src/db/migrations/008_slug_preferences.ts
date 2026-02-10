/**
 * Migration 008: Add slug_preferences table for /go remembered choices
 */

import { execute } from '../index.js';

export const migrationId = '008_slug_preferences';
export const migrationName = 'Add slug_preferences table for /go remembered choices';

export async function up() {
  await execute(
    `CREATE TABLE IF NOT EXISTS slug_preferences (
      user_id VARCHAR(255) NOT NULL,
      slug VARCHAR(255) NOT NULL,
      bookmark_id VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, slug),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (bookmark_id) REFERENCES bookmarks(id) ON DELETE CASCADE
    )`,
    []
  );
  await execute(
    'CREATE INDEX IF NOT EXISTS idx_slug_preferences_user_slug ON slug_preferences(user_id, slug)',
    []
  );
}

export async function down() {
  await execute('DROP INDEX IF EXISTS idx_slug_preferences_user_slug', []);
  await execute('DROP TABLE IF EXISTS slug_preferences', []);
}
