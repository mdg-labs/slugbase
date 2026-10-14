import * as argon2 from "@node-rs/argon2";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPasswordVerifier, hashPassword } from "../../src/auth/password.ts";

// Passwords are argon2id PHC strings, and a sign-in costs one verification
// whatever the account (doc 02 section 2.3, doc 10 T8).

vi.mock("@node-rs/argon2", async (importOriginal) => {
  const original = await importOriginal<typeof import("@node-rs/argon2")>();
  return { ...original, verify: vi.fn(original.verify) };
});

const verifyCalls = vi.mocked(argon2.verify);

beforeEach(() => {
  verifyCalls.mockClear();
});

describe("hashPassword", () => {
  it("writes an argon2id PHC string with the OWASP minimum parameters and a random salt", async () => {
    const first = await hashPassword("correct horse battery staple");
    const second = await hashPassword("correct horse battery staple");
    expect(first).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain("correct horse");
  });
});

describe("createPasswordVerifier", () => {
  it("accepts the right password and refuses a wrong one, each with one verification", async () => {
    const stored = await hashPassword("correct horse battery staple");
    const verifier = createPasswordVerifier();
    verifyCalls.mockClear();
    expect(await verifier.verify(stored, "correct horse battery staple")).toBe(true);
    expect(verifyCalls).toHaveBeenCalledTimes(1);
    expect(await verifier.verify(stored, "wrong horse battery staple")).toBe(false);
    expect(verifyCalls).toHaveBeenCalledTimes(2);
    expect(verifyCalls.mock.calls[0]?.[0]).toBe(stored);
  });

  it.each([
    ["no account", undefined],
    ["an account without a password", null],
    ["a hash of another algorithm", "$argon2i$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$Zm9vYmFy"],
    ["a hash that is not a PHC string", "not-a-hash"],
    ["a truncated argon2id hash", "$argon2id$v=19$m=19456,t=2,p=1$"],
  ])("runs one verification against a dummy hash and refuses for %s", async (_name, stored) => {
    const verifier = createPasswordVerifier();
    verifyCalls.mockClear();
    expect(await verifier.verify(stored, "correct horse battery staple")).toBe(false);
    expect(verifyCalls).toHaveBeenCalledTimes(1);
    const dummy = verifyCalls.mock.calls[0]?.[0];
    expect(typeof dummy === "string" && dummy.startsWith("$argon2id$v=19$m=19456,t=2,p=1$")).toBe(true);
    expect(dummy).not.toBe(stored);
  });

  it("makes the dummy hash once and reuses it", async () => {
    const verifier = createPasswordVerifier();
    await verifier.verify(null, "a");
    await verifier.verify(undefined, "b");
    expect(verifyCalls.mock.calls[0]?.[0]).toBe(verifyCalls.mock.calls[1]?.[0]);
  });

  it("never accepts the password against the dummy hash", async () => {
    const verifier = createPasswordVerifier();
    expect(await verifier.verify(null, "")).toBe(false);
    expect(await verifier.verify(undefined, "anything")).toBe(false);
  });
});
