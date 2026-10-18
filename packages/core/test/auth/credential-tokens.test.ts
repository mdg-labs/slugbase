import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_TOKEN_BYTES,
  CREDENTIAL_TOKEN_PURPOSES,
  CREDENTIAL_TOKEN_TTL_SECONDS,
  generateCredentialToken,
  hashCredentialToken,
} from "../../src/auth/credential-tokens.ts";

describe("generateCredentialToken", () => {
  it("makes a token of 32 random bytes as 43 unpadded base64url characters", () => {
    const { value } = generateCredentialToken();
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(value, "base64url")).toHaveLength(CREDENTIAL_TOKEN_BYTES);
  });

  it("hashes the 32 bytes the value encodes with SHA-256", () => {
    const { value, hash } = generateCredentialToken();
    expect(hash).toEqual(createHash("sha256").update(Buffer.from(value, "base64url")).digest());
    expect(hash).toHaveLength(32);
  });

  it("never repeats", () => {
    const values = new Set(Array.from({ length: 50 }, () => generateCredentialToken().value));
    expect(values.size).toBe(50);
  });
});

describe("CREDENTIAL_TOKEN_TTL_SECONDS", () => {
  it("lives 24 hours for the signup verification (Q48) and 1 hour for every other purpose (doc 02 section 16)", () => {
    expect(CREDENTIAL_TOKEN_TTL_SECONDS.email_verify).toBe(86_400);
    expect(CREDENTIAL_TOKEN_TTL_SECONDS.email_change).toBe(3600);
    expect(CREDENTIAL_TOKEN_TTL_SECONDS.password_reset).toBe(3600);
  });

  it("has a lifetime for every purpose", () => {
    expect(Object.keys(CREDENTIAL_TOKEN_TTL_SECONDS).sort()).toEqual([...CREDENTIAL_TOKEN_PURPOSES].sort());
  });
});

describe("hashCredentialToken", () => {
  it("hashes a value this module issued to what it stored for it", () => {
    const { value, hash } = generateCredentialToken();
    expect(hashCredentialToken(value)).toEqual(hash);
  });

  it("refuses a value that is not the encoding of 32 bytes: wrong length, a foreign character, padding", () => {
    const { value } = generateCredentialToken();
    for (const bad of ["", value.slice(1), `${value}A`, `${value.slice(0, 42)}!`, `${value.slice(0, 42)}=`, ` ${value.slice(1)}`]) {
      expect(hashCredentialToken(bad)).toBeUndefined();
    }
  });

  it("refuses a second spelling of the bytes of a token, so one token has one value", () => {
    const canonical = "A".repeat(43);
    expect(hashCredentialToken(canonical)).toBeDefined();
    // The last character carries two bits that no byte uses; "B" sets one of them and decodes to the same 32 bytes.
    expect(Buffer.from(`${"A".repeat(42)}B`, "base64url").equals(Buffer.from(canonical, "base64url"))).toBe(true);
    expect(hashCredentialToken(`${"A".repeat(42)}B`)).toBeUndefined();
  });
});
