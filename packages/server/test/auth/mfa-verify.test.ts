import type { SecondFactor, SignInCompletion, SignInCompletionOutcome, UnusedBackupCode } from "@slugbase/db";
import { describe, expect, it } from "vitest";
import { verifySecondFactor, type SecondFactorDependencies } from "../../src/auth/mfa.ts";

// The second-factor check of sign-in (doc 02 section 2.3, doc 10 T17) with a
// store that records what it was asked: which hashes a backup code was checked
// against, what was accepted and what was counted as a failure.

const ACCOUNT = "0192f3a0-0000-7000-8000-000000000001";
const SESSION = "0192f3a0-0000-7000-8000-000000000002";
const SEALED = { ciphertext: new Uint8Array(40), keyId: "key-1" };

function setup(options: { enabled?: boolean; unused?: readonly UnusedBackupCode[]; outcome?: SignInCompletionOutcome; matches?: (hash: string, code: string) => boolean } = {}) {
  const verified: { hash: string; code: string }[] = [];
  const completed: SignInCompletion[] = [];
  const failures: string[] = [];
  const opened: number[] = [];
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
    },
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
  return { dependencies, verified, completed, failures, opened };
}

const unused: readonly UnusedBackupCode[] = [
  { id: "0192f3a0-0000-7000-8000-0000000000a1", hash: "hash-a" },
  { id: "0192f3a0-0000-7000-8000-0000000000a2", hash: "hash-b" },
  { id: "0192f3a0-0000-7000-8000-0000000000a3", hash: "hash-c" },
];

const request = (code: string) => ({ accountId: ACCOUNT, sessionId: SESSION, given: { kind: "backup" as const, code } });

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
    const outcome = await verifySecondFactor(world.dependencies, { accountId: ACCOUNT, sessionId: SESSION, given: { kind: "code", code: "123456" } });
    expect(outcome).toEqual({ kind: "invalid_code", sessionEnded: false });
    expect(world.opened).toEqual([]);
    expect(world.completed).toEqual([]);
    expect(world.failures).toEqual([SESSION]);
  });

  it("counts a code that does not verify against the secret", async () => {
    const world = setup();
    const outcome = await verifySecondFactor(world.dependencies, { accountId: ACCOUNT, sessionId: SESSION, given: { kind: "code", code: "not a code" } });
    expect(outcome).toEqual({ kind: "invalid_code", sessionEnded: false });
    expect(world.opened).toHaveLength(1);
    expect(world.failures).toEqual([SESSION]);
  });
});
