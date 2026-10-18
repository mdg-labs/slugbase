import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { InMemoryMail } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import type { MailPort } from "@slugbase/core";
import type { AuthStore } from "@slugbase/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../../vitest.shared.ts";
import { createAccountOnlyTenantResolver } from "../../src/auth/tenant-resolver.ts";
import { createRateLimitRegistry, loadConfig } from "../../src/config/index.ts";
import { createServer, type Server } from "../../src/create-server.ts";
import { runMigrations } from "../../src/migrate/index.ts";
import { createWorker, type RunningWorker } from "../../src/worker/index.ts";
import { productionEnv } from "../config/support.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { memoryRateLimiter } from "../http/rate-limit-support.ts";
import { urlOf } from "../migrate/support.ts";
import { adapters, recordingLogger, serverConfig } from "../support.ts";
import { medianLatencyRatio, postJson, seedAccount, sessionRows, storeFor } from "./support.ts";

// POST /api/v1/auth/verify-email/resend (doc 04 sections 7 and 10.2, doc 02 sections 2.3 and 2.6, doc 10 T8
// and T9) over the whole chain and a migrated database. The failure scenario (T8): a resend for a known
// verified address, a known unverified one and an unknown one answers with one status, one set of headers
// and one body, queues one mail job and falls in one latency class; only the worker, which finds the
// account, issues a token, and only for an unverified one. A resend flood stops at the `reset` limits.

const RESEND = "/api/v1/auth/verify-email/resend";
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
  await database().owner`DELETE FROM pgboss.job WHERE name = 'mail.send'`;
});

interface World {
  readonly server: Server;
  readonly origin: string;
  readonly logs: ReturnType<typeof recordingLogger>;
}

interface ServeOptions {
  readonly env?: Record<string, string>;
  readonly mail?: MailPort;
}

function serve({ env = {}, mail = new InMemoryMail() }: ServeOptions = {}): World {
  const config = serverConfig({ NODE_ENV: "test", DATABASE_URL: appUrl(database()), PUBLIC_REGISTRATION: "true", EMAIL_VERIFICATION_REQUIRED: "true", RATE_LIMIT_RESET_IP: "1000/hour", RATE_LIMIT_RESET_EMAIL: "1000/hour", ...env });
  const logs = recordingLogger();
  const server = createServer({
    config,
    adapters: { ...adapters(config), rateLimit: memoryRateLimiter(createRateLimitRegistry(config)), tenantResolver: createAccountOnlyTenantResolver(), mail },
    modules: [],
    migrations: [],
    logger: logs,
    database: tenantDatabase(database()),
    authStore: store,
  });
  return { server, origin: config.APP_ORIGIN, logs };
}

function resend(world: World, email: string, extra: { forwardedFor?: string } = {}): Promise<Response> {
  return world.server.fetch(postJson(world.origin, RESEND, { email }, extra));
}

interface JobRow {
  readonly data: Record<string, unknown>;
}

async function mailJobs(): Promise<JobRow[]> {
  return [...(await database().app<JobRow[]>`SELECT data FROM pgboss.job WHERE name = 'mail.send' ORDER BY created_on, id`)];
}

async function answerOf(response: Response) {
  const text = await response.text();
  return {
    status: response.status,
    // `x-request-id` differs by request, and `ratelimit` reports the remaining tokens of the address's own bucket, which a repeat of one address lowers.
    headers: [...response.headers].filter(([name]) => name !== "x-request-id" && name !== "ratelimit").sort(([a], [b]) => a.localeCompare(b)),
    body: text === "" ? text : JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(text) as Record<string, unknown>).filter(([name]) => name !== "requestId"))),
  };
}

interface TokenRow {
  readonly account_id: string;
  readonly token_hash: Buffer;
  readonly used_at: Date | null;
}

async function credentialTokens(): Promise<TokenRow[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<TokenRow[]>`SELECT account_id, token_hash, used_at FROM credential_tokens ORDER BY created_at`;
  });
  return [...rows];
}

async function seedToken(accountId: string): Promise<Buffer> {
  const hash = createHash("sha256").update(`earlier token of ${accountId}`).digest();
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`
      INSERT INTO credential_tokens (id, purpose, account_id, token_hash, expires_at)
      VALUES (gen_random_uuid(), 'email_verify', ${accountId}, ${hash}, now() + interval '1 hour')`;
  });
  return hash;
}

async function accountState(accountId: string) {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx`SELECT password_hash, email_verified_at, password_changed_at, mfa_enabled_at, disabled_at FROM accounts WHERE id = ${accountId}`;
  });
  return rows[0];
}

describe("POST /api/v1/auth/verify-email/resend", { timeout: TEST_TIMEOUT_MS }, () => {
  it("answers one 202 with no body for a verified account, an unverified one and an unknown address, whatever the spelling", async () => {
    const world = serve({ env: { TRUSTED_PROXY_HOPS: "1" } });
    const verified = await seedAccount(database(), { emailVerified: true, email: "Verified.Person@Example.test" });
    const unverified = await seedAccount(database(), { email: "Unverified.Person@Example.test" });

    const answers = [];
    let hop = 0;
    for (const email of [verified.email, verified.email.toUpperCase(), unverified.email, unverified.email.toLowerCase(), "nobody@example.test"]) {
      hop += 1;
      answers.push(await answerOf(await resend(world, email, { forwardedFor: `198.51.100.${String(hop)}` })));
    }

    expect(answers[0]?.status).toBe(202);
    expect(answers[0]?.body).toBe("");
    for (const answer of answers) {
      expect(answer).toEqual(answers[0]);
    }
  });

  it("queues one verification mail job on every path, naming only the account that holds the address", async () => {
    const world = serve();
    const verified = await seedAccount(database(), { emailVerified: true });
    const unverified = await seedAccount(database());

    for (const email of [verified.email, unverified.email, "nobody@example.test"]) {
      const before = (await mailJobs()).length;
      expect((await resend(world, email)).status).toBe(202);
      expect(await mailJobs()).toHaveLength(before + 1);
    }

    const queued = (await mailJobs()).map((job) => job.data);
    expect(queued.map((data) => data["template"])).toEqual(["verifyEmail", "verifyEmail", "verifyEmail"]);
    expect(queued.map((data) => data["accountId"])).toEqual([verified.id, unverified.id, expect.not.stringMatching(new RegExp(`${verified.id}|${unverified.id}`))]);
  });

  it("changes nothing of the account itself: no password, verification state or session", async () => {
    const world = serve();
    const unverified = await seedAccount(database());
    const before = await accountState(unverified.id);

    expect((await resend(world, unverified.email)).status).toBe(202);

    expect(await accountState(unverified.id)).toEqual(before);
    expect(await sessionRows(database(), unverified.id)).toEqual([]);
    expect(await credentialTokens()).toEqual([]);
  });

  it("queues nothing when the mail port cannot send, and still answers the same 202", async () => {
    const world = serve({ mail: { available: false, send: () => Promise.reject(new Error("no mail")) } });
    const unverified = await seedAccount(database());

    const response = await resend(world, unverified.email);

    expect(response.status).toBe(202);
    expect(await mailJobs()).toEqual([]);
  });

  it("falls in one latency class for a known unverified address as for an unknown one", { timeout: HEAVY_TEST_TIMEOUT_MS }, async () => {
    const world = serve();
    const unverified = await seedAccount(database());
    const known = () => resend(world, unverified.email);
    const unknown = () => resend(world, "nobody@example.test");

    const ratio = await medianLatencyRatio(unknown, known);

    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2);
  });

  it("rejects a body that is not an email address with 422, and an unknown field", async () => {
    const world = serve();
    for (const body of [{ email: "not an address" }, {}, { email: "a@example.test", extra: 1 }]) {
      const response = await world.server.fetch(postJson(world.origin, RESEND, body));
      expect(response.status).toBe(422);
    }
    expect(await mailJobs()).toEqual([]);
  });

  it("refuses a request that does not come from the application itself, and queues nothing", async () => {
    const world = serve();
    const unverified = await seedAccount(database());
    const request = new Request(new URL(RESEND, world.origin), {
      method: "POST",
      headers: { origin: "https://evil.example.test", "content-type": "application/json" },
      body: JSON.stringify({ email: unverified.email }),
    });

    const response = await world.server.fetch(request);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "cross_site_request" });
    expect(await mailJobs()).toEqual([]);
  });
});

describe("the resend limits (T9)", { timeout: TEST_TIMEOUT_MS }, () => {
  it("is 5 per hour per address and 3 per hour per target email by default", () => {
    const registry = createRateLimitRegistry(serverConfig({ NODE_ENV: "test", DATABASE_URL: appUrl(database()) }));
    expect(registry.window("reset")).toEqual({ capacity: 5, refillPerSecond: 5 / 3600 });
    expect(registry.window("reset:email")).toEqual({ capacity: 3, refillPerSecond: 3 / 3600 });
  });

  it("allows 5 resends per hour from one address and answers the sixth 429 with Retry-After, counting each address on its own", async () => {
    const world = serve({ env: { RATE_LIMIT_RESET_IP: "5/hour", TRUSTED_PROXY_HOPS: "1" } });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await resend(world, `flood.${String(attempt)}@example.test`, { forwardedFor: "198.51.100.7" })).status).toBe(202);
    }

    const denied = await resend(world, "flood.5@example.test", { forwardedFor: "198.51.100.7" });

    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await denied.json()).toMatchObject({ code: "rate_limited" });
    expect((await resend(world, "flood.5@example.test", { forwardedFor: "198.51.100.8" })).status).toBe(202);
  });

  it("allows 3 resends per hour for one email, in any spelling and from any address, known or not, and queues nothing for the fourth", async () => {
    const world = serve({ env: { RATE_LIMIT_RESET_EMAIL: "3/hour", TRUSTED_PROXY_HOPS: "1" } });
    const unverified = await seedAccount(database(), { email: "Target.Person@Example.test" });
    const spellings = [unverified.email, unverified.email.toLowerCase(), unverified.email.toUpperCase()];
    for (const [index, email] of spellings.entries()) {
      expect((await resend(world, email, { forwardedFor: `198.51.100.${String(index + 1)}` })).status).toBe(202);
    }
    expect(await mailJobs()).toHaveLength(3);

    const denied = await resend(world, unverified.email, { forwardedFor: "198.51.100.9" });

    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await mailJobs()).toHaveLength(3);
    expect((await resend(world, "someone.else@example.test", { forwardedFor: "198.51.100.9" })).status).toBe(202);
  });

  it("counts an unknown address against the email limit exactly as a known one", async () => {
    const world = serve({ env: { RATE_LIMIT_RESET_EMAIL: "3/hour" } });
    const statuses = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      statuses.push((await resend(world, "ghost@example.test")).status);
    }
    expect(statuses).toEqual([202, 202, 202, 429]);
  });
});

describe("the verification mail of a resend through the worker", { timeout: TEST_TIMEOUT_MS }, () => {
  const mail = new InMemoryMail();
  let worker: RunningWorker | undefined;

  async function startWorker(): Promise<void> {
    const config = loadConfig("worker", { ...productionEnv(), NODE_ENV: "test", DATABASE_URL: appUrl(database()) }).config;
    worker = await createWorker({
      config,
      adapters: { ...adapters(), mail },
      modules: [],
      logger: recordingLogger(),
      database: tenantDatabase(database()),
      pollingIntervalSeconds: POLL_SECONDS,
      shutdownTimeoutMs: 500,
    }).start();
  }

  beforeEach(() => {
    mail.clear();
  });

  afterEach(async () => {
    await worker?.shutdown();
    worker = undefined;
  });

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

  it("emails an unverified account one fresh link and deletes its earlier unused token, and emails nobody else", async () => {
    const world = serve({ mail });
    const unverified = await seedAccount(database(), { email: "needs.link@example.test" });
    const verified = await seedAccount(database(), { emailVerified: true, email: "done.already@example.test" });
    const earlier = await seedToken(unverified.id);

    for (const email of [unverified.email, verified.email, "nobody@example.test"]) {
      expect((await resend(world, email)).status).toBe(202);
    }
    await startWorker();
    await mailJobsDone(3);

    expect(mail.sent).toHaveLength(1);
    const [message] = mail.sent;
    expect(message).toMatchObject({ template: "verifyEmail", to: "needs.link@example.test" });
    const token = String(message?.data["token"]);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = await credentialTokens();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.account_id).toBe(unverified.id);
    expect(stored[0]?.token_hash.equals(earlier)).toBe(false);
    expect(stored[0]?.token_hash).toEqual(createHash("sha256").update(Buffer.from(token, "base64url")).digest());
    expect(stored[0]?.used_at).toBeNull();
  });
});
