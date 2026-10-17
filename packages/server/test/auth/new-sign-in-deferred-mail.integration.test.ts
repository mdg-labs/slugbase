import { setTimeout as sleep } from "node:timers/promises";
import type { MailPort } from "@slugbase/core";
import type { AuthStore } from "@slugbase/db";
import { InMemoryMail } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAccountOnlyTenantResolver } from "../../src/auth/tenant-resolver.ts";
import { loadConfig } from "../../src/config/index.ts";
import { createServer, type Server } from "../../src/create-server.ts";
import { runMigrations } from "../../src/migrate/index.ts";
import { createWorker } from "../../src/worker/index.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { productionEnv } from "../config/support.ts";
import { urlOf } from "../migrate/support.ts";
import { adapters, recordingLogger, serverConfig } from "../support.ts";
import { seedAccount, sessionRows, storeFor, type SeededAccount } from "./support.ts";

// The "new sign-in" email is decided when the sign-in happens (doc 02 section 12, doc 05 section 2.10): an
// alert queued while the switch was on is sent whatever the account, or someone with its password, does
// before the worker runs. The failure scenario: a sign-in from a new device that ends its own session, or
// turns the alerts off, and so stops the mail about it. The worker starts only after those requests.

const SESSION_COOKIE = "__Host-slugbase_session";
const LOGIN = "/api/v1/auth/login";
const LOGOUT = "/api/v1/auth/logout";
const ME = "/api/v1/me";
const POLL_SECONDS = 0.5;
const WAIT_MS = 20_000;
const SETTLE_MS = 1_500;
const TEST_TIMEOUT_MS = 60_000;

const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";
const CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const database = useTestDatabase();
let store: AuthStore;
const inbox = new InMemoryMail();
const mailPort: MailPort = { available: true, send: (message) => inbox.send(message) };

beforeAll(async () => {
  store = storeFor(database());
  await runMigrations({ url: urlOf(database().owner) });
}, 120_000);

afterAll(async () => {
  await store.close();
}, 30_000);

interface World {
  readonly server: Server;
  readonly origin: string;
}

function serve(): World {
  const config = serverConfig({
    NODE_ENV: "test",
    DATABASE_URL: appUrl(database()),
    TRUSTED_PROXY_HOPS: "1",
    RATE_LIMIT_LOGIN_IP: "1000/min",
    RATE_LIMIT_LOGIN_EMAIL: "1000/hour",
  });
  const server = createServer({
    config,
    adapters: { ...adapters(config), mail: mailPort, tenantResolver: createAccountOnlyTenantResolver() },
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

const LAPTOP: Device = { userAgent: FIREFOX, address: "203.0.113.57" };
const PHONE: Device = { userAgent: CHROME, address: "198.51.100.9" };

function send(world: World, method: string, path: string, device: Device, token: string | null, body?: unknown): Promise<Response> {
  const headers = new Headers({ origin: world.origin, "content-type": "application/json", "user-agent": device.userAgent, "x-forwarded-for": device.address });
  if (token !== null) {
    headers.set("cookie", `${SESSION_COOKIE}=${token}`);
  }
  return world.server.fetch(new Request(new URL(path, world.origin), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
}

async function signIn(world: World, account: SeededAccount, device: Device): Promise<string> {
  const response = await send(world, "POST", LOGIN, device, null, { email: account.email, password: account.password, remember: false });
  const token = new RegExp(`^${SESSION_COOKIE}=([A-Za-z0-9_-]{43});`).exec(response.headers.get("set-cookie") ?? "")?.[1];
  if (response.status !== 200 || token === undefined) {
    throw new Error(`could not sign in: ${String(response.status)}`);
  }
  return token;
}

async function alertJobs(accountId: string): Promise<{ state: string }[]> {
  const rows = await database().app<{ state: string }[]>`
    SELECT state FROM pgboss.job WHERE name = 'mail.send' AND data->>'accountId' = ${accountId} AND data->>'template' = 'newSignIn'`;
  return [...rows];
}

const alertsTo = (account: SeededAccount) => inbox.sent.filter((message) => message.to === account.email && message.template === "newSignIn");

/** Runs the worker until the account's alert has been sent and a moment more, then stops it. */
async function runWorkerUntilSent(account: SeededAccount): Promise<void> {
  const config = loadConfig("worker", { ...productionEnv(), NODE_ENV: "test", DATABASE_URL: appUrl(database()) }).config;
  const worker = await createWorker({
    config,
    adapters: { ...adapters(), mail: mailPort },
    modules: [],
    logger: recordingLogger(),
    database: tenantDatabase(database()),
    pollingIntervalSeconds: POLL_SECONDS,
    shutdownTimeoutMs: 500,
  }).start();
  try {
    const deadline = Date.now() + WAIT_MS;
    while (alertsTo(account).length === 0 && Date.now() < deadline) {
      await sleep(50);
    }
    await sleep(SETTLE_MS);
  } finally {
    await worker.shutdown();
  }
}

describe("the new sign-in email when the session or the switch changes before the worker runs", { timeout: TEST_TIMEOUT_MS }, () => {
  it("sends exactly one mail although the new session logged out before the worker ran", async () => {
    const world = serve();
    const account = await seedAccount(database());
    await signIn(world, account, LAPTOP);
    const token = await signIn(world, account, PHONE);
    expect(await alertJobs(account.id)).toHaveLength(1);

    expect((await send(world, "POST", LOGOUT, PHONE, token)).status).toBe(204);
    expect(await sessionRows(database(), account.id)).toHaveLength(1);

    await runWorkerUntilSent(account);
    expect(alertsTo(account)).toHaveLength(1);
    expect(alertsTo(account)[0]?.data).toMatchObject({ browser: "Chrome", network: "198.51.0.0/16" });
  });

  it("sends exactly one mail although the new session turned the alerts off before the worker ran", async () => {
    const world = serve();
    const account = await seedAccount(database());
    await signIn(world, account, LAPTOP);
    const token = await signIn(world, account, PHONE);
    expect(await alertJobs(account.id)).toHaveLength(1);

    expect((await send(world, "PATCH", ME, PHONE, token, { signinAlerts: false })).status).toBe(200);

    await runWorkerUntilSent(account);
    expect(alertsTo(account)).toHaveLength(1);
  });
});
