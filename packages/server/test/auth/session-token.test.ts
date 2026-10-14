import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashSessionToken, newSessionToken } from "../../src/auth/session-token.ts";

describe("newSessionToken", () => {
  it("is 32 random bytes in base64url, whose SHA-256 is the stored hash", () => {
    const token = newSessionToken();
    expect(token.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const bytes = Buffer.from(token.value, "base64url");
    expect(bytes).toHaveLength(32);
    expect(token.hash.equals(createHash("sha256").update(bytes).digest())).toBe(true);
    expect(token.hash).toHaveLength(32);
    expect(token.hash.toString("base64url")).not.toBe(token.value);
  });

  it("is new every time", () => {
    const values = new Set(Array.from({ length: 50 }, () => newSessionToken().value));
    expect(values.size).toBe(50);
  });
});

describe("hashSessionToken", () => {
  it("hashes the token the same way the token was made", () => {
    const token = newSessionToken();
    expect(hashSessionToken(token.value)?.equals(token.hash)).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["short", "abc"],
    ["one character short", newSessionToken().value.slice(1)],
    ["one character long", `${newSessionToken().value}A`],
    ["outside the alphabet", `${"A".repeat(42)}+`],
    ["padded", `${newSessionToken().value.slice(0, 42)}=`],
    ["with a space", `${"A".repeat(42)} `],
  ])("refuses a value that is %s", (_name, value) => {
    expect(hashSessionToken(value)).toBeUndefined();
  });

  it("refuses a second spelling of the same 32 bytes", () => {
    const bytes = randomBytes(32);
    const canonical = bytes.toString("base64url");
    // The last character of 32 bytes holds two spare bits; set them and the same bytes decode again.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = alphabet.indexOf(canonical.at(-1) ?? "");
    const variant = `${canonical.slice(0, 42)}${alphabet[last | 1] ?? ""}`;
    expect(variant).not.toBe(canonical);
    expect(Buffer.from(variant, "base64url").equals(bytes)).toBe(true);
    expect(hashSessionToken(variant)).toBeUndefined();
    expect(hashSessionToken(canonical)).toBeDefined();
  });
});
