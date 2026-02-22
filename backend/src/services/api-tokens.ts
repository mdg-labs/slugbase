/**
 * API Token service: generate, hash, validate, and manage personal API tokens.
 * Tokens are stored as SHA-256 hashes only; plaintext is never persisted or logged.
 */

import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { query, queryOne, execute } from '../db/index.js';
import { validateLength, sanitizeString } from '../utils/validation.js';

const TOKEN_PREFIX = 'sb_';
const MAX_TOKENS_PER_USER = 10;
const TOKEN_NAME_MAX_LENGTH = 100;

/**
 * Generate a new API token (32 bytes entropy, base64url encoded, sb_ prefix).
 * Caller must store the hash; plaintext is returned only once.
 */
export function generateToken(): string {
  const bytes = crypto.randomBytes(32);
  const encoded = bytes.toString('base64url');
  return `${TOKEN_PREFIX}${encoded}`;
}

/**
 * Hash a token with SHA-256. Never log or store the plaintext.
 */
export function hashToken(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

export interface ApiTokenUser {
  id: string;
  email: string;
  name: string;
  user_key: string;
  is_admin: boolean;
}

/**
 * Validate an API token: hash, lookup, check not revoked.
 * Returns user object if valid, null otherwise.
 */
export async function validateToken(plaintext: string): Promise<ApiTokenUser | null> {
  if (!plaintext || typeof plaintext !== 'string' || !plaintext.startsWith(TOKEN_PREFIX)) {
    return null;
  }
  const hash = hashToken(plaintext);
  const row = await queryOne(
    `SELECT at.id, at.user_id, at.token_hash, u.email, u.name, u.user_key, u.is_admin
     FROM api_tokens at
     JOIN users u ON u.id = at.user_id
     WHERE at.token_hash = ? AND at.revoked_at IS NULL`,
    [hash]
  );
  if (!row) return null;
  const r = row as any;
  updateLastUsed(r.token_hash);
  const user: ApiTokenUser = {
    id: r.user_id,
    email: r.email,
    name: r.name,
    user_key: r.user_key,
    is_admin: r.is_admin === true || r.is_admin === 1,
  };
  return user;
}

/**
 * Update last_used_at for a token (by hash). Call asynchronously, non-blocking.
 */
export function updateLastUsed(tokenHash: string): void {
  setImmediate(async () => {
    try {
      const now = new Date().toISOString();
      await execute(
        `UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ? AND revoked_at IS NULL`,
        [now, tokenHash]
      );
    } catch {
      // Non-critical; do not log to avoid noise
    }
  });
}

export interface CreateTokenResult {
  token: string;
  id: string;
  name: string;
  created_at: string;
}

/**
 * Create a new API token for a user.
 * Validates name, enforces max tokens, returns plaintext once.
 */
export async function createToken(
  userId: string,
  name: string,
  tenantId: string
): Promise<{ success: true; data: CreateTokenResult } | { success: false; error: string }> {
  const sanitized = sanitizeString(name);
  const lengthCheck = validateLength(sanitized, 'Token name', 1, TOKEN_NAME_MAX_LENGTH);
  if (!lengthCheck.valid) {
    return { success: false, error: lengthCheck.error! };
  }

  const countRow = await queryOne(
    `SELECT COUNT(*) as c FROM api_tokens WHERE user_id = ? AND tenant_id = ? AND revoked_at IS NULL`,
    [userId, tenantId]
  );
  const count = parseInt(String((countRow as any)?.c || 0), 10);
  if (count >= MAX_TOKENS_PER_USER) {
    return {
      success: false,
      error: `Maximum of ${MAX_TOKENS_PER_USER} tokens per user. Revoke an existing token first.`,
    };
  }

  const token = generateToken();
  const tokenHash = hashToken(token);
  const id = uuidv4();
  const now = new Date().toISOString();

  await execute(
    `INSERT INTO api_tokens (id, tenant_id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, tenantId, userId, sanitized, tokenHash, now]
  );

  return {
    success: true,
    data: {
      token,
      id,
      name: sanitized,
      created_at: now,
    },
  };
}

export interface ListTokenItem {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

/**
 * List tokens for a user. Never returns plaintext; tokens are masked.
 */
export async function listTokens(userId: string, tenantId: string): Promise<ListTokenItem[]> {
  const rows = await query(
    `SELECT id, name, created_at, last_used_at FROM api_tokens WHERE user_id = ? AND tenant_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
    [userId, tenantId]
  );
  return (rows as any[]).map((r) => ({
    id: r.id,
    name: r.name,
    created_at: r.created_at,
    last_used_at: r.last_used_at ?? null,
  }));
}

/**
 * Revoke a token (soft-delete). Idempotent.
 */
export async function revokeToken(
  userId: string,
  tokenId: string,
  tenantId: string
): Promise<{ success: true } | { success: false; error: string }> {
  const row = await queryOne(
    `SELECT id FROM api_tokens WHERE id = ? AND user_id = ? AND tenant_id = ?`,
    [tokenId, userId, tenantId]
  );
  if (!row) {
    return { success: false, error: 'Token not found' };
  }
  const now = new Date().toISOString();
  await execute(`UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND tenant_id = ?`, [
    now,
    tokenId,
    userId,
    tenantId,
  ]);
  return { success: true };
}
