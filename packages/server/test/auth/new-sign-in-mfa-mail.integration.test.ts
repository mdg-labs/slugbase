import { setTimeout as sleep } from "node:timers/promises";
import { totpCode, totpStep, type MailPort } from "@slugbase/core";
import type { AuthStore } from "@slugbase/db";
import { FixedClock, InMemoryMail } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mfaSecretOptions } from "../../src/auth/mfa.ts";
import { createAccountOnlyTenantResolver } from "../../src/auth/tenant-resolver.ts";
import { loadConfig } from "../../src/config/index.ts";
import { createServer, type Server } from "../../src/create-server.ts";
import { runMigrations } from "../../src/migrate/index.ts";
import { createWorker } from "../../src/worker/index.ts";
import type { RunningWorker } from "../../src/worker/index.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { productionEnv } from "../config/support.ts";
import { urlOf } from "../migrate/support.ts";
import { testKey, testSecretBox } from "../secret-box.ts";
import { adapters, recordingLogger, serverConfig } from "../support.ts";
import { seedAccount, storeFor, type SeededAccount } from "./support.ts";

// The "new sign-in" email for an account whose second factor is on (doc 02 section 12, doc 04 section
// 4.3): the password step makes a partial session and queues nothing; the code that completes the
// sign-in queues the email in the same transaction, once, for a device the account has not signed in
// from and not for one it has. The failure scenarios: no alert for any account with a second factor, an
// alert for the half-finished sign-in, a second one for one sign-in, and a message or a job that carries
// a full address, a token or a code.

const SESSION_COOKIE = "__Host-slugbase_session";
const LOGIN = "/api/v1/auth/login";
const VERIFY = "/api/v1/auth/mfa/verify";
const START = "/api/v1/me/mfa/enrollment";
const CONFIRM = "/api/v1/me/mfa/enrollment/confirm";
const REAUTH = "/api/v1/me/reauth";
const POLL_SECONDS = 0.5;
const WAIT_MS = 20_000;
const SETTLE_MS = 1_500;
const TEST_TIMEOUT_MS = 40_000;
const STEP_MS = 30_000;
// The server's clock leads the database's a little, so a time the database stamps during the test (the re-authentication) is never ahead of it.
const CLOCK_LEAD_MS = 10_000;

const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";
const CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const database = useTestDatabase();
let store: AuthStore;
let worker: RunningWorker | undefined;
const inbox = new InMemoryMail();
const mailPort: MailPort = { available: true, send: (message) => inbox.send(message) };
const keys = [testKey("key-1")] as const;

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

interface World {
  readonly server: Server;
  readonly origin: string;
  readonly clock: FixedClock;
}

function serve(): World {
  const clock = new FixedClock(Date.now() + CLOCK_LEAD_MS);
  const config = serverConfig({
    NODE_ENV: "test",
    DATABASE_URL: appUrl(database()),
    TRUSTED_PROXY_HOPS: "1",
    RATE_LIMIT_LOGIN_IP: "1000/min",
    RATE_LIMIT_LOGIN_EMAIL: "1000/hour",
    RATE_LIMIT_MFA_IP: "1000/min",
    RATE_LIMIT_MFA_ACCOUNT: "1000/hour",
  });
  const server = createServer({
    config,
    adapters: { ...adapters(config), mail: mailPort, tenantResolver: createAccountOnlyTenantResolver(), secretBox: testSecretBox(...keys) },
    modules: [],
    migrations: [],
    logger: recordingLogger(),
    database: tenantDatabase(database()),
    authStore: store,
    now: () => clock.now().getTime(),
  });
  return { server, origin: config.APP_ORIGIN, clock };
}

interface Device {
  readonly userAgent: string;
  readonly address: string;
}

const LAPTOP: Device = { userAgent: FIREFOX, address: "203.0.113.57" };

function post(world: World, path: string, device: Device, token: string | null, body?: unknown): Promise<Response> {
  const headers = new Headers({
    origin: world.origin,
    "content-type": "application/json",
    "user-agent": device.userAgent,
    "x-forwarded-for": device.address,
  });
  if (token !== null) {
    headers.set("cookie", `${SESSION_COOKIE}=${token}`);
  }
  return world.server.fetch(new Request(new URL(path, world.origin), { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) }));
}

function tokenOf(response: Response): string | undefined {
  return new RegExp(`^${SESSION_COOKIE}=([A-Za-z0-9_-]{43});`).exec(response.headers.get("set-cookie") ?? "")?.[1];
}

async function codeFor(world: World, accountId: string): Promise<string> {
  const state = await store.mfaStateOf(accountId);
  if (state === undefined) {
    throw new Error("the account has no secret");
  }
  const secret = await testSecretBox(...keys).open(state.secret, mfaSecretOptions(accountId));
  world.clock.advance(STEP_MS);
  return totpCode(secret, totpStep(world.clock.now().getTime()));
}

interface Enrolled {
  readonly account: SeededAccount;
  readonly backupCodes: readonly string[];
}

/** An account signed in from the laptop and enrolled through the product's own operations, so the laptop keeps a live full session. */
async function enrol(world: World): Promise<Enrolled> {
  const account = await seedAccount(database());
  const signedIn = await post(world, LOGIN, LAPTOP, null, { email: account.email, password: account.password, remember: false });
  const token = tokenOf(signedIn);
  if (signedIn.status !== 200 || token === undefined) {
    throw new Error(`could not sign in: ${String(signedIn.status)}`);
  }
  expect((await post(world, REAUTH, LAPTOP, token, { password: account.password })).status).toBe(204);
  expect((await post(world, START, LAPTOP, token)).status).toBe(200);
  const confirmed = await post(world, CONFIRM, LAPTOP, token, { code: await codeFor(world, account.id) });
  expect(confirmed.status).toBe(200);
  const { backupCodes } = (await confirmed.json()) as { backupCodes: string[] };
  return { account, backupCodes };
}

async function startSignIn(world: World, account: SeededAccount, device: Device): Promise<string> {
  const response = await post(world, LOGIN, device, null, { email: account.email, password: account.password, remember: false });
  const token = tokenOf(response);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ next: "mfa" });
  if (token === undefined) {
    throw new Error("the sign-in set no cookie");
  }
  return token;
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

const alertsTo = (account: SeededAccount) => inbox.sent.filter((message) => message.to === account.email && message.template === "newSignIn");

describe("POST /api/v1/auth/mfa/verify and the new sign-in email", { timeout: TEST_TIMEOUT_MS }, () => {
  it("sends nothing at the password step, whatever the device", async () => {
    const world = serve();
    const { account } = await enrol(world);
    await startSignIn(world, account, { userAgent: CHROME, address: "198.51.100.9" });
    expect(await alertJobs(account.id)).toEqual([]);
    await sleep(SETTLE_MS);
    expect(alertsTo(account)).toEqual([]);
  });

  it("sends exactly one mail once a code from a new device completes the sign-in, with no full address, token or code", async () => {
    const world = serve();
    const { account } = await enrol(world);
    const newDevice: Device = { userAgent: CHROME, address: "198.51.100.9" };
    const pending = await startSignIn(world, account, newDevice);
    const code = await codeFor(world, account.id);
    const before = world.clock.now().getTime();

    const verified = await post(world, VERIFY, newDevice, pending, { code });
    const token = tokenOf(verified);
    expect(verified.status).toBe(200);

    const jobs = await alertJobs(account.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toEqual({
      template: "newSignIn",
      accountId: account.id,
      signedInAt: expect.any(String) as string,
      browser: "Chrome",
      network: "198.51.0.0/16",
    });
    await until(() => alertsTo(account).length > 0, "the alert to reach the mail port");
    await sleep(SETTLE_MS);
    const sent = alertsTo(account);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.data).toMatchObject({ browser: "Chrome", network: "198.51.0.0/16" });
    expect(sent[0]?.data["signedInAt"]).toBe(new Date(before).toISOString());

    const everything = JSON.stringify([jobs, sent]);
    for (const secret of ["198.51.100.9", "203.0.113.57", CHROME, code, token ?? "no token"]) {
      expect(everything, secret).not.toContain(secret);
    }
  });

  it("sends exactly one mail for a backup code from a new device", async () => {
    const world = serve();
    const { account, backupCodes } = await enrol(world);
    const newDevice: Device = { userAgent: CHROME, address: "198.51.100.9" };
    const pending = await startSignIn(world, account, newDevice);
    expect((await post(world, VERIFY, newDevice, pending, { backupCode: backupCodes[0] })).status).toBe(200);
    await until(() => alertsTo(account).length > 0, "the alert to reach the mail port");
    await sleep(SETTLE_MS);
    expect(await alertJobs(account.id)).toHaveLength(1);
    expect(alertsTo(account)).toHaveLength(1);
  });

  it("sends nothing for a code from a device the account is already signed in from", async () => {
    const world = serve();
    const { account } = await enrol(world);
    const pending = await startSignIn(world, account, { userAgent: FIREFOX, address: "203.0.113.200" });
    expect((await post(world, VERIFY, LAPTOP, pending, { code: await codeFor(world, account.id) })).status).toBe(200);
    expect(await alertJobs(account.id)).toEqual([]);
    await sleep(SETTLE_MS);
    expect(alertsTo(account)).toEqual([]);
  });

  it("sends nothing for a wrong code, and then one mail for the right one", async () => {
    const world = serve();
    const { account } = await enrol(world);
    const newDevice: Device = { userAgent: CHROME, address: "198.51.100.9" };
    const pending = await startSignIn(world, account, newDevice);
    expect((await post(world, VERIFY, newDevice, pending, { code: "000000" })).status).toBe(422);
    expect(await alertJobs(account.id)).toEqual([]);
    expect((await post(world, VERIFY, newDevice, pending, { code: await codeFor(world, account.id) })).status).toBe(200);
    expect(await alertJobs(account.id)).toHaveLength(1);
  });
});
