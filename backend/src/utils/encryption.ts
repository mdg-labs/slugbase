import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';

const IV_LENGTH = 16;
const SALT_LENGTH = 64;
const KEY_LENGTH = 32;

/** Max structured lines per process before sampling (avoids log floods). */
const DECRYPT_FALLBACK_LOG_INITIAL = 20;
const DECRYPT_FALLBACK_LOG_SAMPLE_INTERVAL = 50;

type DecryptFallbackReason = 'format_mismatch' | 'decipher_failed';

const decryptFallbackMetrics = {
  format_mismatch: 0,
  decipher_failed: 0,
};

let decryptFallbackLogCount = 0;

/**
 * When `NODE_ENV` is `production` and `SLUGBASE_ENCRYPTION_STRICT=true`, sensitive at-rest fields
 * (OIDC client secrets, TOTP ciphertext) use {@link decryptSensitiveAtRest}, which throws instead
 * of passthrough on format/decrypt failure. Other callers keep legacy migration behavior.
 */
export function isSensitiveEncryptionStrict(): boolean {
  return process.env.NODE_ENV === 'production' && process.env.SLUGBASE_ENCRYPTION_STRICT === 'true';
}

/** Counters for decrypt migration fallbacks (plaintext passthrough paths). Safe to scrape for alerts. */
export function getDecryptFallbackMetrics(): Readonly<typeof decryptFallbackMetrics> {
  return { ...decryptFallbackMetrics };
}

function recordDecryptFallback(reason: DecryptFallbackReason): void {
  decryptFallbackMetrics[reason]++;

  decryptFallbackLogCount++;
  const total =
    decryptFallbackMetrics.format_mismatch + decryptFallbackMetrics.decipher_failed;
  const shouldLog =
    process.env.NODE_ENV !== 'production' ||
    decryptFallbackLogCount <= DECRYPT_FALLBACK_LOG_INITIAL ||
    total % DECRYPT_FALLBACK_LOG_SAMPLE_INTERVAL === 0;

  if (!shouldLog) {
    return;
  }

  console.warn(
    '[encryption]',
    JSON.stringify({
      event: 'decrypt_fallback',
      reason,
      format_mismatch_total: decryptFallbackMetrics.format_mismatch,
      decipher_failed_total: decryptFallbackMetrics.decipher_failed,
      fallback_total: total,
      nodeEnv: process.env.NODE_ENV ?? null,
    })
  );
}

/**
 * Get encryption key from environment variable
 * ENCRYPTION_KEY is validated at startup via validateEnvironmentVariables()
 * This will throw if not set, preventing insecure defaults
 */
function getEncryptionKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    throw new Error('ENCRYPTION_KEY environment variable is required. Please set it before starting the server.');
  }

  // If key is provided as hex string (64 chars = 32 bytes), convert it
  if (key.length === 64) {
    try {
      return Buffer.from(key, 'hex');
    } catch (error) {
      throw new Error('ENCRYPTION_KEY must be a valid hex string (64 characters) or a string of at least 32 characters');
    }
  }

  // Otherwise, derive key from the provided string
  if (key.length < 32) {
    throw new Error('ENCRYPTION_KEY must be at least 32 characters long');
  }

  return crypto.scryptSync(key, 'slugbase-salt', KEY_LENGTH);
}

function decryptFourPartCiphertext(parts: [string, string, string, string]): string {
  const [saltHex, ivHex, tagHex, encrypted] = parts;
  const salt = Buffer.from(saltHex, 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');

  const key = getEncryptionKey();
  const derivedKey = crypto.scryptSync(key, salt, KEY_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, derivedKey, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

type DecryptAttempt = { ok: true; value: string } | { ok: false; error: DecryptFallbackReason };

function tryDecryptCiphertext(encryptedText: string): DecryptAttempt {
  const parts = encryptedText.split(':');
  if (parts.length !== 4) {
    return { ok: false, error: 'format_mismatch' };
  }
  try {
    const value = decryptFourPartCiphertext(parts as [string, string, string, string]);
    return { ok: true, value };
  } catch {
    return { ok: false, error: 'decipher_failed' };
  }
}

/**
 * Encrypt sensitive data
 * @param text - Plain text to encrypt
 * @returns Encrypted string in format: salt:iv:tag:encryptedData (all hex encoded)
 */
export function encrypt(text: string): string {
  if (!text) {
    return text;
  }

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const salt = crypto.randomBytes(SALT_LENGTH);

  // Derive key from master key and salt
  const derivedKey = crypto.scryptSync(key, salt, KEY_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, derivedKey, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const tag = cipher.getAuthTag();

  // Return format: salt:iv:tag:encryptedData
  return `${salt.toString('hex')}:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt sensitive data (legacy migration semantics: plaintext passthrough on format mismatch or failure).
 * @param encryptedText - Encrypted string in format: salt:iv:tag:encryptedData
 * @returns Decrypted plain text
 */
export function decrypt(encryptedText: string): string {
  if (!encryptedText) {
    return encryptedText;
  }

  const attempt = tryDecryptCiphertext(encryptedText);
  if (attempt.ok) {
    return attempt.value;
  }

  recordDecryptFallback(attempt.error);
  return encryptedText;
}

/**
 * Decrypt OIDC secrets, TOTP/MFA ciphertext, and other sensitive columns where production operators
 * may opt into strict failure (see {@link isSensitiveEncryptionStrict}). When strict mode is off,
 * behavior matches {@link decrypt}.
 */
export function decryptSensitiveAtRest(encryptedText: string): string {
  if (!encryptedText) {
    return encryptedText;
  }

  if (!isSensitiveEncryptionStrict()) {
    return decrypt(encryptedText);
  }

  const attempt = tryDecryptCiphertext(encryptedText);
  if (attempt.ok) {
    return attempt.value;
  }

  const msg =
    attempt.error === 'format_mismatch'
      ? 'Sensitive field value is not valid ciphertext (expected salt:iv:tag:data). Plaintext-at-rest is not allowed when SLUGBASE_ENCRYPTION_STRICT is enabled.'
      : 'Sensitive field decryption failed. Verify ENCRYPTION_KEY matches the key used when the value was stored.';

  throw new Error(`[encryption] ${msg}`);
}

/**
 * Generate a secure encryption key (for use in ENCRYPTION_KEY env var)
 * @returns Hex-encoded 32-byte key
 */
export function generateEncryptionKey(): string {
  return crypto.randomBytes(KEY_LENGTH).toString('hex');
}
