import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { hash } from "@node-rs/argon2";
import { InMemoryMail } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import type { MailPort } from "@slugbase/core";
import type { AuthStore } from "@slugbase/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../../vitest.shared.ts";
import { createAccountOnlyTenantResolver } from "../../src/auth/tenant-resolver.ts";
import { createRateLimitRegistry, loadConfig } from "../../src/config/index.ts";
import { createServer, type Server, type ServerModule } from "../../src/create-server.ts";
import { HookResult } from "../../src/hooks/index.ts";
import { runMigrations } from "../../src/migrate/index.ts";
import { createWorker, type RunningWorker } from "../../src/worker/index.ts";
import { productionEnv } from "../config/support.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { memoryRateLimiter } from "../http/rate-limit-support.ts";
import { urlOf } from "../migrate/support.ts";
import { adapters, recordingLogger, serverConfig } from "../support.ts";
import { medianLatencyRatio, postJson, storeFor } from "./support.ts";

// POST /api/v1/auth/register (doc 04 section 10.2, doc 02 sections 2.2 and 2.6, doc 10 T8 and T9)
// over the whole chain and a migrated database. The failure scenario (T8): registering an address
// that has an account and registering a new one answer with the same status, headers and body, hash
// the password once each, queue one verification mail job each and fall in one latency class, and
// the account that exists is left exactly as it was. The rest: what a refused request writes (nothing),
// the 24-hour verification token the worker issues when the job runs, and the token in no queue,
// log or error report.

vi.mock("@node-rs/argon2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@node-rs/argon2")>();
  return { ...actual, hash: vi.fn(actual.hash) };
});

const hashings = vi.mocked(hash);

const REGISTER = "/api/v1/auth/register";
const PASSWORD = "a long enough password for this account";
const POLL_SECONDS = 0.5;
const WAIT_MS = 20_000;
const HOOK_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 40_000;
const DAY_MS = 86_400_000;

const database = useTestDatabase();
let store: AuthStore;

beforeAll(async () => {
  store = storeFor(database());
  // What the image entrypoint runs before the server starts; no worker has run on this database.
  await runMigrations({ url: urlOf(database().owner) });
}, HOOK_TIMEOUT_MS);

beforeEach(async () => {
  hashings.mockClear();
  await database().owner`TRUNCATE accounts CASCADE`;
  await database().owner`DELETE FROM pgboss.job WHERE name IN ('mail.send', 'event.account.created', 'event.workspace.created')`;
  await database().owner`TRUNCATE workspaces CASCADE`;
});

afterAll(async () => {
  await store.close();
}, 30_000);

interface World {
  readonly server: Server;
  readonly origin: string;
  readonly logs: ReturnType<typeof recordingLogger>;
}

interface ServeOptions {
  readonly env?: Record<string, string>;
  readonly mail?: MailPort;
  readonly modules?: readonly ServerModule[];
}

/** The server as the CE composes it, with registration open unless a test says otherwise and the per-address limit out of the way. */
function serve({ env = {}, mail, modules = [] }: ServeOptions = {}): World {
  const config = serverConfig({
    NODE_ENV: "test",
    DATABASE_URL: appUrl(database()),
    PUBLIC_REGISTRATION: "true",
    RATE_LIMIT_REGISTER_IP: "1000/hour",
    ...env,
  });
  const logs = recordingLogger();
  const server = createServer({
    config,
    adapters: {
      ...adapters(config),
      rateLimit: memoryRateLimiter(createRateLimitRegistry(config)),
      tenantResolver: createAccountOnlyTenantResolver(),
      ...(mail === undefined ? {} : { mail }),
    },
    modules,
    migrations: [],
    logger: logs,
    database: tenantDatabase(database()),
    authStore: store,
  });
  return { server, origin: config.APP_ORIGIN, logs };
}

let counter = 0;

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  counter += 1;
  return { displayName: "Ada Lovelace", email: `ada.${String(counter)}@example.test`, password: PASSWORD, ...overrides };
}

function register(world: World, payload: unknown, extra: { acceptLanguage?: string; forwardedFor?: string } = {}): Promise<Response> {
  const request = postJson(world.origin, REGISTER, payload, extra.forwardedFor === undefined ? {} : { forwardedFor: extra.forwardedFor });
  if (extra.acceptLanguage !== undefined) {
    request.headers.set("accept-language", extra.acceptLanguage);
  }
  return world.server.fetch(request);
}

interface AccountRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string | null;
  locale: string;
  email_verified_at: Date | null;
  is_instance_admin: boolean;
  password_changed_at: Date | null;
  mfa_enabled_at: Date | null;
  disabled_at: Date | null;
}

async function accounts(): Promise<AccountRow[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<AccountRow[]>`
      SELECT id, email, display_name, password_hash, locale, email_verified_at, is_instance_admin, password_changed_at, mfa_enabled_at, disabled_at
      FROM accounts ORDER BY created_at, id`;
  });
  return [...rows];
}

interface JobRow {
  readonly id: string;
  readonly name: string;
  readonly data: Record<string, unknown>;
}

async function jobs(name?: string): Promise<JobRow[]> {
  const rows = await database().app<JobRow[]>`
    SELECT id, name, data FROM pgboss.job WHERE name IN ('mail.send', 'event.account.created') ORDER BY created_on, id`;
  return rows.filter((row) => name === undefined || row.name === name);
}

interface CredentialRow {
  purpose: string;
  account_id: string;
  token_hash: Buffer;
  expires_at: Date;
  used_at: Date | null;
}

async function credentialTokens(): Promise<CredentialRow[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<CredentialRow[]>`SELECT purpose, account_id, token_hash, expires_at, used_at FROM credential_tokens ORDER BY created_at`;
  });
  return [...rows];
}

/** A body with the one field that differs by request taken out. */
function withoutRequestId(text: string): string {
  if (text === "") {
    return text;
  }
  const parsed = JSON.parse(text) as Record<string, unknown>;
  return JSON.stringify(Object.fromEntries(Object.entries(parsed).filter(([name]) => name !== "requestId")));
}

async function answerOf(response: Response) {
  return {
    status: response.status,
    // `x-request-id` is the one header that differs by request.
    headers: [...response.headers].filter(([name]) => name !== "x-request-id").sort(([a], [b]) => a.localeCompare(b)),
    body: withoutRequestId(await response.text()),
  };
}

async function workspacesOf(accountId: string | undefined): Promise<{ name: string; role: string }[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ name: string; role: string }[]>`
      SELECT w.name, m.role::text AS role FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id WHERE m.account_id = ${accountId ?? null}`;
  });
  return [...rows];
}

async function workspaceEvents(): Promise<Record<string, unknown>[]> {
  const rows = await database().app<{ data: Record<string, unknown> }[]>`SELECT data FROM pgboss.job WHERE name = 'event.workspace.created' ORDER BY created_on, id`;
  return rows.map((row) => row.data);
}

/** The workspace.created audit events, read as the table owner acting as slugbase_system. */
async function workspaceAudit(): Promise<{ actor_account_id: string | null; actor_label: string; action: string; metadata: unknown }[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ actor_account_id: string | null; actor_label: string; action: string; metadata: unknown }[]>`
      SELECT actor_account_id, actor_label, action, metadata FROM audit_events ORDER BY created_at, id`;
  });
  return [...rows];
}

async function untouched(): Promise<void> {
  expect(await accounts()).toEqual([]);
  expect(await jobs()).toEqual([]);
  expect(hashings).not.toHaveBeenCalled();
}

describe("POST /api/v1/auth/register", { timeout: TEST_TIMEOUT_MS }, () => {
  it("creates an unverified account that is not an instance admin, answers 202 with no body and queues the mail and the event in the transaction that wrote it", async () => {
    const world = serve({ mail: new InMemoryMail() });
    const payload = body({ displayName: "  Ada  ", email: "Ada.Lovelace@Example.test" });

    const response = await register(world, payload, { acceptLanguage: "de-AT,de;q=0.9,en;q=0.8" });

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
    const [account, ...rest] = await accounts();
    expect(rest).toEqual([]);
    expect(account).toMatchObject({
      email: "Ada.Lovelace@Example.test",
      display_name: "Ada",
      locale: "de",
      email_verified_at: null,
      is_instance_admin: false,
      mfa_enabled_at: null,
      disabled_at: null,
    });
    expect(account?.password_hash).toMatch(/^\$argon2id\$/);
    expect(account?.password_hash).not.toContain(PASSWORD);

    const mail = await jobs("mail.send");
    const event = await jobs("event.account.created");
    expect(mail.map((job) => job.data)).toEqual([{ template: "verifyEmail", accountId: account?.id }]);
    expect(event.map((job) => ({ accountId: job.data["accountId"], path: job.data["path"] }))).toEqual([{ accountId: account?.id, path: "self-registration" }]);
    expect(await credentialTokens()).toEqual([]);
  });

  it("gives the account its personal workspace and announces it in the same transaction when verification is not required", async () => {
    const world = serve({ mail: new InMemoryMail(), env: { EMAIL_VERIFICATION_REQUIRED: "false" } });

    expect((await register(world, body({ displayName: "Ada Lovelace" }))).status).toBe(202);

    const [account] = await accounts();
    expect(await workspacesOf(account?.id)).toEqual([{ name: "Ada Lovelace's workspace", role: "owner" }]);
    expect((await workspaceEvents()).map((event) => event["accountId"])).toEqual([account?.id]);
    expect(await workspaceAudit()).toEqual([
      { actor_account_id: account?.id, actor_label: "Ada Lovelace", action: "workspace.created", metadata: { name: "Ada Lovelace's workspace" } },
    ]);
  });

  it("creates no workspace at registration when verification is required, leaving it to the verification", async () => {
    const world = serve({ mail: new InMemoryMail(), env: { EMAIL_VERIFICATION_REQUIRED: "true" } });

    expect((await register(world, body())).status).toBe(202);

    const [account] = await accounts();
    expect(await workspacesOf(account?.id)).toEqual([]);
    expect(await workspaceEvents()).toEqual([]);
    expect(await workspaceAudit()).toEqual([]);
  });

  it("creates no workspace for an address that already has an account, and leaves the account's one workspace alone", async () => {
    const world = serve({ mail: new InMemoryMail(), env: { EMAIL_VERIFICATION_REQUIRED: "false" } });
    expect((await register(world, body({ email: "grace@example.test" }))).status).toBe(202);
    const [account] = await accounts();

    expect((await register(world, body({ email: "GRACE@example.test", displayName: "Mallory" }))).status).toBe(202);

    expect(await accounts()).toHaveLength(1);
    expect(await workspacesOf(account?.id)).toEqual([{ name: "Ada Lovelace's workspace", role: "owner" }]);
    expect(await workspaceEvents()).toHaveLength(1);
    expect(await workspaceAudit()).toHaveLength(1);
  });

  it("gives the account English when the browser asks for no language the interface has", async () => {
    const world = serve({ mail: new InMemoryMail() });
    await register(world, body(), { acceptLanguage: "fr-FR,fr;q=0.9" });
    await register(world, body());
    expect((await accounts()).map((account) => account.locale)).toEqual(["en", "en"]);
  });

  it("queues no mail when the mail port cannot send and verification is not required, and still queues the event", async () => {
    const world = serve();
    expect((await register(world, body())).status).toBe(202);
    expect((await accounts()).length).toBe(1);
    expect(await jobs("mail.send")).toEqual([]);
    expect(await jobs("event.account.created")).toHaveLength(1);
  });

  it("answers 403 registration_closed when public registration is off, whatever the body, and writes nothing", async () => {
    const world = serve({ env: { PUBLIC_REGISTRATION: "false" }, mail: new InMemoryMail() });
    for (const payload of [body(), body({ password: "short" })]) {
      const response = await register(world, payload);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "registration_closed", status: 403 });
    }
    await untouched();
  });

  it("is closed when the key is unset and the composition's default is closed", async () => {
    const world = serve({ env: { PUBLIC_REGISTRATION: "" }, mail: new InMemoryMail() });
    expect((await register(world, body())).status).toBe(403);
    await untouched();
  });

  it("is open for an unset key when the composition's default is open, and an explicit false still closes it", async () => {
    const config = (env: Record<string, string>) => serverConfig({ NODE_ENV: "test", DATABASE_URL: appUrl(database()), RATE_LIMIT_REGISTER_IP: "1000/hour", ...env });
    const build = (env: Record<string, string>): World => {
      const configured = config(env);
      const server = createServer({
        config: configured,
        adapters: { ...adapters(configured), rateLimit: memoryRateLimiter(createRateLimitRegistry(configured)), tenantResolver: createAccountOnlyTenantResolver(), mail: new InMemoryMail() },
        modules: [],
        migrations: [],
        logger: recordingLogger(),
        database: tenantDatabase(database()),
        authStore: store,
        registrationDefaults: { publicRegistration: true, emailVerificationRequired: true },
      });
      return { server, origin: configured.APP_ORIGIN, logs: recordingLogger() };
    };
    expect((await register(build({}), body())).status).toBe(202);
    expect((await register(build({ PUBLIC_REGISTRATION: "false" }), body())).status).toBe(403);
    expect(await accounts()).toHaveLength(1);
  });

  it("answers 503 mail_unavailable and creates nothing when verification is required and no mail is configured", async () => {
    const world = serve({ env: { EMAIL_VERIFICATION_REQUIRED: "true" } });
    const response = await register(world, body());
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(await response.json()).toMatchObject({ code: "mail_unavailable", status: 503 });
    await untouched();
  });

  it("registers when verification is required and mail can be sent", async () => {
    const world = serve({ env: { EMAIL_VERIFICATION_REQUIRED: "true" }, mail: new InMemoryMail() });
    expect((await register(world, body())).status).toBe(202);
    expect(await accounts()).toHaveLength(1);
    expect(await jobs("mail.send")).toHaveLength(1);
  });

  it.each([
    ["shorter than 12 characters", "elevenchars", "too_short"],
    ["longer than 256 characters", "x".repeat(257), "too_long"],
    ["in the breached-password dataset", "password1234", "breached"],
  ])("answers 422 weak_password for a password %s and writes nothing", async (_name, password, code) => {
    const world = serve({ mail: new InMemoryMail() });
    const response = await register(world, body({ password }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "weak_password", errors: [{ path: "password", code }] });
    await untouched();
  });

  it.each([
    ["a blank display name", { displayName: "   " }],
    ["an address that is not one", { email: "not-an-address" }],
    ["a field the operation does not know", { admin: true }],
    ["no password", { password: undefined }],
  ])("answers 422 validation_failed for %s and writes nothing", async (_name, overrides) => {
    const world = serve({ mail: new InMemoryMail() });
    const response = await register(world, body(overrides));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "validation_failed" });
    await untouched();
  });

  it("refuses a request that does not come from the application itself, and writes nothing", async () => {
    const world = serve({ mail: new InMemoryMail() });
    const request = postJson(world.origin, REGISTER, body());
    request.headers.set("origin", "https://evil.example");
    const response = await world.server.fetch(request);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "cross_site_request" });
    await untouched();
  });
});

describe("the register limit (T9)", { timeout: TEST_TIMEOUT_MS }, () => {
  it("allows 5 registrations per hour from one address and answers the sixth 429 with Retry-After, counting each address on its own", async () => {
    const world = serve({ env: { RATE_LIMIT_REGISTER_IP: "5/hour", TRUSTED_PROXY_HOPS: "1" }, mail: new InMemoryMail() });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await register(world, body(), { forwardedFor: "198.51.100.7" })).status).toBe(202);
    }
    const denied = await register(world, body(), { forwardedFor: "198.51.100.7" });
    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await denied.json()).toMatchObject({ code: "rate_limited" });
    expect((await register(world, body(), { forwardedFor: "198.51.100.8" })).status).toBe(202);
    expect(await accounts()).toHaveLength(6);
  });

  it("is 5 per hour per address by default", () => {
    const registry = createRateLimitRegistry(serverConfig({ NODE_ENV: "test", DATABASE_URL: appUrl(database()) }));
    expect(registry.window("register")).toEqual({ capacity: 5, refillPerSecond: 5 / 3600 });
  });
});

describe("registering an address that has an account (T8)", { timeout: TEST_TIMEOUT_MS }, () => {
  const EXISTING = "Grace.Hopper@Example.test";

  async function existingAccount(world: World): Promise<AccountRow> {
    expect((await register(world, body({ email: EXISTING, displayName: "Grace", password: "the first password of grace" }))).status).toBe(202);
    const [account] = await accounts();
    if (account === undefined) {
      throw new Error("the account was not created");
    }
    await database().owner`DELETE FROM pgboss.job WHERE name IN ('mail.send', 'event.account.created')`;
    hashings.mockClear();
    return account;
  }

  it("answers with the same status, headers and body as a new address, whatever the spelling of the address", async () => {
    const world = serve({ mail: new InMemoryMail(), env: { TRUSTED_PROXY_HOPS: "1" } });
    await existingAccount(world);
    const fresh = await register(world, body(), { forwardedFor: "198.51.100.1" });
    const answers = [await answerOf(fresh)];
    for (const [index, email] of [EXISTING, EXISTING.toLowerCase(), EXISTING.toUpperCase()].entries()) {
      answers.push(await answerOf(await register(world, body({ email }), { forwardedFor: `198.51.100.${String(index + 2)}` })));
    }
    expect(answers[0]?.status).toBe(202);
    expect(answers[0]?.body).toBe("");
    for (const answer of answers) {
      expect(answer).toEqual(answers[0]);
    }
  });

  it("leaves the existing account exactly as it was, with the password, name and language it had", async () => {
    const world = serve({ mail: new InMemoryMail() });
    const before = await existingAccount(world);

    const response = await register(world, body({ email: EXISTING.toLowerCase(), displayName: "Mallory", password: "mallory takes over this account" }), { acceptLanguage: "de" });

    expect(response.status).toBe(202);
    expect(await accounts()).toEqual([before]);
    expect(await credentialTokens()).toEqual([]);
  });

  it("hashes the password once and queues one verification mail job on every path, and the event only for the account it creates", async () => {
    const world = serve({ mail: new InMemoryMail() });
    const existing = await existingAccount(world);

    await register(world, body());
    expect(hashings).toHaveBeenCalledTimes(1);
    const created = await jobs();
    expect(created.map((job) => job.name).sort()).toEqual(["event.account.created", "mail.send"]);
    await database().owner`DELETE FROM pgboss.job WHERE name IN ('mail.send', 'event.account.created')`;
    hashings.mockClear();

    await register(world, body({ email: EXISTING }));
    expect(hashings).toHaveBeenCalledTimes(1);
    const taken = await jobs();
    expect(taken.map((job) => job.name)).toEqual(["mail.send"]);
    // The job is addressed to the identifier this request generated, which no account holds: the existing account is not named.
    expect(taken[0]?.data["accountId"]).not.toBe(existing.id);
    expect((await accounts()).map((account) => account.id)).not.toContain(taken[0]?.data["accountId"]);
  });

  it("falls in one latency class for an address that has an account as for a new one", { timeout: HEAVY_TEST_TIMEOUT_MS }, async () => {
    const world = serve({ mail: new InMemoryMail() });
    await existingAccount(world);
    let round = 0;
    const fresh = () => register(world, body({ email: `fresh.${String(round++)}.${String(Date.now())}@example.test` }));
    const taken = () => register(world, body({ email: EXISTING }));
    // A path that skipped the hashing would answer in a small fraction of the time: the bounds are far wider than
    // the noise of a loaded runner, and the ratio is a median over many back-to-back pairs.
    const ratio = await medianLatencyRatio(fresh, taken);
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2);
  });
});

describe("the registration policy (doc 01 section 13.5)", { timeout: TEST_TIMEOUT_MS }, () => {
  function policy(decide: (email: string) => boolean): { module: ServerModule; seen: { email: string; path: string }[] } {
    const seen: { email: string; path: string }[] = [];
    return {
      seen,
      module: {
        name: "policy",
        hooks: {
          registrationPolicy: (input) => {
            seen.push({ email: input.email, path: input.path });
            return decide(input.email) ? HookResult.allow() : HookResult.refuse("blocked_domain");
          },
        },
        register: () => ({}),
      },
    };
  }

  it("is asked with the normalised address and the self-registration path before anything is hashed or written", async () => {
    const { module, seen } = policy(() => true);
    const world = serve({ modules: [module], mail: new InMemoryMail() });

    expect((await register(world, body({ email: "Ada@Example.test" }))).status).toBe(202);

    expect(seen).toEqual([{ email: "Ada@Example.test", path: "self-registration" }]);
  });

  it("answers 403 registration_refused with one answer for every address and every reason, new or taken, and does not hash or write", async () => {
    const { module } = policy((email) => !email.toLowerCase().endsWith("@blocked.test"));
    const world = serve({ modules: [module], mail: new InMemoryMail(), env: { TRUSTED_PROXY_HOPS: "1" } });
    expect((await register(world, body({ email: "Taken@Allowed.test" }), { forwardedFor: "198.51.100.1" })).status).toBe(202);
    await database().owner`DELETE FROM pgboss.job WHERE name IN ('mail.send', 'event.account.created')`;
    hashings.mockClear();
    const before = await accounts();

    const answers = [];
    for (const [index, email] of ["new@blocked.test", "Other@BLOCKED.test"].entries()) {
      answers.push(await answerOf(await register(world, body({ email }), { forwardedFor: `198.51.100.${String(index + 2)}` })));
    }
    expect(answers[0]?.status).toBe(403);
    expect(JSON.parse(answers[0]?.body ?? "{}")).toMatchObject({ code: "registration_refused" });
    expect(answers[1]).toEqual(answers[0]);
    expect(hashings).not.toHaveBeenCalled();
    expect(await jobs()).toEqual([]);
    expect(await accounts()).toEqual(before);
  });

  it("refuses an address that has an account exactly as one that has none, because the answer depends on the address alone", async () => {
    const { module } = policy((email) => !email.toLowerCase().startsWith("blocked"));
    const world = serve({ modules: [module], mail: new InMemoryMail(), env: { TRUSTED_PROXY_HOPS: "1" } });
    await database().owner.begin(async (tx) => {
      const id = "0192f3a0-bbbb-7000-8000-00000000f001";
      await tx`SELECT set_config('app.account_id', ${id}, true)`;
      await tx`INSERT INTO accounts (id, email, display_name) VALUES (${id}, 'blocked.existing@example.test', 'Existing')`;
    });

    const existing = await answerOf(await register(world, body({ email: "blocked.existing@example.test" }), { forwardedFor: "198.51.100.1" }));
    const absent = await answerOf(await register(world, body({ email: "blocked.absent@example.test" }), { forwardedFor: "198.51.100.2" }));

    expect(existing.status).toBe(403);
    expect(existing).toEqual(absent);
  });

  it("answers 503 unavailable and writes nothing when a hook throws", async () => {
    const world = serve({
      mail: new InMemoryMail(),
      modules: [
        {
          name: "broken-policy",
          hooks: {
            registrationPolicy: () => {
              throw new Error("the policy service is down");
            },
          },
          register: () => ({}),
        },
      ],
    });
    const response = await register(world, body());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "unavailable" });
    await untouched();
  });
});

describe("the verification mail through the worker", { timeout: TEST_TIMEOUT_MS }, () => {
  const mail = new InMemoryMail();
  const workerLogs = recordingLogger();
  const captured: { error: unknown; route: string | undefined }[] = [];
  let worker: RunningWorker | undefined;

  async function startWorker(): Promise<void> {
    const config = loadConfig("worker", { ...productionEnv(), NODE_ENV: "test", DATABASE_URL: appUrl(database()) }).config;
    worker = await createWorker({
      config,
      adapters: {
        ...adapters(),
        mail,
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
      database: tenantDatabase(database()),
      pollingIntervalSeconds: POLL_SECONDS,
      shutdownTimeoutMs: 500,
    }).start();
  }

  beforeEach(() => {
    mail.clear();
    workerLogs.entries.length = 0;
    captured.length = 0;
  });

  afterEach(async () => {
    await worker?.shutdown();
    worker = undefined;
  });

  async function until(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await check())) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${what}`);
      }
      await sleep(50);
    }
  }

  async function mailJobsDone(count: number): Promise<void> {
    await until(async () => {
      const rows = await database().app<{ state: string }[]>`SELECT state FROM pgboss.job WHERE name = 'mail.send'`;
      return rows.length >= count && rows.every((row) => row.state === "completed");
    }, "the mail job to complete");
  }

  it("sends the new account one email with a link whose token is stored only as its hash, valid for 24 hours", async () => {
    const world = serve({ mail });
    await register(world, body({ displayName: "Ada", email: "ada.worker@example.test" }), { acceptLanguage: "de" });
    await startWorker();
    await mailJobsDone(1);

    expect(mail.sent).toHaveLength(1);
    const [message] = mail.sent;
    expect(message).toMatchObject({ template: "verifyEmail", to: "ada.worker@example.test", locale: "de", data: { displayName: "Ada" } });
    const token = message?.data["token"];
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [stored, ...rest] = await credentialTokens();
    expect(rest).toEqual([]);
    expect(stored).toMatchObject({ purpose: "email_verify", used_at: null });
    expect(stored?.token_hash).toEqual(createHash("sha256").update(Buffer.from(String(token), "base64url")).digest());
    expect(stored?.account_id).toBe((await accounts())[0]?.id);
    const lifetime = (stored?.expires_at.getTime() ?? 0) - Date.now();
    expect(lifetime).toBeGreaterThan(DAY_MS - 60_000);
    expect(lifetime).toBeLessThanOrEqual(DAY_MS);
  });

  it("keeps the token out of the queue, the logs and the error reports", async () => {
    const world = serve({ mail });
    await register(world, body({ email: "ada.quiet@example.test" }));
    await startWorker();
    await mailJobsDone(1);

    const token = String(mail.sent[0]?.data["token"]);
    const everything = JSON.stringify([
      await database().app`SELECT * FROM pgboss.job WHERE name IN ('mail.send', 'event.account.created')`,
      world.logs.entries,
      world.logs.requests,
      workerLogs.entries,
      workerLogs.requests,
      captured.map((entry) => String(entry.error)),
    ]);
    expect(token).toHaveLength(43);
    expect(everything).not.toContain(token);
    expect(everything).not.toContain("ada.quiet@example.test");
  });

  it("sends nothing for a registration of an address that has an account, and issues that account no token", async () => {
    const world = serve({ mail });
    await register(world, body({ email: "Taken.Worker@Example.test" }));
    await startWorker();
    await mailJobsDone(1);
    mail.clear();
    const before = await credentialTokens();

    await register(world, body({ email: "taken.worker@example.test" }));
    await mailJobsDone(2);

    expect(mail.sent).toEqual([]);
    expect(await credentialTokens()).toEqual(before);
  });

  it("sends nothing to an account that is already verified, and issues it no token", async () => {
    const world = serve({ mail });
    await register(world, body({ email: "verified.worker@example.test" }));
    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`UPDATE accounts SET email_verified_at = now()`;
    });
    await startWorker();
    await mailJobsDone(1);

    expect(mail.sent).toEqual([]);
    expect(await credentialTokens()).toEqual([]);
  });
});
