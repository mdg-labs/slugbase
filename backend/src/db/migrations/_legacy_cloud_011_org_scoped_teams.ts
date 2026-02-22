/**
 * Migration 011: Org-scoped teams and current org context (Cloud mode)
 *
 * Adds org_id to teams (nullable for Selfhosted) and current_org_id to users.
 * Backfills existing teams to first org when orgs exist.
 */

import { execute, queryOne } from '../index.js';

// legacy cloud migration; no longer registered in selfhost-core
export const migrationId = '011';
export const migrationName = 'Org-scoped teams and current org context';

export async function up() {
  const DB_TYPE = process.env.DB_TYPE || 'sqlite';

  if (DB_TYPE === 'postgresql') {
    await execute('ALTER TABLE teams ADD COLUMN IF NOT EXISTS org_id VARCHAR(255)', []);
    await execute('ALTER TABLE users ADD COLUMN IF NOT EXISTS current_org_id VARCHAR(255)', []);
  } else {
    // SQLite: ADD COLUMN IF NOT EXISTS supported since 3.35.0
    try {
      await execute('ALTER TABLE teams ADD COLUMN org_id TEXT', []);
    } catch (error: any) {
      if (!error.message?.includes('duplicate column name')) throw error;
    }
    try {
      await execute('ALTER TABLE users ADD COLUMN current_org_id TEXT', []);
    } catch (error: any) {
      if (!error.message?.includes('duplicate column name')) throw error;
    }
  }

  await execute('CREATE INDEX IF NOT EXISTS idx_teams_org ON teams(org_id)', []);

  // Backfill: assign existing teams (org_id IS NULL) to first org, when orgs exist
  const firstOrg = await queryOne('SELECT id FROM organizations ORDER BY id LIMIT 1', []);
  if (firstOrg && (firstOrg as any).id) {
    const orgId = (firstOrg as any).id;
    if (DB_TYPE === 'postgresql') {
      await execute('UPDATE teams SET org_id = ? WHERE org_id IS NULL', [orgId]);
    } else {
      await execute('UPDATE teams SET org_id = ? WHERE org_id IS NULL', [orgId]);
    }
  }
}

export async function down() {
  await execute('DROP INDEX IF EXISTS idx_teams_org', []);

  const DB_TYPE = process.env.DB_TYPE || 'sqlite';
  if (DB_TYPE === 'postgresql') {
    await execute('ALTER TABLE teams DROP COLUMN IF EXISTS org_id', []);
    await execute('ALTER TABLE users DROP COLUMN IF EXISTS current_org_id', []);
  } else {
    // SQLite doesn't support DROP COLUMN easily; would need table recreation - skip for down
    console.warn('SQLite: down migration does not remove columns (requires table recreation)');
  }
}
