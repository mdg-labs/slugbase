import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { useTestDatabase } from "@slugbase/testing/db";
import type { AuthStore } from "@slugbase/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAccountOnlyTenantResolver } from "../../src/auth/tenant-resolver.ts";
import { loadConfig } from "../../src/config/index.ts";
import { createServer, type Server, type ServerModule } from "../../src/create-server.ts";
import { HookResult, type DeletionGuardInput, type ServerHooks } from "../../src/hooks/index.ts";
import { runMigrations } from "../../src/migrate/index.ts";
import { createWorker, type RunningWorker } from "../../src/worker/index.ts";
import { seedAccount, seedApiToken, seedMembership, seedWorkspace, sessionRows, setActiveWorkspace, storeFor, type SeededAccount } from "../auth/support.ts";
import { productionEnv } from "../config/support.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { urlOf } from "../migrate/support.ts";
import { adapters, fakeDatabase, recordingLogger, serverConfig } from "../support.ts";

// DELETE /api/v1/me through the whole chain over the migrated database, and the jobs it queues run by the worker
// (doc 04 section 10.3, doc 02 section 2.10, doc 05 section 7.1, doc 01 section 13.2, doc 10 T1 and T18). The failure
// scenarios: a deletion by a session that has not re-authenticated, by a token, or with another address typed; an
// account that is deleted while it is the only owner of a workspace that has other members; a refusing, failing or
// timing-out guard that leaves the account or any of its workspaces changed, whichever workspace it refuses; a row
// that still holds the account afterwards; another account's data that changes with it; and a workspace of the
// account that is neither deleted nor hidden.

const ME = "/api/v1/me";
const MEMBERS = "/api/v1/members";
const WORKSPACE = "/api/v1/workspace";
const REAUTH = "/api/v1/me/reauth";
const SESSION_COOKIE = "__Host-slugbase_session";
const HOOK_TIMEOUT_MS = 300_000;
const JOB = "workspace.delete";
const WORKSPACE_EVENT = "event.workspace.deleted";
const ACCOUNT_EVENT = "event.account.deleted";
const PREFIX = "10.1.0.0/16";

const database = useTestDatabase();
let store: AuthStore;

beforeAll(async () => {
  store = storeFor(database());
  // The queues exist once the image entrypoint has run migrate.
  await runMigrations({ url: urlOf(database().owner) });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await store.close();
});

beforeEach(async () => {
  await database().owner`DELETE FROM pgboss.job WHERE name IN (${JOB}, ${WORKSPACE_EVENT}, ${ACCOUNT_EVENT})`;
});

const workers: RunningWorker[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.shutdown()));
});

interface World {
  readonly server: Server;
  readonly origin: string;
}

function serve(modules: readonly ServerModule[] = [], hookTimeoutMs?: number): World {
  const config = serverConfig({
    NODE_ENV: "test",
    DATABASE_URL: appUrl(database()),
    RATE_LIMIT_LOGIN_IP: "1000/min",
    RATE_LIMIT_LOGIN_EMAIL: "1000/hour",
    RATE_LIMIT_WRITE_IP: "1000/min",
    RATE_LIMIT_WRITE_ACCOUNT: "1000/min",
    RATE_LIMIT_READ_IP: "1000/min",
    RATE_LIMIT_READ_ACCOUNT: "1000/min",
  });
  const server = createServer({
    config,
    adapters: { ...adapters(config), tenantResolver: createAccountOnlyTenantResolver() },
    modules,
    migrations: [],
    logger: recordingLogger(),
    database: tenantDatabase(database()),
    authStore: store,
    ...(hookTimeoutMs === undefined ? {} : { hookTimeoutMs }),
  });
  return { server, origin: config.APP_ORIGIN };
}

function guardModule(guard: NonNullable<ServerHooks["deletionGuard"]>): ServerModule {
  return { name: "test/billing", hooks: { deletionGuard: guard }, hookRefusals: { deletionGuard: ["billing_active"] }, register: () => ({}) };
}

function send(world: World, method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<Response> {
  const init: RequestInit = { method, headers: { origin: world.origin, "content-type": "application/json", ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return world.server.fetch(new Request(new URL(path, world.origin), init));
}

interface Person {
  readonly account: SeededAccount;
  /** The cookie header of a full session that re-authenticated just now. */
  readonly cookie: string;
  /** The cookie header of a full session that has not. */
  readonly stale: string;
}

async function signIn(world: World, account: SeededAccount, reauthenticate: boolean): Promise<string> {
  const response = await send(world, "POST", "/api/v1/auth/login", {}, { email: account.email, password: account.password, remember: false });
  const token = new RegExp(`^${SESSION_COOKIE}=([A-Za-z0-9_-]{43});`).exec(response.headers.get("set-cookie") ?? "")?.[1];
  if (response.status !== 200 || token === undefined) {
    throw new Error(`could not sign in: ${String(response.status)}`);
  }
  const cookie = `${SESSION_COOKIE}=${token}`;
  if (reauthenticate) {
    expect((await send(world, "POST", REAUTH, { cookie }, { password: account.password })).status).toBe(204);
  }
  return cookie;
}

async function person(world: World): Promise<Person> {
  const account = await seedAccount(database(), { emailVerified: true });
  return { account, cookie: await signIn(world, account, true), stale: await signIn(world, account, false) };
}

type Role = "owner" | "admin" | "member";

/** A workspace with its settings row, the given members in that order and an audit event of each, which names the member as its actor and carries a network. */
async function workspaceOf(name: string, ...members: readonly (readonly [Person, Role])[]): Promise<string> {
  const workspaceId = await seedWorkspace(database(), { name });
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`INSERT INTO workspace_settings (workspace_id) VALUES (${workspaceId})`;
  });
  for (const [member, role] of members) {
    await seedMembership(database(), { workspaceId, accountId: member.account.id, role });
    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`
        INSERT INTO audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, ip_prefix)
        VALUES (gen_random_uuid(), ${workspaceId}, 'account', ${member.account.id}, ${`Member ${member.account.id}`}, 'workspace.renamed', ${PREFIX})`;
    });
    for (const session of await sessionRows(database(), member.account.id)) {
      await setActiveWorkspace(database(), session.id, workspaceId);
    }
  }
  return workspaceId;
}

async function problem(response: Response): Promise<Record<string, unknown>> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return (await response.json()) as Record<string, unknown>;
}

function only<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error("no such item");
  }
  return item;
}

/** One digest of every row of the tables an account deletion can reach, as slugbase_system reads them: a change anywhere shows. */
async function state(): Promise<string> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ digest: string }[]>`
      SELECT md5(
        coalesce((SELECT string_agg(a.id::text || a.email::text, '|' ORDER BY a.id) FROM accounts a), '') ||
        coalesce((SELECT string_agg(w::text, '|' ORDER BY w.id) FROM workspaces w), '') ||
        coalesce((SELECT string_agg(m.workspace_id::text || m.account_id::text || m.role::text, '|' ORDER BY m.workspace_id, m.account_id) FROM workspace_members m), '') ||
        coalesce((SELECT string_agg(s.id::text || coalesce(s.active_workspace_id::text, ''), '|' ORDER BY s.id) FROM sessions s), '') ||
        coalesce((SELECT string_agg(t.id::text || coalesce(t.revoked_at::text, ''), '|' ORDER BY t.id) FROM api_tokens t), '') ||
        coalesce((SELECT string_agg(e::text, '|' ORDER BY e.id) FROM audit_events e), '')
      ) AS digest`;
  });
  return only(rows, 0).digest;
}

async function accountExists(accountId: string): Promise<boolean> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx`SELECT 1 FROM accounts WHERE id = ${accountId}`;
  });
  return rows.length === 1;
}

async function markedAt(workspaceId: string): Promise<Date | null> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ deleting_at: Date | null }[]>`SELECT deleting_at FROM workspaces WHERE id = ${workspaceId}`;
  });
  return only(rows, 0).deleting_at;
}

async function workspaceRows(workspaceId: string): Promise<{ workspaces: number; members: number; settings: number; events: number }> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ workspaces: number; members: number; settings: number; events: number }[]>`
      SELECT (SELECT count(*) FROM workspaces WHERE id = ${workspaceId})::int AS workspaces,
             (SELECT count(*) FROM workspace_members WHERE workspace_id = ${workspaceId})::int AS members,
             (SELECT count(*) FROM workspace_settings WHERE workspace_id = ${workspaceId})::int AS settings,
             (SELECT count(*) FROM audit_events WHERE workspace_id = ${workspaceId})::int AS events`;
  });
  return only(rows, 0);
}

async function eventsOf(accountId: string): Promise<{ actor_account_id: string | null; actor_label: string; ip_prefix: string | null; workspace_id: string }[]> {
  const label = `Member ${accountId}`;
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ actor_account_id: string | null; actor_label: string; ip_prefix: string | null; workspace_id: string }[]>`
      SELECT actor_account_id, actor_label, ip_prefix::text AS ip_prefix, workspace_id FROM audit_events WHERE actor_label = ${label} ORDER BY workspace_id`;
  });
  return [...rows];
}

async function jobs(name: string): Promise<Record<string, unknown>[]> {
  const rows = await database().owner<{ data: Record<string, unknown> }[]>`SELECT data FROM pgboss.job WHERE name = ${name} ORDER BY created_on, id`;
  return rows.map((row) => row.data);
}

/** An event of the catalog made by `actor` that names `target` as its target and carries `metadata`. */
async function seedTargetEvent(workspaceId: string, actor: Person, action: string, target: string, metadata: Record<string, string>): Promise<string> {
  const id = randomUUID();
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`
      INSERT INTO audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, entity_type, entity_id, metadata)
      VALUES (${id}, ${workspaceId}, 'account', ${actor.account.id}, 'Grace', ${action}, 'member', ${target}, ${JSON.stringify(metadata)}::text::jsonb)`;
  });
  return id;
}

/** The events with a column that holds `needle`, as slugbase_system reads them; the label is left out, which this test's events build from the actor's identifier. */
async function eventsHolding(needle: string): Promise<string[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ id: string }[]>`SELECT id FROM audit_events e WHERE (to_jsonb(e) - 'actor_label')::text ILIKE ${`%${needle}%`}`;
  });
  return rows.map((row) => row.id);
}

const bearer = (value: string): Record<string, string> => ({ authorization: `Bearer ${value}` });

async function until(check: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(100);
  }
}

describe("DELETE /api/v1/me", () => {
  it("deletes the account and clears its cookie: its sessions, tokens and sign-in are gone, its sole workspaces are hidden and queued, it leaves the shared ones, and account.deleted is queued", async () => {
    const world = serve();
    const ada = await person(world);
    const grace = await person(world);
    const own = await workspaceOf("Ada's own", [ada, "owner"]);
    const shared = await workspaceOf("Shared", [grace, "owner"], [ada, "admin"]);
    const adaToken = await seedApiToken(database(), { accountId: ada.account.id, workspaceId: own });
    const adaSharedToken = await seedApiToken(database(), { accountId: ada.account.id, workspaceId: shared });
    const graceToken = await seedApiToken(database(), { accountId: grace.account.id, workspaceId: shared });
    expect((await send(world, "GET", MEMBERS, { cookie: grace.cookie })).status).toBe(200);
    const graceEvents = await eventsOf(grace.account.id);
    const heidi = await person(world);
    const promoted = await seedTargetEvent(shared, grace, "member.role_changed", ada.account.id, { from: "member", to: "admin" });
    const removed = await seedTargetEvent(shared, grace, "member.removed", heidi.account.id, { content: "transfer", transferTo: ada.account.id });
    expect((await eventsHolding(ada.account.id)).sort()).toEqual(expect.arrayContaining([promoted, removed]));

    const response = await send(world, "DELETE", ME, { cookie: ada.cookie }, { email: ada.account.email.toUpperCase() });

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("set-cookie")).toMatch(new RegExp(`^${SESSION_COOKIE}=; .*Max-Age=0`));
    expect(await accountExists(ada.account.id)).toBe(false);
    // her sessions, tokens and sign-in
    for (const cookie of [ada.cookie, ada.stale]) {
      expect((await send(world, "GET", ME, { cookie })).status).toBe(401);
    }
    for (const token of [adaToken, adaSharedToken]) {
      expect((await send(world, "GET", WORKSPACE, bearer(token.value))).status).toBe(401);
    }
    const signInAgain = await send(world, "POST", "/api/v1/auth/login", {}, { email: ada.account.email, password: ada.account.password, remember: false });
    expect(signInAgain.status).toBe(401);
    // her own workspace is marked and queued; the shared one keeps its owner and loses her
    expect(await markedAt(own)).toBeInstanceOf(Date);
    expect(await markedAt(shared)).toBeNull();
    expect(await jobs(JOB)).toEqual([{ workspaceId: own }]);
    expect(await jobs(ACCOUNT_EVENT)).toEqual([{ eventId: expect.any(String) as string, accountId: ada.account.id }]);
    const members = await send(world, "GET", MEMBERS, { cookie: grace.cookie });
    expect(((await members.json()) as { items: { accountId: string }[] }).items.map((member) => member.accountId)).toEqual([grace.account.id]);
    // her events keep the label and the workspace and lose the reference and the network; the other member's are as they were
    expect(await eventsOf(ada.account.id)).toEqual([
      { actor_account_id: null, actor_label: `Member ${ada.account.id}`, ip_prefix: null, workspace_id: own },
      { actor_account_id: null, actor_label: `Member ${ada.account.id}`, ip_prefix: null, workspace_id: shared },
    ].sort((a, b) => a.workspace_id.localeCompare(b.workspace_id)));
    expect(await eventsOf(grace.account.id)).toEqual(graceEvents);
    // the events about her lose her identifier too, whether it is their target or the recipient of a transfer
    expect(await eventsHolding(ada.account.id)).toEqual([]);
    expect(await eventsHolding(ada.account.email)).toEqual([]);
    // another account's session and token keep working
    expect((await send(world, "GET", WORKSPACE, { cookie: grace.cookie })).status).toBe(200);
    expect((await send(world, "GET", WORKSPACE, bearer(graceToken.value))).status).toBe(200);
  });

  it("answers 422 validation_failed for another address, an empty one and no body, and changes nothing and asks no guard", async () => {
    const asked: DeletionGuardInput[] = [];
    const world = serve([guardModule((input) => (asked.push(input), HookResult.allow()))]);
    const ada = await person(world);
    const grace = await person(world);
    await workspaceOf("Ada's own", [ada, "owner"]);
    const before = await state();

    for (const body of [{ email: grace.account.email }, { email: "" }, { email: `${ada.account.email}.evil` }, {}]) {
      const response = await send(world, "DELETE", ME, { cookie: ada.cookie }, body);
      expect(response.status).toBe(422);
      expect(await problem(response)).toMatchObject({ code: "validation_failed" });
    }
    const mismatch = await problem(await send(world, "DELETE", ME, { cookie: ada.cookie }, { email: grace.account.email }));
    expect(mismatch["errors"]).toEqual([{ path: "email", code: "email_mismatch" }]);
    expect((await send(world, "DELETE", ME, { cookie: ada.cookie })).status).toBe(422);
    expect(await state()).toBe(before);
    expect(asked).toEqual([]);
    expect(await jobs(JOB)).toEqual([]);
    expect(await jobs(ACCOUNT_EVENT)).toEqual([]);
  });

  it("refuses a session that has not re-authenticated with 401, a token with 403, no session with 401 and a cross-site request with 403, and changes nothing", async () => {
    const world = serve();
    const ada = await person(world);
    const own = await workspaceOf("Ada's own", [ada, "owner"]);
    const token = await seedApiToken(database(), { accountId: ada.account.id, workspaceId: own, scope: "read-write" });
    const before = await state();
    const body = { email: ada.account.email };

    const stale = await send(world, "DELETE", ME, { cookie: ada.stale }, body);
    const byToken = await send(world, "DELETE", ME, bearer(token.value), body);
    const anonymous = await send(world, "DELETE", ME, {}, body);
    const crossSite = await send(world, "DELETE", ME, { cookie: ada.cookie, origin: "https://evil.example" }, body);

    expect([stale.status, byToken.status, anonymous.status, crossSite.status]).toEqual([401, 403, 401, 403]);
    expect(await problem(stale)).toMatchObject({ code: "reauth_required" });
    expect(await problem(byToken)).toMatchObject({ code: "forbidden" });
    expect(await problem(crossSite)).toMatchObject({ code: "cross_site_request" });
    expect(await state()).toBe(before);
    expect(await jobs(JOB)).toEqual([]);
  });
});

describe("DELETE /api/v1/me while the account is the only owner of a workspace that has other members", () => {
  it("answers 409 last_owner naming each such workspace and no other, and changes nothing", async () => {
    const asked: DeletionGuardInput[] = [];
    const world = serve([guardModule((input) => (asked.push(input), HookResult.allow()))]);
    const ada = await person(world);
    const grace = await person(world);
    const own = await workspaceOf("Ada's own", [ada, "owner"]);
    const team = await workspaceOf("Ada's team", [ada, "owner"], [grace, "member"]);
    const club = await workspaceOf("Ada's club", [ada, "owner"], [grace, "admin"]);
    await workspaceOf("Grace's with Ada", [grace, "owner"], [ada, "member"]);
    await workspaceOf("Co-owned", [grace, "owner"], [ada, "owner"]);
    const before = await state();

    const response = await send(world, "DELETE", ME, { cookie: ada.cookie }, { email: ada.account.email });

    expect(response.status).toBe(409);
    const body = await problem(response);
    expect(body).toMatchObject({ code: "last_owner", status: 409 });
    const listed = (body["workspaces"] as { id: string; name: string }[]).sort((a, b) => a.name.localeCompare(b.name));
    expect(listed).toEqual([
      { id: club, name: "Ada's club" },
      { id: team, name: "Ada's team" },
    ]);
    expect(listed.map((workspace) => workspace.id)).not.toContain(own);
    expect(await state()).toBe(before);
    expect(asked).toEqual([]);
    expect(await jobs(JOB)).toEqual([]);
    expect(await jobs(ACCOUNT_EVENT)).toEqual([]);
    expect((await send(world, "GET", ME, { cookie: ada.cookie })).status).toBe(200);
  });

  it("lets the account go once ownership is shared, and the workspace keeps an owner", async () => {
    const world = serve();
    const ada = await person(world);
    const grace = await person(world);
    const team = await workspaceOf("Ada's team", [ada, "owner"], [grace, "owner"]);

    expect((await send(world, "DELETE", ME, { cookie: ada.cookie }, { email: ada.account.email })).status).toBe(204);

    expect(await markedAt(team)).toBeNull();
    expect((await workspaceRows(team)).members).toBe(1);
    expect((await send(world, "GET", WORKSPACE, { cookie: grace.cookie })).status).toBe(200);
  });
});

describe("DELETE /api/v1/me with a deletion guard", () => {
  it("asks the guard for the account and then for each workspace that goes with it, as a member, and proceeds when it allows", async () => {
    const asked: DeletionGuardInput[] = [];
    const world = serve([guardModule((input) => (asked.push(input), HookResult.allow()))]);
    const ada = await person(world);
    const first = await workspaceOf("First", [ada, "owner"]);
    const second = await workspaceOf("Second", [ada, "owner"]);

    expect((await send(world, "DELETE", ME, { cookie: ada.cookie }, { email: ada.account.email })).status).toBe(204);

    // the workspaces are asked in the order of their identifiers
    expect(first < second).toBe(true);
    expect(asked).toEqual([
      { kind: "account", accountId: ada.account.id, requestedBy: "member" },
      { kind: "workspace", workspaceId: first, accountId: ada.account.id, requestedBy: "member" },
      { kind: "workspace", workspaceId: second, accountId: ada.account.id, requestedBy: "member" },
    ]);
    expect(await accountExists(ada.account.id)).toBe(false);
  });

  it("answers 409 billing_active when the guard refuses the account, and changes nothing", async () => {
    const world = serve([guardModule((input) => (input.kind === "account" ? HookResult.refuse("billing_active") : HookResult.allow()))]);
    const ada = await person(world);
    const grace = await person(world);
    await workspaceOf("Ada's own", [ada, "owner"]);
    await workspaceOf("Shared", [grace, "owner"], [ada, "member"]);
    const before = await state();

    const response = await send(world, "DELETE", ME, { cookie: ada.cookie }, { email: ada.account.email });

    expect(response.status).toBe(409);
    expect(await problem(response)).toMatchObject({ code: "billing_active" });
    expect(await state()).toBe(before);
    expect(await jobs(JOB)).toEqual([]);
    expect(await jobs(ACCOUNT_EVENT)).toEqual([]);
    expect((await send(world, "GET", ME, { cookie: ada.cookie })).status).toBe(200);
  });

  it("answers 409 billing_active when the guard refuses the second workspace, and leaves the account and both workspaces untouched", async () => {
    let second = "";
    const world = serve([guardModule((input) => (input.kind === "workspace" && input.workspaceId === second ? HookResult.refuse("billing_active") : HookResult.allow()))]);
    const ada = await person(world);
    const first = await workspaceOf("First", [ada, "owner"]);
    second = await workspaceOf("Second", [ada, "owner"]);
    // the guard is asked about the workspaces in the order of their identifiers, so the second is asked after the first allowed
    expect(first < second).toBe(true);
    const adaToken = await seedApiToken(database(), { accountId: ada.account.id, workspaceId: first });
    const before = await state();

    const response = await send(world, "DELETE", ME, { cookie: ada.cookie }, { email: ada.account.email });

    expect(response.status).toBe(409);
    expect(await problem(response)).toMatchObject({ code: "billing_active" });
    expect(await state()).toBe(before);
    expect(await markedAt(first)).toBeNull();
    expect(await markedAt(second)).toBeNull();
    expect(await accountExists(ada.account.id)).toBe(true);
    expect(await jobs(JOB)).toEqual([]);
    expect(await jobs(ACCOUNT_EVENT)).toEqual([]);
    expect((await send(world, "GET", WORKSPACE, { cookie: ada.cookie })).status).toBe(200);
    expect((await send(world, "GET", WORKSPACE, bearer(adaToken.value))).status).toBe(200);
  });

  it("answers 503 unavailable when the guard throws, and when it does not answer in time, and changes nothing", async () => {
    const failing: ServerModule = guardModule(() => {
      throw new Error("the billing service is down");
    });
    const hanging: ServerModule = guardModule(() => new Promise<never>(() => undefined));
    for (const [module, timeoutMs] of [
      [failing, undefined],
      [hanging, 50],
    ] as const) {
      const world = serve([module], timeoutMs);
      const ada = await person(world);
      await workspaceOf("Ada's own", [ada, "owner"]);
      const before = await state();

      const response = await send(world, "DELETE", ME, { cookie: ada.cookie }, { email: ada.account.email });

      expect(response.status).toBe(503);
      expect(await problem(response)).toMatchObject({ code: "unavailable" });
      expect(await state()).toBe(before);
      expect(await jobs(JOB)).toEqual([]);
      expect(await jobs(ACCOUNT_EVENT)).toEqual([]);
    }
  });
});

describe("the worker the CE image starts, after DELETE /api/v1/me", () => {
  function ceWorker() {
    return createWorker({
      config: loadConfig("worker", { ...productionEnv(), NODE_ENV: "test", DATABASE_URL: appUrl(database()) }).config,
      adapters: adapters(),
      modules: [],
      logger: recordingLogger(),
      database: fakeDatabase(),
      pollingIntervalSeconds: 0.5,
    });
  }

  it("registers the event.account.deleted job without any module", () => {
    expect(ceWorker().jobs.map((job) => job.name)).toContain(ACCOUNT_EVENT);
  });

  it("removes every row of the workspaces that went with the account, announces workspace.deleted once for each, and keeps the shared workspace and its other member", async () => {
    const world = serve();
    const ada = await person(world);
    const grace = await person(world);
    const own = await workspaceOf("Ada's own", [ada, "owner"]);
    const second = await workspaceOf("Ada's second", [ada, "owner"]);
    const shared = await workspaceOf("Shared", [grace, "owner"], [ada, "member"]);
    expect((await send(world, "DELETE", ME, { cookie: ada.cookie }, { email: ada.account.email })).status).toBe(204);
    expect((await workspaceRows(own)).workspaces).toBe(1);

    workers.push(await ceWorker().start());

    await until(async () => (await workspaceRows(own)).workspaces + (await workspaceRows(second)).workspaces === 0, 30_000, "the jobs to delete the workspaces");
    expect(await workspaceRows(own)).toEqual({ workspaces: 0, members: 0, settings: 0, events: 0 });
    expect(await workspaceRows(second)).toEqual({ workspaces: 0, members: 0, settings: 0, events: 0 });
    await until(async () => (await jobs(WORKSPACE_EVENT)).length >= 2, 10_000, "workspace.deleted to be queued");
    expect((await jobs(WORKSPACE_EVENT)).map((data) => data["workspaceId"]).sort()).toEqual([own, second].sort());
    expect((await workspaceRows(shared)).workspaces).toBe(1);
    expect((await workspaceRows(shared)).members).toBe(1);
    expect((await send(world, "GET", WORKSPACE, { cookie: grace.cookie })).status).toBe(200);
  });
});
