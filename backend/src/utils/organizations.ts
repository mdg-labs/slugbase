/**
 * Organization helpers for Cloud mode billing.
 * Creates org for user on first signup; used by auth (register, OIDC) and organizations routes.
 */

import { execute, queryOne } from '../db/index.js';
import { v4 as uuidv4 } from 'uuid';
import { isCloud } from '../config/mode.js';

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
    `INSERT INTO organizations (id, name, plan, included_seats) VALUES (?, ?, 'free', 5)`,
    [orgId, orgName]
  );
  await execute(
    `INSERT INTO org_members (user_id, org_id, role) VALUES (?, ?, 'owner')`,
    [userId, orgId]
  );
  return orgId;
}
