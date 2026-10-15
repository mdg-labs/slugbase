import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Time-based one-time passwords (RFC 6238, doc 02 section 2.7) and backup
// codes. A code has 6 digits and a time step is 30 seconds; the algorithm is
// HMAC-SHA-1, which every authenticator app supports. A code of the step before
// or after the current one is accepted, so one step of clock skew either way is
// tolerated. The functions are pure apart from the random draws: the caller
// passes the instant and the secret, and nothing here logs or keeps either.

export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
/** How many steps before and after the current one a code may be from. */
export const TOTP_SKEW_STEPS = 1;
/** 160 bits, the length RFC 4226 recommends for an HMAC-SHA-1 secret. */
export const TOTP_SECRET_BYTES = 20;

export const BACKUP_CODE_COUNT = 10;
export const BACKUP_CODE_LENGTH = 10;
/** 32 symbols without the look-alikes 0, 1, I and O, so a code read aloud or from paper is unambiguous. */
export const BACKUP_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const CODE_PATTERN = /^[0-9]{6}$/;
const MODULUS = 10 ** TOTP_DIGITS;

/** A new random secret. */
export function generateTotpSecret(): Uint8Array {
  return new Uint8Array(randomBytes(TOTP_SECRET_BYTES));
}

/** RFC 4648 base32 without padding: the text key an authenticator app takes. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) {
    out += BASE32_ALPHABET.charAt((value << (5 - bits)) & 31);
  }
  return out;
}

/** The time step `nowMs` falls in: whole periods since the Unix epoch. */
export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

/** The code of one time step (RFC 4226 dynamic truncation of HMAC-SHA-1). */
export function totpCode(secret: Uint8Array, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", secret).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % MODULUS).padStart(TOTP_DIGITS, "0");
}

/**
 * The time step `code` is valid for at `nowMs`, or undefined when it is none of the current step
 * and its neighbours. The code is compared against every candidate in constant time and the three
 * candidates are always all computed, so the answer's timing does not say which step matched.
 * Spaces in `code` are ignored, as an authenticator app groups its digits. A step below 1 is never
 * a candidate. The caller records the step it gets back and refuses a step it has seen.
 */
export function verifyTotp(secret: Uint8Array, code: string, nowMs: number): number | undefined {
  const typed = code.replace(/ /g, "");
  const wellFormed = CODE_PATTERN.test(typed);
  const current = totpStep(nowMs);
  let matched: number | undefined;
  for (let offset = -TOTP_SKEW_STEPS; offset <= TOTP_SKEW_STEPS; offset += 1) {
    const step = current + offset;
    if (step < 1) {
      continue;
    }
    const expected = Buffer.from(totpCode(secret, step));
    // A malformed code is replaced by one no candidate can equal, so it costs the same comparisons.
    const given = Buffer.from(wellFormed ? typed : "-".repeat(TOTP_DIGITS));
    if (timingSafeEqual(expected, given)) {
      matched = step;
    }
  }
  return matched;
}

export interface OtpauthOptions {
  /** The service the app lists the account under. */
  readonly issuer: string;
  /** The account the code is for, normally its email. */
  readonly account: string;
  /** The secret as the base32 text key. */
  readonly secret: string;
}

/** The `otpauth://totp/` URI an authenticator app reads from a QR code (Google Authenticator key URI format). */
export function otpauthUri({ issuer, account, secret }: OtpauthOptions): string {
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?${query.toString().replace(/\+/g, "%20")}`;
}

/** One backup code: 10 symbols drawn uniformly from `BACKUP_CODE_ALPHABET` (50 bits). */
function backupCode(): string {
  let out = "";
  // 256 is a multiple of 32, so masking a random byte to five bits is uniform.
  for (const byte of randomBytes(BACKUP_CODE_LENGTH)) {
    out += BACKUP_CODE_ALPHABET.charAt(byte & 31);
  }
  return out;
}

/** `count` distinct backup codes. */
export function generateBackupCodes(count = BACKUP_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) {
    codes.add(backupCode());
  }
  return [...codes];
}
