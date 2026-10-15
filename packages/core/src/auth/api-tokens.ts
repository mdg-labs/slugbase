import { createHash, randomBytes } from "node:crypto";

// The personal API token (doc 02 section 2.9, doc 04 section 4.1, doc 10 T4):
// `slb_` followed by 32 random bytes encoded as base64url, which is 43
// characters with no padding. Only the SHA-256 of the whole token is stored; the
// token is shown once, in the response that creates it. The functions are pure
// apart from the random draw, and nothing here logs or keeps a token.

/** The fixed start of every token, so a secret scanner can find one. */
export const API_TOKEN_PREFIX = "slb_";

/** A token carries this many random bytes. */
export const API_TOKEN_BYTES = 32;

/** The length of the part after `slb_`: 32 bytes as unpadded base64url. */
export const API_TOKEN_SECRET_LENGTH = 43;

/** How many characters after `slb_` are kept for display and leak scanning. */
export const API_TOKEN_DISPLAY_PREFIX_LENGTH = 6;

/** The most tokens an account may hold that are neither revoked nor expired (doc 02 section 2.9). */
export const MAX_API_TOKENS_PER_USER = 10;

export interface ApiToken {
  /** The text the bearer presents; returned once and never stored. */
  readonly value: string;
  /** SHA-256 of the value, what the database stores. */
  readonly hash: Buffer;
  /** The first characters after `slb_`, what the database keeps for display. */
  readonly displayPrefix: string;
}

/** The hash of a token as presented. */
export function hashApiToken(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** A fresh token from the operating system's random source. */
export function generateApiToken(): ApiToken {
  const value = `${API_TOKEN_PREFIX}${randomBytes(API_TOKEN_BYTES).toString("base64url")}`;
  return {
    value,
    hash: hashApiToken(value),
    displayPrefix: value.slice(API_TOKEN_PREFIX.length, API_TOKEN_PREFIX.length + API_TOKEN_DISPLAY_PREFIX_LENGTH),
  };
}
