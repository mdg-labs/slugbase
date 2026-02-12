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
