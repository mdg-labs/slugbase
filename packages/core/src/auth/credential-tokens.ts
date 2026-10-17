import { createHash, randomBytes } from "node:crypto";

// The emailed single-use token (doc 02 section 2.6, doc 05 section 2.1, doc 10 T4, T7): 32 random bytes,
// carried in the fragment of a link as base64url, which is 43 characters with no padding, and stored only as
// their SHA-256. The functions are pure apart from the random draw, and nothing here logs or keeps a token.

/** What an emailed token is for; the values of `credential_tokens.purpose`. */
export const CREDENTIAL_TOKEN_PURPOSES = ["email_verify", "email_change", "email_change_cancel", "password_reset"] as const;

export type CredentialTokenPurpose = (typeof CREDENTIAL_TOKEN_PURPOSES)[number];

/** A token carries this many random bytes. */
export const CREDENTIAL_TOKEN_BYTES = 32;

/** How long a token of each purpose works (doc 02 section 16, Q48): signup verification 24 hours, every other 1 hour. */
export const CREDENTIAL_TOKEN_TTL_SECONDS = {
  email_verify: 24 * 60 * 60,
  email_change: 60 * 60,
  email_change_cancel: 60 * 60,
  password_reset: 60 * 60,
} as const satisfies Record<CredentialTokenPurpose, number>;

export interface CredentialToken {
  /** The text the link carries; put into the email once and never stored. */
  readonly value: string;
  /** SHA-256 of the 32 bytes, what the database stores. */
  readonly hash: Buffer;
}

/** A fresh token from the operating system's random source. */
export function generateCredentialToken(): CredentialToken {
  const bytes = randomBytes(CREDENTIAL_TOKEN_BYTES);
  return { value: bytes.toString("base64url"), hash: createHash("sha256").update(bytes).digest() };
}
