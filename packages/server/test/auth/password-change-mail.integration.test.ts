import { setTimeout as sleep } from "node:timers/promises";
import { InMemoryMail } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import type { MailMessage, MailPort } from "@slugbase/core";
import type { AuthStore } from "@slugbase/db";
import { getConstructionPlans } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAccountOnlyTenantResolver } from "../../src/auth/tenant-resolver.ts";
import { loadConfig } from "../../src/config/index.ts";
import { createServer, type Server } from "../../src/create-server.ts";
import { createWorker } from "../../src/worker/index.ts";
import { mailSendJob } from "../../src/worker/jobs/mail-send.ts";
import type { RunningWorker } from "../../src/worker/index.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { productionEnv } from "../config/support.ts";
import { adapters, recordingLogger, serverConfig } from "../support.ts";
import { seedAccount, storeFor, type SeededAccount } from "./support.ts";

// The "password changed" email through the whole path (doc 02 section 12, doc 01
// section 8.1, doc 10 T7): POST /api/v1/me/password queues `mail.send` in the
// transaction that writes the change, and the worker's consumer sends it through
// the mail port. The failure scenarios: a message queued for a change that was
// not committed, or a change committed with no message; a request that waits for
// the relay or fails with it; and an address, a name or a message body in a job
// payload, a log line or an error report.

const SESSION_COOKIE = "__Host-slugbase_session";
const REAUTH = "/api/v1/me/reauth";
const PASSWORD = "/api/v1/me/password";
const NEW_PASSWORD = "a brand new password for this account";
const POLL_SECONDS = 0.5;
const WAIT_MS = 20_000;
const TEST_TIMEOUT_MS = 40_000;

const database = useTestDatabase();
let store: AuthStore;

beforeAll(async () => {
  store = storeFor(database());
  const owner = database().owner;
  // The plans carry their own BEGIN and COMMIT, which need one session.
  const session = await owner.reserve();
  try {
    await session.unsafe(getConstructionPlans("pgboss", { createSchema: false }));
  } finally {
    session.release();
  }
}, 120_000);

let worker: RunningWorker | undefined;

afterAll(async () => {
  await worker?.shutdown();
  await store.close();
}, 30_000);

type Behaviour = "record" | "fail" | "hang";

/** A mail port that can send, whose answer a test chooses; what reaches it is kept in `inbox` as well. */
function switchableMail(): { readonly port: MailPort; readonly inbox: InMemoryMail; behaviour: Behaviour; attempts: number } {
  const inbox = new InMemoryMail();
  const state = {
    inbox,
    behaviour: "record" as Behaviour,
    attempts: 0,
    port: {
      available: true,
      send: async (message: MailMessage): Promise<void> => {
        state.attempts += 1;
        if (state.behaviour === "fail") {
          throw new Error("delivery_failed");
        }
        if (state.behaviour === "hang") {
          await new Promise<never>(() => undefined);
        }
        await inbox.send(message);
      },
    } satisfies MailPort,
  };
  return state;
}

const mail = switchableMail();

function serve(mailPort: MailPort): { server: Server; origin: string; logs: ReturnType<typeof recordingLogger> } {
  const config = serverConfig({
    NODE_ENV: "test",
    DATABASE_URL: appUrl(database()),
    RATE_LIMIT_LOGIN_IP: "1000/min",
    RATE_LIMIT_LOGIN_EMAIL: "1000/hour",
  });
  const logs = recordingLogger();
  const server = createServer({
    config,
    adapters: { ...adapters(config), mail: mailPort, tenantResolver: createAccountOnlyTenantResolver() },
    modules: [],
    migrations: [],
    logger: logs,
    database: tenantDatabase(database()),
    authStore: store,
  });
  return { server, origin: config.APP_ORIGIN, logs };
}

const captured: { error: unknown; route: string | undefined }[] = [];
const workerLogs = recordingLogger();

async function startWorker(): Promise<void> {
  const config = loadConfig("worker", { ...productionEnv(), NODE_ENV: "test", DATABASE_URL: appUrl(database()) }).config;
  worker = await createWorker({
    config,
    adapters: {
      ...adapters(),
      mail: mail.port,
      errors: {
        available: true,
        capture: (error, context) => {
          captured.push({ error, route: context?.route });
          return Promise.resolve();
        },
      },
    },
    modules: [],
    logger: workerLogs,
    // The handler reads the account in a tenant transaction on the real database.
    database: tenantDatabase(database()),
    pollingIntervalSeconds: POLL_SECONDS,
    shutdownTimeoutMs: 500,
  }).start();
}

interface Browser {
  readonly token: string;
}

async function signIn(world: { server: Server; origin: string }, account: SeededAccount): Promise<Browser> {
  const response = await world.server.fetch(
    new Request(new URL("/api/v1/auth/login", world.origin), {
      method: "POST",
      headers: { origin: world.origin, "content-type": "application/json" },
      body: JSON.stringify({ email: account.email, password: account.password, remember: false }),
    }),
  );
  const token = new RegExp(`^${SESSION_COOKIE}=([A-Za-z0-9_-]{43});`).exec(response.headers.get("set-cookie") ?? "")?.[1];
  if (response.status !== 200 || token === undefined) {
    throw new Error(`could not sign in: ${String(response.status)}`);
  }
  return { token };
}

function post(world: { server: Server; origin: string }, path: string, as: Browser, body: unknown): Promise<Response> {
  return world.server.fetch(
    new Request(new URL(path, world.origin), {
      method: "POST",
      headers: { origin: world.origin, "content-type": "application/json", cookie: `${SESSION_COOKIE}=${as.token}` },
      body: JSON.stringify(body),
    }),
  );
}

/** Signs in, re-authenticates and changes the password; returns the response of the change. */
async function changePassword(world: { server: Server; origin: string }, account: SeededAccount): Promise<Response> {
  const browser = await signIn(world, account);
  expect((await post(world, REAUTH, browser, { password: account.password })).status).toBe(204);
  return post(world, PASSWORD, browser, { currentPassword: account.password, newPassword: NEW_PASSWORD });
}

async function setLocale(accountId: string, locale: "en" | "de"): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${accountId}, true)`;
    await tx`UPDATE accounts SET locale = ${locale} WHERE id = ${accountId}`;
  });
}

interface JobRow {
  readonly id: string;
  readonly state: string;
  readonly data: Record<string, unknown>;
}

async function mailJobs(): Promise<JobRow[]> {
  return database().app<JobRow[]>`SELECT id, state, data FROM pgboss.job WHERE name = 'mail.send' ORDER BY created_on`;
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

async function passwordHashOf(accountId: string): Promise<string | null> {
  return store.passwordHashOf(accountId);
}

describe("POST /api/v1/me/password with mail that can send", { timeout: TEST_TIMEOUT_MS }, () => {
  it("fails and changes nothing while no worker has created the queue, so no change is committed without its message and no message exists without its change", async () => {
    const world = serve(mail.port);
    const account = await seedAccount(database());
    const before = await passwordHashOf(account.id);

    const response = await changePassword(world, account);

    expect(response.status).toBe(500);
    expect(await passwordHashOf(account.id)).toBe(before);
    expect(await mailJobs()).toEqual([]);
    // The old password still signs in, and no session was rotated or revoked by the failed change.
    expect((await signIn(world, account)).token).toHaveLength(43);
  });

  it("queues the message in the change's transaction and the worker sends it to the account's address in its language", async () => {
    await startWorker();
    const world = serve(mail.port);
    const account = await seedAccount(database());
    await setLocale(account.id, "de");
    mail.inbox.clear();

    const response = await changePassword(world, account);

    expect(response.status).toBe(204);
    expect(await passwordHashOf(account.id)).not.toBeNull();
    await until(() => mail.inbox.sent.length === 1, "the message to reach the mail port");
    expect(mail.inbox.sent).toEqual([
      { template: "passwordChanged", to: account.email, locale: "de", data: { displayName: "Test account" } },
    ]);
    const jobs = (await mailJobs()).filter((job) => job.data["accountId"] === account.id);
    expect(jobs).toHaveLength(1);
    // The job names the account and the template; the address, the name and any body stay out of the queue.
    expect(jobs[0]?.data).toEqual({ template: "passwordChanged", accountId: account.id });
  });

  it("sends English to an account whose language is English", async () => {
    const world = serve(mail.port);
    const account = await seedAccount(database());
    mail.inbox.clear();

    expect((await changePassword(world, account)).status).toBe(204);

    await until(() => mail.inbox.sent.length === 1, "the message to reach the mail port");
    expect(mail.inbox.sent[0]).toMatchObject({ to: account.email, locale: "en" });
  });

  it("does not fail the change when the mail port rejects, and keeps the address, the name and the body out of the logs and the error reports", async () => {
    const world = serve(mail.port);
    const account = await seedAccount(database());
    mail.behaviour = "fail";
    const attempts = mail.attempts;
    captured.length = 0;

    const response = await changePassword(world, account);

    expect(response.status).toBe(204);
    await until(() => mail.attempts > attempts, "the worker to try the message");
    await until(() => captured.length > 0, "the failure to be reported");
    expect(captured[0]?.route).toBe("mail.send");
    const everything = JSON.stringify([workerLogs.entries, world.logs.entries, world.logs.requests, captured.map(({ error }) => String(error))]);
    expect(everything).not.toContain(account.email);
    expect(everything).not.toContain("Test account");
    expect(everything).not.toContain("settings/account/security");
    expect(workerLogs.entries.some((entry) => entry.message === "Job failed" && entry.fields["job"] === "mail.send")).toBe(true);
    mail.behaviour = "record";
  });

  it("answers without waiting for the relay", async () => {
    const world = serve(mail.port);
    const account = await seedAccount(database());
    mail.behaviour = "hang";
    const attempts = mail.attempts;

    const response = await changePassword(world, account);

    expect(response.status).toBe(204);
    // The worker takes the message up and is stuck in the relay, which never answers; the request has answered.
    await until(() => mail.attempts > attempts, "the worker to start sending");
    const stuck = (await mailJobs()).filter((job) => job.data["accountId"] === account.id);
    expect(stuck.map((job) => job.state)).toEqual(["active"]);
  });
});

describe("POST /api/v1/me/password with the log-only mail adapter", { timeout: TEST_TIMEOUT_MS }, () => {
  it("changes the password and queues no message", async () => {
    const world = serve({ available: false, send: () => Promise.reject(new Error("mail_unavailable")) });
    const account = await seedAccount(database());
    const jobsBefore = (await mailJobs()).length;
    const before = await passwordHashOf(account.id);

    const response = await changePassword(world, account);

    expect(response.status).toBe(204);
    expect(await passwordHashOf(account.id)).not.toBe(before);
    expect(await mailJobs()).toHaveLength(jobsBefore);
  });
});

describe("the mail.send job", { timeout: TEST_TIMEOUT_MS }, () => {
  it("sends nothing and does not fail for an account that no longer exists, and logs no address", async () => {
    const logs = recordingLogger();
    const attempts = mail.attempts;
    const config = loadConfig("worker", { ...productionEnv(), NODE_ENV: "test", DATABASE_URL: appUrl(database()) }).config;

    await mailSendJob.handle(
      { template: "passwordChanged", accountId: "0192f3a0-bbbb-7000-8000-00000000ffff" },
      { config, logger: logs, adapters: { ...adapters(), mail: mail.port }, withTenant: (context, fn) => database().tenant.withTenant(context, fn) },
    );

    expect(mail.attempts).toBe(attempts);
    expect(logs.entries).toEqual([{ level: "warn", message: "Mail not sent; the account no longer exists", fields: { template: "passwordChanged" } }]);
  });
});
