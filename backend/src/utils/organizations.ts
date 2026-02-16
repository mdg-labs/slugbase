/**
 * Organization helpers for Cloud mode billing.
 * Creates org for user on first signup; used by auth (register, OIDC) and organizations routes.
 */

import { execute, queryOne } from '../db/index.js';
import { v4 as uuidv4 } from 'uuid';
import { isCloud } from '../config/mode.js';

/**
 * Get current org id for user. Returns user.current_org_id if set and user is member;
 * else first org from org_members.
 */
export async function getCurrentOrgId(userId: string): Promise<string | null> {
  if (!isCloud) return null;
  const user = await queryOne('SELECT current_org_id FROM users WHERE id = ?', [userId]);
  if (!user) return null;
  const currentOrgId = (user as any).current_org_id;
  if (currentOrgId) {
    const member = await queryOne(
      'SELECT 1 FROM org_members WHERE user_id = ? AND org_id = ?',
      [userId, currentOrgId]
    );
    if (member) return currentOrgId;
  }
  const first = await queryOne(
    'SELECT org_id FROM org_members WHERE user_id = ? ORDER BY joined_at ASC LIMIT 1',
    [userId]
  );
  return first ? (first as any).org_id : null;
}

/**
 * Set current org for user. Verifies membership, then updates users.current_org_id.
 */
export async function setCurrentOrg(userId: string, orgId: string): Promise<boolean> {
  if (!isCloud) return false;
  const member = await queryOne(
    'SELECT 1 FROM org_members WHERE user_id = ? AND org_id = ?',
    [userId, orgId]
  );
  if (!member) return false;
  await execute('UPDATE users SET current_org_id = ? WHERE id = ?', [orgId, userId]);
  return true;
}

export type PlanTier = 'free' | 'personal' | 'team';

/**
 * Get effective plan tier for user (Cloud only). Returns null if self-hosted. early_supporter -> personal.
 */
export async function getUserPlan(userId: string): Promise<PlanTier | null> {
  if (!isCloud) return null;
  const orgId = await getCurrentOrgId(userId);
  if (!orgId) return null;
  const row = await queryOne('SELECT plan FROM organizations WHERE id = ?', [orgId]);
  const plan = (row as any)?.plan;
  if (plan === 'early_supporter') return 'personal';
  if (plan === 'free' || plan === 'personal' || plan === 'team') return plan;
  return 'free';
}

/**
 * Ensure user has an organization in Cloud mode. Creates org if needed.
 * Returns org id or null (if not Cloud or error).
 */
export async function ensureOrgForUser(userId: string, userName: string): Promise<string | null> {
  if (!isCloud) return null;
  const existing = await queryOne(
    'SELECT org_id FROM org_members WHERE user_id = ?',
    [userId]
  );
  if (existing && (existing as any).org_id) {
    return (existing as any).org_id;
  }
  const orgId = uuidv4();
  const orgName = `${userName}'s Workspace`;
  await execute(
    `INSERT INTO organizations (id, name, plan, included_seats) VALUES (?, ?, 'free', 1)`,
    [orgId, orgName]
  );
  await execute(
    `INSERT INTO org_members (user_id, org_id, role) VALUES (?, ?, 'owner')`,
    [userId, orgId]
  );
  await execute('UPDATE users SET current_org_id = ? WHERE id = ?', [orgId, userId]);
  return orgId;
}

/** Grace period in days when user has >100 bookmarks on free plan */
export const FREE_PLAN_GRACE_DAYS = parseInt(process.env.FREE_PLAN_GRACE_DAYS || '14', 10) || 14;

/** Free plan bookmark limit */
export const FREE_BOOKMARK_LIMIT = 100;

/**
 * Set free_plan_grace_ends_at when user has >100 bookmarks (e.g. after being removed from org).
 * Only sets if not already set. Call when user moves to free plan with over-limit bookmarks.
 */
export async function setFreePlanGraceIfOverLimit(userId: string): Promise<void> {
  if (!isCloud) return;
  const countRow = await queryOne('SELECT COUNT(*) as count FROM bookmarks WHERE user_id = ?', [userId]);
  const count = parseInt((countRow as any)?.count || '0');
  if (count <= FREE_BOOKMARK_LIMIT) return;
  const existing = await queryOne('SELECT free_plan_grace_ends_at FROM users WHERE id = ?', [userId]);
  if (existing && (existing as any).free_plan_grace_ends_at) return; // Already has grace
  const graceEndsAt = new Date();
  graceEndsAt.setDate(graceEndsAt.getDate() + FREE_PLAN_GRACE_DAYS);
  await execute('UPDATE users SET free_plan_grace_ends_at = ? WHERE id = ?', [graceEndsAt.toISOString(), userId]);
}

/**
 * Clear free_plan_grace_ends_at (e.g. when user deletes down to ≤100 or upgrades).
 */
export async function clearFreePlanGrace(userId: string): Promise<void> {
  if (!isCloud) return;
  await execute('UPDATE users SET free_plan_grace_ends_at = NULL WHERE id = ?', [userId]);
}

/**
 * Get free_plan_grace_ends_at for user (for API response). Returns ISO string or null.
 */
export async function getFreePlanGraceEndsAt(userId: string): Promise<string | null> {
  if (!isCloud) return null;
  const row = await queryOne('SELECT free_plan_grace_ends_at FROM users WHERE id = ?', [userId]);
  const val = (row as any)?.free_plan_grace_ends_at;
  return val ? String(val) : null;
}

/**
 * Check if user can create bookmarks on free plan (considering grace period).
 * Returns true if allowed, false if over limit and grace expired or not set.
 */
export async function canCreateBookmarkFreePlan(userId: string, bookmarkCount: number): Promise<boolean> {
  if (!isCloud) return true;
  if (bookmarkCount < FREE_BOOKMARK_LIMIT) return true;
  const row = await queryOne('SELECT free_plan_grace_ends_at FROM users WHERE id = ?', [userId]);
  const graceEndsAt = (row as any)?.free_plan_grace_ends_at;
  if (!graceEndsAt) return false;
  const endsAt = new Date(graceEndsAt);
  return Date.now() < endsAt.getTime();
}

/**
 * Delete an organization and all related data. Cloud mode only.
 * Clears users.current_org_id, deletes teams, then the org (cascades org_members, org_invitations).
 * Does not cancel Stripe subscriptions.
 */
export async function deleteOrganization(orgId: string): Promise<void> {
  if (!isCloud) return;
  // Clear current_org_id for any users pointing to this org
  await execute('UPDATE users SET current_org_id = NULL WHERE current_org_id = ?', [orgId]);
  // Delete teams belonging to this org (cascades team_members, bookmark_team_shares, folder_team_shares)
  await execute('DELETE FROM teams WHERE org_id = ?', [orgId]);
  // Delete org (cascades org_members, org_invitations)
  await execute('DELETE FROM organizations WHERE id = ?', [orgId]);
}
