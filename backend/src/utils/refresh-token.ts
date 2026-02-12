/**
 * Refresh token helpers for CLOUD mode: create, rotate, revoke.
 * Store only SHA-256 hash in DB; rotation on use; revoke on logout.
 */

import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { queryOne, execute } from '../db/index.js';

const DB_TYPE = process.env.DB_TYPE || 'sqlite';
const JWT_REFRESH_EXPIRES_DAYS = parseInt(process.env.JWT_REFRESH_EXPIRES_DAYS || '7', 10);

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Convert ? placeholders to $1, $2 for PostgreSQL */
function toPg(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

function sql(sql: string, params: any[]): [string, any[]] {
  return DB_TYPE === 'postgresql' ? [toPg(sql), params] : [sql, params];
}

export interface CreateRefreshTokenResult {
  token: string;
  expiresAt: Date;
}

/** Create a new refresh token for user; store hash in DB. Caller sets cookie. */
export async function createRefreshToken(userId: string): Promise<CreateRefreshTokenResult> {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const id = uuidv4();
  const expiresAt = new Date(Date.now() + JWT_REFRESH_EXPIRES_DAYS * 24 * 60 * 60 * 1000);
  const [q, p] = sql(
    'INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, revoked) VALUES (?, ?, ?, ?, ?)',
    [id, userId, tokenHash, expiresAt.toISOString(), false]
  );
  await execute(q, p);
  return { token, expiresAt };
}

export interface RotateRefreshTokenResult {
  token: string;
  expiresAt: Date;
  user: { id: string; email: string; name: string; user_key: string; is_admin: boolean };
}

/**
 * Validate refresh token from cookie, delete old record, create new token (rotation), return new token + user.
 * Returns null if invalid or expired.
 */
export async function rotateRefreshToken(currentToken: string): Promise<RotateRefreshTokenResult | null> {
  const tokenHash = hashToken(currentToken);
  const [qSel, pSel] = sql(
    'SELECT id, user_id FROM refresh_tokens WHERE token_hash = ? AND revoked = ? AND expires_at > ?',
    [tokenHash, false, new Date().toISOString()]
  );
  const row = await queryOne(qSel, pSel);
  if (!row) return null;
  const r = row as { id: string; user_id: string };
  const userRow = await queryOne('SELECT id, email, name, user_key, is_admin FROM users WHERE id = ?', [r.user_id]);
  if (!userRow) return null;
  const user = userRow as { id: string; email: string; name: string; user_key: string; is_admin: boolean };
  const [qDel, pDel] = sql('DELETE FROM refresh_tokens WHERE id = ?', [r.id]);
  await execute(qDel, pDel);
  const { token, expiresAt } = await createRefreshToken(user.id);
  return { token, expiresAt, user };
}

/** Revoke all refresh tokens for a user (e.g. on logout). */
export async function revokeRefreshTokensForUser(userId: string): Promise<void> {
  const [q, p] = sql('DELETE FROM refresh_tokens WHERE user_id = ?', [userId]);
  await execute(q, p);
}

/** Get user id for a valid refresh token (for logout revoke). Returns null if invalid or expired. */
export async function findUserIdByRefreshToken(token: string): Promise<string | null> {
  const tokenHash = hashToken(token);
  const [q, p] = sql(
    'SELECT user_id FROM refresh_tokens WHERE token_hash = ? AND revoked = ? AND expires_at > ?',
    [tokenHash, false, new Date().toISOString()]
  );
  const row = await queryOne(q, p);
  return row ? (row as { user_id: string }).user_id : null;
}
