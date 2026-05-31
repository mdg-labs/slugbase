import { randomBytes } from "node:crypto";

import * as argon2 from "argon2";
import { describe, expect, it } from "vitest";

const TOKEN_PREFIX = "slb_";
const TOKEN_RANDOM_BYTES = 32;
const LOOKUP_PREFIX_LENGTH = 8;

function makeToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(TOKEN_RANDOM_BYTES).toString("hex")}`;
}

function extractPrefix(token: string): string {
  return token.slice(TOKEN_PREFIX.length, TOKEN_PREFIX.length + LOOKUP_PREFIX_LENGTH);
}

describe("API token generation", () => {
  it("generates a token with the slb_ prefix and 64 hex chars", () => {
    const token = makeToken();
    expect(token).toMatch(/^slb_[0-9a-f]{64}$/);
  });

  it("generates unique tokens on each call", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => makeToken()));
    expect(tokens.size).toBe(50);
  });

  it("extracts an 8-char lowercase-hex prefix from the hex portion", () => {
    const token = makeToken();
    const prefix = extractPrefix(token);
    expect(prefix).toHaveLength(LOOKUP_PREFIX_LENGTH);
    expect(prefix).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("API token hash verification", () => {
  it("verifies the original token against its argon2id hash", async () => {
    const token = makeToken();
    const hash = await argon2.hash(token, { type: argon2.argon2id });
    expect(await argon2.verify(hash, token)).toBe(true);
  });

  it("rejects a different token against the hash", async () => {
    const token = makeToken();
    const otherToken = makeToken();
    const hash = await argon2.hash(token, { type: argon2.argon2id });
    expect(await argon2.verify(hash, otherToken)).toBe(false);
  });

  it("produces distinct hashes for the same token (argon2 random salting)", async () => {
    const token = makeToken();
    const hash1 = await argon2.hash(token, { type: argon2.argon2id });
    const hash2 = await argon2.hash(token, { type: argon2.argon2id });
    expect(hash1).not.toBe(hash2);
    expect(await argon2.verify(hash1, token)).toBe(true);
    expect(await argon2.verify(hash2, token)).toBe(true);
  });
});
