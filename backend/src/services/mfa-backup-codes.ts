/**
 * MFA backup codes: generation, hashing, and timing-safe verification.
 * Plaintext codes are shown once to the user; only SHA-256 hex hashes are stored.
 *
 * On successful MFA via backup code, the route must set `used_at` in the **same database
 * transaction** as the rest of the success path (login / mfa verify) to prevent double spend.
 */

import crypto from 'crypto';

export const MFA_BACKUP_CODE_COUNT = 10;

/** 8 random bytes → 16 lowercase hex characters (plan §3). */
export const MFA_BACKUP_CODE_HEX_LENGTH = 16;

/**
 * Generate a new set of one-time backup codes (plaintext only — hash before persisting).
 */
export function generateBackupCodesPlaintext(): string[] {
  const codes: string[] = [];
  for (let i = 0; i < MFA_BACKUP_CODE_COUNT; i++) {
    codes.push(crypto.randomBytes(8).toString('hex'));
  }
  return codes;
}

/**
 * Strip whitespace, lowercase, require exactly 16 hex digits. Returns null if invalid.
 */
export function parseBackupCodeInput(raw: string): string | null {
  if (raw == null || typeof raw !== 'string') {
    return null;
  }
  const s = raw.replace(/\s+/g, '').toLowerCase();
  if (s.length !== MFA_BACKUP_CODE_HEX_LENGTH) {
    return null;
  }
  if (!/^[0-9a-f]+$/.test(s)) {
    return null;
  }
  return s;
}

/**
 * SHA-256 hash of the normalized 16-char hex code, as lowercase hex (64 chars). For DB storage.
 */
export function hashBackupCodeForStorage(normalizedHex16: string): string {
  return crypto.createHash('sha256').update(normalizedHex16, 'utf8').digest('hex');
}

/**
 * Compare a user-submitted backup code to a stored hash using timing-safe equality.
 * `storedHashHex` must be a 64-char lowercase hex SHA-256 digest from the database.
 */
export function verifyBackupCodeAgainstStoredHash(rawInput: string, storedHashHex: string): boolean {
  const normalized = parseBackupCodeInput(rawInput);
  if (!normalized) {
    return false;
  }
  const computedHex = hashBackupCodeForStorage(normalized);
  let a: Buffer;
  let b: Buffer;
  try {
    a = Buffer.from(computedHex, 'hex');
    b = Buffer.from(storedHashHex, 'hex');
  } catch {
    return false;
  }
  if (a.length !== b.length || a.length !== 32) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}
