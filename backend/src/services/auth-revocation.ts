/**
 * Revoke refresh tokens and tear down session rows that reference a user id.
 * Used after org spin-off / member removal so stale clients must re-authenticate.
 */

import { execute, getDbType, query } from '../db/index.js';

export interface InvalidateUserAuthOptions {
  /** When set, skip deleting this session sid (e.g. self-leave keeps the current browser session). */
  excludeSid?: string;
}

function sessionJsonReferencesUserId(parsed: unknown, userId: string): boolean {
  if (parsed == null || typeof parsed !== 'object') return false;
  const o = parsed as Record<string, unknown>;
  const passportUser = o.passport;
  if (passportUser && typeof passportUser === 'object' && (passportUser as { user?: unknown }).user === userId) {
    return true;
  }
  const user = o.user;
  if (user && typeof user === 'object' && (user as { id?: unknown }).id === userId) {
    return true;
  }
  return false;
}

/**
 * Marks all refresh tokens for the user revoked; deletes DB session rows that explicitly
 * reference {@link userId} (Passport session serialization, etc.). JWT access tokens are short-lived.
 */
export async function invalidateUserAuth(userId: string, options?: InvalidateUserAuthOptions): Promise<void> {
  const excludeSid = options?.excludeSid;

  if (getDbType() === 'postgresql') {
    await execute(
      `UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = ? AND (revoked IS DISTINCT FROM TRUE)`,
      [userId]
    );
  } else {
    await execute(
      `UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ? AND (revoked = 0 OR revoked IS NULL)`,
      [userId]
    );
  }

  let rows: unknown[] = [];
  try {
    rows = (await query(`SELECT sid, sess FROM sessions WHERE expire > ?`, [new Date().toISOString()])) as unknown[];
  } catch {
    // sessions table may not exist (e.g. MemoryStore in tests)
    return;
  }
  const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
  for (const row of list as { sid?: string; sess?: string }[]) {
    const sid = row.sid;
    if (!sid || sid === excludeSid) continue;
    const raw = row.sess;
    if (raw == null) continue;
    let parsed: unknown;
    try {
      parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      continue;
    }
    if (sessionJsonReferencesUserId(parsed, userId)) {
      await execute(`DELETE FROM sessions WHERE sid = ?`, [sid]);
    }
  }
}
