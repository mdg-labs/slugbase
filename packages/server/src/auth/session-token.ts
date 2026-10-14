import { createHash, randomBytes } from "node:crypto";
import { SESSION_TOKEN_BYTES } from "@slugbase/core";

// The session token (doc 01 section 10, D10): 32 random bytes, sent to the
// browser as base64url and stored only as their SHA-256. The cookie value is the
// token; nothing derived from the database row is ever sent.

const ENCODED_LENGTH = Math.ceil((SESSION_TOKEN_BYTES * 4) / 3);

export interface SessionToken {
  /** The cookie value. */
  readonly value: string;
  /** SHA-256 of the 32 bytes, what the database stores. */
  readonly hash: Buffer;
}

function sha256(bytes: Buffer): Buffer {
  return createHash("sha256").update(bytes).digest();
}

/** A fresh token from the operating system's random source. */
export function newSessionToken(): SessionToken {
  const bytes = randomBytes(SESSION_TOKEN_BYTES);
  return { value: bytes.toString("base64url"), hash: sha256(bytes) };
}

/**
 * The hash of the token a cookie value carries, or undefined for a value that is
 * not exactly the encoding of 32 bytes this server writes (wrong length, a
 * character outside the base64url alphabet, a non-canonical spelling of the same bytes).
 */
export function hashSessionToken(value: string): Buffer | undefined {
  if (value.length !== ENCODED_LENGTH) {
    return undefined;
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== SESSION_TOKEN_BYTES || bytes.toString("base64url") !== value) {
    return undefined;
  }
  return sha256(bytes);
}
