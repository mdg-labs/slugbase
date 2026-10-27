import { randomBytes } from "node:crypto";
import { verify } from "@node-rs/argon2";
import { InMemoryMail } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import type { AuthStore } from "@slugbase/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../../vitest.shared.ts";
import { uuidv7 } from "../../src/auth/uuidv7.ts";
import { runMigrations } from "../../src/migrate/index.ts";
import { urlOf } from "../migrate/support.ts";
import { GRANTED, acceptAs, freshAddress, inspect, invite, linkOf, markDeleting, randomToken, revoke, setExpiry, signup, workspaceWithAdmin } from "../invitations/support.ts";
import { HOOK_TIMEOUT_MS, workspaceHarness } from "../workspaces/support.ts";
import { CREDENTIAL_ENV, requestFlows, type RequestFlow } from "./credential-flows.ts";
import {
  attemptLogin,
  freshSessionCookie,
  latencyCalls,
  medianLatencyRatio,
  seedAccount,
  serveAuth,
  signInAttempt,
  storeFor,
  type Attempt,
  type AuthWorld,
  type SeededAccount,
} from "./support.ts";

// The auth/enumeration suite of doc 08 section 3.5 (doc 10 T8, doc 02 section
// 2.3): the login endpoint gives no signal, in status, body, headers or time,
// that tells an account that exists from one that does not, or an account that
// is disabled or has no password from a live one, and the four requests that ask
// for an emailed link (register, resend, forgot, change email) give none that tells
// an address with an account, verified or not, from one without. The two requests that redeem an
// invitation token (inspect, and accept in both its forms) give none that tells a token nobody
// issued from one that expired, was revoked, was replaced by a newer link or was used.
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

beforeAll(async () => {
  store = storeFor(database());
  // The credential flows queue their mail through pg-boss, whose schema the image entrypoint creates before the server starts.
  await runMigrations({ url: urlOf(database().owner) });
}, 120_000);

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
  if (text === "") {
    return text;
  }
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

// The credential flows. A request for an emailed link answers alike for an address that has a verified account,
// one that has an unverified account and one that has none (doc 04 section 10.2, doc 02 section 2.3): the status,
// the headers and the body agree, each path queues the one mail job, and none is faster than another. What the
// worker then sends, and to whom, is its decision and not visible to the requester.
const EMAIL_LIMIT_KEY = /^[0-9a-f]{64}$/;

describe("the requests for an emailed link (T8)", () => {
  const mail = new InMemoryMail();
  let tag = 0;

  async function mailJobCount(): Promise<number> {
    const rows = await database().app<{ count: number }[]>`SELECT count(*)::int AS count FROM pgboss.job WHERE name = 'mail.send'`;
    return rows[0]?.count ?? -1;
  }

  interface Target {
    readonly name: string;
    readonly email: string;
  }

  /** An account that moved away from `address`, whose unused "this wasn't me" link reserves it: no account holds the address. */
  async function reserve(address: string, movedTo: string): Promise<void> {
    const mover = await seedAccount(database(), { emailVerified: true, email: movedTo });
    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`
        INSERT INTO credential_tokens (id, purpose, account_id, token_hash, target_email, expires_at)
        VALUES (${uuidv7()}, 'email_change_cancel', ${mover.id}, ${randomBytes(32)}, ${address}, now() + interval '1 hour')`;
    });
  }

  /** An address of every kind a request can name, each of its own, so that the per-address count in the limit headers reads the same. */
  async function targets(): Promise<readonly Target[]> {
    tag += 1;
    const suffix = String(tag);
    const verified = await seedAccount(database(), { emailVerified: true, email: `Verified.Person.${suffix}@Example.test` });
    const verifiedShouting = await seedAccount(database(), { emailVerified: true, email: `VERIFIED.SHOUTING.${suffix}@EXAMPLE.TEST` });
    const unverified = await seedAccount(database(), { email: `Unverified.Person.${suffix}@Example.test` });
    const unverifiedQuiet = await seedAccount(database(), { email: `unverified.quiet.${suffix}@example.test` });
    await reserve(`Reserved.Old.${suffix}@Example.test`, `reserved.moved.${suffix}@example.test`);
    await reserve(`reserved.shouting.${suffix}@example.test`, `reserved.moved.again.${suffix}@example.test`);
    return [
      { name: "a verified account", email: verified.email },
      { name: "a verified account in capitals", email: verifiedShouting.email },
      { name: "an unverified account", email: unverified.email },
      { name: "an unverified account in lower case", email: unverifiedQuiet.email },
      { name: "an unknown address", email: `nobody.${suffix}@example.test` },
      { name: "an unknown address in capitals", email: `NOBODY.ELSE.${suffix}@EXAMPLE.TEST` },
      { name: "an address reserved by a live undo link", email: `reserved.old.${suffix}@example.test` },
      { name: "an address reserved by a live undo link, in capitals", email: `RESERVED.SHOUTING.${suffix}@EXAMPLE.TEST` },
    ];
  }

  /** `count` addresses of each kind that has a lookup outcome of its own, every one with its own account or undo link. */
  async function latencyTargets(count: number): Promise<readonly { readonly name: string; readonly addresses: readonly string[] }[]> {
    tag += 1;
    const suffix = String(tag);
    const indexes = Array.from({ length: count }, (_unused, index) => String(index));
    const [verified, unverified, reserved] = await Promise.all([
      Promise.all(indexes.map(async (index) => (await seedAccount(database(), { emailVerified: true, email: `latency.verified.${suffix}.${index}@example.test` })).email)),
      Promise.all(indexes.map(async (index) => (await seedAccount(database(), { email: `latency.unverified.${suffix}.${index}@example.test` })).email)),
      Promise.all(
        indexes.map(async (index) => {
          const address = `latency.reserved.${suffix}.${index}@example.test`;
          await reserve(address, `latency.moved.${suffix}.${index}@example.test`);
          return address;
        }),
      ),
    ]);
    return [
      { name: "an address with a verified account", addresses: verified },
      { name: "an address with an unverified account", addresses: unverified },
      { name: "an address reserved by a live undo link", addresses: reserved },
    ];
  }

  /** The session the flow that needs one is asked with: an account of its own, signed in and re-authenticated. */
  async function sessionFor(world: AuthWorld, flow: RequestFlow): Promise<string | undefined> {
    if (!flow.authenticated) {
      return undefined;
    }
    const requester = await seedAccount(database(), { emailVerified: true });
    return freshSessionCookie(world, requester, "198.51.100.250");
  }

  describe.each(requestFlows.map((flow) => [flow.name, flow] as const))("%s", (_name, flow) => {
    it("answers an address with a verified account, an unverified one and an unknown one with the same status, headers and body, and queues the one mail job on every path", async () => {
      const world = serveAuth(database(), store, { env: { ...CREDENTIAL_ENV, TRUSTED_PROXY_HOPS: "1", RATE_LIMIT_REGISTER_IP: "1000/hour" }, mail });
      const cookie = await sessionFor(world, flow);
      const answers: { name: string; answer: Awaited<ReturnType<typeof answerOf>> }[] = [];
      let hop = 0;
      for (const { name, email } of await targets()) {
        hop += 1;
        const before = await mailJobCount();
        // Each request comes from its own address, so the rate-limit headers, which count per address, read the same too.
        const response = await flow.call(world, email, { forwardedFor: `198.51.100.${String(hop)}` }, cookie);
        expect(response.headers.get("set-cookie"), name).toBeNull();
        answers.push({ name, answer: await answerOf(response) });
        expect(await mailJobCount(), name).toBe(before + 1);
      }
      const [first, ...rest] = answers;
      expect(first?.answer.status).toBe(202);
      expect(first?.answer.body).toBe("");
      expect(first?.answer.headers.map(([name]) => name)).toContain("ratelimit");
      for (const { name, answer } of rest) {
        expect(answer, name).toEqual(first?.answer);
      }
    });

    it(
      "falls in one latency class for an address with a verified account and one with an unverified account as for an unknown one",
      { timeout: HEAVY_TEST_TIMEOUT_MS },
      async () => {
        const world = serveAuth(database(), store, { env: { ...CREDENTIAL_ENV, RATE_LIMIT_REGISTER_IP: "1000/hour" }, mail });
        const cookie = await sessionFor(world, flow);
        const calls = latencyCalls();
        const kinds = await latencyTargets(calls);
        // Every call names an address of its own, on the reference side and on the probe side: the per-address limit
        // makes a bucket on an address's first use, and a side that repeats an address would not pay that again.
        let unknown = 0;
        const reference = () => {
          unknown += 1;
          return flow.call(world, `latency.unknown.${String(tag)}.${String(unknown)}@example.test`, {}, cookie);
        };
        // A path that skipped the account lookup or the hashing would answer in a small fraction of the time: the
        // bounds are far wider than the noise of a loaded runner, and the ratio is a median over many back-to-back pairs.
        for (const { name, addresses } of kinds) {
          const taken = world.limiter.takes.length;
          let drawn = 0;
          const probe = () => {
            const address = addresses[drawn];
            drawn += 1;
            if (address === undefined) {
              throw new Error(`the latency probe for ${name} ran out of addresses`);
            }
            return flow.call(world, address, {}, cookie);
          };
          const ratio = await medianLatencyRatio(reference, probe);
          const keys = world.limiter.takes.slice(taken).map((take) => take.key).filter((key) => EMAIL_LIMIT_KEY.test(key));
          expect(drawn, name).toBe(calls);
          expect(new Set(keys).size, name).toBe(keys.length);
          if (flow.bucket === "reset") {
            expect(keys, name).toHaveLength(2 * calls);
          }
          expect(ratio, name).toBeGreaterThan(0.5);
          expect(ratio, name).toBeLessThan(2);
        }
      },
    );
  });
});

// The invitation tokens (doc 04 section 10.5, doc 02 section 3.4, doc 10 T8): the token is the only credential of
// the inspection and the acceptance, so the answer to a token that no longer works must not say why it does not.
// Already asserted in routes/invitation-acceptance.integration ("answers one identical 410 token_expired"): the
// status, code, title, detail and type of the unknown, malformed, expired, revoked, replaced and used token to the
// inspection and to the signed-in acceptance. What this adds: the headers and the body text as well, for the
// acceptance that creates the account too, and the latency class of each kind of dead token against an unknown one.
describe("the requests that redeem an invitation token (T8)", () => {
  const harness = workspaceHarness(database);
  const REDEEM_ENV = { RATE_LIMIT_TOKEN_REDEEM_IP: "100000/hour", RATE_LIMIT_TOKEN_REDEEM_ACCOUNT: "100000/hour" };

  beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

  afterAll(() => harness.stop());

  interface DeadToken {
    readonly name: string;
    readonly token: string;
  }

  /** A token of every kind that no longer redeems, and an unknown one. */
  async function deadTokens(): Promise<readonly DeadToken[]> {
    const setup = serveAuth(database(), store, { entitlements: GRANTED });
    const { admin } = await workspaceWithAdmin(harness, setup);
    const expired = await invite(setup, admin, freshAddress());
    await setExpiry(database(), expired.id, -1);
    const revoked = await invite(setup, admin, freshAddress());
    expect((await revoke(setup, admin, revoked.id)).status).toBe(204);
    const replaced = await invite(setup, admin, freshAddress());
    await linkOf(setup, admin, replaced.id);
    const invitee = await harness.person(setup);
    const used = await invite(setup, admin, invitee.account.email);
    expect((await acceptAs(setup, invitee, used.token)).status).toBe(200);
    const other = await workspaceWithAdmin(harness, setup);
    const deleting = await invite(setup, other.admin, freshAddress());
    await markDeleting(database(), other.workspaceId);
    return [
      { name: "a token nobody issued", token: randomToken() },
      { name: "an expired token", token: expired.token },
      { name: "a revoked token", token: revoked.token },
      { name: "a token a newer link replaced", token: replaced.token },
      { name: "a used token", token: used.token },
      { name: "a token of a workspace being deleted", token: deleting.token },
    ];
  }

  interface Form {
    readonly name: string;
    /** Redeems `token` from the client address `from`. */
    readonly call: (world: AuthWorld, token: string, from: string) => Promise<Response>;
  }

  /** The three requests, each one from the address it names; the signed-in acceptance is made by `accounts` accounts in turn, so that its per-account count reads the same while no account is used twice. */
  async function forms(accounts = 24): Promise<readonly Form[]> {
    const setup = serveAuth(database(), store);
    const people = await Promise.all(Array.from({ length: accounts }, () => harness.person(setup)));
    let next = 0;
    return [
      { name: "the inspection", call: (world, token, from) => inspect(world, token, { "x-forwarded-for": from }) },
      {
        name: "the acceptance as the signed-in account",
        call: (world, token, from) => {
          const person = people[next % people.length];
          next += 1;
          if (person === undefined) {
            throw new Error("no signed-in account");
          }
          return acceptAs(world, person, token, { "x-forwarded-for": from });
        },
      },
      { name: "the acceptance that creates the account", call: (world, token, from) => signup(world, token, undefined, { "x-forwarded-for": from }) },
    ];
  }

  it("answers every kind of dead token with the same status, header names and values and body text, to the inspection and to both forms of the acceptance", async () => {
    const world = serveAuth(database(), store, { env: { ...REDEEM_ENV, TRUSTED_PROXY_HOPS: "1" } });
    const byForm: { form: string; answers: { name: string; answer: Awaited<ReturnType<typeof answerOf>> }[] }[] = [];
    let hop = 0;
    // A refused redemption writes nothing, so one set of dead tokens serves all three requests.
    const [dead, requests] = await Promise.all([deadTokens(), forms(6)]);
    expect(dead).toHaveLength(6);
    for (const form of requests) {
      const answers: { name: string; answer: Awaited<ReturnType<typeof answerOf>> }[] = [];
      for (const { name, token } of dead) {
        hop += 1;
        // Each request comes from its own address, so the rate-limit headers, which count per address, read the same too.
        const response = await form.call(world, token, `198.51.100.${String(hop)}`);
        expect(response.headers.get("set-cookie"), `${form.name}, ${name}`).toBeNull();
        answers.push({ name: `${form.name}, ${name}`, answer: await answerOf(response) });
      }
      expect(answers).toHaveLength(6);
      byForm.push({ form: form.name, answers });
    }
    // Within one request, every kind of dead token is answered alike down to the limit headers.
    for (const { answers } of byForm) {
      const [first, ...rest] = answers;
      expect(first?.answer.status).toBe(410);
      expect(JSON.parse(first?.answer.body ?? "{}")).toMatchObject({ code: "token_expired", status: 410 });
      expect(first?.answer.headers.map(([name]) => name)).toContain("ratelimit");
      for (const { name, answer } of rest) {
        expect(answer, name).toEqual(first?.answer);
      }
    }
    // Across the requests everything but the limit headers agrees: the acceptance of the signed-in account is also counted per account.
    const unlimited = (answer: Awaited<ReturnType<typeof answerOf>>) => ({ ...answer, headers: answer.headers.filter(([name]) => !name.startsWith("ratelimit")) });
    const [reference, ...others] = byForm.map(({ answers }) => unlimited(answers[0]?.answer ?? { status: 0, headers: [], body: "" }));
    for (const answer of others) {
      expect(answer).toEqual(reference);
    }
  });

  it(
    "falls in one latency class for an expired, a revoked and a used token as for a token nobody issued, to the inspection and to both forms of the acceptance",
    { timeout: 4 * HEAVY_TEST_TIMEOUT_MS },
    async () => {
      const world = serveAuth(database(), store, { env: REDEEM_ENV });
      const dead = await deadTokens();
      const probes = ["an expired token", "a revoked token", "a used token"].map((name) => dead.find((candidate) => candidate.name === name));
      for (const form of await forms()) {
        const reference = () => form.call(world, randomToken(), "198.51.100.1");
        // A path that answered before it looked the token up, or after more work than the other, would fall outside the
        // bounds, which are far wider than the noise of a loaded runner: the ratio is a median over many back-to-back pairs.
        for (const probe of probes) {
          if (probe === undefined) {
            throw new Error("a kind of dead token is missing");
          }
          const { name, token } = probe;
          const ratio = await medianLatencyRatio(reference, () => form.call(world, token, "198.51.100.1"));
          expect(ratio, `${form.name}, ${name}`).toBeGreaterThan(0.5);
          expect(ratio, `${form.name}, ${name}`).toBeLessThan(2);
        }
      }
    },
  );
});
