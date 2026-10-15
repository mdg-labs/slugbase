import { setTimeout as sleep } from "node:timers/promises";
import type { MailMessage, MailPort } from "@slugbase/core";
import { totpCode, totpStep } from "@slugbase/core";
import type { AuthStore } from "@slugbase/db";
import { FixedClock, InMemoryMail } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mfaSecretOptions } from "../../src/auth/mfa.ts";
import { createAccountOnlyTenantResolver } from "../../src/auth/tenant-resolver.ts";
import { loadConfig } from "../../src/config/index.ts";
import { createServer, type Server } from "../../src/create-server.ts";
import { runMigrations } from "../../src/migrate/index.ts";
import { createWorker, type RunningWorker } from "../../src/worker/index.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { productionEnv } from "../config/support.ts";
import { urlOf } from "../migrate/support.ts";
import { testKey, testSecretBox } from "../secret-box.ts";
import { adapters, recordingLogger, serverConfig } from "../support.ts";
import { seedAccount, storeFor, type SeededAccount } from "./support.ts";

// The "MFA enabled" and "MFA disabled" emails through the whole path (doc 02
// section 12, doc 01 section 8.1, doc 10 T7): POST /api/v1/me/mfa/enrollment/confirm
// and DELETE /api/v1/me/mfa queue `mail.send` in the transaction that writes the
// change, and the worker's consumer sends it through the mail port. The failure
// scenarios: a message queued for a change that was not committed, or a change
// committed with no message; a change that fails or waits because mail cannot be
// sent; and a secret, a code or a backup code in a job payload or a message.

const LOGIN = "/api/v1/auth/login";
const REAUTH = "/api/v1/me/reauth";
const START = "/api/v1/me/mfa/enrollment";
const CONFIRM = "/api/v1/me/mfa/enrollment/confirm";
const MFA = "/api/v1/me/mfa";
const SESSION_COOKIE = "__Host-slugbase_session";
const STEP_MS = 30_000;
const KEY = testKey("key-1");
const POLL_SECONDS = 0.5;
const WAIT_MS = 20_000;
const TEST_TIMEOUT_MS = 40_000;

const database = useTestDatabase();
let store: AuthStore;
let worker: RunningWorker | undefined;

beforeAll(() => {
  store = storeFor(database());
});

afterAll(async () => {
  await worker?.shutdown();
  await store.close();
}, 30_000);

type Behaviour = "record" | "fail";

/** A mail port that can send, whose answer a test chooses; what reaches it is kept in `inbox` as well. */
function switchableMail(): { readonly port: MailPort; readonly inbox: InMemoryMail; behaviour: Behaviour } {
  const inbox = new InMemoryMail();
  const state = {
    inbox,
    behaviour: "record" as Behaviour,
    port: {
      available: true,
      send: async (message: MailMessage): Promise<void> => {
        if (state.behaviour === "fail") {
          throw new Error("delivery_failed");
        }
        await inbox.send(message);
      },
    } satisfies MailPort,
  };
  return state;
}

const mail = switchableMail();

interface World {
  readonly server: Server;
  readonly origin: string;
  readonly clock: FixedClock;
}

function serve(mailPort: MailPort): World {
  const config = serverConfig({
    NODE_ENV: "test",
    DATABASE_URL: appUrl(database()),
    RATE_LIMIT_LOGIN_IP: "1000/min",
    RATE_LIMIT_LOGIN_EMAIL: "1000/hour",
    RATE_LIMIT_MFA_IP: "1000/min",
    RATE_LIMIT_MFA_ACCOUNT: "1000/hour",
  });
  const clock = new FixedClock(Date.now());
  const server = createServer({
    config,
    adapters: { ...adapters(config), mail: mailPort, tenantResolver: createAccountOnlyTenantResolver(), secretBox: testSecretBox(KEY) },
    modules: [],
    migrations: [],
    logger: recordingLogger(),
    database: tenantDatabase(database()),
    authStore: store,
    now: () => clock.now().getTime(),
  });
  return { server, origin: config.APP_ORIGIN, clock };
}

async function startWorker(): Promise<void> {
  const config = loadConfig("worker", { ...productionEnv(), NODE_ENV: "test", DATABASE_URL: appUrl(database()) }).config;
  worker = await createWorker({
    config,
    adapters: { ...adapters(), mail: mail.port },
    modules: [],
    logger: recordingLogger(),
    database: tenantDatabase(database()),
    pollingIntervalSeconds: POLL_SECONDS,
    shutdownTimeoutMs: 500,
  }).start();
}

function tokenOf(response: Response): string | undefined {
  return new RegExp(`^${SESSION_COOKIE}=([A-Za-z0-9_-]{43});`).exec(response.headers.get("set-cookie") ?? "")?.[1];
}

function send({ server, origin }: World, method: string, path: string, token: string | null, body?: unknown): Promise<Response> {
  const headers = new Headers({ origin, "content-type": "application/json" });
  if (token !== null) {
    headers.set("cookie", `${SESSION_COOKIE}=${token}`);
  }
  return server.fetch(new Request(new URL(path, origin), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
}

async function codeAt(world: World, accountId: string): Promise<string> {
  const state = await store.mfaStateOf(accountId);
  if (state === undefined) {
    throw new Error("the account has no secret");
  }
  const secret = await testSecretBox(KEY).open(state.secret, mfaSecretOptions(accountId));
  return totpCode(secret, totpStep(world.clock.now().getTime()));
}

/** Signs in and re-authenticates with the password, then starts an enrolment: the state `confirm` is made from. */
async function startedEnrolment(world: World, account: SeededAccount): Promise<{ token: string; secret: string }> {
  const signedIn = await send(world, "POST", LOGIN, null, { email: account.email, password: account.password, remember: false });
  const token = tokenOf(signedIn) ?? "";
  expect(signedIn.status).toBe(200);
  expect((await send(world, "POST", REAUTH, token, { password: account.password })).status).toBe(204);
  const started = await send(world, "POST", START, token);
  expect(started.status).toBe(200);
  const { secret } = (await started.json()) as { secret: string };
  return { token, secret };
}

interface Enabled {
  readonly token: string;
  readonly secret: string;
  readonly backupCodes: readonly string[];
}

async function enable(world: World, account: SeededAccount): Promise<Enabled> {
  const { token, secret } = await startedEnrolment(world, account);
  const confirmed = await send(world, "POST", CONFIRM, token, { code: await codeAt(world, account.id) });
  expect(confirmed.status).toBe(200);
  const { backupCodes } = (await confirmed.json()) as { backupCodes: string[] };
  // The enrolment spent the current time step; the next code the account gives is one later.
  world.clock.advance(STEP_MS);
  return { token: tokenOf(confirmed) ?? "", secret, backupCodes };
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

async function mailJobs(accountId: string): Promise<JobRow[]> {
  const rows = await database().app<JobRow[]>`SELECT id, state, data FROM pgboss.job WHERE name = 'mail.send' ORDER BY created_on`;
  return rows.filter((job) => job.data["accountId"] === accountId);
}

async function mfaEnabledAt(accountId: string): Promise<Date | null> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ enabled_at: Date | null }[]>`SELECT mfa_enabled_at AS enabled_at FROM accounts WHERE id = ${accountId}`;
  });
  return rows[0]?.enabled_at ?? null;
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

describe("the MFA operations on a database whose mail queue does not exist", { timeout: TEST_TIMEOUT_MS }, () => {
  it("fail without enabling the factor when the message cannot be queued", async () => {
    const world = serve(mail.port);
    const account = await seedAccount(database());
    const { token } = await startedEnrolment(world, account);

    const response = await send(world, "POST", CONFIRM, token, { code: await codeAt(world, account.id) });

    expect(response.status).toBe(500);
    expect(await mfaEnabledAt(account.id)).toBeNull();
    expect((await store.mfaStateOf(account.id))?.enabledAt).toBeNull();
  });
});

describe("the MFA operations with mail that can send", { timeout: TEST_TIMEOUT_MS }, () => {
  beforeAll(async () => {
    // What the image entrypoint runs before the server starts; no worker has run on this database.
    await runMigrations({ url: urlOf(database().owner) });
  }, 120_000);

  it("queue the messages in the transaction of the change, naming the template and the account and nothing else", async () => {
    const world = serve(mail.port);
    const account = await seedAccount(database());

    const { token, secret, backupCodes } = await enable(world, account);

    expect(await mfaEnabledAt(account.id)).not.toBeNull();
    const enabled = await mailJobs(account.id);
    expect(enabled.map((job) => job.state)).toEqual(["created"]);
    expect(enabled[0]?.data).toEqual({ template: "mfaEnabled", accountId: account.id });

    const response = await send(world, "DELETE", MFA, token, { password: account.password, code: await codeAt(world, account.id) });

    expect(response.status).toBe(204);
    expect(await mfaEnabledAt(account.id)).toBeNull();
    const jobs = await mailJobs(account.id);
    expect(jobs.map((job) => job.data["template"])).toEqual(["mfaEnabled", "mfaDisabled"]);
    expect(jobs[1]?.data).toEqual({ template: "mfaDisabled", accountId: account.id });
    const everything = JSON.stringify(jobs);
    for (const value of [secret, ...backupCodes, account.email]) {
      expect(everything).not.toContain(value);
    }
  });

  it("queue nothing when the code is wrong, replayed or the password is wrong, and nothing for a change that was not made", async () => {
    const world = serve(mail.port);
    const account = await seedAccount(database());
    const { token } = await startedEnrolment(world, account);
    const right = await codeAt(world, account.id);

    expect((await send(world, "POST", CONFIRM, token, { code: right === "123456" ? "654321" : "123456" })).status).toBe(422);
    expect(await mailJobs(account.id)).toEqual([]);

    const confirmed = await send(world, "POST", CONFIRM, token, { code: right });
    expect(confirmed.status).toBe(200);
    const enabledToken = tokenOf(confirmed) ?? "";
    expect(await mailJobs(account.id)).toHaveLength(1);
    // The step of the enrolment is spent: the same code does not turn anything off.
    expect((await send(world, "DELETE", MFA, enabledToken, { password: account.password, code: right })).status).toBe(422);
    world.clock.advance(STEP_MS);
    const next = await codeAt(world, account.id);
    expect((await send(world, "DELETE", MFA, enabledToken, { password: "not the password at all", code: next })).status).toBe(422);

    expect(await mfaEnabledAt(account.id)).not.toBeNull();
    expect((await mailJobs(account.id)).map((job) => job.data["template"])).toEqual(["mfaEnabled"]);
  });

  it("are sent by the worker to the account's address in its language, with its name as the only data", async () => {
    await startWorker();
    const world = serve(mail.port);
    const account = await seedAccount(database());
    await setLocale(account.id, "de");
    // Messages queued by the tests above are sent once the worker starts; only this account's are looked at.
    const sentToAccount = (): readonly MailMessage[] => mail.inbox.sent.filter((message) => message.to === account.email);

    const { token, secret, backupCodes } = await enable(world, account);
    await until(() => sentToAccount().length === 1, "the enabled message to reach the mail port");
    expect((await send(world, "DELETE", MFA, token, { password: account.password, backupCode: backupCodes[0] ?? "" })).status).toBe(204);
    await until(() => sentToAccount().length === 2, "the disabled message to reach the mail port");

    const expected = (template: string): MailMessage => ({ template, to: account.email, locale: "de", data: { displayName: "Test account" } });
    expect(sentToAccount()).toEqual([expected("mfaEnabled"), expected("mfaDisabled")]);
    const everything = JSON.stringify(mail.inbox.sent);
    for (const value of [secret, ...backupCodes]) {
      expect(everything).not.toContain(value);
    }
  });

  it("do not fail when the mail port rejects the message", async () => {
    const world = serve(mail.port);
    const account = await seedAccount(database());
    mail.behaviour = "fail";
    try {
      const { token } = await enable(world, account);
      const response = await send(world, "DELETE", MFA, token, { password: account.password, code: await codeAt(world, account.id) });
      expect(response.status).toBe(204);
      expect(await mfaEnabledAt(account.id)).toBeNull();
    } finally {
      mail.behaviour = "record";
    }
  });
});

describe("the MFA operations with the log-only mail adapter", { timeout: TEST_TIMEOUT_MS }, () => {
  it("enable and disable the factor and queue no message", async () => {
    const world = serve({ available: false, send: () => Promise.reject(new Error("mail_unavailable")) });
    const account = await seedAccount(database());

    const { token } = await enable(world, account);
    expect(await mfaEnabledAt(account.id)).not.toBeNull();
    const response = await send(world, "DELETE", MFA, token, { password: account.password, code: await codeAt(world, account.id) });

    expect(response.status).toBe(204);
    expect(await mfaEnabledAt(account.id)).toBeNull();
    expect(await mailJobs(account.id)).toEqual([]);
  });
});
