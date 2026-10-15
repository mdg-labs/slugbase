import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  API_TOKEN_SECRET_LENGTH,
  MAX_API_TOKENS_PER_USER,
  generateApiToken,
  hashApiToken,
} from "../../src/index.ts";

describe("generateApiToken", () => {
  it("is slb_ followed by 43 base64url characters, the encoding of 32 bytes", () => {
    const { value } = generateApiToken();
    expect(value).toMatch(/^slb_[A-Za-z0-9_-]{43}$/);
    expect(value.length - "slb_".length).toBe(API_TOKEN_SECRET_LENGTH);
    const bytes = Buffer.from(value.slice(4), "base64url");
    expect(bytes).toHaveLength(32);
    expect(bytes.toString("base64url")).toBe(value.slice(4));
  });

  it("hashes the whole token with SHA-256 and keeps the first six characters after slb_ for display", () => {
    const token = generateApiToken();
    expect(token.hash).toEqual(createHash("sha256").update(token.value, "utf8").digest());
    expect(token.hash).toHaveLength(32);
    expect(token.displayPrefix).toBe(token.value.slice(4, 10));
    expect(token.displayPrefix).toHaveLength(6);
    expect(hashApiToken(token.value)).toEqual(token.hash);
  });

  it("draws a different token every time", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateApiToken().value));
    expect(seen.size).toBe(200);
  });
});

describe("the limit", () => {
  it("is the ten active tokens per account of doc 02 section 2.9", () => {
    expect(MAX_API_TOKENS_PER_USER).toBe(10);
  });
});
