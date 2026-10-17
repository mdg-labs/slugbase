import type { AuthStore, LoginCandidate, MfaState, NewSession, SignInAlertContext } from "@slugbase/db";
import { describe, expect, it } from "vitest";
import { signIn, type SignInRequest } from "../../src/auth/login.ts";
import type { PasswordVerifier } from "../../src/auth/password.ts";

// The sign-in service (doc 02 section 2.3, doc 10 T8): every outcome of a failed
// sign-in is one outcome, and every path costs one password verification.

const ACCOUNT = "0192f3a0-0000-7000-8000-000000000001";
const PASSWORD = "correct horse battery staple";

const MAIL = { available: true };
const CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const CHROME_OTHER_VERSION = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";

function setup(
  candidate: LoginCandidate | undefined,
  options: { created?: boolean; mfa?: MfaState; alerts?: SignInAlertContext | undefined; required?: boolean; emailVerified?: boolean } = {},
) {
  const looked: string[] = [];
  const contexts: { accountId: string; ipPrefix: string | null }[] = [];
  const created: NewSession[] = [];
  const asked: string[] = [];
  const checked: string[] = [];
  const verified: { stored: string | null | undefined; password: string }[] = [];
  const store = {
    loginLookup: (email: string) => {
      looked.push(email);
      return Promise.resolve(candidate);
    },
    emailVerified: (accountId: string) => {
      checked.push(accountId);
      return Promise.resolve(options.emailVerified ?? false);
    },
    mfaStateOf: (accountId: string) => {
      asked.push(accountId);
      return Promise.resolve(options.mfa);
    },
    signInAlertContext: (accountId: string, ipPrefix: string | null) => {
      contexts.push({ accountId, ipPrefix });
      return Promise.resolve(options.alerts);
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
  return { store, passwords, mail: MAIL, registration: { emailVerificationRequired: options.required ?? false }, checked, looked, created, asked, verified, contexts };
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
    expect(result?.next).toBe("done");
    expect(session).toMatchObject({ accountId: ACCOUNT, level: "full", remember: false, ipPrefix: "203.0.0.0/16", userAgent: "Vitest", replacedTokenHash: null });
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

  const sealed = { ciphertext: new Uint8Array(40), keyId: "key-1" };

  it("makes a partial session and answers mfa for an account whose second factor is on", async () => {
    const world = setup(live, { mfa: { secret: sealed, enabledAt: new Date("2026-01-01T00:00:00Z"), lastStep: 5 } });
    const result = await signIn(world, { ...request, remember: true });
    expect(result?.next).toBe("mfa");
    expect(result?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(world.created).toHaveLength(1);
    expect(world.created[0]).toMatchObject({ accountId: ACCOUNT, level: "partial", remember: true });
  });

  it("signs in fully while an enrolment is only pending", async () => {
    const world = setup(live, { mfa: { secret: sealed, enabledAt: null, lastStep: null } });
    expect((await signIn(world, request))?.next).toBe("done");
    expect(world.created[0]?.level).toBe("full");
  });

  it("asks for the second-factor state only after the password was verified", async () => {
    const world = setup(live, { mfa: { secret: sealed, enabledAt: new Date(), lastStep: null } });
    expect(await signIn(world, { ...request, password: "not the password" })).toBeUndefined();
    expect(world.asked).toEqual([]);
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
    await expect(signIn({ ...world, store }, request)).rejects.toThrow("database down");
    const failingState = { ...world.store, mfaStateOf: () => Promise.reject(new Error("database down")) } as unknown as AuthStore;
    await expect(signIn({ ...world, store: failingState }, request)).rejects.toThrow("database down");
    expect(world.created).toEqual([]);
    const failingCreate = { ...world.store, createSession: () => Promise.reject(new Error("database down")) } as unknown as AuthStore;
    await expect(signIn({ ...world, store: failingCreate }, request)).rejects.toThrow("database down");
  });
});

// The "new sign-in" email (doc 02 section 12): a full session queues it exactly when the account has the alerts
// on, has signed in before and has no live session of the same prefix and user-agent family.
describe("signIn and an address that was never verified", () => {
  const wrong = { ...request, password: "not the password" };

  it("refuses the correct password with email_unverified where verification is required, before any second factor or session", async () => {
    const world = setup(live, { required: true, emailVerified: false });
    await expect(signIn(world, request)).rejects.toMatchObject({ code: "email_unverified" });
    expect(world.checked).toEqual([ACCOUNT]);
    expect(world.asked).toEqual([]);
    expect(world.created).toEqual([]);
  });

  it("asks nothing about the address, and answers the generic failure, for a wrong password, an unknown address and a disabled account", async () => {
    const worlds = [
      [setup(live, { required: true }), wrong],
      [setup(undefined, { required: true }), request],
      [setup({ ...live, disabledAt: new Date("2026-01-01T00:00:00Z") }, { required: true }), request],
    ] as const;
    for (const [world, attempt] of worlds) {
      expect(await signIn(world, attempt)).toBeUndefined();
      expect(world.checked).toEqual([]);
      expect(world.created).toEqual([]);
    }
  });

  it("signs a verified account in where verification is required", async () => {
    const world = setup(live, { required: true, emailVerified: true });
    expect((await signIn(world, request))?.next).toBe("done");
    expect(world.created).toHaveLength(1);
  });

  it("signs an unverified account in, without asking, where verification is optional", async () => {
    const world = setup(live, { required: false, emailVerified: false });
    expect((await signIn(world, request))?.next).toBe("done");
    expect(world.checked).toEqual([]);
    expect(world.created).toHaveLength(1);
  });

  it("does not turn a failing verification lookup into a sign-in", async () => {
    const world = setup(live, { required: true });
    const failing = { ...world, store: { ...world.store, emailVerified: () => Promise.reject(new Error("the database is down")) } as unknown as AuthStore };
    await expect(signIn(failing, request)).rejects.toThrow("the database is down");
    expect(world.created).toEqual([]);
  });
});

describe("signIn and the new-device alert", () => {
  const known = (userAgentsOnNetwork: readonly (string | null)[], overrides: Partial<SignInAlertContext> = {}): SignInAlertContext => ({
    alertsOn: true,
    signedInBefore: true,
    userAgentsOnNetwork,
    ...overrides,
  });
  const queued = (world: ReturnType<typeof setup>) => world.created[0]?.jobs ?? [];

  it("queues one mail.send job carrying the time, the browser family and the network prefix when no live session on the network has the browser family", async () => {
    const world = setup(live, { alerts: known([FIREFOX]) });
    await signIn(world, { ...request, userAgent: CHROME });
    expect(world.contexts).toEqual([{ accountId: ACCOUNT, ipPrefix: "203.0.0.0/16" }]);
    expect(queued(world)).toHaveLength(1);
    expect(queued(world)[0]).toMatchObject({
      queue: "mail.send",
      data: { template: "newSignIn", accountId: ACCOUNT, signedInAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/) as string, browser: "Chrome", network: "203.0.0.0/16" },
    });
    expect(Object.keys(queued(world)[0]?.data ?? {}).sort()).toEqual(["accountId", "browser", "network", "signedInAt", "template"]);
  });

  it("queues nothing for a browser family a live session on the same network has, whatever its version or system", async () => {
    const world = setup(live, { alerts: known([CHROME_OTHER_VERSION]) });
    await signIn(world, { ...request, userAgent: CHROME });
    expect(queued(world)).toEqual([]);
  });

  it("queues the job when no live session is on the network, but not for the first session of the account", async () => {
    const away = setup(live, { alerts: known([]) });
    await signIn(away, { ...request, userAgent: CHROME });
    expect(queued(away)).toHaveLength(1);
    const first = setup(live, { alerts: known([], { signedInBefore: false }) });
    await signIn(first, { ...request, userAgent: CHROME });
    expect(queued(first)).toEqual([]);
  });

  it("queues nothing when the account turned the alerts off", async () => {
    const world = setup(live, { alerts: known([], { alertsOn: false }) });
    await signIn(world, { ...request, userAgent: CHROME });
    expect(queued(world)).toEqual([]);
  });

  it("treats two sessions without a user agent as one device", async () => {
    const same = setup(live, { alerts: known([null]) });
    await signIn(same, { ...request, userAgent: null });
    expect(queued(same)).toEqual([]);
    const different = setup(live, { alerts: known([FIREFOX]) });
    await signIn(different, { ...request, userAgent: null });
    expect(queued(different)).toHaveLength(1);
  });

  it("asks and queues nothing for a partial session, which is not a sign-in yet", async () => {
    const world = setup(live, {
      alerts: known([]),
      mfa: { secret: { ciphertext: new Uint8Array(40), keyId: "key-1" }, enabledAt: new Date("2026-01-01T00:00:00Z"), lastStep: 5 },
    });
    await signIn(world, { ...request, userAgent: CHROME });
    expect(world.contexts).toEqual([]);
    expect(queued(world)).toEqual([]);
  });

  it("asks and queues nothing when the mail port cannot send", async () => {
    const world = setup(live, { alerts: known([]) });
    await signIn({ ...world, mail: { available: false } }, { ...request, userAgent: CHROME });
    expect(world.contexts).toEqual([]);
    expect(queued(world)).toEqual([]);
  });

  it("asks nothing before the password is verified", async () => {
    const world = setup(live, { alerts: known([]) });
    await signIn(world, { ...request, password: "not the password", userAgent: CHROME });
    expect(world.contexts).toEqual([]);
  });

  it("does not turn a failing context lookup into a sign-in without the check", async () => {
    const world = setup(live, { alerts: known([]) });
    const store = { ...world.store, signInAlertContext: () => Promise.reject(new Error("database down")) } as unknown as AuthStore;
    await expect(signIn({ ...world, store }, request)).rejects.toThrow("database down");
    expect(world.created).toEqual([]);
  });
});
