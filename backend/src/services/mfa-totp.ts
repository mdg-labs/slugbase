/**
 * TOTP (RFC 6238) helpers for MFA: secret generation, otpauth URI, verification.
 * Secrets at rest: use {@link encryptTotpSecretForStorage} / {@link decryptTotpSecretFromStorage} only;
 * do not log plaintext secrets, otpauth URLs, or submitted codes.
 */

import { generateSecret, generateURI, verifySync } from 'otplib';
import { encrypt, decryptSensitiveAtRest } from '../utils/encryption.js';

/** ±1 thirty-second step (see plan §3). */
const MFA_TOTP_EPOCH_TOLERANCE_SECONDS = 30;

const DEFAULT_MFA_ISSUER = 'SlugBase';

export function getMfaIssuerName(): string {
  const raw = process.env.MFA_ISSUER_NAME;
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  return trimmed.length > 0 ? trimmed : DEFAULT_MFA_ISSUER;
}

/**
 * Account label for otpauth URI (normalized email per plan §3).
 */
export function normalizeEmailForTotpLabel(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * New random Base32 TOTP secret (library-generated entropy).
 */
export function generateTotpSecret(): string {
  return generateSecret();
}

/**
 * otpauth:// URI for authenticator apps (QR input on the client). Do not log.
 */
export function buildTotpOtpauthUrl(secret: string, accountEmail: string): string {
  const issuer = getMfaIssuerName();
  const label = normalizeEmailForTotpLabel(accountEmail);
  return generateURI({
    issuer,
    label,
    secret,
  });
}

export function encryptTotpSecretForStorage(plainSecret: string): string {
  return encrypt(plainSecret);
}

export function decryptTotpSecretFromStorage(encrypted: string): string {
  return decryptSensitiveAtRest(encrypted);
}

/**
 * Strip whitespace; require exactly six digits. Returns null if invalid.
 */
export function parseTotpCodeInput(raw: string): string | null {
  if (raw == null || typeof raw !== 'string') {
    return null;
  }
  const digits = raw.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(digits)) {
    return null;
  }
  return digits;
}

/**
 * Verify a user-supplied TOTP against the plaintext secret (decrypt in the route, then call this).
 * Invalid or non-6-digit input returns false without verifying.
 */
export function verifyTotpCode(plainSecret: string, rawUserCode: string): boolean {
  const token = parseTotpCodeInput(rawUserCode);
  if (!token) {
    return false;
  }
  const result = verifySync({
    secret: plainSecret,
    token,
    epochTolerance: MFA_TOTP_EPOCH_TOLERANCE_SECONDS,
  });
  return result.valid === true;
}
