import { setTimeout as sleep } from "node:timers/promises";
import type { AnyDomainEvent } from "@slugbase/core";
import type { AuthStore } from "@slugbase/db";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashSetupToken } from "../src/auth/setup-token.ts";
import { createAccountOnlyTenantResolver } from "../src/auth/tenant-resolver.ts";
import { loadConfig } from "../src/config/index.ts";
import { createServer, type RunningServer, type Server, type ServerModule } from "../src/create-server.ts";
import { runMigrations } from "../src/migrate/index.ts";
import { createWorker, type RunningWorker } from "../src/worker/index.ts";
import { storeFor } from "./auth/support.ts";
import { productionEnv } from "./config/support.ts";
import { appUrl, tenantDatabase } from "./contract/support.ts";
import { urlOf } from "./migrate/support.ts";
import { adapters, recordingLogger, serverConfig } from "./support.ts";

// The account.created event of first-run setup through the whole path (doc 01 section 7.1 and 8.1):
// POST /setup queues `event.account.created` in the setup's own transaction, and the worker hands
// it to the subscribers of the composed modules. The failure scenarios: an event for a setup that
// did not commit, a setup committed without its event, a request that waits for a subscriber or
// fails with it, and an email address in the queue, the logs or the error reports.

const SETUP = "/api/v1/setup";
const QUEUE = "event.account.created";
const POLL_SECONDS = 0.5;
const WAIT_MS = 20_000;
const HOOK_TIMEOUT_MS = 120_000;
const EMAIL = "first.admin@example.test";
const BODY = { displayName: "First Admin", email: EMAIL, password: "a long enough password", workspaceName: "Home" };

const database = useTestDatabase();
let store: AuthStore;
const servers: RunningServer[] = [];
let worker: RunningWorker | undefined;

beforeAll(async () => {
  store = storeFor(database());
  await runMigrations({ url: urlOf(database().owner) });
}, HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await database().owner`TRUNCATE accounts, workspaces, instance_state CASCADE`;
  await database().owner`DELETE FROM pgboss.job WHERE name = ${QUEUE}`;
});

afterEach(async () => {
  await worker?.shutdown();
  worker = undefined;
  await Promise.all(servers.splice(0).map((running) => running.shutdown()));
});

afterAll(async () => {
  await store.close();
}, 30_000);

function serve(authStore: AuthStore = store, env: Record<string, string> = {}): { server: Server; origin: string } {
  const config = serverConfig({ NODE_ENV: "test", DATABASE_URL: appUrl(database()), RATE_LIMIT_SETUP_IP: "1000/hour", SETUP_TOKEN_REQUIRED: "false", ...env });
  const server = createServer({
    config,
    adapters: { ...adapters(config), tenantResolver: createAccountOnlyTenantResolver() },
    modules: [],
    migrations: [],
    logger: recordingLogger(),
    database: tenantDatabase(database()),
    authStore,
  });
  return { server, origin: config.APP_ORIGIN };
}

function setup(world: { server: Server; origin: string }, body: unknown = BODY): Promise<Response> {
  return world.server.fetch(
    new Request(new URL(SETUP, world.origin), {
      method: "POST",
      headers: { origin: world.origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

interface JobRow {
  readonly id: string;
  readonly state: string;
  readonly data: Record<string, unknown>;
}

async function eventJobs(): Promise<JobRow[]> {
  return database().app<JobRow[]>`SELECT id, state, data FROM pgboss.job WHERE name = ${QUEUE} ORDER BY created_on`;
}

async function accountIds(): Promise<string[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ id: string }[]>`SELECT id FROM accounts`;
  });
  return rows.map((row) => row.id);
}

const workerLogs = recordingLogger();
const captured: { error: unknown; route: string | undefined }[] = [];

async function startWorker(modules: ServerModule[]): Promise<void> {
  const config = loadConfig("worker", { ...productionEnv(), NODE_ENV: "test", DATABASE_URL: appUrl(database()) }).config;
  worker = await createWorker({
    config,
    adapters: {
      ...adapters(),
      errors: {
        available: true,
        capture: (error, context) => {
          captured.push({ error, route: context?.route });
          return Promise.resolve();
        },
      },
    },
    modules,
    logger: workerLogs,
    database: tenantDatabase(database()),
    pollingIntervalSeconds: POLL_SECONDS,
    shutdownTimeoutMs: 500,
  }).start();
}

async function until(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(50);
  }
}

describe("POST /api/v1/setup", { timeout: 40_000 }, () => {
  it("queues exactly one account.created job in the transaction that creates the account, with no email address in it", async () => {
    const response = await setup(serve());

    expect(response.status).toBe(201);
    const [account] = await accountIds();
    const jobs = await eventJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.state).toBe("created");
    expect(jobs[0]?.data).toEqual({ eventId: jobs[0]?.id, accountId: account, path: "setup" });
    expect(JSON.stringify(jobs)).not.toContain(EMAIL);
  });

  it("queues nothing when setup is already completed", async () => {
    const world = serve();
    expect((await setup(world)).status).toBe(201);
    const [first] = await eventJobs();

    const again = await setup(world, { ...BODY, email: "second@example.test" });

    expect(again.status).toBe(403);
    expect(((await again.json()) as { code: string }).code).toBe("setup_completed");
    expect((await eventJobs()).map((job) => job.id)).toEqual([first?.id]);
  });

  it("queues nothing for a wrong setup token", async () => {
    await store.setSetupToken(hashSetupToken("the right token"));
    const world = serve(store, { SETUP_TOKEN_REQUIRED: "true" });

    const response = await setup(world, { ...BODY, setupToken: "the wrong token" });

    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("forbidden");
    expect(await eventJobs()).toEqual([]);
    expect(await accountIds()).toEqual([]);
  });

  it("creates no account and queues no event when the event cannot be queued", async () => {
    const broken: AuthStore = {
      ...store,
      completeSetup: (request) =>
        store.completeSetup({ ...request, jobs: (request.jobs ?? []).map((job) => ({ ...job, queue: "event.missing.queue" })) }),
    };
    const world = serve(broken);

    const response = await setup(world);

    expect(response.status).toBe(500);
    expect(await accountIds()).toEqual([]);
    expect(await eventJobs()).toEqual([]);
    expect(await store.setupPending()).toBe(true);
    // The instance is not stuck: the same request succeeds once the event can be queued.
    expect((await setup(serve())).status).toBe(201);
    expect(await eventJobs()).toHaveLength(1);
  });
});

describe("the worker", { timeout: 60_000 }, () => {
  it("delivers account.created to the subscriber of a composed module, with the identifier of the queued job", async () => {
    const received: AnyDomainEvent[] = [];
    await startWorker([
      {
        name: "listener",
        register: () => ({
          subscribers: [
            {
              event: "account.created",
              handle: (event) => {
                received.push(event);
              },
            },
          ],
        }),
      },
    ]);

    expect((await setup(serve())).status).toBe(201);

    await until(() => received.length > 0, "the subscriber to receive the event");
    const [account] = await accountIds();
    const [job] = await eventJobs();
    expect(received).toEqual([{ eventId: job?.id, name: "account.created", payload: { accountId: account, path: "setup" } }]);
    await until(async () => (await eventJobs())[0]?.state === "completed", "the job to complete");
  });

  it("completes the job when no module subscribes", async () => {
    await startWorker([]);

    expect((await setup(serve())).status).toBe(201);

    await until(async () => (await eventJobs())[0]?.state === "completed", "the job to complete");
  });

  it("keeps a failing subscriber away from the request, retries the job, and leaves the address out of the logs and reports", async () => {
    const delivered: string[] = [];
    captured.length = 0;
    await startWorker([
      {
        name: "broken",
        register: () => ({
          subscribers: [
            {
              event: "account.created",
              handle: () => {
                throw new Error(`could not record ${EMAIL}`);
              },
            },
          ],
        }),
      },
      {
        name: "fine",
        register: () => ({
          subscribers: [
            {
              event: "account.created",
              handle: (event) => {
                delivered.push(event.eventId);
              },
            },
          ],
        }),
      },
    ]);

    const response = await setup(serve());

    // The request answered; the failure is the worker's.
    expect(response.status).toBe(201);
    await until(() => captured.length > 0, "the failure to be reported");
    expect(captured[0]?.route).toBe(QUEUE);
    const [job] = await eventJobs();
    expect(delivered).toEqual([job?.id]);
    expect(job?.state).toBe("retry");
    expect(workerLogs.entries.some((entry) => entry.message === "An event subscriber failed" && entry.fields["module"] === "broken")).toBe(true);
    expect(workerLogs.entries.some((entry) => entry.message === "Job failed" && entry.fields["job"] === QUEUE)).toBe(true);
    const everything = JSON.stringify([workerLogs.entries, captured.map(({ error }) => String(error))]);
    expect(everything).not.toContain(EMAIL);
  });
});
