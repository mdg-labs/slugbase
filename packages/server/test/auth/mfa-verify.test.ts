import type { SecondFactor, SignInAlertContext, SignInCompletion, SignInCompletionOutcome, UnusedBackupCode } from "@slugbase/db";
import { describe, expect, it } from "vitest";
import { verifySecondFactor, type SecondFactorDependencies } from "../../src/auth/mfa.ts";

// The second-factor check of sign-in (doc 02 section 2.3, doc 10 T17) with a
// store that records what it was asked: which hashes a backup code was checked
// against, what was accepted and what was counted as a failure.

const ACCOUNT = "0192f3a0-0000-7000-8000-000000000001";
const SESSION = "0192f3a0-0000-7000-8000-000000000002";
const SEALED = { ciphertext: new Uint8Array(40), keyId: "key-1" };

const CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";

function setup(
  options: {
    enabled?: boolean;
    unused?: readonly UnusedBackupCode[];
    outcome?: SignInCompletionOutcome;
    matches?: (hash: string, code: string) => boolean;
    alerts?: SignInAlertContext;
    mail?: boolean;
  } = {},
) {
  const verified: { hash: string; code: string }[] = [];
  const completed: SignInCompletion[] = [];
  const failures: string[] = [];
  const opened: number[] = [];
  const contexts: { accountId: string; ipPrefix: string | null }[] = [];
  const dependencies: SecondFactorDependencies = {
    store: {
      mfaStateOf: () => Promise.resolve({ secret: SEALED, enabledAt: options.enabled === false ? null : new Date(0), lastStep: null }),
      resealMfaSecret: () => Promise.reject(new Error("not expected")),
      unusedBackupCodes: () => Promise.resolve(options.unused ?? []),
      completeMfaSignIn: (completion) => {
        completed.push(completion);
        return Promise.resolve(options.outcome ?? "completed");
      },
      recordMfaFailure: (sessionId) => {
        failures.push(sessionId);
        return Promise.resolve(false);
      },
      signInAlertContext: (accountId, ipPrefix) => {
        contexts.push({ accountId, ipPrefix });
        return Promise.resolve(options.alerts);
      },
    },
    mail: { available: options.mail ?? true },
    secretBox: {
      open: () => {
        opened.push(1);
        return Promise.resolve(new Uint8Array(20));
      },
      needsRotation: () => Promise.resolve(false),
      reseal: () => Promise.reject(new Error("not expected")),
    },
    verifyCode: (hash, code) => {
      verified.push({ hash, code });
      return Promise.resolve(options.matches?.(hash, code) ?? false);
    },
    now: () => 1_000_000_000_000,
  };
  return { dependencies, verified, completed, failures, opened, contexts };
}

const unused: readonly UnusedBackupCode[] = [
  { id: "0192f3a0-0000-7000-8000-0000000000a1", hash: "hash-a" },
  { id: "0192f3a0-0000-7000-8000-0000000000a2", hash: "hash-b" },
  { id: "0192f3a0-0000-7000-8000-0000000000a3", hash: "hash-c" },
];

const DEVICE = { ipPrefix: "203.0.0.0/16", userAgent: CHROME };
const request = (code: string) => ({ accountId: ACCOUNT, sessionId: SESSION, given: { kind: "backup" as const, code }, device: DEVICE });
const totp = { accountId: ACCOUNT, sessionId: SESSION, given: { kind: "code" as const, code: "123456" }, device: DEVICE };

describe("verifySecondFactor with a backup code", () => {
  it("checks the typed code against every unused hash, the first match included, and accepts the code that matched", async () => {
    const world = setup({ unused, matches: (hash) => hash === "hash-a" });
    const outcome = await verifySecondFactor(world.dependencies, request("abcde-23456"));

    expect(outcome.kind).toBe("signed_in");
    expect(world.verified.map((call) => call.hash)).toEqual(["hash-a", "hash-b", "hash-c"]);
    expect(world.verified.every((call) => call.code === "ABCDE23456")).toBe(true);
    const factor: SecondFactor | undefined = world.completed[0]?.factor;
    expect(factor).toEqual({ kind: "backup", codeId: "0192f3a0-0000-7000-8000-0000000000a1" });
    expect(world.failures).toEqual([]);
  });

  it("counts a code that matches none against the session and accepts nothing", async () => {
    const world = setup({ unused });
    expect(await verifySecondFactor(world.dependencies, request("ZZZZZZZZZZ"))).toEqual({ kind: "invalid_code", sessionEnded: false });
    expect(world.verified).toHaveLength(3);
    expect(world.completed).toEqual([]);
    expect(world.failures).toEqual([SESSION]);
  });

  it("counts a code the store reports as already used, and does not sign in", async () => {
    const world = setup({ unused, outcome: "replayed", matches: (hash) => hash === "hash-b" });
    expect(await verifySecondFactor(world.dependencies, request("ABCDE23456"))).toEqual({ kind: "invalid_code", sessionEnded: false });
    expect(world.failures).toEqual([SESSION]);
  });

  it("does not count a failure when the session is gone", async () => {
    const world = setup({ unused, outcome: "no_session", matches: () => true });
    expect(await verifySecondFactor(world.dependencies, request("ABCDE23456"))).toEqual({ kind: "no_session" });
    expect(world.failures).toEqual([]);
  });
});

describe("verifySecondFactor with a TOTP code", () => {
  it("refuses, without opening the secret, when the account's second factor is not on, and counts the failure", async () => {
    const world = setup({ enabled: false });
    const outcome = await verifySecondFactor(world.dependencies, totp);
    expect(outcome).toEqual({ kind: "invalid_code", sessionEnded: false });
    expect(world.opened).toEqual([]);
    expect(world.completed).toEqual([]);
    expect(world.failures).toEqual([SESSION]);
  });

  it("counts a code that does not verify against the secret", async () => {
    const world = setup();
    const outcome = await verifySecondFactor(world.dependencies, { ...totp, given: { kind: "code", code: "not a code" } });
    expect(outcome).toEqual({ kind: "invalid_code", sessionEnded: false });
    expect(world.opened).toHaveLength(1);
    expect(world.failures).toEqual([SESSION]);
  });
});

// The "new sign-in" email of an account with a second factor (doc 02 section 12): the partial session
// asks and queues nothing (login.test.ts); the code that completes the sign-in queues it, in the call that
// makes the session full, and only for a device the account has not signed in from.
describe("verifySecondFactor and the new-device alert", () => {
  const known = (userAgentsOnNetwork: readonly (string | null)[], overrides: Partial<SignInAlertContext> = {}): SignInAlertContext => ({
    alertsOn: true,
    signedInBefore: true,
    userAgentsOnNetwork,
    ...overrides,
  });
  const matching = { unused, matches: (hash: string) => hash === "hash-a" };

  it("hands the completion one mail.send job with the time, the browser family and the network prefix for a device no live session shares", async () => {
    const world = setup({ ...matching, alerts: known([FIREFOX]) });
    await verifySecondFactor(world.dependencies, request("ABCDE23456"));
    expect(world.contexts).toEqual([{ accountId: ACCOUNT, ipPrefix: "203.0.0.0/16" }]);
    expect(world.completed).toHaveLength(1);
    const jobs = world.completed[0]?.jobs ?? [];
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      queue: "mail.send",
      data: { template: "newSignIn", accountId: ACCOUNT, signedInAt: new Date(1_000_000_000_000).toISOString(), browser: "Chrome", network: "203.0.0.0/16" },
    });
    expect(Object.keys(jobs[0]?.data ?? {}).sort()).toEqual(["accountId", "browser", "network", "signedInAt", "template"]);
  });

  it("hands the completion no job for a device a live session on the network already has", async () => {
    const world = setup({ ...matching, alerts: known([CHROME]) });
    await verifySecondFactor(world.dependencies, request("ABCDE23456"));
    expect(world.completed[0]?.jobs).toEqual([]);
  });

  it("hands the completion no job for the account's first session, or when the alerts are off", async () => {
    const first = setup({ ...matching, alerts: known([], { signedInBefore: false }) });
    await verifySecondFactor(first.dependencies, request("ABCDE23456"));
    expect(first.completed[0]?.jobs).toEqual([]);
    const off = setup({ ...matching, alerts: known([], { alertsOn: false }) });
    await verifySecondFactor(off.dependencies, request("ABCDE23456"));
    expect(off.completed[0]?.jobs).toEqual([]);
  });

  it("asks and queues nothing when the mail port cannot send", async () => {
    const world = setup({ ...matching, alerts: known([]), mail: false });
    await verifySecondFactor(world.dependencies, request("ABCDE23456"));
    expect(world.contexts).toEqual([]);
    expect(world.completed[0]?.jobs).toEqual([]);
  });

  it("asks and queues nothing for a code that does not verify", async () => {
    const world = setup({ unused, alerts: known([]) });
    await verifySecondFactor(world.dependencies, request("ZZZZZZZZZZ"));
    expect(world.contexts).toEqual([]);
    expect(world.completed).toEqual([]);
  });
});
