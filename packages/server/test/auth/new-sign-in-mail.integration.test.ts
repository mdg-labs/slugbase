import { setTimeout as sleep } from "node:timers/promises";
import { InMemoryMail } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import type { MailPort } from "@slugbase/core";
import type { AuthStore } from "@slugbase/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAccountOnlyTenantResolver } from "../../src/auth/tenant-resolver.ts";
import { loadConfig } from "../../src/config/index.ts";
import { createServer, type Server } from "../../src/create-server.ts";
import { runMigrations } from "../../src/migrate/index.ts";
import { createWorker } from "../../src/worker/index.ts";
import type { RunningWorker } from "../../src/worker/index.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { productionEnv } from "../config/support.ts";
import { urlOf } from "../migrate/support.ts";
import { adapters, recordingLogger, serverConfig } from "../support.ts";
import { seedAccount, storeFor, type SeededAccount } from "./support.ts";

// The "new sign-in" email through the whole path (doc 02 section 12, doc 01 section 8.1, doc 10 T7):
// POST /api/v1/auth/login queues `mail.send` in the transaction that creates the session, and the worker's
// consumer sends it through the mail port. The failure scenarios: an alert for a sign-in from a device
// the account already uses, none for a new one, a second one for one sign-in, and a message or a job that
// carries a full address or a token.

const SESSION_COOKIE = "__Host-slugbase_session";
const LOGIN = "/api/v1/auth/login";
const ME = "/api/v1/me";
const POLL_SECONDS = 0.5;
const WAIT_MS = 20_000;
const SETTLE_MS = 1_500;
const TEST_TIMEOUT_MS = 40_000;

const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";
const FIREFOX_LATER = "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0";
const CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const database = useTestDatabase();
let store: AuthStore;
let worker: RunningWorker | undefined;
const inbox = new InMemoryMail();
const mailPort: MailPort = { available: true, send: (message) => inbox.send(message) };

beforeAll(async () => {
  store = storeFor(database());
  await runMigrations({ url: urlOf(database().owner) });
  const config = loadConfig("worker", { ...productionEnv(), NODE_ENV: "test", DATABASE_URL: appUrl(database()) }).config;
  worker = await createWorker({
    config,
    adapters: { ...adapters(), mail: mailPort },
    modules: [],
    logger: recordingLogger(),
    database: tenantDatabase(database()),
    pollingIntervalSeconds: POLL_SECONDS,
    shutdownTimeoutMs: 500,
  }).start();
}, 120_000);

afterAll(async () => {
  await worker?.shutdown();
  await store.close();
}, 30_000);

function serve(mail: MailPort = mailPort): { server: Server; origin: string } {
  const config = serverConfig({
    NODE_ENV: "test",
    DATABASE_URL: appUrl(database()),
    TRUSTED_PROXY_HOPS: "1",
    RATE_LIMIT_LOGIN_IP: "1000/min",
    RATE_LIMIT_LOGIN_EMAIL: "1000/hour",
  });
  const server = createServer({
    config,
    adapters: { ...adapters(config), mail, tenantResolver: createAccountOnlyTenantResolver() },
    modules: [],
    migrations: [],
    logger: recordingLogger(),
    database: tenantDatabase(database()),
    authStore: store,
  });
  return { server, origin: config.APP_ORIGIN };
}

interface Device {
  readonly userAgent: string;
  readonly address: string;
}

function login(world: { server: Server; origin: string }, account: SeededAccount, device: Device, password = account.password): Promise<Response> {
  return world.server.fetch(
    new Request(new URL(LOGIN, world.origin), {
      method: "POST",
      headers: { origin: world.origin, "content-type": "application/json", "user-agent": device.userAgent, "x-forwarded-for": device.address },
      body: JSON.stringify({ email: account.email, password, remember: false }),
    }),
  );
}

async function signIn(world: { server: Server; origin: string }, account: SeededAccount, device: Device): Promise<string> {
  const response = await login(world, account, device);
  const token = new RegExp(`^${SESSION_COOKIE}=([A-Za-z0-9_-]{43});`).exec(response.headers.get("set-cookie") ?? "")?.[1];
  if (response.status !== 200 || token === undefined) {
    throw new Error(`could not sign in: ${String(response.status)}`);
  }
  return token;
}

function patchMe(world: { server: Server; origin: string }, token: string, body: unknown): Promise<Response> {
  return world.server.fetch(
    new Request(new URL(ME, world.origin), {
      method: "PATCH",
      headers: { origin: world.origin, "content-type": "application/json", cookie: `${SESSION_COOKIE}=${token}` },
      body: JSON.stringify(body),
    }),
  );
}

async function setLocale(accountId: string, locale: "en" | "de"): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${accountId}, true)`;
    await tx`UPDATE accounts SET locale = ${locale} WHERE id = ${accountId}`;
  });
}

interface JobRow {
  readonly state: string;
  readonly data: Record<string, unknown>;
}

async function alertJobs(accountId: string): Promise<JobRow[]> {
  const rows = await database().app<JobRow[]>`
    SELECT state, data FROM pgboss.job WHERE name = 'mail.send' AND data->>'accountId' = ${accountId} AND data->>'template' = 'newSignIn' ORDER BY created_on`;
  return [...rows];
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(50);
  }
}

const sentTo = (account: SeededAccount) => inbox.sent.filter((message) => message.to === account.email);

const LAPTOP: Device = { userAgent: FIREFOX, address: "203.0.113.57" };

describe("POST /api/v1/auth/login and the new sign-in email", { timeout: TEST_TIMEOUT_MS }, () => {
  it("sends nothing for the first session of an account", async () => {
    const world = serve();
    const account = await seedAccount(database());
    await signIn(world, account, LAPTOP);
    expect(await alertJobs(account.id)).toEqual([]);
    await sleep(SETTLE_MS);
    expect(sentTo(account)).toEqual([]);
  });

  it("sends nothing for a sign-in from a device the account is already signed in from, however its address or version differs inside the prefix", async () => {
    const world = serve();
    const account = await seedAccount(database());
    await signIn(world, account, LAPTOP);
    await signIn(world, account, LAPTOP);
    await signIn(world, account, { userAgent: FIREFOX_LATER, address: "203.0.113.200" });
    expect(await alertJobs(account.id)).toEqual([]);
    await sleep(SETTLE_MS);
    expect(sentTo(account)).toEqual([]);
  });

  it("sends exactly one mail for a sign-in from a new browser, with the time, the browser and the network prefix and no full address or token", async () => {
    const world = serve();
    const account = await seedAccount(database());
    await signIn(world, account, LAPTOP);
    const before = Date.now();

    const token = await signIn(world, account, { userAgent: CHROME, address: "203.0.113.58" });

    const jobs = await alertJobs(account.id);
    expect(jobs).toHaveLength(1);
    // The job carries the template, the account, the time, the browser family and the coarse prefix; the address, the name and any body stay out of the queue.
    expect(jobs[0]?.data).toEqual({ template: "newSignIn", accountId: account.id, signedInAt: expect.any(String) as string, browser: "Chrome", network: "203.0.0.0/16" });
    await until(() => sentTo(account).length > 0, "the alert to reach the mail port");
    await sleep(SETTLE_MS);
    const sent = sentTo(account);
    expect(sent).toHaveLength(1);
    const [message] = sent;
    expect(message).toMatchObject({ template: "newSignIn", to: account.email, locale: "en" });
    expect(message?.data).toEqual({
      displayName: "Test account",
      signedInAt: expect.any(String) as string,
      browser: "Chrome",
      network: "203.0.0.0/16",
    });
    expect(Math.abs(Date.parse(String(message?.data["signedInAt"])) - before)).toBeLessThan(60_000);

    const everything = JSON.stringify([jobs, message]);
    for (const secret of ["203.0.113.58", "203.0.113.57", token, CHROME]) {
      expect(everything, secret).not.toContain(secret);
    }
  });

  it("sends exactly one mail for a sign-in from the same browser on another network", async () => {
    const world = serve();
    const account = await seedAccount(database());
    await signIn(world, account, LAPTOP);
    await signIn(world, account, { userAgent: FIREFOX, address: "198.51.100.9" });
    expect(await alertJobs(account.id)).toHaveLength(1);
    await until(() => sentTo(account).length > 0, "the alert to reach the mail port");
    await sleep(SETTLE_MS);
    expect(sentTo(account)).toHaveLength(1);
    expect(sentTo(account)[0]?.data["network"]).toBe("198.51.0.0/16");
  });

  it("writes the mail in the account's language", async () => {
    const world = serve();
    const account = await seedAccount(database());
    await setLocale(account.id, "de");
    await signIn(world, account, LAPTOP);
    await signIn(world, account, { userAgent: CHROME, address: "203.0.113.57" });
    await until(() => sentTo(account).length > 0, "the alert to reach the mail port");
    expect(sentTo(account)[0]).toMatchObject({ template: "newSignIn", locale: "de" });
  });

  it("sends nothing once the account turned the alerts off, and again after they are turned on", async () => {
    const world = serve();
    const account = await seedAccount(database());
    const token = await signIn(world, account, LAPTOP);
    expect((await patchMe(world, token, { signinAlerts: false })).status).toBe(200);

    await signIn(world, account, { userAgent: CHROME, address: "203.0.113.57" });
    expect(await alertJobs(account.id)).toEqual([]);

    expect((await patchMe(world, token, { signinAlerts: true })).status).toBe(200);
    await signIn(world, account, { userAgent: "Mozilla/5.0 Edg/130.0 Safari/537.36 Chrome/130.0", address: "203.0.113.57" });
    expect(await alertJobs(account.id)).toHaveLength(1);
  });

  it("queues nothing for a refused sign-in", async () => {
    const world = serve();
    const account = await seedAccount(database());
    await signIn(world, account, LAPTOP);
    expect((await login(world, account, { userAgent: CHROME, address: "198.51.100.9" }, "not the password")).status).toBe(401);
    expect(await alertJobs(account.id)).toEqual([]);
  });

  it("queues nothing when the mail port cannot send", async () => {
    const world = serve({ available: false, send: () => Promise.reject(new Error("mail_unavailable")) });
    const account = await seedAccount(database());
    await signIn(world, account, LAPTOP);
    await signIn(world, account, { userAgent: CHROME, address: "198.51.100.9" });
    expect(await alertJobs(account.id)).toEqual([]);
  });
});
