import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CREDENTIAL_TOKEN_BYTES, CREDENTIAL_TOKEN_PURPOSES, CREDENTIAL_TOKEN_TTL_SECONDS, generateCredentialToken } from "../../src/auth/credential-tokens.ts";

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
