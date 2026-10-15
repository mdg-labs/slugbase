import { verify } from "@node-rs/argon2";
import { useTestDatabase } from "@slugbase/testing/db";
import type { AuthStore } from "@slugbase/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../../vitest.shared.ts";
import {
  attemptLogin,
  medianLatencyRatio,
  seedAccount,
  serveAuth,
  signInAttempt,
  storeFor,
  type Attempt,
  type SeededAccount,
} from "./support.ts";

// The auth/enumeration suite of doc 08 section 3.5 (doc 10 T8, doc 02 section
// 2.3): the login endpoint gives no signal, in status, body, headers or time,
// that tells an account that exists from one that does not, or an account that
// is disabled or has no password from a live one. Later epics add the endpoints
// they own (reset, registration, invitation) to this file.
//
// Already asserted in login.integration ("one answer for every way to fail"),
// and not repeated here: the same 401 unauthenticated, body shape, header names
// and absence of a cookie for an unknown email, a wrong password, a disabled
// account and an account without a password; the unknown email's latency class
// against a known one's.
//
// What this file adds: the headers' values and the body's text, compared with
// the spelling of the address varied; one password verification on every
// failure path, counted at the argon2 verifier (the time comparison alone
// cannot tell a skipped verification on a fast machine); the latency class of
// the disabled and password-less paths; and the answer once a limit is reached.

vi.mock("@node-rs/argon2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@node-rs/argon2")>();
  return { ...actual, verify: vi.fn(actual.verify) };
});

const verifications = vi.mocked(verify);

const database = useTestDatabase();
let store: AuthStore;

beforeAll(() => {
  store = storeFor(database());
});

afterAll(async () => {
  await store.close();
});

beforeEach(() => {
  verifications.mockClear();
});

interface Scenario {
  readonly name: string;
  readonly attempt: Attempt;
}

let round = 0;

/** One account of every kind a sign-in can name, and the attempts that fail against them, each from its own address. */
async function scenarios(): Promise<readonly Scenario[]> {
  round += 1;
  const tag = String(round);
  const mixedCase = `Grace.Hopper.${tag}@Example.test`;
  const known = await seedAccount(database());
  await seedAccount(database(), { email: mixedCase });
  const disabled = await seedAccount(database(), { disabled: true });
  const disabledWrong = await seedAccount(database(), { disabled: true });
  const passwordless = await seedAccount(database(), { password: null });
  const attempts: readonly (readonly [string, Attempt])[] = [
    ["an unknown email", { email: `nobody.${tag}@example.test`, password: "some password" }],
    ["an unknown email in capitals, padded", { email: `  NOBODY.ELSE.${tag}@EXAMPLE.TEST `, password: "some password" }],
    ["an unknown email with a 256-character password", { email: `nobody.third.${tag}@example.test`, password: "x".repeat(256) }],
    ["a wrong password", { email: known.email, password: "not the password" }],
    ["a wrong password for an email in other capitals, padded", { email: `  ${mixedCase.toUpperCase()} `, password: "not the password" }],
    ["a disabled account with its right password", { email: disabled.email, password: disabled.password }],
    ["a disabled account with a wrong password", { email: disabledWrong.email, password: "not the password" }],
    ["an account without a password", { email: passwordless.email, password: "some password" }],
  ];
  return attempts.map(([name, attempt], index) => ({ name, attempt: { ...attempt, forwardedFor: `198.51.${tag}.${String(index + 1)}` } }));
}

/** A body with the one field that differs by request taken out. */
function withoutRequestId(text: string): string {
  const body = JSON.parse(text) as Record<string, unknown>;
  return JSON.stringify(Object.fromEntries(Object.entries(body).filter(([name]) => name !== "requestId")));
}

async function answerOf(response: Response) {
  return {
    status: response.status,
    // `x-request-id` is the one header that differs by request.
    headers: [...response.headers].filter(([name]) => name !== "x-request-id").sort(([a], [b]) => a.localeCompare(b)),
    body: withoutRequestId(await response.text()),
  };
}

describe("POST /api/v1/auth/login (T8)", () => {
  it("answers every failure with the same status, the same header names and values and the same body text, whatever the spelling of the address", async () => {
    // Each attempt comes from its own address, so the rate-limit headers, which count per address, read the same too.
    const world = serveAuth(database(), store, { env: { TRUSTED_PROXY_HOPS: "1" } });
    const answers: { name: string; answer: Awaited<ReturnType<typeof answerOf>> }[] = [];
    for (const { name, attempt } of await scenarios()) {
      const response = await attemptLogin(world, attempt);
      expect(response.headers.get("set-cookie"), name).toBeNull();
      answers.push({ name, answer: await answerOf(response) });
    }
    const [first, ...rest] = answers;
    expect(first?.answer.status).toBe(401);
    expect(JSON.parse(first?.answer.body ?? "{}")).toMatchObject({ code: "unauthenticated", status: 401 });
    expect(first?.answer.headers.map(([name]) => name)).toContain("ratelimit");
    for (const { name, answer } of rest) {
      expect(answer, name).toEqual(first?.answer);
    }
  });

  it("runs exactly one password verification on every way to fail and on a success, so no path is cheaper than another", async () => {
    const world = serveAuth(database(), store);
    const good = await seedAccount(database());
    for (const { name, attempt } of await scenarios()) {
      verifications.mockClear();
      const response = await attemptLogin(world, attempt);
      expect(response.status, name).toBe(401);
      expect(verifications, name).toHaveBeenCalledTimes(1);
    }
    verifications.mockClear();
    expect((await signInAttempt(world, good)).status).toBe(200);
    expect(verifications).toHaveBeenCalledTimes(1);
  });

  it(
    "falls in one latency class for a disabled account and an account without a password as for a wrong password",
    { timeout: HEAVY_TEST_TIMEOUT_MS },
    async () => {
      const world = serveAuth(database(), store);
      const known = await seedAccount(database());
      const disabled = await seedAccount(database(), { disabled: true });
      const passwordless = await seedAccount(database(), { password: null });
      const wrong = (account: SeededAccount, password: string) => () => signInAttempt(world, account, { password });
      const reference = wrong(known, "not the password");
      // A path that skipped the verification would answer in a small fraction of the time: the bounds are far
      // wider than the noise of a loaded runner, and the ratio is a median over many back-to-back pairs.
      for (const probe of [wrong(disabled, disabled.password), wrong(passwordless, "some password")]) {
        const ratio = await medianLatencyRatio(reference, probe);
        expect(ratio).toBeGreaterThan(0.5);
        expect(ratio).toBeLessThan(2);
      }
    },
  );

  it("is limited alike for every kind of address: the attempt over the per-email limit is the same 429 for an unknown, a known, a disabled and a password-less one", async () => {
    const world = serveAuth(database(), store, { env: { RATE_LIMIT_LOGIN_EMAIL: "2/hour", TRUSTED_PROXY_HOPS: "1" } });
    const known = await seedAccount(database());
    const disabled = await seedAccount(database(), { disabled: true });
    const passwordless = await seedAccount(database(), { password: null });
    const emails = ["nobody@example.test", known.email, disabled.email, passwordless.email];

    const denied: Awaited<ReturnType<typeof answerOf>>[] = [];
    for (const [index, email] of emails.entries()) {
      const from = { forwardedFor: `198.51.100.${String(index + 10)}` };
      expect((await attemptLogin(world, { email, password: "wrong one", ...from })).status, email).toBe(401);
      expect((await attemptLogin(world, { email, password: "wrong two", ...from })).status, email).toBe(401);
      const response = await attemptLogin(world, { email, password: "wrong three", ...from });
      expect(response.status, email).toBe(429);
      denied.push(await answerOf(response));
    }
    const [first, ...rest] = denied;
    expect(JSON.parse(first?.body ?? "{}")).toMatchObject({ code: "rate_limited", status: 429 });
    for (const answer of rest) {
      // Each address took the same attempts from its own network address, so even the counts in the limit headers agree.
      expect(answer).toEqual(first);
    }
    expect(verifications).toHaveBeenCalledTimes(emails.length * 2);
  });
});
