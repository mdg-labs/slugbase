import { setTimeout as sleep } from "node:timers/promises";
import { InMemoryMail } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import type { MailPort } from "@slugbase/core";
import type { AuthStore } from "@slugbase/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createAccountOnlyTenantResolver } from "../../src/auth/tenant-resolver.ts";
import { loadConfig } from "../../src/config/index.ts";
import { createServer, type Server } from "../../src/create-server.ts";
import { runMigrations } from "../../src/migrate/index.ts";
import { createWorker, type RunningWorker } from "../../src/worker/index.ts";
import { seedAccount, seedMembership, seedWorkspace, sessionRows, setActiveWorkspace, storeFor, type SeededAccount } from "../auth/support.ts";
import { productionEnv } from "../config/support.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { urlOf } from "../migrate/support.ts";
import { adapters, recordingLogger, serverConfig } from "../support.ts";

// The "ownership transferred to you" email through the whole path (doc 02 section 12, doc 01 section 8.1, doc 04
// section 10.4): POST /api/v1/workspace/transfer-ownership queues `mail.send` in the transaction of the transfer
// and the worker sends it to the recipient, in the recipient's language, naming the workspace and the owner as
// they are when the message is sent. The failure scenarios: a message for a transfer that was not committed or
// to an account that no longer is an owner, a message in the wrong language or to the wrong address, and a name
// or an address in the queued payload.

const SESSION_COOKIE = "__Host-slugbase_session";
const REAUTH = "/api/v1/me/reauth";
const TRANSFER = "/api/v1/workspace/transfer-ownership";
const POLL_SECONDS = 0.5;
const WAIT_MS = 20_000;
const TEST_TIMEOUT_MS = 60_000;

const database = useTestDatabase();
let store: AuthStore;
const inbox = new InMemoryMail();
const mail: MailPort = { available: true, send: (message) => inbox.send(message) };
let worker: RunningWorker | undefined;

beforeAll(async () => {
  store = storeFor(database());
  await runMigrations({ url: urlOf(database().owner) });
}, 120_000);

afterEach(async () => {
  await worker?.shutdown();
  worker = undefined;
  inbox.clear();
});

afterAll(async () => {
  await store.close();
}, 30_000);

function serve(): { server: Server; origin: string } {
  const config = serverConfig({
    NODE_ENV: "test",
    DATABASE_URL: appUrl(database()),
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

function request(world: { server: Server; origin: string }, path: string, cookie: string, body: unknown): Promise<Response> {
  return world.server.fetch(
    new Request(new URL(path, world.origin), { method: "POST", headers: { origin: world.origin, "content-type": "application/json", cookie }, body: JSON.stringify(body) }),
  );
}

async function signedIn(world: { server: Server; origin: string }, account: SeededAccount): Promise<string> {
  const response = await request(world, "/api/v1/auth/login", "", { email: account.email, password: account.password, remember: false });
  const token = new RegExp(`^${SESSION_COOKIE}=([A-Za-z0-9_-]{43});`).exec(response.headers.get("set-cookie") ?? "")?.[1];
  if (response.status !== 200 || token === undefined) {
    throw new Error(`could not sign in: ${String(response.status)}`);
  }
  const cookie = `${SESSION_COOKIE}=${token}`;
  expect((await request(world, REAUTH, cookie, { password: account.password })).status).toBe(204);
  return cookie;
}

interface Pair {
  readonly workspaceId: string;
  readonly owner: SeededAccount;
  readonly recipient: SeededAccount;
  readonly cookie: string;
}

/** A workspace named `name` with an owner called `ownerName` and a plain member whose language is `locale`. */
async function pair(world: { server: Server; origin: string }, name: string, ownerName: string, locale: "en" | "de"): Promise<Pair> {
  const workspaceId = await seedWorkspace(database(), { name });
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`INSERT INTO workspace_settings (workspace_id) VALUES (${workspaceId})`;
  });
  const owner = await seedAccount(database(), { emailVerified: true });
  const recipient = await seedAccount(database(), { emailVerified: true });
  await database().owner.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${owner.id}, true)`;
    await tx`UPDATE accounts SET display_name = ${ownerName} WHERE id = ${owner.id}`;
  });
  await database().owner.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${recipient.id}, true)`;
    await tx`UPDATE accounts SET display_name = 'Grace Hopper', locale = ${locale} WHERE id = ${recipient.id}`;
  });
  await seedMembership(database(), { workspaceId, accountId: owner.id, role: "owner" });
  await seedMembership(database(), { workspaceId, accountId: recipient.id, role: "member" });
  const cookie = await signedIn(world, owner);
  for (const session of await sessionRows(database(), owner.id)) {
    await setActiveWorkspace(database(), session.id, workspaceId);
  }
  return { workspaceId, owner, recipient, cookie };
}

interface JobRow {
  readonly id: string;
  readonly state: string;
  readonly data: Record<string, unknown>;
}

async function jobsFor(accountId: string): Promise<JobRow[]> {
  return [...(await database().app<JobRow[]>`SELECT id, state, data FROM pgboss.job WHERE name = 'mail.send' AND data->>'accountId' = ${accountId} ORDER BY created_on`)];
}

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(50);
  }
}

describe("the ownership transferred email", { timeout: TEST_TIMEOUT_MS }, () => {
  it("is sent to the new owner in their language, naming the workspace and the owner who made the change, from a payload that holds identifiers only", async () => {
    const world = serve();
    const { workspaceId, owner, recipient, cookie } = await pair(world, "Compilers", "Ada Lovelace", "de");

    expect((await request(world, TRANSFER, cookie, { accountId: recipient.id, demoteSelf: false })).status).toBe(200);
    const queued = await jobsFor(recipient.id);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.data).toEqual({ template: "ownershipTransferred", accountId: recipient.id, workspaceId, fromAccountId: owner.id });
    await startWorker();
    await until(() => inbox.sent.length === 1, "the message to reach the mail port");

    expect(inbox.sent).toEqual([
      {
        template: "ownershipTransferred",
        to: recipient.email,
        locale: "de",
        data: { displayName: "Grace Hopper", workspaceName: "Compilers", transferredBy: "Ada Lovelace" },
      },
    ]);
  });

  it("is not sent once the recipient is no owner of the workspace any more, and the job still ends", async () => {
    const world = serve();
    const { workspaceId, recipient, cookie } = await pair(world, "Compilers", "Ada Lovelace", "en");
    expect((await request(world, TRANSFER, cookie, { accountId: recipient.id, demoteSelf: false })).status).toBe(200);
    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`UPDATE workspace_members SET role = 'member' WHERE workspace_id = ${workspaceId} AND account_id = ${recipient.id}`;
    });

    await startWorker();
    await until(async () => (await jobsFor(recipient.id)).every((job) => job.state === "completed"), "the job to end");

    expect(inbox.sent).toEqual([]);
  });

  it("is not queued for a transfer the request refused", async () => {
    const world = serve();
    const { recipient, cookie } = await pair(world, "Compilers", "Ada Lovelace", "en");

    const response = await request(world, TRANSFER, cookie, { accountId: "0192f3a0-ffff-7000-8000-000000000001", demoteSelf: false });

    expect(response.status).toBe(404);
    expect(await jobsFor(recipient.id)).toEqual([]);
  });
});
