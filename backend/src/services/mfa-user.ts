/**
 * MFA enrollment, backup codes, step-up verification, disable/regenerate — DB-backed.
 * Handlers stay thin; errors map to HTTP in routes.
 */

import type Database from 'better-sqlite3';
import type { Pool, PoolClient } from 'pg';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { getDb, getDbType, queryOne, execute } from '../db/index.js';
import {
  generateTotpSecret,
  buildTotpOtpauthUrl,
  encryptTotpSecretForStorage,
  decryptTotpSecretFromStorage,
  verifyTotpCode,
  parseTotpCodeInput,
} from './mfa-totp.js';
import {
  generateBackupCodesPlaintext,
  hashBackupCodeForStorage,
  parseBackupCodeInput,
} from './mfa-backup-codes.js';

export function rowMfaEnabled(row: { mfa_enabled?: boolean | number | null }): boolean {
  return row.mfa_enabled === true || row.mfa_enabled === 1;
}

async function insertBackupCodeHashes(userId: string, plaintextCodes: string[]): Promise<void> {
  for (const code of plaintextCodes) {
    const normalized = parseBackupCodeInput(code);
    if (!normalized) continue;
    const hash = hashBackupCodeForStorage(normalized);
    await execute(
      'INSERT INTO mfa_backup_codes (id, user_id, code_hash) VALUES (?, ?, ?)',
      [uuidv4(), userId, hash]
    );
  }
}

/**
 * Atomically mark one backup row used by hash. Returns true if a row was updated.
 */
export async function tryConsumeBackupCode(userId: string, rawBackupInput: string): Promise<boolean> {
  const normalized = parseBackupCodeInput(rawBackupInput);
  if (!normalized) return false;
  const hash = hashBackupCodeForStorage(normalized);

  if (getDbType() === 'postgresql') {
    const pool = getDb() as Pool;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const sel = await client.query<{ id: string }>(
        `SELECT id FROM mfa_backup_codes
         WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
         LIMIT 1
         FOR UPDATE`,
        [userId, hash]
      );
      if (sel.rows.length === 0) {
        await client.query('ROLLBACK');
        return false;
      }
      const id = sel.rows[0].id;
      const up = await client.query(
        `UPDATE mfa_backup_codes SET used_at = CURRENT_TIMESTAMP WHERE id = $1 AND used_at IS NULL`,
        [id]
      );
      if ((up.rowCount ?? 0) !== 1) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query('COMMIT');
      return true;
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw e;
    } finally {
      client.release();
    }
  }

  const sqlite = getDb() as Database.Database;
  return sqlite.transaction(() => {
    const row = sqlite
      .prepare(
        `SELECT id FROM mfa_backup_codes
         WHERE user_id = ? AND code_hash = ? AND used_at IS NULL
         LIMIT 1`
      )
      .get(userId, hash) as { id: string } | undefined;
    if (!row) return false;
    const now = new Date().toISOString();
    const result = sqlite
      .prepare('UPDATE mfa_backup_codes SET used_at = ? WHERE id = ? AND used_at IS NULL')
      .run(now, row.id);
    return result.changes === 1;
  })();
}

/** TOTP or an existing unused backup hash match (does not consume). */
export async function possessionCodeValid(userId: string, rawCode: string): Promise<boolean> {
  const user = await queryOne(
    'SELECT mfa_enabled, mfa_totp_secret_enc FROM users WHERE id = ?',
    [userId]
  );
  if (!user || !rowMfaEnabled(user as any) || !(user as any).mfa_totp_secret_enc) {
    return false;
  }
  const enc = (user as any).mfa_totp_secret_enc as string;
  let plain: string;
  try {
    plain = decryptTotpSecretFromStorage(enc);
  } catch {
    return false;
  }

  if (parseTotpCodeInput(rawCode) && verifyTotpCode(plain, rawCode)) {
    return true;
  }

  const normalized = parseBackupCodeInput(rawCode);
  if (!normalized) return false;
  const h = hashBackupCodeForStorage(normalized);
  const row = await queryOne(
    'SELECT id FROM mfa_backup_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL',
    [userId, h]
  );
  return Boolean(row);
}

export async function getMfaStatus(userId: string): Promise<{ enabled: boolean; enrolled_at: string | null }> {
  const row = await queryOne(
    'SELECT mfa_enabled, mfa_enrolled_at FROM users WHERE id = ?',
    [userId]
  );
  if (!row) {
    return { enabled: false, enrolled_at: null };
  }
  const r = row as any;
  const enrolledAt = r.mfa_enrolled_at != null ? String(r.mfa_enrolled_at) : null;
  return { enabled: rowMfaEnabled(r), enrolled_at: enrolledAt };
}

export type EnrollBeginResult = { otpauth_url: string; secret: string };

export async function enrollBegin(userId: string, accountEmail: string): Promise<EnrollBeginResult | { error: 'already_enrolled' }> {
  const row = await queryOne('SELECT mfa_enabled FROM users WHERE id = ?', [userId]);
  if (!row) return { error: 'already_enrolled' };
  if (rowMfaEnabled(row as any)) {
    return { error: 'already_enrolled' };
  }
  const secret = generateTotpSecret();
  const enc = encryptTotpSecretForStorage(secret);
  await execute('UPDATE users SET mfa_totp_secret_enc = ? WHERE id = ?', [enc, userId]);
  return {
    otpauth_url: buildTotpOtpauthUrl(secret, accountEmail),
    secret,
  };
}

export type EnrollConfirmResult =
  | { ok: true; backup_codes: string[] }
  | { ok: false; reason: 'already_enabled' | 'no_pending_enrollment' | 'invalid_code' };

export async function enrollConfirm(userId: string, rawCode: string): Promise<EnrollConfirmResult> {
  const user = await queryOne(
    'SELECT mfa_enabled, mfa_totp_secret_enc FROM users WHERE id = ?',
    [userId]
  );
  if (!user) {
    return { ok: false, reason: 'no_pending_enrollment' };
  }
  const u = user as any;
  if (rowMfaEnabled(u)) {
    return { ok: false, reason: 'already_enabled' };
  }
  if (!u.mfa_totp_secret_enc) {
    return { ok: false, reason: 'no_pending_enrollment' };
  }
  let plain: string;
  try {
    plain = decryptTotpSecretFromStorage(u.mfa_totp_secret_enc);
  } catch {
    return { ok: false, reason: 'invalid_code' };
  }
  if (!verifyTotpCode(plain, rawCode)) {
    return { ok: false, reason: 'invalid_code' };
  }

  const now = new Date().toISOString();
  const codes = generateBackupCodesPlaintext();
  const DB_TYPE = getDbType();

  if (DB_TYPE === 'postgresql') {
    const pool = getDb() as Pool;
    const client: PoolClient = await pool.connect();
    try {
      await client.query('BEGIN');
      const up = await client.query(
        'UPDATE users SET mfa_enabled = TRUE, mfa_enrolled_at = $1 WHERE id = $2 AND mfa_enabled = FALSE',
        [now, userId]
      );
      if ((up.rowCount ?? 0) !== 1) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'already_enabled' };
      }
      await client.query('DELETE FROM mfa_backup_codes WHERE user_id = $1', [userId]);
      for (const code of codes) {
        const normalized = parseBackupCodeInput(code);
        if (!normalized) continue;
        const hash = hashBackupCodeForStorage(normalized);
        await client.query(
          'INSERT INTO mfa_backup_codes (id, user_id, code_hash) VALUES ($1, $2, $3)',
          [uuidv4(), userId, hash]
        );
      }
      await client.query('COMMIT');
      return { ok: true, backup_codes: codes };
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw e;
    } finally {
      client.release();
    }
  }

  const sqlite = getDb() as Database.Database;
  const ENROLL_CONFLICT = 'ENROLL_CONFIRM_CONFLICT';
  try {
    sqlite.transaction(() => {
      const up = sqlite
        .prepare(
          'UPDATE users SET mfa_enabled = 1, mfa_enrolled_at = ? WHERE id = ? AND (mfa_enabled = 0 OR mfa_enabled IS NULL)'
        )
        .run(now, userId);
      if (up.changes !== 1) {
        throw Object.assign(new Error('enroll confirm not applied'), { code: ENROLL_CONFLICT });
      }
      sqlite.prepare('DELETE FROM mfa_backup_codes WHERE user_id = ?').run(userId);
      const ins = sqlite.prepare(
        'INSERT INTO mfa_backup_codes (id, user_id, code_hash) VALUES (?, ?, ?)'
      );
      for (const code of codes) {
        const normalized = parseBackupCodeInput(code);
        if (!normalized) continue;
        ins.run(uuidv4(), userId, hashBackupCodeForStorage(normalized));
      }
    })();
  } catch (e: any) {
    if (e?.code === ENROLL_CONFLICT) {
      return { ok: false, reason: 'already_enabled' };
    }
    throw e;
  }
  return { ok: true, backup_codes: codes };
}

export type EnrollCancelResult = { ok: true } | { ok: false; reason: 'already_enabled' };

export async function enrollCancel(userId: string): Promise<EnrollCancelResult> {
  const user = await queryOne('SELECT mfa_enabled, mfa_totp_secret_enc FROM users WHERE id = ?', [userId]);
  if (!user) return { ok: true };
  const u = user as any;
  if (rowMfaEnabled(u)) {
    return { ok: false, reason: 'already_enabled' };
  }
  await execute('UPDATE users SET mfa_totp_secret_enc = NULL WHERE id = ?', [userId]);
  return { ok: true };
}

export type DisableMfaResult =
  | { ok: true }
  | { ok: false; reason: 'not_enabled' | 'password_required' | 'invalid_password' | 'invalid_code' };

export async function disableMfa(
  userId: string,
  opts: { rawCode: string; password?: string }
): Promise<DisableMfaResult> {
  const user = await queryOne(
    'SELECT mfa_enabled, password_hash FROM users WHERE id = ?',
    [userId]
  );
  if (!user) return { ok: false, reason: 'not_enabled' };
  const u = user as any;
  if (!rowMfaEnabled(u)) {
    return { ok: false, reason: 'not_enabled' };
  }
  if (u.password_hash) {
    if (!opts.password || typeof opts.password !== 'string') {
      return { ok: false, reason: 'password_required' };
    }
    const match = await bcrypt.compare(opts.password, u.password_hash);
    if (!match) {
      return { ok: false, reason: 'invalid_password' };
    }
  }
  const okCode = await possessionCodeValid(userId, opts.rawCode);
  if (!okCode) {
    return { ok: false, reason: 'invalid_code' };
  }

  if (getDbType() === 'postgresql') {
    await execute(
      'UPDATE users SET mfa_enabled = FALSE, mfa_totp_secret_enc = NULL, mfa_enrolled_at = NULL WHERE id = ?',
      [userId]
    );
  } else {
    await execute(
      'UPDATE users SET mfa_enabled = 0, mfa_totp_secret_enc = NULL, mfa_enrolled_at = NULL WHERE id = ?',
      [userId]
    );
  }
  await execute('DELETE FROM mfa_backup_codes WHERE user_id = ?', [userId]);
  return { ok: true };
}

export type RegenerateBackupResult =
  | { ok: true; backup_codes: string[] }
  | { ok: false; reason: 'not_enabled' | 'password_required' | 'invalid_password' | 'invalid_code' };

export async function regenerateBackupCodes(
  userId: string,
  opts: { rawCode: string; password?: string }
): Promise<RegenerateBackupResult> {
  const user = await queryOne(
    'SELECT mfa_enabled, password_hash FROM users WHERE id = ?',
    [userId]
  );
  if (!user) return { ok: false, reason: 'not_enabled' };
  const u = user as any;
  if (!rowMfaEnabled(u)) {
    return { ok: false, reason: 'not_enabled' };
  }
  if (u.password_hash) {
    if (!opts.password || typeof opts.password !== 'string') {
      return { ok: false, reason: 'password_required' };
    }
    const match = await bcrypt.compare(opts.password, u.password_hash);
    if (!match) {
      return { ok: false, reason: 'invalid_password' };
    }
  }
  const okCode = await possessionCodeValid(userId, opts.rawCode);
  if (!okCode) {
    return { ok: false, reason: 'invalid_code' };
  }

  await execute('DELETE FROM mfa_backup_codes WHERE user_id = ?', [userId]);
  const codes = generateBackupCodesPlaintext();
  await insertBackupCodeHashes(userId, codes);
  return { ok: true, backup_codes: codes };
}

/**
 * MFA step-up after login/OIDC: valid TOTP, or consume one backup code in a transaction.
 */
export async function verifyMfaStepUp(userId: string, rawCode: string): Promise<boolean> {
  const user = await queryOne(
    'SELECT mfa_enabled, mfa_totp_secret_enc FROM users WHERE id = ?',
    [userId]
  );
  if (!user || !rowMfaEnabled(user as any) || !(user as any).mfa_totp_secret_enc) {
    return false;
  }
  const enc = (user as any).mfa_totp_secret_enc as string;
  let plain: string;
  try {
    plain = decryptTotpSecretFromStorage(enc);
  } catch {
    return false;
  }

  if (parseTotpCodeInput(rawCode) && verifyTotpCode(plain, rawCode)) {
    return true;
  }

  if (parseBackupCodeInput(rawCode)) {
    return tryConsumeBackupCode(userId, rawCode);
  }

  return false;
}
