import { setTimeout as sleep } from "node:timers/promises";
import { useTestDatabase } from "@slugbase/testing/db";
import type { AuthStore } from "@slugbase/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAccountOnlyTenantResolver } from "../../src/auth/tenant-resolver.ts";
import { loadConfig } from "../../src/config/index.ts";
import { createServer, type Server, type ServerModule } from "../../src/create-server.ts";
import { HookResult, type DeletionGuardInput, type DeletionRefusalCode, type ServerHooks } from "../../src/hooks/index.ts";
import { runMigrations } from "../../src/migrate/index.ts";
import { createWorker, type RunningWorker } from "../../src/worker/index.ts";
import { seedAccount, seedApiToken, seedMembership, seedWorkspace, sessionRows, setActiveWorkspace, storeFor, type SeededAccount } from "../auth/support.ts";
import { productionEnv } from "../config/support.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { urlOf } from "../migrate/support.ts";
import { adapters, fakeDatabase, recordingLogger, serverConfig } from "../support.ts";

// DELETE /api/v1/workspace through the whole chain over the migrated database, and the job it queues run by the
// worker (doc 04 section 10.4, doc 02 section 3.7, doc 05 section 7.2, doc 01 section 13.2, doc 10 T1). The failure
// scenarios: a workspace that stays reachable after the 202 (to a member's session, to a bound token, in the list),
// a request by an admin, a member, a token or a session that has not re-authenticated that marks it anyway, a
// refusing, failing or timing-out guard that leaves the workspace marked, queued or audited, a deletion that touches
// another workspace of the same member, and a job that does not delete the rows or announce the deletion.

const WORKSPACE = "/api/v1/workspace";
const WORKSPACES = "/api/v1/workspaces";
const MEMBERS = "/api/v1/members";
const REAUTH = "/api/v1/me/reauth";
const SESSION_COOKIE = "__Host-slugbase_session";
const HOOK_TIMEOUT_MS = 300_000;
const JOB = "workspace.delete";
const EVENT = "event.workspace.deleted";

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
  await database().owner`DELETE FROM pgboss.job WHERE name IN (${JOB}, ${EVENT})`;
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
  const cookie = await signIn(world, account, true);
  const stale = await signIn(world, account, false);
  return { account, cookie, stale };
}

type Role = "owner" | "admin" | "member";

/** A workspace with a signed-in member of each role given, in that order, all acting in it, its settings row and two audit events. */
async function workspaceOf(world: World, ...roles: Role[]): Promise<{ readonly workspaceId: string; readonly people: readonly (Person & { readonly role: Role })[] }> {
  const workspaceId = await seedWorkspace(database(), { name: "Deletion test" });
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`INSERT INTO workspace_settings (workspace_id) VALUES (${workspaceId})`;
    await tx`INSERT INTO audit_events (id, workspace_id, actor_type, actor_label, action) VALUES (gen_random_uuid(), ${workspaceId}, 'system', 'Test', 'workspace.renamed')`;
  });
  const people: (Person & { role: Role })[] = [];
  for (const role of roles) {
    const as = await person(world);
    await seedMembership(database(), { workspaceId, accountId: as.account.id, role });
    for (const session of await sessionRows(database(), as.account.id)) {
      await setActiveWorkspace(database(), session.id, workspaceId);
    }
    people.push({ ...as, role });
  }
  return { workspaceId, people };
}

function only<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error("no such item");
  }
  return item;
}

async function problem(response: Response): Promise<Record<string, unknown>> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return (await response.json()) as Record<string, unknown>;
}

/** The rows of the workspace in every table that holds them, with the mark, read as slugbase_system. A member's last activity is left out: a request moves it. */
async function content(workspaceId: string): Promise<string> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ digest: string }[]>`
      SELECT md5(
        coalesce((SELECT string_agg(w::text, '|' ORDER BY w.id) FROM workspaces w WHERE w.id = ${workspaceId}), '') ||
        coalesce((SELECT string_agg(m.account_id::text || m.role::text, '|' ORDER BY m.account_id) FROM workspace_members m WHERE m.workspace_id = ${workspaceId}), '') ||
        coalesce((SELECT string_agg(s::text, '|' ORDER BY s.workspace_id) FROM workspace_settings s WHERE s.workspace_id = ${workspaceId}), '') ||
        coalesce((SELECT string_agg(t.id::text || coalesce(t.revoked_at::text, ''), '|' ORDER BY t.id) FROM api_tokens t WHERE t.workspace_id = ${workspaceId}), '') ||
        coalesce((SELECT string_agg(e::text, '|' ORDER BY e.id) FROM audit_events e WHERE e.workspace_id = ${workspaceId}), '')
      ) AS digest`;
  });
  return only(rows, 0).digest;
}

interface Counts {
  workspaces: number;
  members: number;
  settings: number;
  tokens: number;
  events: number;
}

async function counts(workspaceId: string): Promise<Counts> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<Counts[]>`
      SELECT (SELECT count(*) FROM workspaces WHERE id = ${workspaceId})::int AS workspaces,
             (SELECT count(*) FROM workspace_members WHERE workspace_id = ${workspaceId})::int AS members,
             (SELECT count(*) FROM workspace_settings WHERE workspace_id = ${workspaceId})::int AS settings,
             (SELECT count(*) FROM api_tokens WHERE workspace_id = ${workspaceId})::int AS tokens,
             (SELECT count(*) FROM audit_events WHERE workspace_id = ${workspaceId})::int AS events`;
  });
  return only(rows, 0);
}

async function markedAt(workspaceId: string): Promise<Date | null> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ deleting_at: Date | null }[]>`SELECT deleting_at FROM workspaces WHERE id = ${workspaceId}`;
  });
  return only(rows, 0).deleting_at;
}

async function auditActions(workspaceId: string): Promise<{ action: string; actor_account_id: string | null; entity_type: string | null; entity_id: string | null }[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ action: string; actor_account_id: string | null; entity_type: string | null; entity_id: string | null }[]>`
      SELECT action, actor_account_id, entity_type, entity_id FROM audit_events
      WHERE workspace_id = ${workspaceId} AND action <> 'workspace.renamed' ORDER BY created_at, id`;
  });
  return [...rows];
}

async function jobs(name: string): Promise<Record<string, unknown>[]> {
  const rows = await database().owner<{ data: Record<string, unknown> }[]>`SELECT data FROM pgboss.job WHERE name = ${name} ORDER BY created_on, id`;
  return rows.map((row) => row.data);
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

describe("DELETE /api/v1/workspace", () => {
  it("marks the workspace at once and answers 202: nobody who belonged to it reaches it, its tokens are dead, the job is queued and the request is audited, with every row still in place", async () => {
    const world = serve();
    const { workspaceId, people } = await workspaceOf(world, "owner", "admin", "member");
    const [owner, admin, member] = [only(people, 0), only(people, 1), only(people, 2)];
    const memberToken = await seedApiToken(database(), { accountId: member.account.id, workspaceId });
    const ownerToken = await seedApiToken(database(), { accountId: owner.account.id, workspaceId });
    expect((await send(world, "GET", WORKSPACE, bearer(memberToken.value))).status).toBe(200);
    const rowsBefore = await counts(workspaceId);

    const response = await send(world, "DELETE", WORKSPACE, { cookie: owner.cookie });

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
    expect(await markedAt(workspaceId)).toBeInstanceOf(Date);
    for (const as of [owner, admin, member]) {
      expect((await send(world, "GET", WORKSPACE, { cookie: as.cookie })).status).toBe(404);
      expect((await send(world, "GET", MEMBERS, { cookie: as.cookie })).status).toBe(404);
      const list = await send(world, "GET", WORKSPACES, { cookie: as.cookie });
      expect(((await list.json()) as { items: { id: string }[] }).items).toEqual([]);
    }
    for (const token of [memberToken, ownerToken]) {
      const dead = await send(world, "GET", WORKSPACE, bearer(token.value));
      expect(dead.status).toBe(401);
      expect(await problem(dead)).toMatchObject({ code: "unauthenticated" });
    }
    expect(await jobs(JOB)).toEqual([{ workspaceId }]);
    expect(await auditActions(workspaceId)).toEqual([
      { action: "workspace.deletion_requested", actor_account_id: owner.account.id, entity_type: "workspace", entity_id: workspaceId },
    ]);
    // The rows go in the job, not in the request.
    expect(await counts(workspaceId)).toEqual({ ...rowsBefore, events: rowsBefore.events + 1 });
    const sessions = await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      return tx<{ active_workspace_id: string | null }[]>`SELECT active_workspace_id FROM sessions WHERE account_id IN ${tx([owner.account.id, admin.account.id, member.account.id])}`;
    });
    expect(sessions.map((row) => row.active_workspace_id)).toEqual(sessions.map(() => null));
  });

  it("moves a member's session to the other workspace it belongs to, and leaves that workspace, its tokens and its audit log as they were", async () => {
    const world = serve();
    const { workspaceId, people } = await workspaceOf(world, "owner", "member");
    const [owner, member] = [only(people, 0), only(people, 1)];
    const other = await workspaceOf(world, "owner");
    await seedMembership(database(), { workspaceId: other.workspaceId, accountId: member.account.id, role: "member" });
    const kept = await seedApiToken(database(), { accountId: member.account.id, workspaceId: other.workspaceId });
    const before = await content(other.workspaceId);

    expect((await send(world, "DELETE", WORKSPACE, { cookie: owner.cookie })).status).toBe(202);

    const after = await send(world, "GET", WORKSPACE, { cookie: member.cookie });
    expect(after.status).toBe(200);
    expect(((await after.json()) as { id: string }).id).toBe(other.workspaceId);
    expect((await send(world, "GET", WORKSPACE, bearer(kept.value))).status).toBe(200);
    expect(await content(other.workspaceId)).toBe(before);
    expect(await markedAt(other.workspaceId)).toBeNull();
    expect(await markedAt(workspaceId)).toBeInstanceOf(Date);
  });

  it("answers 404 to a second request: a workspace being deleted is not one a request acts in", async () => {
    const world = serve();
    const { workspaceId, people } = await workspaceOf(world, "owner");
    const owner = only(people, 0);
    expect((await send(world, "DELETE", WORKSPACE, { cookie: owner.cookie })).status).toBe(202);

    const again = await send(world, "DELETE", WORKSPACE, { cookie: owner.cookie });

    expect(again.status).toBe(404);
    expect(await jobs(JOB)).toHaveLength(1);
    expect((await auditActions(workspaceId)).map((row) => row.action)).toEqual(["workspace.deletion_requested"]);
  });

  it("lets either of two owners delete the workspace, whoever of them is the last owner", async () => {
    const world = serve();
    const { workspaceId, people } = await workspaceOf(world, "owner", "owner");

    expect((await send(world, "DELETE", WORKSPACE, { cookie: only(people, 1).cookie })).status).toBe(202);

    expect(await markedAt(workspaceId)).toBeInstanceOf(Date);
  });

  it("refuses an admin and a member with 403, a session that has not re-authenticated with 401 reauth_required, a token with 403 and no session with 401, and changes, queues and records nothing", async () => {
    const world = serve();
    const { workspaceId, people } = await workspaceOf(world, "owner", "admin", "member");
    const [owner, admin, member] = [only(people, 0), only(people, 1), only(people, 2)];
    const token = await seedApiToken(database(), { accountId: owner.account.id, workspaceId, scope: "read-write" });
    const before = await content(workspaceId);

    const byAdmin = await send(world, "DELETE", WORKSPACE, { cookie: admin.cookie });
    const byMember = await send(world, "DELETE", WORKSPACE, { cookie: member.cookie });
    const stale = await send(world, "DELETE", WORKSPACE, { cookie: owner.stale });
    const byToken = await send(world, "DELETE", WORKSPACE, bearer(token.value));
    const anonymous = await send(world, "DELETE", WORKSPACE, {});

    expect([byAdmin.status, byMember.status, stale.status, byToken.status, anonymous.status]).toEqual([403, 403, 401, 403, 401]);
    expect(await problem(byAdmin)).toMatchObject({ code: "forbidden" });
    expect(await problem(stale)).toMatchObject({ code: "reauth_required" });
    expect(await problem(byToken)).toMatchObject({ code: "forbidden" });
    expect(await markedAt(workspaceId)).toBeNull();
    expect(await content(workspaceId)).toBe(before);
    expect(await jobs(JOB)).toEqual([]);
    expect(await auditActions(workspaceId)).toEqual([]);
  });

  it("refuses a request that did not come from the application itself, and changes nothing", async () => {
    const world = serve();
    const { workspaceId, people } = await workspaceOf(world, "owner");
    const before = await content(workspaceId);

    const response = await send(world, "DELETE", WORKSPACE, { cookie: only(people, 0).cookie, origin: "https://evil.example" });

    expect(response.status).toBe(403);
    expect(await problem(response)).toMatchObject({ code: "cross_site_request" });
    expect(await content(workspaceId)).toBe(before);
  });
});

describe("DELETE /api/v1/workspace with a deletion guard", () => {
  it("asks the guard for the workspace and the account that asks, requested by a member, and proceeds when it allows", async () => {
    const asked: DeletionGuardInput[] = [];
    const world = serve([
      guardModule((input) => {
        asked.push(input);
        return HookResult.allow();
      }),
    ]);
    const { workspaceId, people } = await workspaceOf(world, "owner");
    const owner = only(people, 0);

    expect((await send(world, "DELETE", WORKSPACE, { cookie: owner.cookie })).status).toBe(202);

    expect(asked).toEqual([{ kind: "workspace", workspaceId, accountId: owner.account.id, requestedBy: "member" }]);
    expect(await markedAt(workspaceId)).toBeInstanceOf(Date);
  });

  it("answers 409 billing_active when the guard refuses, and leaves the workspace visible and its rows, tokens, sessions, jobs and audit log untouched", async () => {
    const world = serve([guardModule(() => HookResult.refuse("billing_active"))]);
    const { workspaceId, people } = await workspaceOf(world, "owner", "member");
    const [owner, member] = [only(people, 0), only(people, 1)];
    const token = await seedApiToken(database(), { accountId: member.account.id, workspaceId });
    const before = await content(workspaceId);

    const response = await send(world, "DELETE", WORKSPACE, { cookie: owner.cookie });

    expect(response.status).toBe(409);
    expect(await problem(response)).toMatchObject({ code: "billing_active" });
    expect(await markedAt(workspaceId)).toBeNull();
    expect(await content(workspaceId)).toBe(before);
    expect(await jobs(JOB)).toEqual([]);
    expect(await auditActions(workspaceId)).toEqual([]);
    for (const as of [owner, member]) {
      expect((await send(world, "GET", WORKSPACE, { cookie: as.cookie })).status).toBe(200);
    }
    expect((await send(world, "GET", WORKSPACE, bearer(token.value))).status).toBe(200);
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
      const { workspaceId, people } = await workspaceOf(world, "owner");
      const before = await content(workspaceId);

      const response = await send(world, "DELETE", WORKSPACE, { cookie: only(people, 0).cookie });

      expect(response.status).toBe(503);
      expect(await problem(response)).toMatchObject({ code: "unavailable" });
      expect(await markedAt(workspaceId)).toBeNull();
      expect(await content(workspaceId)).toBe(before);
      expect(await jobs(JOB)).toEqual([]);
      expect(await auditActions(workspaceId)).toEqual([]);
    }
  });

  it("fails closed for a guard that answers with a code it did not declare", async () => {
    const undeclared: ServerModule = {
      name: "test/undeclared",
      hooks: { deletionGuard: () => HookResult.refuse("billing_active" satisfies DeletionRefusalCode) },
      hookRefusals: { deletionGuard: [] },
      register: () => ({}),
    };
    const world = serve([undeclared]);
    const { workspaceId, people } = await workspaceOf(world, "owner");

    const response = await send(world, "DELETE", WORKSPACE, { cookie: only(people, 0).cookie });

    expect(response.status).toBe(503);
    expect(await markedAt(workspaceId)).toBeNull();
  });
});

describe("the worker the CE image starts, after DELETE /api/v1/workspace", () => {
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

  it("registers the workspace.delete job without any module", () => {
    expect(ceWorker().jobs.map((job) => job.name)).toContain(JOB);
  });

  it("removes every row of the workspace and the workspace itself, announces workspace.deleted once, and touches no other workspace", async () => {
    const world = serve();
    const { workspaceId, people } = await workspaceOf(world, "owner", "admin", "member");
    const owner = only(people, 0);
    const other = await workspaceOf(world, "owner", "member");
    await seedMembership(database(), { workspaceId, accountId: only(other.people, 1).account.id, role: "member" });
    await seedApiToken(database(), { accountId: owner.account.id, workspaceId });
    await seedApiToken(database(), { accountId: only(other.people, 0).account.id, workspaceId: other.workspaceId });
    const before = await content(other.workspaceId);
    expect((await send(world, "DELETE", WORKSPACE, { cookie: owner.cookie })).status).toBe(202);
    expect((await counts(workspaceId)).members).toBe(4);

    workers.push(await ceWorker().start());

    await until(async () => (await counts(workspaceId)).workspaces === 0, 20_000, "the job to delete the workspace");
    expect(await counts(workspaceId)).toEqual({ workspaces: 0, members: 0, settings: 0, tokens: 0, events: 0 });
    expect(await content(other.workspaceId)).toBe(before);
    await until(async () => (await jobs(EVENT)).length > 0, 10_000, "workspace.deleted to be queued");
    expect(await jobs(EVENT)).toEqual([{ eventId: expect.any(String) as string, workspaceId }]);
    // The accounts survive: only the memberships go.
    expect(await sessionRows(database(), owner.account.id)).not.toEqual([]);
  });
});
