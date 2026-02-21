/**
 * Migration: Add free_plan_grace_ends_at to users for grace period when over 100 bookmarks on free plan.
 * When a user moves to free plan with >100 bookmarks, they get a grace period to delete or upgrade.
 */

import { execute, query } from '../index.js';

// legacy cloud migration; no longer registered in selfhost-core
export const migrationId = '016';
export const migrationName = 'Add free_plan_grace_ends_at for over-limit bookmark grace period';

const FREE_PLAN_GRACE_DAYS = 14;

export async function up() {
  const DB_TYPE = process.env.DB_TYPE || 'sqlite';

  if (DB_TYPE === 'postgresql') {
    await execute('ALTER TABLE users ADD COLUMN IF NOT EXISTS free_plan_grace_ends_at TIMESTAMP', []);
  } else {
    try {
      await execute('ALTER TABLE users ADD COLUMN free_plan_grace_ends_at TEXT', []);
    } catch (error: any) {
      if (!error.message?.includes('duplicate column name')) throw error;
    }
  }

  // Backfill: users already over 100 bookmarks on free plan get grace from now
  const overLimit = await query(
    `SELECT u.id FROM users u
     INNER JOIN org_members om ON u.id = om.user_id
     INNER JOIN organizations o ON o.id = om.org_id
     WHERE o.plan = 'free'
     AND (SELECT COUNT(*) FROM bookmarks WHERE user_id = u.id) > 100`,
    []
  );
  const list = Array.isArray(overLimit) ? overLimit : overLimit ? [overLimit] : [];
  const graceEndsAt = new Date();
  graceEndsAt.setDate(graceEndsAt.getDate() + FREE_PLAN_GRACE_DAYS);
  const graceIso = graceEndsAt.toISOString();

  for (const row of list) {
    const uid = (row as any).id;
    if (uid) {
      await execute('UPDATE users SET free_plan_grace_ends_at = ? WHERE id = ?', [graceIso, uid]);
    }
  }
}

export async function down() {
  const DB_TYPE = process.env.DB_TYPE || 'sqlite';
  if (DB_TYPE === 'postgresql') {
    await execute('ALTER TABLE users DROP COLUMN IF EXISTS free_plan_grace_ends_at', []);
  } else {
    console.warn('SQLite: down migration does not remove free_plan_grace_ends_at (requires table recreation)');
  }
}
