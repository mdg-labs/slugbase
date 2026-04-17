/**
 * Unit tests for MFA helpers (TOTP, backup codes, pending JWT).
 * Run via backend `npm test` (env provides JWT_SECRET for pending JWT cases).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { generateSync } from 'otplib';
import {
  parseTotpCodeInput,
  verifyTotpCode,
  generateTotpSecret,
  buildTotpOtpauthUrl,
  normalizeEmailForTotpLabel,
  getMfaIssuerName,
  encryptTotpSecretForStorage,
  decryptTotpSecretFromStorage,
} from '../src/services/mfa-totp.js';
import {
  parseBackupCodeInput,
  generateBackupCodesPlaintext,
  hashBackupCodeForStorage,
  verifyBackupCodeAgainstStoredHash,
  MFA_BACKUP_CODE_COUNT,
} from '../src/services/mfa-backup-codes.js';
import jwt from 'jsonwebtoken';
import {
  signMfaPendingToken,
  verifyMfaPendingToken,
  MFA_PENDING_JWT_TTL_MS,
} from '../src/utils/mfa-pending-jwt.js';
import { getMfaPendingCookieOptions, MFA_PENDING_COOKIE_NAME } from '../src/config/cookies.js';

describe('MFA TOTP', () => {
  it('parseTotpCodeInput strips whitespace and rejects non-6-digit', () => {
    assert.strictEqual(parseTotpCodeInput(' 123456 '), '123456');
    assert.strictEqual(parseTotpCodeInput('12 34 56'), '123456');
    assert.strictEqual(parseTotpCodeInput('12345'), null);
    assert.strictEqual(parseTotpCodeInput('1234567'), null);
    assert.strictEqual(parseTotpCodeInput('abcdef'), null);
  });

  it('verifyTotpCode accepts current interval code', () => {
    const secret = generateTotpSecret();
    const token = generateSync({ secret });
    assert.strictEqual(verifyTotpCode(secret, token), true);
  });

  it('verifyTotpCode rejects invalid input without throwing', () => {
    const secret = generateTotpSecret();
    assert.strictEqual(verifyTotpCode(secret, 'abc'), false);
    assert.strictEqual(verifyTotpCode(secret, ''), false);
  });

  it('normalizeEmailForTotpLabel lowercases and trims', () => {
    assert.strictEqual(normalizeEmailForTotpLabel('  User@EXAMPLE.com '), 'user@example.com');
  });

  it('buildTotpOtpauthUrl encodes issuer and account', () => {
    const prev = process.env.MFA_ISSUER_NAME;
    process.env.MFA_ISSUER_NAME = 'ACME Test';
    try {
      const url = buildTotpOtpauthUrl('JBSWY3DPEHPK3PXP', 'User@Example.com');
      assert.match(url, /^otpauth:\/\/totp\//);
      assert.ok(url.includes('secret=JBSWY3DPEHPK3PXP'));
      assert.ok(url.toLowerCase().includes('user%40example.com') || url.includes('user@example.com'));
    } finally {
      if (prev === undefined) {
        delete process.env.MFA_ISSUER_NAME;
      } else {
        process.env.MFA_ISSUER_NAME = prev;
      }
    }
  });

  it('getMfaIssuerName defaults when unset', () => {
    const prev = process.env.MFA_ISSUER_NAME;
    delete process.env.MFA_ISSUER_NAME;
    try {
      assert.strictEqual(getMfaIssuerName(), 'SlugBase');
    } finally {
      if (prev !== undefined) process.env.MFA_ISSUER_NAME = prev;
    }
  });

  it('encryptTotpSecretForStorage round-trips with ENCRYPTION_KEY', () => {
    const secret = generateTotpSecret();
    const enc = encryptTotpSecretForStorage(secret);
    assert.notStrictEqual(enc, secret);
    assert.ok(enc.includes(':'));
    assert.strictEqual(decryptTotpSecretFromStorage(enc), secret);
  });
});

describe('MFA backup codes', () => {
  it('generateBackupCodesPlaintext returns 10 lowercase hex strings', () => {
    const codes = generateBackupCodesPlaintext();
    assert.strictEqual(codes.length, MFA_BACKUP_CODE_COUNT);
    for (const c of codes) {
      assert.strictEqual(c.length, 16);
      assert.ok(/^[0-9a-f]{16}$/.test(c));
    }
  });

  it('parseBackupCodeInput normalizes case and whitespace', () => {
    assert.strictEqual(parseBackupCodeInput('  ABCDEF0123456789 '), 'abcdef0123456789');
    assert.strictEqual(parseBackupCodeInput('gggggggggggggggg'), null);
  });

  it('verifyBackupCodeAgainstStoredHash uses timing-safe compare', () => {
    const code = 'a1b2c3d4e5f67890';
    const hash = hashBackupCodeForStorage(code);
    assert.strictEqual(verifyBackupCodeAgainstStoredHash(code, hash), true);
    assert.strictEqual(verifyBackupCodeAgainstStoredHash('a1b2c3d4e5f67891', hash), false);
  });
});

describe('MFA pending JWT', () => {
  it('signMfaPendingToken and verifyMfaPendingToken round-trip', () => {
    const userId = 'user-uuid-123';
    const token = signMfaPendingToken(userId);
    assert.strictEqual(verifyMfaPendingToken(token)?.sub, userId);
  });

  it('rejects access-style JWT missing mfa_pending purpose', () => {
    const wrong = jwt.sign(
      { id: '1', email: 'a@test' },
      process.env.JWT_SECRET!,
      { algorithm: 'HS256', expiresIn: 60 }
    );
    assert.strictEqual(verifyMfaPendingToken(wrong), null);
  });
});

describe('MFA pending cookie options', () => {
  it('uses lax sameSite and path /', () => {
    const opts = getMfaPendingCookieOptions(MFA_PENDING_JWT_TTL_MS);
    assert.strictEqual(opts.httpOnly, true);
    assert.strictEqual(opts.sameSite, 'lax');
    assert.strictEqual(opts.path, '/');
    assert.strictEqual(opts.maxAge, MFA_PENDING_JWT_TTL_MS);
    assert.strictEqual(MFA_PENDING_COOKIE_NAME, 'slugbase.mfa_pending');
  });
});
