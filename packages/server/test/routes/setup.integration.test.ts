import { createHash } from "node:crypto";
import type { AuthStore } from "@slugbase/db";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAccountOnlyTenantResolver } from "../../src/auth/tenant-resolver.ts";
import { createServer, type RunningServer, type Server } from "../../src/create-server.ts";
import { hashPassword } from "../../src/auth/password.ts";
import { runMigrations } from "../../src/migrate/index.ts";
import { uuidv7 } from "../../src/auth/uuidv7.ts";
import { storeFor } from "../auth/support.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { urlOf } from "../migrate/support.ts";
import { adapters, recordingLogger, serverConfig } from "../support.ts";

// First-run setup through the whole chain over the migrated database (doc 02
// section 2.2, doc 04 section 10.2, doc 10 section 2.1 and T8): the failure
// scenario is the setup lock. After setup completes, a valid POST /setup must
// answer 403 setup_completed and create nothing, and many POST /setup calls on
// an empty instance must create exactly one account.

const STATUS = "/api/v1/setup/status";
const SETUP = "/api/v1/setup";
const CONFIG = "/api/config";
const ME = "/api/v1/me";
const LOGIN = "/api/v1/auth/login";
const SESSION_COOKIE = "__Host-slugbase_session";
const PARALLEL_CALLS = 6;
// In the shipped breached-password dataset (12 characters or more, so the length rule does not refuse it first).
const BREACHED_PASSWORD = "123qweasdzxc";
const HOOK_TIMEOUT_MS = 300_000;

const database = useTestDatabase();
let store: AuthStore;
const running: RunningServer[] = [];

beforeAll(async () => {
  store = storeFor(database());
  // Setup queues the account.created event, so the queues exist, as they do once the image entrypoint has run migrate.
  await runMigrations({ url: urlOf(database().owner) });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await store.close();
});

// Every test starts on an instance that has never been set up.
beforeEach(async () => {
  await database().owner`TRUNCATE accounts, workspaces, instance_state CASCADE`;
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.shutdown()));
});

async function registerAccount(): Promise<void> {
  // An account that exists without a setup: registered the way the other entry paths will, by a system function.
  const passwordHash = await hashPassword("some other password");
  await database().app`SELECT sys_create_account(${uuidv7()}::uuid, 'registered@example.test', 'Registered', ${passwordHash}, 'en', false)`;
}

interface Served {
  readonly server: Server;
  readonly origin: string;
  readonly logger: ReturnType<typeof recordingLogger>;
}

function serve(env: Record<string, string> = {}, authStore: AuthStore = store): Served {
  const config = serverConfig({
    NODE_ENV: "test",
    DATABASE_URL: appUrl(database()),
    // The defaults are for production traffic; a test that is not about them calls freely.
    RATE_LIMIT_SETUP_IP: "1000/hour",
    RATE_LIMIT_PUBLIC_IP: "1000/min",
    RATE_LIMIT_LOGIN_IP: "1000/min",
    RATE_LIMIT_LOGIN_EMAIL: "1000/hour",
    ...env,
  });
  const logger = recordingLogger();
  const server = createServer({
    config,
    adapters: { ...adapters(config), tenantResolver: createAccountOnlyTenantResolver() },
    modules: [],
    migrations: [],
    logger,
    database: tenantDatabase(database()),
    authStore,
  });
  return { server, origin: config.APP_ORIGIN, logger };
}

const BODY = {
  displayName: "First Admin",
  email: "admin@example.test",
  password: "a long enough password",
  workspaceName: "Home",
};

interface Post {
  readonly body?: unknown;
  readonly origin?: string | null;
  readonly contentType?: string;
  readonly fetchSite?: string;
  readonly forwardedFor?: string;
}

function post({ origin }: Served, path: string, attempt: Post = {}): Request {
  const headers = new Headers({ "content-type": attempt.contentType ?? "application/json" });
  const sent = attempt.origin === undefined ? origin : attempt.origin;
  if (sent !== null) {
    headers.set("origin", sent);
  }
  if (attempt.fetchSite !== undefined) {
    headers.set("sec-fetch-site", attempt.fetchSite);
  }
  if (attempt.forwardedFor !== undefined) {
    headers.set("x-forwarded-for", attempt.forwardedFor);
  }
  return new Request(new URL(path, origin), { method: "POST", headers, body: JSON.stringify(attempt.body ?? BODY) });
}

function get(served: Served, path: string, cookie?: string): Promise<Response> {
  return served.server.fetch(new Request(new URL(path, served.origin), { headers: cookie === undefined ? {} : { cookie } }));
}

function setup(served: Served, attempt: Post = {}): Promise<Response> {
  return served.server.fetch(post(served, SETUP, attempt));
}

interface ProblemBody {
  code: string;
  status: number;
  errors?: { path: string; code: string }[];
}

async function problem(response: Response): Promise<ProblemBody> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return (await response.json()) as ProblemBody;
}

function cookieOf(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  const match = new RegExp(`^(${SESSION_COOKIE}=[A-Za-z0-9_-]{43});`).exec(header);
  if (match?.[1] === undefined) {
    throw new Error(`no session cookie in: ${header}`);
  }
  return match[1];
}

interface Counts {
  accounts: number;
  workspaces: number;
  members: number;
  settings: number;
  sessions: number;
  completed: number;
}

async function counts(): Promise<Counts> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<Counts[]>`
      SELECT (SELECT count(*) FROM accounts)::int AS accounts,
             (SELECT count(*) FROM workspaces)::int AS workspaces,
             (SELECT count(*) FROM workspace_members)::int AS members,
             (SELECT count(*) FROM workspace_settings)::int AS settings,
             (SELECT count(*) FROM sessions)::int AS sessions,
             (SELECT count(*) FROM instance_state WHERE setup_completed_at IS NOT NULL)::int AS completed`;
  });
  const [row] = rows;
  if (row === undefined) {
    throw new Error("the count query returned no row");
  }
  return row;
}

const NOTHING: Counts = { accounts: 0, workspaces: 0, members: 0, settings: 0, sessions: 0, completed: 0 };
const ONE_OF_EACH: Counts = { accounts: 1, workspaces: 1, members: 1, settings: 1, sessions: 1, completed: 1 };

async function statusOf(served: Served): Promise<boolean> {
  const response = await get(served, STATUS);
  expect(response.status).toBe(200);
  return ((await response.json()) as { setupRequired: boolean }).setupRequired;
}

type TokenAnswer = { setupRequired: boolean; setupTokenRequired: unknown };

/** The two answers that carry the token requirement, read whole so a field that should not be there shows. */
async function tokenAnswers(served: Served): Promise<{ status: TokenAnswer; config: TokenAnswer & Record<string, unknown> }> {
  const status = await get(served, STATUS);
  const config = await get(served, CONFIG);
  expect(status.status).toBe(200);
  expect(config.status).toBe(200);
  return { status: (await status.json()) as TokenAnswer, config: (await config.json()) as TokenAnswer & Record<string, unknown> };
}

async function configSaysSetupRequired(served: Served): Promise<boolean | undefined> {
  const response = await get(served, CONFIG);
  expect(response.status).toBe(200);
  return ((await response.json()) as { setupRequired?: boolean }).setupRequired;
}

/** Starts the token flow of `start()` against the migrated test database and returns the token it printed, if any. */
async function startAndReadToken(env: Record<string, string> = {}): Promise<{ token: string | undefined; prints: number }> {
  const authStore = storeFor(database());
  const served = serve(env, authStore);
  running.push(await served.server.start({ port: 0 }));
  const printed = served.logger.entries.filter((entry) => entry.fields["setupToken"] !== undefined);
  const token = printed[0]?.fields["setupToken"];
  return { token: typeof token === "string" ? token : undefined, prints: printed.length };
}

describe("GET /api/v1/setup/status and the setupRequired of /api/config", () => {
  it("say that setup is pending on an empty instance, and not once the first account exists", async () => {
    const served = serve({ SETUP_TOKEN_REQUIRED: "false" });
    expect(await statusOf(served)).toBe(true);
    expect(await configSaysSetupRequired(served)).toBe(true);

    expect((await setup(served)).status).toBe(201);
    expect(await statusOf(served)).toBe(false);
    expect(await configSaysSetupRequired(served)).toBe(false);
  });

  it("report setupTokenRequired alike, as SETUP_TOKEN_REQUIRED while setup is pending and false otherwise", async () => {
    const without = serve({ SETUP_TOKEN_REQUIRED: "false" });
    const { status, config } = await tokenAnswers(without);
    expect(status).toEqual({ setupRequired: true, setupTokenRequired: false });
    expect(config).toMatchObject({ setupRequired: true, setupTokenRequired: false });

    const withToken = await tokenAnswers(serve({ SETUP_TOKEN_REQUIRED: "true" }));
    expect(withToken.status).toEqual({ setupRequired: true, setupTokenRequired: true });
    expect(withToken.config).toMatchObject({ setupRequired: true, setupTokenRequired: true });

    const off = await tokenAnswers(serve({ SETUP_ENABLED: "false", SETUP_TOKEN_REQUIRED: "true" }));
    expect(off.status).toEqual({ setupRequired: false, setupTokenRequired: false });
    expect(off.config).toMatchObject({ setupRequired: false, setupTokenRequired: false });
  });

  it("report setupTokenRequired false once the first account exists, whatever SETUP_TOKEN_REQUIRED says", async () => {
    const served = serve({ SETUP_TOKEN_REQUIRED: "false" });
    expect((await setup(served)).status).toBe(201);
    const after = await tokenAnswers(served);
    expect(after.status).toEqual({ setupRequired: false, setupTokenRequired: false });
    expect(after.config).toMatchObject({ setupRequired: false, setupTokenRequired: false });
  });

  it("never carry the setup token or its hash, only the boolean", async () => {
    const served = serve({ SETUP_TOKEN_REQUIRED: "true" }, storeFor(database()));
    running.push(await served.server.start({ port: 0 }));
    const printed = served.logger.entries.find((entry) => entry.fields["setupToken"] !== undefined)?.fields["setupToken"];
    const token = typeof printed === "string" ? printed : undefined;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const bodies = await Promise.all([get(served, STATUS), get(served, CONFIG)].map(async (r) => (await r).text()));
    for (const text of bodies) {
      expect(typeof (JSON.parse(text) as TokenAnswer).setupTokenRequired).toBe("boolean");
      expect(text).not.toContain(token ?? "unreachable");
      expect(text).not.toMatch(/hash/i);
    }
  });

  it("say that setup is not pending when the deployment turns it off", async () => {
    const served = serve({ SETUP_ENABLED: "false" });
    expect(await statusOf(served)).toBe(false);
    expect(await configSaysSetupRequired(served)).toBe(false);
  });

  it("do not answer false when the database cannot say", async () => {
    const down: AuthStore = { ...store, setupPending: () => Promise.reject(new Error("database down")) };
    const served = serve({}, down);
    expect((await get(served, STATUS)).status).toBe(500);
    expect((await get(served, CONFIG)).status).toBe(500);
  });
});

describe("POST /api/v1/setup", () => {
  it("creates the verified instance admin with its workspace as owner, answers 201 and signs the account in with that workspace active", async () => {
    const served = serve({ SETUP_TOKEN_REQUIRED: "false" });
    const response = await setup(served, { body: { ...BODY, email: "Admin@Example.test" } });
    expect(response.status).toBe(201);
    const { workspaceId } = (await response.json()) as { workspaceId: string };
    expect(response.headers.get("cache-control")).toBe("no-store");
    const cookie = cookieOf(response);
    expect(response.headers.get("set-cookie")).toMatch(/HttpOnly/);
    expect(response.headers.get("set-cookie")).toMatch(/SameSite=Lax/);

    const me = await get(served, ME, cookie);
    expect(me.status).toBe(200);
    const body = (await me.json()) as {
      account: { email: string; displayName: string; emailVerified: boolean; hasPassword: boolean };
      memberships: { workspaceId: string; name: string; role: string }[];
      activeWorkspaceId: string | null;
    };
    expect(body.account).toMatchObject({ email: "Admin@Example.test", displayName: "First Admin", emailVerified: true, hasPassword: true });
    expect(body.memberships).toEqual([{ workspaceId, name: "Home", role: "owner" }]);
    expect(body.activeWorkspaceId).toBe(workspaceId);

    const rows = await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      return tx<{ admin: boolean; ai: boolean; level: string; active: string | null }[]>`
        SELECT a.is_instance_admin AS admin, s.ai_enabled AS ai, ss.level, ss.active_workspace_id AS active
        FROM accounts a
        JOIN workspace_settings s ON s.workspace_id = ${workspaceId}
        JOIN sessions ss ON ss.account_id = a.id`;
    });
    expect([...rows]).toEqual([{ admin: true, ai: true, level: "full", active: workspaceId }]);
    expect(await counts()).toEqual(ONE_OF_EACH);
  });

  it("leaves an account that can sign in with the password it was created with, and with no other", async () => {
    const served = serve({ SETUP_TOKEN_REQUIRED: "false" });
    expect((await setup(served)).status).toBe(201);
    const login = (password: string) =>
      served.server.fetch(post(served, LOGIN, { body: { email: "ADMIN@example.test", password, remember: false } }));
    expect((await login(BODY.password)).status).toBe(200);
    expect((await login("not the password at all")).status).toBe(401);
  });

  it("answers 403 setup_completed and writes nothing once setup is done, for a valid body and for a different one", async () => {
    const served = serve({ SETUP_TOKEN_REQUIRED: "false" });
    expect((await setup(served)).status).toBe(201);
    expect(await counts()).toEqual(ONE_OF_EACH);

    for (const body of [BODY, { ...BODY, email: "someone.else@example.test", workspaceName: "Other" }]) {
      const again = await setup(served, { body });
      expect(again.status).toBe(403);
      expect(again.headers.get("set-cookie")).toBeNull();
      expect(await problem(again)).toMatchObject({ code: "setup_completed", status: 403 });
    }
    expect(await counts()).toEqual(ONE_OF_EACH);
  });

  it("answers 403 setup_completed and writes nothing when an account appears after the server saw setup pending", async () => {
    // The pre-check passes and an account appears before the write: the database's lock is what holds.
    const racing: AuthStore = {
      ...store,
      setupPending: async () => {
        const pending = await store.setupPending();
        await registerAccount();
        return pending;
      },
    };
    const response = await setup(serve({ SETUP_TOKEN_REQUIRED: "false" }, racing));
    expect(response.status).toBe(403);
    expect(await problem(response)).toMatchObject({ code: "setup_completed" });
    expect(await counts()).toEqual({ ...NOTHING, accounts: 1 });
  });

  it("creates exactly one account when many calls arrive at once", async () => {
    const served = serve({ SETUP_TOKEN_REQUIRED: "false" });
    const responses = await Promise.all(
      Array.from({ length: PARALLEL_CALLS }, (_unused, index) =>
        setup(served, { body: { ...BODY, email: `admin${String(index)}@example.test`, workspaceName: `Home ${String(index)}` } }),
      ),
    );
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([201, ...Array<number>(PARALLEL_CALLS - 1).fill(403)]);
    for (const response of responses.filter((candidate) => candidate.status === 403)) {
      expect(await problem(response)).toMatchObject({ code: "setup_completed" });
    }
    expect(await counts()).toEqual(ONE_OF_EACH);
  });

  it("answers 403 setup_completed and writes nothing when the deployment turns setup off, on an empty instance", async () => {
    const served = serve({ SETUP_ENABLED: "false", SETUP_TOKEN_REQUIRED: "false" });
    const response = await setup(served);
    expect(response.status).toBe(403);
    expect(await problem(response)).toMatchObject({ code: "setup_completed" });
    expect(await counts()).toEqual(NOTHING);
  });

  it("answers 403 setup_completed when an account exists although setup was never recorded", async () => {
    const served = serve({ SETUP_TOKEN_REQUIRED: "false" });
    await registerAccount();
    expect(await statusOf(served)).toBe(false);
    const response = await setup(served);
    expect(response.status).toBe(403);
    expect(await problem(response)).toMatchObject({ code: "setup_completed" });
    expect(await counts()).toEqual({ ...NOTHING, accounts: 1 });
  });

  describe("the password", () => {
    it.each([
      ["11 characters", "a".repeat(11), "too_short"],
      ["empty", "", "too_short"],
      ["257 characters", "a".repeat(257), "too_long"],
    ])("is refused with 422 weak_password and nothing written for %s", async (_name, password, code) => {
      const served = serve({ SETUP_TOKEN_REQUIRED: "false" });
      const response = await setup(served, { body: { ...BODY, password } });
      expect(response.status).toBe(422);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await problem(response)).toMatchObject({ code: "weak_password", errors: [{ path: "password", code }] });
      expect(await counts()).toEqual(NOTHING);
    });

    it("is refused with 422 weak_password and no account when it is on the breached list", async () => {
      const served = serve({ SETUP_TOKEN_REQUIRED: "false" });
      const response = await setup(served, { body: { ...BODY, password: BREACHED_PASSWORD } });
      expect(response.status).toBe(422);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await problem(response)).toMatchObject({ code: "weak_password", errors: [{ path: "password", code: "breached" }] });
      expect(await counts()).toEqual(NOTHING);
      expect(await statusOf(served)).toBe(true);
    });

    it("is accepted when it is on the breached list and the operator turned the check off, and the length rules still apply", async () => {
      const served = serve({ SETUP_TOKEN_REQUIRED: "false", BREACHED_PASSWORD_CHECK: "false" });
      const short = await setup(served, { body: { ...BODY, password: "a".repeat(11) } });
      expect(short.status).toBe(422);
      expect(await problem(short)).toMatchObject({ code: "weak_password", errors: [{ path: "password", code: "too_short" }] });
      expect(await counts()).toEqual(NOTHING);
      expect((await setup(served, { body: { ...BODY, password: BREACHED_PASSWORD } })).status).toBe(201);
    });

    it.each([12, 256])("is accepted at %i characters", async (length) => {
      const served = serve({ SETUP_TOKEN_REQUIRED: "false" });
      expect((await setup(served, { body: { ...BODY, password: `Kq7-${"z".repeat(length - 4)}` } })).status).toBe(201);
    });
  });

  it("refuses a display name that is blank once trimmed with 422 validation_failed and writes nothing", async () => {
    const served = serve({ SETUP_TOKEN_REQUIRED: "false" });
    const response = await setup(served, { body: { ...BODY, displayName: "   " } });
    expect(response.status).toBe(422);
    expect(await problem(response)).toMatchObject({ code: "validation_failed", errors: [{ path: "displayName", code: "too_small" }] });
    expect(await counts()).toEqual(NOTHING);
  });

  it("refuses a workspace name that is blank once trimmed with 422 validation_failed and writes nothing", async () => {
    const served = serve({ SETUP_TOKEN_REQUIRED: "false" });
    const response = await setup(served, { body: { ...BODY, workspaceName: "\t" } });
    expect(response.status).toBe(422);
    expect(await problem(response)).toMatchObject({ code: "validation_failed", errors: [{ path: "workspaceName", code: "too_small" }] });
    expect(await counts()).toEqual(NOTHING);
  });

  it("accepts 100 astral-plane characters and a spaced 100-character name stored trimmed, and refuses 101 characters", async () => {
    const emoji = "\u{1F600}".repeat(100);
    const refusing = serve({ SETUP_TOKEN_REQUIRED: "false" });
    const tooLong = await setup(refusing, { body: { ...BODY, displayName: `${emoji}\u{1F600}` } });
    expect(tooLong.status).toBe(422);
    expect(await problem(tooLong)).toMatchObject({ code: "validation_failed", errors: [{ path: "displayName", code: "too_big" }] });
    expect(await counts()).toEqual(NOTHING);

    const served = serve({ SETUP_TOKEN_REQUIRED: "false" });
    const response = await setup(served, { body: { ...BODY, displayName: `  ${emoji}  ` } });
    expect(response.status).toBe(201);
    const me = await get(served, ME, cookieOf(response));
    expect(await me.json()).toMatchObject({ account: { displayName: emoji } });
  });

  it("refuses an unknown field and a malformed address with 422 and writes nothing", async () => {
    const served = serve({ SETUP_TOKEN_REQUIRED: "false" });
    expect((await setup(served, { body: { ...BODY, isInstanceAdmin: true } })).status).toBe(422);
    expect((await setup(served, { body: { ...BODY, email: "not an address" } })).status).toBe(422);
    expect(await counts()).toEqual(NOTHING);
  });

  it("answers 500 and no cookie when the database fails, and the instance can still be set up", async () => {
    const failing: AuthStore = { ...store, completeSetup: () => Promise.reject(new Error("database down")) };
    const served = serve({ SETUP_TOKEN_REQUIRED: "false" }, failing);
    const response = await setup(served);
    expect(response.status).toBe(500);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await counts()).toEqual(NOTHING);
    expect((await setup(serve({ SETUP_TOKEN_REQUIRED: "false" }))).status).toBe(201);
  });

  it("neither answers with nor logs the password or its hash", async () => {
    const served = serve({ SETUP_TOKEN_REQUIRED: "false" });
    const response = await setup(served, { body: { ...BODY, password: "the password nobody may see" } });
    const text = await response.text();
    const logged = JSON.stringify([...served.logger.entries, ...served.logger.requests]);
    for (const secret of ["the password nobody may see", "$argon2"]) {
      expect(text).not.toContain(secret);
      expect(logged).not.toContain(secret);
    }
  });
});

describe("the setup token", () => {
  it("is generated and printed at start while there is no account, and only its hash is kept", async () => {
    const first = await startAndReadToken();
    expect(first.prints).toBe(1);
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const rows = await database().owner<{ hash: Buffer }[]>`SELECT setup_token_hash AS hash FROM instance_state`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.hash.equals(createHash("sha256").update(first.token ?? "").digest())).toBe(true);
    const dump = await database().owner<{ text: string }[]>`SELECT instance_state::text AS text FROM instance_state`;
    expect(dump[0]?.text).not.toContain(first.token ?? "missing");
  }, HOOK_TIMEOUT_MS);

  it("is replaced by a new one at each start: the old token stops working and the new one completes setup", async () => {
    const first = await startAndReadToken();
    await Promise.all(running.splice(0).map((server) => server.shutdown()));
    const restarted = await startAndReadToken();
    expect(restarted.prints).toBe(1);
    expect(restarted.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(restarted.token).not.toBe(first.token);

    const served = serve();
    const stale = await setup(served, { body: { ...BODY, setupToken: first.token } });
    expect(stale.status).toBe(403);
    expect(await problem(stale)).toMatchObject({ code: "forbidden" });
    expect(await counts()).toEqual(NOTHING);

    expect((await setup(served, { body: { ...BODY, setupToken: restarted.token } })).status).toBe(201);
    expect(await counts()).toEqual(ONE_OF_EACH);
  }, HOOK_TIMEOUT_MS);

  it("leaves, when several servers start together, a token that one of them printed and no other", async () => {
    const tokens: (string | undefined)[] = [];
    const starts = await Promise.all(Array.from({ length: 3 }, () => startAndReadToken()));
    tokens.push(...starts.map((start) => start.token));
    expect(tokens.every((token) => token !== undefined)).toBe(true);
    const served = serve();
    const statuses: number[] = [];
    for (const token of tokens) {
      statuses.push((await setup(served, { body: { ...BODY, email: `a${String(statuses.length)}@example.test`, setupToken: token } })).status);
    }
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 403)).toHaveLength(2);
    expect((await counts()).accounts).toBe(1);
  }, HOOK_TIMEOUT_MS);

  it("is not generated when the deployment does not require one, turns setup off, or has an account", async () => {
    expect((await startAndReadToken({ SETUP_TOKEN_REQUIRED: "false" })).prints).toBe(0);
    await Promise.all(running.splice(0).map((server) => server.shutdown()));
    expect((await startAndReadToken({ SETUP_ENABLED: "false" })).prints).toBe(0);
    await Promise.all(running.splice(0).map((server) => server.shutdown()));
    await registerAccount();
    expect((await startAndReadToken()).prints).toBe(0);
    expect(await database().owner`SELECT 1 FROM instance_state WHERE setup_token_hash IS NOT NULL`).toHaveLength(0);
  }, HOOK_TIMEOUT_MS);

  it("answers 403 forbidden and writes nothing for a missing or a wrong token, and 201 for the printed one", async () => {
    const { token } = await startAndReadToken();
    const served = serve();
    for (const attempt of [{ body: BODY }, { body: { ...BODY, setupToken: "" } }, { body: { ...BODY, setupToken: "not the token" } }]) {
      const response = await setup(served, attempt);
      expect(response.status).toBe(403);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await problem(response)).toMatchObject({ code: "forbidden", status: 403 });
    }
    expect(await counts()).toEqual(NOTHING);
    expect(await statusOf(served)).toBe(true);

    expect((await setup(served, { body: { ...BODY, setupToken: ` ${token ?? ""}\n` } })).status).toBe(201);
    expect(await counts()).toEqual(ONE_OF_EACH);
    expect(await database().owner`SELECT 1 FROM instance_state WHERE setup_token_hash IS NOT NULL`).toHaveLength(0);
  }, HOOK_TIMEOUT_MS);

  it("cannot be used again after setup, and a closed instance answers setup_completed to it", async () => {
    const { token } = await startAndReadToken();
    const served = serve();
    expect((await setup(served, { body: { ...BODY, setupToken: token } })).status).toBe(201);
    const again = await setup(served, { body: { ...BODY, email: "second@example.test", setupToken: token } });
    expect(again.status).toBe(403);
    expect(await problem(again)).toMatchObject({ code: "setup_completed" });
    expect((await counts()).accounts).toBe(1);
  }, HOOK_TIMEOUT_MS);

  it("keeps setup closed to a request that needs a token when none was ever stored", async () => {
    const served = serve();
    const response = await setup(served, { body: { ...BODY, setupToken: "anything at all" } });
    expect(response.status).toBe(403);
    expect(await problem(response)).toMatchObject({ code: "forbidden" });
    expect(await counts()).toEqual(NOTHING);
  });

  it("is ignored by a deployment that does not require one", async () => {
    const served = serve({ SETUP_TOKEN_REQUIRED: "false" });
    expect((await setup(served)).status).toBe(201);
  });

  it("logs that it could not be prepared, and still starts, when the database refuses", async () => {
    const refusing: AuthStore = { ...store, setSetupToken: () => Promise.reject(new Error("database down")), close: () => Promise.resolve() };
    const served = serve({}, refusing);
    running.push(await served.server.start({ port: 0 }));
    expect(served.logger.entries.filter((entry) => entry.level === "error").map((entry) => entry.message)).toEqual([
      "The first-run setup token could not be prepared; no new token was stored, and a token printed at an earlier start, if any, still works",
    ]);
    const response = await setup(served, { body: { ...BODY, setupToken: "guess" } });
    expect(response.status).toBe(403);
  }, HOOK_TIMEOUT_MS);

  it("keeps the token of an earlier start working when a later start cannot store a new one", async () => {
    const first = await startAndReadToken();
    await Promise.all(running.splice(0).map((server) => server.shutdown()));
    const refusing: AuthStore = { ...store, setSetupToken: () => Promise.reject(new Error("database down")), close: () => Promise.resolve() };
    const served = serve({}, refusing);
    running.push(await served.server.start({ port: 0 }));
    expect(served.logger.entries.filter((entry) => entry.level === "error").map((entry) => entry.message)).toEqual([
      "The first-run setup token could not be prepared; no new token was stored, and a token printed at an earlier start, if any, still works",
    ]);
    expect((await setup(served, { body: { ...BODY, setupToken: "guess" } })).status).toBe(403);
    expect((await setup(served, { body: { ...BODY, setupToken: first.token } })).status).toBe(201);
    expect(await counts()).toEqual(ONE_OF_EACH);
  }, HOOK_TIMEOUT_MS);
});

describe("the cross-site rules (Q5)", () => {
  it.each([
    ["another origin", { origin: "https://evil.example" }],
    ["no origin", { origin: null }],
    ["a cross-site fetch", { fetchSite: "cross-site" }],
    ["a form post", { contentType: "application/x-www-form-urlencoded" }],
  ])("refuse a setup request with %s before anything is written", async (_name, attempt) => {
    const served = serve({ SETUP_TOKEN_REQUIRED: "false" });
    const response = await setup(served, attempt);
    expect(response.status).toBe(403);
    expect(await problem(response)).toMatchObject({ code: "cross_site_request" });
    expect(await counts()).toEqual(NOTHING);
    expect(await statusOf(served)).toBe(true);
  });
});

describe("the setup rate limit", () => {
  it("answers 429 after the configured attempts from one address, wrong ones included, and writes nothing for them", async () => {
    const served = serve({ RATE_LIMIT_SETUP_IP: "3/hour", SETUP_TOKEN_REQUIRED: "true" });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await setup(served, { body: { ...BODY, setupToken: `guess ${String(attempt)}` }, forwardedFor: "198.51.100.1" });
      statuses.push(response.status);
      if (response.status === 429) {
        expect(await problem(response)).toMatchObject({ code: "rate_limited" });
        expect(response.headers.get("retry-after")).not.toBeNull();
      }
    }
    expect(statuses).toEqual([403, 403, 403, 429, 429]);
    expect(await counts()).toEqual(NOTHING);
  });
});
