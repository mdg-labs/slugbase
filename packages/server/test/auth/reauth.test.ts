import * as argon2 from "@node-rs/argon2";
import { createPasswordPolicy } from "@slugbase/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPasswordVerifier, hashPassword } from "../../src/auth/password.ts";
import { changePassword, reauthenticate, type PasswordChangeDependencies } from "../../src/auth/reauth.ts";
import { newSessionToken } from "../../src/auth/session-token.ts";

// The checks in front of re-authentication and the password change (doc 04
// sections 4.4 and 10.3, doc 10 T8 and T18): a wrong password, an account
// without one and an unreadable hash are one outcome that costs one argon2id
// verification, nothing is written unless the password is right, and the new
// token is the one whose hash is stored.

vi.mock("@node-rs/argon2", async (importOriginal) => {
  const original = await importOriginal<typeof import("@node-rs/argon2")>();
  return { ...original, verify: vi.fn(original.verify) };
});

vi.mock("../../src/auth/session-token.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/auth/session-token.ts")>();
  return { ...original, newSessionToken: vi.fn(original.newSessionToken) };
});

const verifyCalls = vi.mocked(argon2.verify);
const issuedTokens = vi.mocked(newSessionToken);

const ACCOUNT = "0192f3a0-0000-7000-8000-0000000000a1";
const SESSION = "0192f3a0-0000-7000-8000-0000000000b1";
const CURRENT = "the current password";
const NEW = "a brand new password";
const NEW_HASH = "$argon2id$v=19$m=19456,t=2,p=1$bmV3$bmV3aGFzaA";

let storedHash: string;

beforeEach(async () => {
  storedHash = await hashPassword(CURRENT);
  verifyCalls.mockClear();
  issuedTokens.mockClear();
});

interface Calls {
  readonly marked: [string, string][];
  readonly changes: { accountId: string; sessionId: string; passwordHash: string; newTokenHash: Buffer }[];
  readonly hashed: string[];
}

function world(options: { hash?: string | null; sessionExists?: boolean } = {}): { dependencies: PasswordChangeDependencies; calls: Calls } {
  const calls: Calls = { marked: [], changes: [], hashed: [] };
  const hash = options.hash === undefined ? storedHash : options.hash;
  const dependencies: PasswordChangeDependencies = {
    store: {
      passwordHashOf: () => Promise.resolve(hash),
      markReauthenticated: (sessionId, accountId) => {
        calls.marked.push([sessionId, accountId]);
        return Promise.resolve(options.sessionExists ?? true);
      },
      changePassword: (change) => {
        calls.changes.push(change);
        return Promise.resolve(options.sessionExists ?? true);
      },
    },
    passwords: createPasswordVerifier(),
    passwordPolicy: createPasswordPolicy(),
    hashPassword: (password) => {
      calls.hashed.push(password);
      return Promise.resolve(NEW_HASH);
    },
  };
  return { dependencies, calls };
}

const request = { accountId: ACCOUNT, sessionId: SESSION };

describe("reauthenticate", () => {
  it("marks the session after the right password, once, for the session and account of the request", async () => {
    const { dependencies, calls } = world();
    expect(await reauthenticate(dependencies, { ...request, password: CURRENT })).toBe("reauthenticated");
    expect(calls.marked).toEqual([[SESSION, ACCOUNT]]);
  });

  it("writes nothing for a wrong password", async () => {
    const { dependencies, calls } = world();
    expect(await reauthenticate(dependencies, { ...request, password: "not the password" })).toBe("wrong_password");
    expect(calls.marked).toEqual([]);
  });

  it.each([
    ["an account without a password", null],
    ["a hash of another algorithm", "$argon2i$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$Zm9vYmFy"],
    ["a hash that is not a PHC string", "not-a-hash"],
    ["a wrong password against a real hash", undefined],
  ])("answers wrong_password after exactly one verification, and writes nothing, for %s", async (_name, hash) => {
    const { dependencies, calls } = world(hash === undefined ? {} : { hash });
    expect(await reauthenticate(dependencies, { ...request, password: "not the password" })).toBe("wrong_password");
    expect(verifyCalls).toHaveBeenCalledTimes(1);
    expect(calls.marked).toEqual([]);
  });

  it("answers no_session when the session is gone after the right password", async () => {
    const { dependencies } = world({ sessionExists: false });
    expect(await reauthenticate(dependencies, { ...request, password: CURRENT })).toBe("no_session");
  });

  it("does not report success when the store fails", async () => {
    const { dependencies } = world();
    const failing = { ...dependencies, store: { ...dependencies.store, markReauthenticated: () => Promise.reject(new Error("database down")) } };
    await expect(reauthenticate(failing, { ...request, password: CURRENT })).rejects.toThrow("database down");
  });
});

describe("changePassword", () => {
  it("writes the new hash and a new token's hash in one store call, and returns that token", async () => {
    const { dependencies, calls } = world();
    const outcome = await changePassword(dependencies, { ...request, currentPassword: CURRENT, newPassword: NEW });
    expect(outcome.kind).toBe("changed");
    expect(calls.changes).toHaveLength(1);
    const [change] = calls.changes;
    expect(change).toMatchObject({ accountId: ACCOUNT, sessionId: SESSION, passwordHash: NEW_HASH });
    expect(calls.hashed).toEqual([NEW]);
    if (outcome.kind !== "changed") {
      throw new Error("not changed");
    }
    expect(outcome.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issuedTokens).toHaveBeenCalledTimes(1);
    const issued = issuedTokens.mock.results[0];
    if (issued?.type !== "return") {
      throw new Error("no token was issued");
    }
    expect(outcome.token).toBe(issued.value.value);
    expect(change?.newTokenHash.equals(issued.value.hash)).toBe(true);
  });

  it("refuses a password the policy refuses, naming why, before verifying anything or writing", async () => {
    const { dependencies, calls } = world();
    expect(await changePassword(dependencies, { ...request, currentPassword: CURRENT, newPassword: "short" })).toEqual({
      kind: "weak_password",
      problems: ["too_short"],
    });
    expect(verifyCalls).not.toHaveBeenCalled();
    expect(calls.hashed).toEqual([]);
    expect(calls.changes).toEqual([]);
  });

  it.each([
    ["a wrong current password", undefined],
    ["an account without a password", null],
    ["a hash of another algorithm", "$argon2i$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$Zm9vYmFy"],
    ["a hash that is not a PHC string", "not-a-hash"],
  ])("answers the one wrong_password outcome after exactly one verification, hashing and writing nothing, for %s", async (_name, hash) => {
    const { dependencies, calls } = world(hash === undefined ? {} : { hash });
    expect(await changePassword(dependencies, { ...request, currentPassword: "not the password", newPassword: NEW })).toEqual({
      kind: "wrong_password",
    });
    expect(verifyCalls).toHaveBeenCalledTimes(1);
    expect(calls.hashed).toEqual([]);
    expect(calls.changes).toEqual([]);
  });

  it("answers no_session when the transaction finds no session to rotate", async () => {
    const { dependencies } = world({ sessionExists: false });
    expect(await changePassword(dependencies, { ...request, currentPassword: CURRENT, newPassword: NEW })).toEqual({ kind: "no_session" });
  });

  it("does not report a change when the store fails", async () => {
    const { dependencies } = world();
    const failing = { ...dependencies, store: { ...dependencies.store, changePassword: () => Promise.reject(new Error("database down")) } };
    await expect(changePassword(failing, { ...request, currentPassword: CURRENT, newPassword: NEW })).rejects.toThrow("database down");
  });

  it("returns neither password nor stored hash in a refusal", async () => {
    const { dependencies } = world();
    const refusals = [
      await changePassword(dependencies, { ...request, currentPassword: "not the password", newPassword: NEW }),
      await changePassword(dependencies, { ...request, currentPassword: CURRENT, newPassword: "short" }),
    ];
    for (const outcome of refusals) {
      const text = JSON.stringify(outcome);
      expect(text).not.toContain(storedHash);
      expect(text).not.toContain("not the password");
      expect(text).not.toContain(NEW);
    }
  });
});
