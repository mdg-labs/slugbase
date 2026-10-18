import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { CREDENTIAL_TOKEN_TTL_SECONDS, generateCredentialToken, type MailPort } from "@slugbase/core";
import { type AuthStore } from "@slugbase/db";
import { InMemoryMail } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../../vitest.shared.ts";
import { createAccountOnlyTenantResolver } from "../../src/auth/tenant-resolver.ts";
import { uuidv7 } from "../../src/auth/uuidv7.ts";
import { createRateLimitRegistry, loadConfig } from "../../src/config/index.ts";
import { createServer, type Server } from "../../src/create-server.ts";
import { runMigrations } from "../../src/migrate/index.ts";
import { createWorker, type RunningWorker } from "../../src/worker/index.ts";
import { productionEnv } from "../config/support.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { memoryRateLimiter } from "../http/rate-limit-support.ts";
import { urlOf } from "../migrate/support.ts";
import { adapters, recordingLogger, serverConfig } from "../support.ts";
import { SESSION_COOKIE, issuedToken, medianLatencyRatio, postJson, seedAccount, sessionRows, storeFor, type SeededAccount } from "./support.ts";

// POST /api/v1/me/email, /me/email/confirm, /me/email/cancel and DELETE /me/email/pending (doc 04 sections 4.5, 7
// and 10.3, doc 02 section 2.6, doc 10 T4, T8, T9 and T18) over the whole chain and a migrated database. The
// failure scenarios: a change without a fresh re-authentication; a request that tells a taken address from a free
// one, by its answer or by a mail to the other account; a confirmation that works twice, after its hour, after a
// newer request, after the change was cancelled or for an address another account took meanwhile; a "this wasn't
// me" link that leaves a session alive; a change that an account nobody verified completes.

const REAUTH = "/api/v1/me/reauth";
const EMAIL = "/api/v1/me/email";
const CONFIRM = "/api/v1/me/email/confirm";
const CANCEL = "/api/v1/me/email/cancel";
const FORGOT = "/api/v1/auth/password/forgot";
const RESET = "/api/v1/auth/password/reset";
const PENDING = "/api/v1/me/email/pending";
const ME = "/api/v1/me";
const LOGIN = "/api/v1/auth/login";
const PASSWORD = "the password of the account being changed";
const HOUR_SECONDS = 3600;
const POLL_SECONDS = 0.5;
const WAIT_MS = 20_000;
const HOOK_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 40_000;

const database = useTestDatabase();
let store: AuthStore;

beforeAll(async () => {
  store = storeFor(database());
  await runMigrations({ url: urlOf(database().owner) });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await store.close();
}, 30_000);

beforeEach(async () => {
  await database().owner`TRUNCATE accounts CASCADE`;
  await database().owner`TRUNCATE workspaces CASCADE`;
  await database().owner`DELETE FROM pgboss.job WHERE name IN ('mail.send', 'event.account.created', 'event.workspace.created')`;
});

interface World {
  readonly server: Server;
  readonly origin: string;
}

interface ServeOptions {
  readonly env?: Record<string, string>;
  readonly mail?: MailPort;
}

/** The server as the CE composes it; the limits are open unless a test is about them. */
function serve({ env = {}, mail = new InMemoryMail() }: ServeOptions = {}): World {
  const config = serverConfig({
    NODE_ENV: "test",
    DATABASE_URL: appUrl(database()),
    RATE_LIMIT_RESET_IP: "1000/hour",
    RATE_LIMIT_RESET_EMAIL: "1000/hour",
    RATE_LIMIT_TOKEN_REDEEM_IP: "1000/hour",
    RATE_LIMIT_LOGIN_IP: "1000/min",
    RATE_LIMIT_LOGIN_EMAIL: "1000/hour",
    RATE_LIMIT_MFA_IP: "1000/min",
    RATE_LIMIT_MFA_ACCOUNT: "1000/hour",
    ...env,
  });
  const server = createServer({
    config,
    adapters: { ...adapters(config), rateLimit: memoryRateLimiter(createRateLimitRegistry(config)), tenantResolver: createAccountOnlyTenantResolver(), mail },
    modules: [],
    migrations: [],
    logger: recordingLogger(),
    database: tenantDatabase(database()),
    authStore: store,
  });
  return { server, origin: config.APP_ORIGIN };
}

function owner(options: { email?: string; emailVerified?: boolean } = {}): Promise<SeededAccount> {
  return seedAccount(database(), { emailVerified: true, password: PASSWORD, ...options });
}

/** A session cookie of the account, signed in now; `fresh` re-authenticates it with the password too. */
async function signIn(world: World, account: SeededAccount, fresh: boolean): Promise<string> {
  const response = await world.server.fetch(postJson(world.origin, LOGIN, { email: account.email, password: account.password, remember: false }));
  const token = issuedToken(response);
  if (response.status !== 200 || token === undefined) {
    throw new Error(`could not sign in: ${String(response.status)}`);
  }
  const cookie = `${SESSION_COOKIE}=${token}`;
  if (fresh) {
    const reauth = await world.server.fetch(postJson(world.origin, REAUTH, { password: account.password }, { cookie }));
    if (reauth.status !== 204) {
      throw new Error(`could not re-authenticate: ${String(reauth.status)}`);
    }
  }
  return cookie;
}

function requestChange(world: World, cookie: string | undefined, email: string, extra: { forwardedFor?: string } = {}): Promise<Response> {
  return world.server.fetch(postJson(world.origin, EMAIL, { email }, { ...(cookie === undefined ? {} : { cookie }), ...extra }));
}

function redeem(world: World, path: string, token: string): Promise<Response> {
  return world.server.fetch(postJson(world.origin, path, { token }));
}

function cancelPending(world: World, cookie: string): Promise<Response> {
  return world.server.fetch(new Request(new URL(PENDING, world.origin), { method: "DELETE", headers: { origin: world.origin, "content-type": "application/json", cookie } }));
}

/** The `account` of `GET /me` as the session sees it. */
async function accountOf(world: World, cookie: string): Promise<Record<string, unknown>> {
  const response = await probe(world, cookie);
  expect(response.status).toBe(200);
  return ((await response.json()) as { account: Record<string, unknown> }).account;
}

function probe(world: World, cookie: string): Promise<Response> {
  return world.server.fetch(new Request(new URL(ME, world.origin), { headers: { cookie } }));
}

async function pendingEmail(accountId: string): Promise<{ email: string; pending: string | null }> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ email: string; pending: string | null }[]>`SELECT email, pending_email AS pending FROM accounts WHERE id = ${accountId}`;
  });
  const row = rows[0];
  if (row === undefined) {
    throw new Error("the account is missing");
  }
  return row;
}

interface TokenRow {
  readonly account_id: string;
  readonly purpose: string;
  readonly target_email: string | null;
  readonly token_hash: Buffer;
  readonly used_at: Date | null;
  readonly lifetime_seconds: number;
}

async function credentialTokens(): Promise<TokenRow[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<TokenRow[]>`
      SELECT account_id, purpose, target_email, token_hash, used_at, extract(epoch FROM expires_at - created_at)::float8 AS lifetime_seconds
      FROM credential_tokens ORDER BY created_at, id`;
  });
  return [...rows];
}

async function ageTokens(accountId: string, seconds: number): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE credential_tokens SET expires_at = expires_at - make_interval(secs => ${seconds}) WHERE account_id = ${accountId}`;
  });
}

async function mailJobs(): Promise<{ data: Record<string, unknown> }[]> {
  return [...(await database().app<{ data: Record<string, unknown> }[]>`SELECT data FROM pgboss.job WHERE name = 'mail.send' ORDER BY created_on, id`)];
}

async function answerOf(response: Response) {
  const text = await response.text();
  return {
    status: response.status,
    // `x-request-id` differs by request, and `ratelimit` reports the remaining tokens of the bucket, which a repeat lowers.
    headers: [...response.headers].filter(([name]) => name !== "x-request-id" && name !== "ratelimit").sort(([a], [b]) => a.localeCompare(b)),
    body: text === "" ? text : JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(text) as Record<string, unknown>).filter(([name]) => name !== "requestId"))),
  };
}

describe("POST /api/v1/me/email", { timeout: TEST_TIMEOUT_MS }, () => {
  it("refuses a session that has not re-authenticated with 401 reauth_required, and an anonymous request with 401, and records and queues nothing", async () => {
    const world = serve();
    const account = await owner();
    const stale = await signIn(world, account, false);

    const refused = await requestChange(world, stale, "new@example.test");
    const anonymous = await requestChange(world, undefined, "new@example.test");

    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({ code: "reauth_required" });
    expect(anonymous.status).toBe(401);
    expect(await pendingEmail(account.id)).toEqual({ email: account.email, pending: null });
    expect(await mailJobs()).toEqual([]);
  });

  it("accepts a session that re-authenticated, answers 202 with no body, records the address and queues the one mail job naming only the account", async () => {
    const world = serve();
    const account = await owner();
    const cookie = await signIn(world, account, true);

    const response = await requestChange(world, cookie, "New.Address@Example.test");

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
    expect(await pendingEmail(account.id)).toEqual({ email: account.email, pending: "New.Address@Example.test" });
    expect((await mailJobs()).map((job) => job.data)).toEqual([{ template: "emailChange", accountId: account.id }]);
    expect(await credentialTokens()).toEqual([]);
    expect(await probe(world, cookie)).toMatchObject({ status: 200 });
  });

  it("answers one 202 for a free address, the account's own, another account's and its other spelling, and queues the same jobs for each", async () => {
    const world = serve({ env: { TRUSTED_PROXY_HOPS: "1" } });
    const account = await owner();
    const other = await owner({ email: "Taken.Person@Example.test" });
    const cookie = await signIn(world, account, true);

    const answers = [];
    let hop = 0;
    for (const email of ["free@example.test", account.email, account.email.toUpperCase(), other.email, other.email.toLowerCase()]) {
      hop += 1;
      const before = (await mailJobs()).length;
      answers.push(await answerOf(await requestChange(world, cookie, email, { forwardedFor: `198.51.100.${String(hop)}` })));
      expect(await mailJobs()).toHaveLength(before + 1);
    }

    expect(answers[0]?.status).toBe(202);
    expect(answers[0]?.body).toBe("");
    for (const answer of answers) {
      expect(answer).toEqual(answers[0]);
    }
    expect(await pendingEmail(other.id)).toEqual({ email: "Taken.Person@Example.test", pending: null });
    expect((await mailJobs()).every((job) => job.data["accountId"] === account.id)).toBe(true);
  });

  it("falls in one latency class for an address that is taken as for one that is free", { timeout: HEAVY_TEST_TIMEOUT_MS }, async () => {
    const world = serve();
    const account = await owner();
    const other = await owner({ email: "taken.latency@example.test" });
    const cookie = await signIn(world, account, true);

    const ratio = await medianLatencyRatio(
      () => requestChange(world, cookie, "free.latency@example.test"),
      () => requestChange(world, cookie, other.email),
    );

    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2);
  });

  it("records the address and queues nothing when the mail port cannot send, and answers the same 202", async () => {
    const world = serve({ mail: { available: false, send: () => Promise.reject(new Error("no mail")) } });
    const account = await owner();
    const cookie = await signIn(world, account, true);

    const response = await requestChange(world, cookie, "new@example.test");

    expect(response.status).toBe(202);
    expect(await mailJobs()).toEqual([]);
  });

  it("rejects a body that is not an email address, and an unknown field, with 422", async () => {
    const world = serve();
    const account = await owner();
    const cookie = await signIn(world, account, true);

    for (const body of [{ email: "not an address" }, {}, { email: "a@example.test", extra: 1 }]) {
      expect((await world.server.fetch(postJson(world.origin, EMAIL, body, { cookie }))).status).toBe(422);
    }
    expect(await pendingEmail(account.id)).toEqual({ email: account.email, pending: null });
  });

  it("refuses a request that does not come from the application itself, and records nothing", async () => {
    const world = serve();
    const account = await owner();
    const cookie = await signIn(world, account, true);
    const request = postJson(world.origin, EMAIL, { email: "new@example.test" }, { cookie });
    request.headers.set("origin", "https://evil.example.test");

    const response = await world.server.fetch(request);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "cross_site_request" });
    expect((await pendingEmail(account.id)).pending).toBeNull();
  });

  it("counts attempts per target address in the reset bucket: the fourth request for one address in an hour is 429, whoever asks", async () => {
    const world = serve({ env: { RATE_LIMIT_RESET_EMAIL: "3/hour" } });
    const first = await owner();
    const second = await owner();
    const cookies = [await signIn(world, first, true), await signIn(world, second, true)];

    for (const cookie of [cookies[0], cookies[0], cookies[1]]) {
      expect((await requestChange(world, cookie, "popular@example.test")).status).toBe(202);
    }
    const denied = await requestChange(world, cookies[1], "popular@example.test");

    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await requestChange(world, cookies[1], "another@example.test")).status).toBe(202);
  });
});

describe("GET /api/v1/me pendingEmail", { timeout: TEST_TIMEOUT_MS }, () => {
  it("is null until a change is requested, then the address as stored, then the newer address after a newer request, then null after DELETE /me/email/pending", async () => {
    const world = serve();
    const account = await owner();
    const cookie = await signIn(world, account, true);
    expect((await accountOf(world, cookie))["pendingEmail"]).toBeNull();

    expect((await requestChange(world, cookie, "New.Address@Example.test")).status).toBe(202);
    expect((await accountOf(world, cookie))["pendingEmail"]).toBe("New.Address@Example.test");
    expect((await accountOf(world, cookie))["email"]).toBe(account.email);

    expect((await requestChange(world, cookie, "newer@example.test")).status).toBe(202);
    expect((await accountOf(world, cookie))["pendingEmail"]).toBe("newer@example.test");

    expect((await cancelPending(world, cookie)).status).toBe(204);
    expect((await accountOf(world, cookie))["pendingEmail"]).toBeNull();
  });

  it("shows the requested address as stored whether it is free, the account's own or another account's, so the account tells nothing about who holds an address", async () => {
    const world = serve({ env: { TRUSTED_PROXY_HOPS: "1" } });
    const account = await owner();
    const other = await owner({ email: "Held.Elsewhere@Example.test" });
    const cookie = await signIn(world, account, true);
    const free = await accountOf(world, cookie);

    let hop = 0;
    for (const email of ["free@example.test", account.email, other.email, other.email.toLowerCase()]) {
      hop += 1;
      expect((await requestChange(world, cookie, email, { forwardedFor: `198.51.100.${String(hop)}` })).status).toBe(202);
      const shown = await accountOf(world, cookie);
      expect(shown["pendingEmail"]).toBe(email);
      expect({ ...shown, pendingEmail: null }).toEqual({ ...free, pendingEmail: null });
    }
    expect((await pendingEmail(other.id)).pending).toBeNull();
  });
});

describe("the confirmation and the cancel link", { timeout: TEST_TIMEOUT_MS }, () => {
  const mail = new InMemoryMail();
  let worker: RunningWorker | undefined;

  beforeEach(() => {
    mail.clear();
  });

  afterEach(async () => {
    await worker?.shutdown();
    worker = undefined;
  });

  async function startWorker(port: MailPort = mail): Promise<void> {
    const config = loadConfig("worker", { ...productionEnv(), NODE_ENV: "test", DATABASE_URL: appUrl(database()) }).config;
    worker = await createWorker({
      config,
      adapters: { ...adapters(), mail: port },
      modules: [],
      logger: recordingLogger(),
      database: tenantDatabase(database()),
      pollingIntervalSeconds: POLL_SECONDS,
      shutdownTimeoutMs: 500,
    }).start();
  }

  async function mailJobsDone(count: number): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const rows = await database().app<{ state: string }[]>`SELECT state FROM pgboss.job WHERE name = 'mail.send'`;
      if (rows.length >= count && rows.every((row) => row.state === "completed")) {
        return;
      }
      if (Date.now() > deadline) {
        throw new Error("timed out waiting for the mail jobs");
      }
      await sleep(50);
    }
  }

  function tokenOf(template: string, to: string): string {
    const message = mail.sent.find((candidate) => candidate.template === template && candidate.to === to);
    if (message === undefined) {
      throw new Error(`no ${template} mail to ${to}`);
    }
    return String(message.data["token"]);
  }

  /** Requests the change as a re-authenticated owner and lets the worker send both mails. */
  async function requested(world: World, account: SeededAccount, newEmail: string, jobs = 1): Promise<string> {
    const cookie = await signIn(world, account, true);
    expect((await requestChange(world, cookie, newEmail)).status).toBe(202);
    await mailJobsDone(jobs);
    return cookie;
  }

  it("mails a confirmation link to the new address and the notice to the old one, each a token that works once for an hour, and the confirmation moves the account", async () => {
    const world = serve({ mail });
    const account = await owner({ email: "old.address@example.test" });
    await startWorker();
    await requested(world, account, "new.address@example.test");

    expect(mail.sent.map((message) => [message.template, message.to])).toEqual([
      ["emailChangeNotice", "old.address@example.test"],
      ["emailChange", "new.address@example.test"],
    ]);
    const confirmation = tokenOf("emailChange", "new.address@example.test");
    const cancel = tokenOf("emailChangeNotice", "old.address@example.test");
    expect(confirmation).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cancel).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cancel).not.toBe(confirmation);
    const stored = await credentialTokens();
    expect(stored.map((row) => [row.purpose, row.target_email, row.used_at])).toEqual(
      expect.arrayContaining([
        ["email_change", "new.address@example.test", null],
        ["email_change_cancel", "old.address@example.test", null],
      ]),
    );
    const bytes = (value: string) => createHash("sha256").update(Buffer.from(value, "base64url")).digest();
    expect(stored.find((row) => row.purpose === "email_change")?.token_hash).toEqual(bytes(confirmation));
    expect(stored.find((row) => row.purpose === "email_change_cancel")?.token_hash).toEqual(bytes(cancel));
    for (const row of stored) {
      expect(row.lifetime_seconds).toBeCloseTo(HOUR_SECONDS, -1);
    }
    expect(CREDENTIAL_TOKEN_TTL_SECONDS.email_change).toBe(HOUR_SECONDS);

    const confirmed = await redeem(world, CONFIRM, confirmation);
    expect(confirmed.status).toBe(204);
    expect(await pendingEmail(account.id)).toEqual({ email: "new.address@example.test", pending: null });
    expect((await redeem(world, CONFIRM, confirmation)).status).toBe(410);
    expect((await world.server.fetch(postJson(world.origin, LOGIN, { email: "new.address@example.test", password: PASSWORD, remember: false }))).status).toBe(200);
    expect((await world.server.fetch(postJson(world.origin, LOGIN, { email: "old.address@example.test", password: PASSWORD, remember: false }))).status).toBe(401);
  });

  it("mails no confirmation link while the notice to the old address cannot be sent, so a change cannot be confirmed before the owner is told", async () => {
    const world = serve({ mail });
    const account = await owner({ email: "owner.told@example.test" });
    let noticeAttempts = 0;
    await startWorker({
      available: true,
      send: (message) => {
        if (message.template === "emailChangeNotice") {
          noticeAttempts += 1;
          if (noticeAttempts === 1) {
            return Promise.reject(new Error("the relay is down"));
          }
        }
        return mail.send(message);
      },
    });
    const attacker = await signIn(world, account, true);
    expect((await requestChange(world, attacker, "attacker.chosen@example.test")).status).toBe(202);

    const deadline = Date.now() + WAIT_MS;
    while ((await database().app<{ state: string }[]>`SELECT state FROM pgboss.job WHERE name = 'mail.send'`)[0]?.state !== "retry") {
      if (Date.now() > deadline) {
        throw new Error("timed out waiting for the mail job to be queued for a retry");
      }
      await sleep(50);
    }
    expect(noticeAttempts).toBe(1);
    expect(mail.sent).toEqual([]);

    await mailJobsDone(1);

    expect(mail.sent.map((message) => [message.template, message.to])).toEqual([
      ["emailChangeNotice", "owner.told@example.test"],
      ["emailChange", "attacker.chosen@example.test"],
    ]);
    expect((await redeem(world, CONFIRM, tokenOf("emailChange", "attacker.chosen@example.test"))).status).toBe(204);
    expect((await redeem(world, CANCEL, tokenOf("emailChangeNotice", "owner.told@example.test"))).status).toBe(204);
    expect((await probe(world, attacker)).status).toBe(401);
    expect((await pendingEmail(account.id)).email).toBe("owner.told@example.test");
  });

  it("mails nothing to the account that holds the requested address, and the notice still goes to the requester's own address", async () => {
    const world = serve({ mail });
    const account = await owner({ email: "requester@example.test" });
    const bystander = await owner({ email: "bystander@example.test" });
    await startWorker();

    await requested(world, account, bystander.email);

    expect(mail.sent.map((message) => [message.template, message.to])).toEqual([["emailChangeNotice", "requester@example.test"]]);
    expect((await credentialTokens()).map((row) => row.purpose)).toEqual(["email_change_cancel"]);
    expect(await pendingEmail(bystander.id)).toEqual({ email: bystander.email, pending: null });
  });

  it("mails nothing to the account's own address as a confirmation, and no token that could move the account is issued", async () => {
    const world = serve({ mail });
    const account = await owner({ email: "same@example.test" });
    await startWorker();

    await requested(world, account, "SAME@example.test");

    expect(mail.sent.map((message) => message.template)).toEqual(["emailChangeNotice"]);
    expect((await credentialTokens()).map((row) => row.purpose)).toEqual(["email_change_cancel"]);
  });

  it("fails a confirmation for an address another account took after the link was mailed as it fails an unknown token, and changes nothing", async () => {
    const world = serve({ mail });
    const account = await owner({ email: "mover@example.test" });
    await startWorker();
    await requested(world, account, "contested@example.test");
    const confirmation = tokenOf("emailChange", "contested@example.test");
    const rival = await owner({ email: "Contested@Example.test" });

    const taken = await redeem(world, CONFIRM, confirmation);
    const unknown = await redeem(world, CONFIRM, "A".repeat(43));

    expect(taken.status).toBe(410);
    expect(await answerOf(taken)).toEqual(await answerOf(unknown));
    expect(await pendingEmail(account.id)).toEqual({ email: "mover@example.test", pending: "contested@example.test" });
    expect((await pendingEmail(rival.id)).email).toBe("Contested@Example.test");
  });

  it("answers an unknown, a malformed, an expired, a used, a replaced and a foreign-purpose token with one identical 410", async () => {
    const world = serve({ mail });
    const account = await owner({ email: "answers@example.test" });
    await startWorker();
    const cookie = await requested(world, account, "answers.new@example.test");
    const first = tokenOf("emailChange", "answers.new@example.test");
    const cancelToken = tokenOf("emailChangeNotice", "answers@example.test");
    mail.clear();
    expect((await requestChange(world, cookie, "answers.newer@example.test")).status).toBe(202);
    await mailJobsDone(2);
    const second = tokenOf("emailChange", "answers.newer@example.test");
    const third = await owner({ email: "late@example.test" });
    await requested(world, third, "late.new@example.test", 3);
    const late = tokenOf("emailChange", "late.new@example.test");
    await ageTokens(third.id, HOUR_SECONDS + 1);
    expect((await redeem(world, CONFIRM, second)).status).toBe(204);

    const answers = [];
    for (const token of ["A".repeat(43), "not-a-token", late, second, first, cancelToken]) {
      answers.push(await answerOf(await redeem(world, CONFIRM, token)));
    }

    expect(answers[0]?.status).toBe(410);
    for (const answer of answers) {
      expect(answer).toEqual(answers[0]);
    }
    expect(JSON.parse(answers[0]?.body ?? "{}")).toMatchObject({ code: "token_expired" });
    expect(await pendingEmail(third.id)).toMatchObject({ email: "late@example.test" });
  });

  it("shows null once the change is confirmed, and null after the cancel link, with the address the account then holds", async () => {
    const world = serve({ mail });
    const account = await owner({ email: "shown.old@example.test" });
    const other = await owner({ email: "shown.other@example.test" });
    await startWorker();
    const cookie = await requested(world, account, "shown.new@example.test");
    expect((await accountOf(world, cookie))["pendingEmail"]).toBe("shown.new@example.test");

    expect((await redeem(world, CONFIRM, tokenOf("emailChange", "shown.new@example.test"))).status).toBe(204);
    expect(await accountOf(world, cookie)).toMatchObject({ email: "shown.new@example.test", pendingEmail: null });

    const second = await requested(world, other, "shown.elsewhere@example.test", 2);
    expect((await accountOf(world, second))["pendingEmail"]).toBe("shown.elsewhere@example.test");
    expect((await redeem(world, CANCEL, tokenOf("emailChangeNotice", "shown.other@example.test"))).status).toBe(204);
    expect(await accountOf(world, await signIn(world, other, false))).toMatchObject({ email: "shown.other@example.test", pendingEmail: null });
  });

  it("deletes every session of the account when the \"this wasn't me\" link is used, cancels the change, and answers the link once", async () => {
    const world = serve({ mail });
    const account = await owner({ email: "victim@example.test" });
    const bystander = await owner({ email: "bystander2@example.test" });
    const bystanderCookie = await signIn(world, bystander, false);
    await startWorker();
    const laptop = await signIn(world, account, false);
    const phone = await signIn(world, account, false);
    const attacker = await requested(world, account, "attacker@example.test");
    expect(await sessionRows(database(), account.id)).toHaveLength(3);
    const cancel = tokenOf("emailChangeNotice", "victim@example.test");
    const confirmation = tokenOf("emailChange", "attacker@example.test");

    const response = await redeem(world, CANCEL, cancel);

    expect(response.status).toBe(204);
    for (const cookie of [laptop, phone, attacker]) {
      expect((await probe(world, cookie)).status).toBe(401);
    }
    expect(await sessionRows(database(), account.id)).toEqual([]);
    expect((await probe(world, bystanderCookie)).status).toBe(200);
    expect(await pendingEmail(account.id)).toEqual({ email: "victim@example.test", pending: null });
    expect((await redeem(world, CONFIRM, confirmation)).status).toBe(410);
    expect((await pendingEmail(account.id)).email).toBe("victim@example.test");
    const replay = await redeem(world, CANCEL, cancel);
    expect(replay.status).toBe(410);
    expect(await replay.json()).toMatchObject({ code: "token_expired" });
  });

  it("puts the old address back with the link after the change was confirmed, ends every session, and refuses a password reset requested to the new address before the undo", async () => {
    const world = serve({ mail });
    const account = await owner({ email: "late.victim@example.test" });
    await startWorker();
    const attacker = await requested(world, account, "late.attacker@example.test");
    expect((await redeem(world, CONFIRM, tokenOf("emailChange", "late.attacker@example.test"))).status).toBe(204);
    expect((await probe(world, attacker)).status).toBe(200);
    expect((await world.server.fetch(postJson(world.origin, FORGOT, { email: "late.attacker@example.test" }))).status).toBe(202);
    await mailJobsDone(2);
    const reset = tokenOf("passwordReset", "late.attacker@example.test");

    expect((await redeem(world, CANCEL, tokenOf("emailChangeNotice", "late.victim@example.test"))).status).toBe(204);

    expect((await probe(world, attacker)).status).toBe(401);
    expect(await pendingEmail(account.id)).toEqual({ email: "late.victim@example.test", pending: null });
    const refused = await world.server.fetch(postJson(world.origin, RESET, { token: reset, newPassword: "the password an attacker would choose" }));
    expect(refused.status).toBe(410);
    expect(await refused.json()).toMatchObject({ code: "token_expired" });
    expect((await world.server.fetch(postJson(world.origin, LOGIN, { email: "late.victim@example.test", password: PASSWORD, remember: false }))).status).toBe(200);
    expect((await credentialTokens()).filter((token) => token.used_at === null)).toEqual([]);
  });

  it("keeps the account's address and answers 204 all the same when another account holds the old one by now, ending every session", async () => {
    const world = serve({ mail });
    const account = await owner({ email: "held.victim@example.test" });
    await startWorker();
    const attacker = await requested(world, account, "held.attacker@example.test");
    expect((await redeem(world, CONFIRM, tokenOf("emailChange", "held.attacker@example.test"))).status).toBe(204);
    await owner({ email: "held.victim@example.test" });

    expect((await redeem(world, CANCEL, tokenOf("emailChangeNotice", "held.victim@example.test"))).status).toBe(204);

    expect((await probe(world, attacker)).status).toBe(401);
    expect(await pendingEmail(account.id)).toEqual({ email: "held.attacker@example.test", pending: null });
  });

  it("cancels a pending change with DELETE /me/email/pending: its links stop working, the session stays, and repeating it is a 204", async () => {
    const world = serve({ mail });
    const account = await owner({ email: "changer@example.test" });
    await startWorker();
    const cookie = await requested(world, account, "changer.new@example.test");
    const confirmation = tokenOf("emailChange", "changer.new@example.test");
    const cancel = tokenOf("emailChangeNotice", "changer@example.test");

    expect((await cancelPending(world, cookie)).status).toBe(204);
    expect((await cancelPending(world, cookie)).status).toBe(204);

    expect(await pendingEmail(account.id)).toEqual({ email: "changer@example.test", pending: null });
    expect((await redeem(world, CONFIRM, confirmation)).status).toBe(410);
    expect((await redeem(world, CANCEL, cancel)).status).toBe(410);
    expect(await credentialTokens()).toEqual([]);
    expect((await probe(world, cookie)).status).toBe(200);
    expect((await cancelPending(world, "")).status).toBe(401);
  });

  it("replaces the links of an earlier request when a newer one is made, so only the newest confirmation works", async () => {
    const world = serve({ mail });
    const account = await owner({ email: "twice@example.test" });
    await startWorker();
    const cookie = await requested(world, account, "first.choice@example.test");
    const first = tokenOf("emailChange", "first.choice@example.test");
    mail.clear();
    expect((await requestChange(world, cookie, "second.choice@example.test")).status).toBe(202);
    await mailJobsDone(2);
    const second = tokenOf("emailChange", "second.choice@example.test");

    expect((await redeem(world, CONFIRM, first)).status).toBe(410);
    expect((await redeem(world, CONFIRM, second)).status).toBe(204);
    expect((await pendingEmail(account.id)).email).toBe("second.choice@example.test");
  });

  it("completes no change for an account whose address was never verified: it is mailed nothing and holds no token", async () => {
    const world = serve({ mail });
    const registrant = await owner({ emailVerified: false, email: "registered.first@example.test" });
    await startWorker();

    await requested(world, registrant, "registrant.chosen@example.test");

    expect(mail.sent).toEqual([]);
    expect(await credentialTokens()).toEqual([]);
    expect((await pendingEmail(registrant.id)).email).toBe("registered.first@example.test");
  });

  it("answers the owner who verifies after a change was started by whoever registered the address first: nothing is left to redeem", async () => {
    const world = serve({ mail });
    const registrant = await owner({ emailVerified: false, email: "victim.address@example.test" });
    const cookie = await signIn(world, registrant, true);
    expect((await requestChange(world, cookie, "registrant.chosen@example.test")).status).toBe(202);
    const confirmation = await seedToken(registrant.id, "email_change", "registrant.chosen@example.test");
    const cancel = await seedToken(registrant.id, "email_change_cancel", null);
    const verification = await seedToken(registrant.id, "email_verify", null);

    const verified = await world.server.fetch(postJson(world.origin, "/api/v1/auth/verify-email", { token: verification, password: "the password the owner chose when verifying" }));

    expect(verified.status).toBe(200);
    expect((await redeem(world, CONFIRM, confirmation)).status).toBe(410);
    expect((await redeem(world, CANCEL, cancel)).status).toBe(410);
    expect(await pendingEmail(registrant.id)).toEqual({ email: "victim.address@example.test", pending: null });
  });
});

/** A token of the purpose as the system issues it, for a test that needs one for an account the worker would not mail. */
async function seedToken(accountId: string, purpose: "email_verify" | "email_change" | "email_change_cancel", targetEmail: string | null): Promise<string> {
  const token = generateCredentialToken();
  const rows = await database().app`
    SELECT sys_credential_token_issue(${uuidv7()}::uuid, ${purpose}::text, ${accountId}::uuid, ${token.hash}::bytea, ${targetEmail}::text, 3600::integer) AS issued`;
  expect(rows[0]?.["issued"]).toBe(true);
  return token.value;
}
