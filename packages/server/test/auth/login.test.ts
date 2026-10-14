import type { AuthStore, LoginCandidate, NewSession } from "@slugbase/db";
import { describe, expect, it } from "vitest";
import { signIn, type SignInRequest } from "../../src/auth/login.ts";
import type { PasswordVerifier } from "../../src/auth/password.ts";

// The sign-in service (doc 02 section 2.3, doc 10 T8): every outcome of a failed
// sign-in is one outcome, and every path costs one password verification.

const ACCOUNT = "0192f3a0-0000-7000-8000-000000000001";
const PASSWORD = "correct horse battery staple";

function setup(candidate: LoginCandidate | undefined, options: { created?: boolean } = {}) {
  const looked: string[] = [];
  const created: NewSession[] = [];
  const verified: { stored: string | null | undefined; password: string }[] = [];
  const store = {
    loginLookup: (email: string) => {
      looked.push(email);
      return Promise.resolve(candidate);
    },
    createSession: (session: NewSession) => {
      created.push(session);
      return Promise.resolve(options.created ?? true);
    },
  } as unknown as AuthStore;
  const passwords: PasswordVerifier = {
    verify: (stored, password) => {
      verified.push({ stored, password });
      return Promise.resolve(stored === "stored-hash" && password === PASSWORD);
    },
  };
  return { store, passwords, looked, created, verified };
}

const request: SignInRequest = {
  email: "  Ada@Example.test ",
  password: PASSWORD,
  remember: false,
  replacedTokenHash: null,
  ipPrefix: "203.0.0.0/16",
  userAgent: "Vitest",
};

const live: LoginCandidate = { accountId: ACCOUNT, passwordHash: "stored-hash", disabledAt: null };

describe("signIn", () => {
  it("looks the account up by the normalised email and creates a session with a new token", async () => {
    const world = setup(live);
    const result = await signIn(world, request);
    expect(world.looked).toEqual(["Ada@Example.test"]);
    expect(result?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(world.created).toHaveLength(1);
    const [session] = world.created;
    expect(session).toMatchObject({ accountId: ACCOUNT, remember: false, ipPrefix: "203.0.0.0/16", userAgent: "Vitest", replacedTokenHash: null });
    expect(session?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    expect(session?.tokenHash).toHaveLength(32);
    expect(session?.tokenHash.toString("base64url")).not.toBe(result?.token);
  });

  it("hands the hash of the cookie's token to the same call that creates the session, and carries remember", async () => {
    const world = setup(live);
    const replaced = Buffer.alloc(32, 7);
    await signIn(world, { ...request, remember: true, replacedTokenHash: replaced });
    expect(world.created[0]?.replacedTokenHash?.equals(replaced)).toBe(true);
    expect(world.created[0]?.remember).toBe(true);
  });

  const failures: readonly [string, LoginCandidate | undefined, string][] = [
    ["an unknown email", undefined, PASSWORD],
    ["a wrong password", live, "not the password"],
    ["an account without a password", { accountId: ACCOUNT, passwordHash: null, disabledAt: null }, PASSWORD],
    ["a disabled account with the right password", { ...live, disabledAt: new Date("2026-01-01T00:00:00Z") }, PASSWORD],
  ];

  it.each(failures)("refuses %s, with one password verification and no session", async (_name, candidate, password) => {
    const world = setup(candidate);
    expect(await signIn(world, { ...request, password })).toBeUndefined();
    expect(world.verified).toHaveLength(1);
    expect(world.created).toEqual([]);
  });

  it("verifies against the stored hash of a known account and against nothing for an unknown one", async () => {
    const known = setup(live);
    await signIn(known, { ...request, password: "wrong" });
    expect(known.verified[0]?.stored).toBe("stored-hash");
    const unknown = setup(undefined);
    await signIn(unknown, { ...request, password: "wrong" });
    expect(unknown.verified[0]?.stored).toBeUndefined();
  });

  it("refuses when the database will not create the session (the account was disabled meanwhile)", async () => {
    const world = setup(live, { created: false });
    expect(await signIn(world, request)).toBeUndefined();
    expect(world.created).toHaveLength(1);
  });

  it("does not turn a failing store into a failed or a successful sign-in", async () => {
    const world = setup(live);
    const store = { ...world.store, loginLookup: () => Promise.reject(new Error("database down")) } as unknown as AuthStore;
    await expect(signIn({ store, passwords: world.passwords }, request)).rejects.toThrow("database down");
    const failingCreate = { ...world.store, createSession: () => Promise.reject(new Error("database down")) } as unknown as AuthStore;
    await expect(signIn({ store: failingCreate, passwords: world.passwords }, request)).rejects.toThrow("database down");
  });
});
