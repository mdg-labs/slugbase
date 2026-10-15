import { totpCode, totpStep } from "@slugbase/core";
import type { AuthStore } from "@slugbase/db";
import { FixedClock } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mfaSecretOptions } from "../../src/auth/mfa.ts";
import { createAccountOnlyTenantResolver } from "../../src/auth/tenant-resolver.ts";
import { createServer, type Server } from "../../src/create-server.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { testKey, testSecretBox, type TestKey } from "../secret-box.ts";
import { adapters, recordingLogger, serverConfig } from "../support.ts";
import { seedAccount, sessionRows, storeFor, type SeededAccount } from "./support.ts";

// The T17 suite (doc 08 section 3.5, doc 10 T7, T9, T17 and T18, doc 02 sections
// 2.3 and 2.7): what proves the second factor cannot be bypassed, end to end
// through the HTTP chain over the migrated database. The failure scenarios: a
// time step that is accepted again after a newer one was, by sign-in or by any
// other operation that takes a code; a request over the `mfa` limit that is
// answered by IP or by account when it should be counted by the other; and a
// secret, a code, a backup code or a QR payload that reaches a log line, an error
// report or a problem document.
//
// Already proven by the suites that landed with the operations, and not repeated
// here (file, then test):
// - A partial session is refused with 401 mfa_required by every operation of
//   openapi.json but verifyMfa, logout and the anonymous ones, which the test pins
//   by name, so a new operation is covered when it is added:
//   mfa-signin.integration, "what a partial session may call" > "is refused with
//   401 mfa_required by every operation of openapi.json ...".
// - The same TOTP code twice at sign-in: mfa-signin.integration, "refuses a code
//   from an already accepted step with 422 invalid_code ...", and in parallel
//   "accepts one of two sign-ins made at once with the same code".
// - A backup code is single use, also under parallel requests:
//   mfa-signin.integration, "completes the sign-in, consumes the code and refuses
//   it afterwards" and "accepts a backup code presented twice at once exactly once".
// - Regeneration replaces the whole set, so no old code works:
//   mfa-manage.integration, "replaces the whole set with ten new codes ...".
// - Regenerating and disabling without the second factor are refused, and change
//   nothing: mfa-manage.integration, "is refused to a stolen full session with no
//   second factor ..." under both POST /me/mfa/backup-codes and DELETE /me/mfa.
// - Five wrong codes revoke the pending session: mfa-signin.integration, "revokes
//   the pending session at the fifth failed code ...".
// - The per-account limit of the mfa bucket on each operation that takes a code:
//   mfa-signin.integration, "holds the per-account limit of the mfa bucket ...",
//   and the "counts every attempt against the mfa limit of the account" tests of
//   mfa.integration and mfa-manage.integration.
// - Logs carry no code or secret per operation: mfa.integration, "writes no secret,
//   code or backup code to a log line"; mfa-signin.integration, "keeps a TOTP code,
//   a backup code and the secret out of every log line and every problem document";
//   mfa-manage.integration, "writes no password, code or backup code to a log line".
// What this file adds: a step older than one accepted by another operation, across
// every operation that takes a code; the mfa limit per IP, and per account across
// IPs and across the pending sessions of the account; and one scrape of logs, error
// reports and error answers over every path.

const LOGIN = "/api/v1/auth/login";
const VERIFY = "/api/v1/auth/mfa/verify";
const REAUTH = "/api/v1/me/reauth";
const START = "/api/v1/me/mfa/enrollment";
const CONFIRM = "/api/v1/me/mfa/enrollment/confirm";
const BACKUP_CODES = "/api/v1/me/mfa/backup-codes";
const MFA = "/api/v1/me/mfa";
const SESSION_COOKIE = "__Host-slugbase_session";
const STEP_MS = 30_000;
const DEFAULT_ADDRESS = "203.0.113.250";

const database = useTestDatabase();
let store: AuthStore;

beforeAll(() => {
  store = storeFor(database());
});

afterAll(async () => {
  await store.close();
});

interface Report {
  readonly error: unknown;
  readonly route: string | undefined;
}

interface World {
  readonly server: Server;
  readonly origin: string;
  readonly logs: ReturnType<typeof recordingLogger>;
  readonly reports: Report[];
  readonly clock: FixedClock;
  readonly keys: readonly [TestKey, ...TestKey[]];
}

interface ServeOptions {
  readonly env?: Record<string, string>;
  readonly keys?: readonly [TestKey, ...TestKey[]];
  readonly clock?: FixedClock;
}

/** A server whose limits are open unless the test sets them, with the error reports it makes kept. */
function serve({ env = {}, keys = [testKey("key-1")], clock = new FixedClock(Date.now()) }: ServeOptions = {}): World {
  const config = serverConfig({
    NODE_ENV: "test",
    DATABASE_URL: appUrl(database()),
    RATE_LIMIT_LOGIN_IP: "1000/min",
    RATE_LIMIT_LOGIN_EMAIL: "1000/hour",
    RATE_LIMIT_MFA_IP: "1000/min",
    RATE_LIMIT_MFA_ACCOUNT: "1000/hour",
    ...env,
  });
  const logs = recordingLogger();
  const reports: Report[] = [];
  const server = createServer({
    config,
    adapters: {
      ...adapters(config),
      tenantResolver: createAccountOnlyTenantResolver(),
      secretBox: testSecretBox(...keys),
      errors: {
        available: true,
        capture: (error, context) => {
          reports.push({ error, route: context?.route });
          return Promise.resolve();
        },
      },
    },
    modules: [],
    migrations: [],
    logger: logs,
    database: tenantDatabase(database()),
    authStore: store,
    now: () => clock.now().getTime(),
  });
  return { server, origin: config.APP_ORIGIN, logs, reports, clock, keys };
}

function tokenOf(response: Response): string | undefined {
  return new RegExp(`^${SESSION_COOKIE}=([A-Za-z0-9_-]{43});`).exec(response.headers.get("set-cookie") ?? "")?.[1];
}

/** A same-origin request from `from`, as a proxy one hop in front of the server reports it. */
function send({ server, origin }: World, method: string, path: string, token: string | null, body?: unknown, from = DEFAULT_ADDRESS): Promise<Response> {
  const headers = new Headers({ origin, "content-type": "application/json", "x-forwarded-for": from });
  if (token !== null) {
    headers.set("cookie", `${SESSION_COOKIE}=${token}`);
  }
  return server.fetch(new Request(new URL(path, origin), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
}

const post = (world: World, path: string, token: string | null, body?: unknown, from?: string) => send(world, "POST", path, token, body, from);
const del = (world: World, path: string, token: string | null, body?: unknown) => send(world, "DELETE", path, token, body);

async function problem(response: Response): Promise<Record<string, unknown>> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return (await response.json()) as Record<string, unknown>;
}

/** The code of the step `offset` steps from the server's current one, from the secret the account has stored. */
async function codeAt(world: World, accountId: string, offset = 0): Promise<string> {
  const state = await store.mfaStateOf(accountId);
  if (state === undefined) {
    throw new Error("the account has no secret");
  }
  const secret = await testSecretBox(...world.keys).open(state.secret, mfaSecretOptions(accountId));
  return totpCode(secret, totpStep(world.clock.now().getTime()) + offset);
}

/** A code that is not the right one for any step near now. */
function wrongCode(right: string): string {
  return right === "123456" ? "654321" : "123456";
}

interface Enrolled {
  readonly account: SeededAccount;
  readonly backupCodes: readonly string[];
  /** What the enrolment showed once: the text key, the otpauth URI and the QR code. */
  readonly shown: readonly string[];
}

/** An account whose second factor is on, enrolled through the product's own operations; the clock is one step past the enrolment. */
async function enrol(world: World): Promise<Enrolled> {
  const account = await seedAccount(database());
  const signedIn = await post(world, LOGIN, null, { email: account.email, password: account.password, remember: false });
  const token = tokenOf(signedIn) ?? "";
  expect(signedIn.status).toBe(200);
  expect((await post(world, REAUTH, token, { password: account.password })).status).toBe(204);
  const started = await post(world, START, token);
  expect(started.status).toBe(200);
  const enrolment = (await started.json()) as { secret: string; otpauthUri: string; qrSvg: string };
  const confirmed = await post(world, CONFIRM, token, { code: await codeAt(world, account.id) });
  expect(confirmed.status).toBe(200);
  const { backupCodes } = (await confirmed.json()) as { backupCodes: string[] };
  world.clock.advance(STEP_MS);
  return { account, backupCodes, shown: [enrolment.secret, enrolment.otpauthUri, enrolment.qrSvg] };
}

/** A correct password for an enrolled account: the partial session it gives. */
async function startSignIn(world: World, account: SeededAccount, from?: string): Promise<string> {
  const response = await post(world, LOGIN, null, { email: account.email, password: account.password, remember: false }, from);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ next: "mfa" });
  return tokenOf(response) ?? "";
}

/** A full session that has re-authenticated with its password a moment ago. */
async function fullSession(world: World, account: SeededAccount, code: string): Promise<string> {
  const verified = await post(world, VERIFY, await startSignIn(world, account), { code });
  expect(verified.status).toBe(200);
  const token = tokenOf(verified) ?? "";
  expect((await post(world, REAUTH, token, { password: account.password })).status).toBe(204);
  return token;
}

async function levels(accountId: string): Promise<string[]> {
  return (await sessionRows(database(), accountId)).map((row) => row.level);
}

async function expectInvalidCode(response: Response, label: string): Promise<void> {
  expect(response.status, label).toBe(422);
  expect(await problem(response), label).toMatchObject({ code: "invalid_code" });
}

describe("a time step that was accepted once (T17)", () => {
  it("is not accepted again, nor is any earlier one, by sign-in, re-authentication, regeneration or disabling", async () => {
    const world = serve();
    const { account } = await enrol(world);
    // The enrolment accepted the previous step. A code one step ahead is inside the window, and signing in with it moves the account's step forward.
    const newest = await codeAt(world, account.id, 1);
    const token = await fullSession(world, account, newest);
    const accepted = (await store.mfaStateOf(account.id))?.lastStep;
    expect(accepted).toBe(totpStep(world.clock.now().getTime()) + 1);
    const codesBefore = await store.unusedBackupCodes(account.id);

    // The newest step itself, the current one before it and the enrolment's step before that.
    for (const offset of [1, 0, -1]) {
      const code = await codeAt(world, account.id, offset);
      const label = `offset ${String(offset)}`;
      await expectInvalidCode(await post(world, VERIFY, await startSignIn(world, account), { code }), `verify, ${label}`);
      await expectInvalidCode(await post(world, REAUTH, token, { code }), `reauth, ${label}`);
      await expectInvalidCode(await post(world, BACKUP_CODES, token, { code }), `regenerate, ${label}`);
      await expectInvalidCode(await del(world, MFA, token, { password: account.password, code }), `disable, ${label}`);
    }

    // Nothing was spent, regenerated or turned off.
    expect((await store.mfaStateOf(account.id))?.lastStep).toBe(accepted);
    expect((await store.mfaStateOf(account.id))?.enabledAt).not.toBeNull();
    expect((await store.unusedBackupCodes(account.id)).map((row) => row.id)).toEqual(codesBefore.map((row) => row.id));
    expect(await levels(account.id)).toContain("partial");

    // A step newer than the accepted one is still taken, so the refusals above are the replay rule and not something else.
    world.clock.advance(STEP_MS);
    expect((await post(world, REAUTH, token, { password: account.password })).status).toBe(204);
    expect((await post(world, BACKUP_CODES, token, { code: await codeAt(world, account.id, 1) })).status).toBe(200);
  });

  it("is spent for sign-in once re-authentication or regeneration used it", async () => {
    const world = serve();
    const { account } = await enrol(world);
    const token = await fullSession(world, account, await codeAt(world, account.id));
    world.clock.advance(STEP_MS);

    const reauthenticated = await codeAt(world, account.id);
    expect((await post(world, REAUTH, token, { code: reauthenticated })).status).toBe(204);
    await expectInvalidCode(await post(world, VERIFY, await startSignIn(world, account), { code: reauthenticated }), "verify after reauth");

    const regenerated = await codeAt(world, account.id, 1);
    expect((await post(world, BACKUP_CODES, token, { code: regenerated })).status).toBe(200);
    await expectInvalidCode(await post(world, VERIFY, await startSignIn(world, account), { code: regenerated }), "verify after regeneration");
  });
});

describe("the mfa limit (T9)", () => {
  async function pendingSessions(): Promise<{ readonly open: World; readonly accounts: readonly [SeededAccount, SeededAccount] }> {
    // The enrolments take tokens of the mfa bucket too, so they are made on a server with open limits.
    const open = serve();
    const first = await enrol(open);
    const second = await enrol(open);
    return { open, accounts: [first.account, second.account] };
  }

  it("holds per IP: the attempt over it is 429 with Retry-After for every account behind that address, a right code included, and another address is not limited", async () => {
    const { open, accounts } = await pendingSessions();
    const world = serve({ env: { RATE_LIMIT_MFA_IP: "3/min", TRUSTED_PROXY_HOPS: "1" }, keys: open.keys, clock: open.clock });
    const [a, b] = accounts;
    const pendingA = await startSignIn(world, a);
    const pendingB = await startSignIn(world, b);
    const rightA = await codeAt(world, a.id);
    const rightB = await codeAt(world, b.id);

    for (const wrong of ["000000", "000001", "000002"]) {
      await expectInvalidCode(await post(world, VERIFY, pendingA, { code: wrong }, "198.51.100.1"), wrong);
    }
    const limited = await post(world, VERIFY, pendingA, { code: rightA }, "198.51.100.1");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(await problem(limited)).toMatchObject({ code: "rate_limited" });
    // Another account behind the same address is limited with it.
    expect((await post(world, VERIFY, pendingB, { code: rightB }, "198.51.100.1")).status).toBe(429);
    // A refusal by the limit is not a failed code and ends no session.
    expect(await levels(a.id)).toContain("partial");
    expect(await levels(b.id)).toContain("partial");

    // Another address is not limited, and the sessions the first one was refused for are still good.
    expect((await post(world, VERIFY, pendingB, { code: rightB }, "198.51.100.2")).status).toBe(200);
    expect((await post(world, VERIFY, pendingA, { code: rightA }, "198.51.100.2")).status).toBe(200);
  });

  it("holds per account whatever the address or the session: attempts from different addresses and pending sessions are counted together, and another account is not limited", async () => {
    const { open, accounts } = await pendingSessions();
    const world = serve({ env: { RATE_LIMIT_MFA_ACCOUNT: "3/hour", TRUSTED_PROXY_HOPS: "1" }, keys: open.keys, clock: open.clock });
    const [a, b] = accounts;
    // Three pending sessions of one account: a limit keyed by session would give each a bucket of its own.
    const first = await startSignIn(world, a);
    const second = await startSignIn(world, a);
    const third = await startSignIn(world, a);
    const pendingB = await startSignIn(world, b);
    const rightA = await codeAt(world, a.id);
    const rightB = await codeAt(world, b.id);

    await expectInvalidCode(await post(world, VERIFY, first, { code: "000000" }, "198.51.100.1"), "first session, first attempt");
    await expectInvalidCode(await post(world, VERIFY, first, { code: "000001" }, "198.51.100.2"), "first session, second attempt");
    await expectInvalidCode(await post(world, VERIFY, second, { code: "000002" }, "198.51.100.3"), "second session, first attempt");
    const limited = await post(world, VERIFY, third, { code: rightA }, "198.51.100.4");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(await problem(limited)).toMatchObject({ code: "rate_limited" });
    expect(await levels(a.id)).toContain("partial");

    expect((await post(world, VERIFY, pendingB, { code: rightB }, "198.51.100.4")).status).toBe(200);
  });
});

describe("what is never written down (T7)", () => {
  /** Every string a value holds, keys included. Numbers are left out: a duration or a timestamp is not a place a code is written. */
  function strings(value: unknown, into: string[] = []): string[] {
    if (typeof value === "string") {
      into.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        strings(item, into);
      }
    } else if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        into.push(key);
        strings(item, into);
      }
    }
    return into;
  }

  /** What an error report holds: the error's name, message and stack as well as the context it came with. */
  function reported({ error, route }: Report): string[] {
    const own = error instanceof Error ? [error.name, error.message, error.stack ?? "", String(error)] : [String(error)];
    return [...own, ...strings(error), route ?? ""];
  }

  it("keeps secrets, codes, backup codes and QR payloads out of every log line, error report and error answer of the MFA operations", async () => {
    const key = testKey("key-1");
    const world = serve({ keys: [key] });
    const { account, backupCodes, shown } = await enrol(world);
    const presented: string[] = [];
    const answers: string[] = [];
    const record = async (response: Response, ...values: string[]): Promise<Response> => {
      presented.push(...values);
      if (response.status >= 400) {
        answers.push(await response.clone().text());
      }
      return response;
    };

    // Sign in: a wrong code, a wrong backup code, a malformed one, then the right code.
    const right = await codeAt(world, account.id, 1);
    const pending = await startSignIn(world, account);
    await record(await post(world, VERIFY, pending, { code: "918273" }), "918273");
    await record(await post(world, VERIFY, pending, { backupCode: "ZYXWVUTSRQ" }), "ZYXWVUTSRQ");
    await record(await post(world, VERIFY, pending, { code: "not a code" }), "not a code");
    const verified = await record(await post(world, VERIFY, pending, { code: right }), right);
    const token = tokenOf(verified) ?? "";

    // Re-authenticate, regenerate and disable, each with a wrong value (for disabling also a backup code the regeneration replaced) and then a right one.
    expect((await post(world, REAUTH, token, { password: account.password })).status).toBe(204);
    await record(await post(world, REAUTH, token, { code: "918274" }), "918274");
    world.clock.advance(STEP_MS);
    const forReauth = await codeAt(world, account.id, 1);
    await record(await post(world, REAUTH, token, { code: forReauth }), forReauth);
    await record(await post(world, BACKUP_CODES, token, { code: "918275" }), "918275");
    world.clock.advance(STEP_MS);
    const forRegeneration = await codeAt(world, account.id, 1);
    const regenerated = await record(await post(world, BACKUP_CODES, token, { code: forRegeneration }), forRegeneration);
    expect(regenerated.status).toBe(200);
    const { backupCodes: newBackupCodes } = (await regenerated.json()) as { backupCodes: string[] };
    await record(await del(world, MFA, token, { password: "not the password at all", code: "918276" }), "not the password at all", "918276");
    await record(await del(world, MFA, token, { password: account.password, backupCode: backupCodes[0] ?? "" }), backupCodes[0] ?? "");
    world.clock.advance(STEP_MS);
    const forDisabling = await codeAt(world, account.id, 1);
    const disabled = await record(await del(world, MFA, token, { password: account.password, code: forDisabling }), forDisabling);
    expect(disabled.status).toBe(204);
    const freed = tokenOf(disabled) ?? "";

    // An enrolment, wrong and right, on the account that disabling freed.
    expect((await post(world, REAUTH, freed, { password: account.password })).status).toBe(204);
    const started = await post(world, START, freed);
    expect(started.status).toBe(200);
    const again = (await started.json()) as { secret: string; otpauthUri: string; qrSvg: string };
    const wrongConfirmation = wrongCode(await codeAt(world, account.id));
    await record(await post(world, CONFIRM, freed, { code: wrongConfirmation }), wrongConfirmation);

    // A key that is gone: the operations that open the secret fail with a 500, which is reported.
    const lost = serve({ keys: [testKey("key-lost")], clock: world.clock });
    const other = await enrol(world);
    const lostSession = await startSignIn(lost, other.account);
    const lostCode = await codeAt(world, other.account.id, 1);
    const failed = await record(await post(lost, VERIFY, lostSession, { code: lostCode }), lostCode);
    expect(failed.status).toBe(500);
    expect(await levels(other.account.id)).toContain("partial");
    for (let waited = 0; lost.reports.length === 0 && waited < 100; waited += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(lost.reports.map((report) => report.route)).toContain("POST /api/v1/auth/mfa/verify");

    const secret = Buffer.from(await testSecretBox(key).open((await store.mfaStateOf(account.id))?.secret ?? { ciphertext: new Uint8Array(), keyId: "" }, mfaSecretOptions(account.id)));
    const everywhere = [
      ...[world, lost].flatMap((each) => [...strings([...each.logs.entries, ...each.logs.requests]), ...each.reports.flatMap(reported)]),
      ...answers,
    ];
    expect(world.logs.requests.length).toBeGreaterThan(0);
    for (const value of [...presented, ...backupCodes, ...newBackupCodes, ...shown, again.secret, again.otpauthUri, again.qrSvg, secret.toString("hex"), secret.toString("base64"), account.password]) {
      expect(value.length, "a value to look for").toBeGreaterThan(0);
      expect(
        everywhere.some((written) => written.includes(value)),
        `${value.slice(0, 12)} is written down`,
      ).toBe(false);
    }
  });
});
