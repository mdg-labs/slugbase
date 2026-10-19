import { useTestDatabase } from "@slugbase/testing/db";
import type { AuthStore } from "@slugbase/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAccountOnlyTenantResolver } from "../../src/auth/tenant-resolver.ts";
import { createServer, type Authenticator, type Server } from "../../src/create-server.ts";
import { seedAccount, seedMembership, seedWorkspace, sessionRows, setActiveWorkspace, storeFor, workspaceChecksum, type SeededAccount } from "../auth/support.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { adapters, recordingLogger, serverConfig } from "../support.ts";

// GET and PATCH /api/v1/workspace and GET and PATCH /api/v1/workspace/settings through the whole chain over the
// migrated database (doc 04 sections 2.4 and 10.4, doc 02 sections 3.1 and 10, doc 05 section 2.2, doc 10 T1,
// T2 and T3). The failure scenarios: a member who renames the workspace or changes its settings, a rename made
// against an older version that overwrites a newer name, a token bound to A that reads or changes the settings
// of B, a change without its audit event or an audit event without its change, and a request that acts in a
// workspace other than the one it is bound to.

const WORKSPACE = "/api/v1/workspace";
const SETTINGS = "/api/v1/workspace/settings";
const SESSION_COOKIE = "__Host-slugbase_session";
const HOOK_TIMEOUT_MS = 300_000;

const database = useTestDatabase();
let store: AuthStore;

beforeAll(() => {
  store = storeFor(database());
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await store.close();
});

/** An API token for an account and a workspace: `Bearer token:<read|read-write>:<account>:<workspace>`. */
const bearer: Authenticator = {
  credential: "bearer",
  authenticate: (authorization) => {
    const [, scope, accountId, workspaceId] = /^Bearer token:(read|read-write):([^:]+):([^:]+)$/.exec(authorization) ?? [];
    return Promise.resolve(
      (scope !== "read" && scope !== "read-write") || accountId === undefined || workspaceId === undefined ? undefined : { kind: "api-token", accountId, workspaceId, scope },
    );
  },
};

interface World {
  readonly server: Server;
  readonly origin: string;
}

function serve(): World {
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
    modules: [{ name: "bearer", register: () => ({ routes: [], authenticators: [bearer] }) }],
    migrations: [],
    logger: recordingLogger(),
    database: tenantDatabase(database()),
    authStore: store,
  });
  return { server, origin: config.APP_ORIGIN };
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
  readonly cookie: string;
  readonly sessionId: string;
}

async function person(world: World): Promise<Person> {
  const account = await seedAccount(database(), { emailVerified: true });
  const response = await send(world, "POST", "/api/v1/auth/login", {}, { email: account.email, password: account.password, remember: false });
  const token = new RegExp(`^${SESSION_COOKIE}=([A-Za-z0-9_-]{43});`).exec(response.headers.get("set-cookie") ?? "")?.[1];
  if (response.status !== 200 || token === undefined) {
    throw new Error(`could not sign in: ${String(response.status)}`);
  }
  const sessionId = (await sessionRows(database(), account.id))[0]?.id;
  if (sessionId === undefined) {
    throw new Error("the account has no session");
  }
  return { account, cookie: `${SESSION_COOKIE}=${token}`, sessionId };
}

/** A workspace with its settings row, as creating one makes it. */
async function workspaceWith(options: { name?: string; aiEnabled?: boolean } = {}): Promise<string> {
  const id = await seedWorkspace(database(), options.name === undefined ? {} : { name: options.name });
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`INSERT INTO workspace_settings (workspace_id, ai_enabled) VALUES (${id}, ${options.aiEnabled ?? true})`;
  });
  return id;
}

/** A person who is a member of a new workspace with the role, acting in it. */
async function memberOf(world: World, role: "owner" | "admin" | "member", options: { name?: string; aiEnabled?: boolean } = {}): Promise<Person & { readonly workspaceId: string }> {
  const as = await person(world);
  const workspaceId = await workspaceWith(options);
  await seedMembership(database(), { workspaceId, accountId: as.account.id, role });
  await setActiveWorkspace(database(), as.sessionId, workspaceId);
  return { ...as, workspaceId };
}

async function problem(response: Response): Promise<Record<string, unknown>> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return (await response.json()) as Record<string, unknown>;
}

interface WorkspaceBody {
  id: string;
  name: string;
  role: string;
  memberCount: number;
  createdAt: string;
  version: number;
}

async function stored(workspaceId: string): Promise<{ name: string; version: number }> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ name: string; version: number }[]>`SELECT name, version FROM workspaces WHERE id = ${workspaceId}`;
  });
  const row = rows[0];
  if (row === undefined) {
    throw new Error("no such workspace");
  }
  return row;
}

async function storedSettings(workspaceId: string): Promise<{ aiEnabled: boolean; updatedBy: string | null }> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ ai_enabled: boolean; updated_by: string | null }[]>`SELECT ai_enabled, updated_by FROM workspace_settings WHERE workspace_id = ${workspaceId}`;
  });
  const row = rows[0];
  if (row === undefined) {
    throw new Error("no settings");
  }
  return { aiEnabled: row.ai_enabled, updatedBy: row.updated_by };
}

interface AuditRow {
  action: string;
  actor_type: string;
  actor_account_id: string | null;
  actor_label: string;
  actor_token_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
}

async function auditOf(workspaceId: string): Promise<AuditRow[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<AuditRow[]>`
      SELECT action, actor_type, actor_account_id, actor_label, actor_token_id, entity_type, entity_id, metadata, host(ip_prefix) AS ip
      FROM audit_events WHERE workspace_id = ${workspaceId} ORDER BY created_at, id`;
  });
  return [...rows];
}

/**
 * A digest of the workspace's row, its settings and its audit events, read as slugbase_system, so a change by any path is
 * seen. The members are left out: a request moves the `last_active_at` of its own membership, which is not what these
 * operations change.
 */
async function contentOf(workspaceId: string): Promise<string> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ digest: string }[]>`
      SELECT md5(
        coalesce((SELECT string_agg(w::text, '|') FROM workspaces w WHERE w.id = ${workspaceId}), '') ||
        coalesce((SELECT string_agg(s::text, '|') FROM workspace_settings s WHERE s.workspace_id = ${workspaceId}), '') ||
        coalesce((SELECT string_agg(e::text, '|' ORDER BY e.id) FROM audit_events e WHERE e.workspace_id = ${workspaceId}), '')
      ) AS digest`;
  });
  return rows[0]?.digest ?? "";
}

/** The content of a workspace the request does not act in, and its members: nothing of it may move. */
async function everythingOf(workspaceId: string): Promise<string> {
  return `${await workspaceChecksum(database(), workspaceId)}/${await contentOf(workspaceId)}`;
}

const asToken = (scope: "read" | "read-write", accountId: string, workspaceId: string): Record<string, string> => ({ authorization: `Bearer token:${scope}:${accountId}:${workspaceId}` });

describe("GET /api/v1/workspace", () => {
  it("returns the workspace the session acts in with the caller's role, the member count, the creation time and the version, and an ETag", async () => {
    const world = serve();
    const admin = await memberOf(world, "admin", { name: "Research" });
    const other = await person(world);
    await seedMembership(database(), { workspaceId: admin.workspaceId, accountId: other.account.id, role: "owner" });

    const response = await send(world, "GET", WORKSPACE, { cookie: admin.cookie });

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe('"1"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      id: admin.workspaceId,
      name: "Research",
      role: "admin",
      memberCount: 2,
      createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/) as string,
      version: 1,
    });
  });

  it("is callable with a read-scope token, which acts in its own workspace and never in another the account belongs to", async () => {
    const world = serve();
    const as = await memberOf(world, "member", { name: "Bound" });
    const elsewhere = await workspaceWith({ name: "Elsewhere" });
    await seedMembership(database(), { workspaceId: elsewhere, accountId: as.account.id, role: "owner" });
    await setActiveWorkspace(database(), as.sessionId, elsewhere);

    const bound = await send(world, "GET", WORKSPACE, asToken("read", as.account.id, as.workspaceId));
    const session = await send(world, "GET", WORKSPACE, { cookie: as.cookie });

    expect(bound.status).toBe(200);
    expect(await bound.json()).toMatchObject({ id: as.workspaceId, name: "Bound", role: "member" });
    expect(await session.json()).toMatchObject({ id: elsewhere, name: "Elsewhere", role: "owner" });
  });

  it("answers a token of an account that is not a member of the workspace it names with 401, and shows nothing of that workspace", async () => {
    const world = serve();
    const as = await person(world);
    const theirs = await workspaceWith({ name: "Theirs" });

    const response = await send(world, "GET", WORKSPACE, asToken("read", as.account.id, theirs));

    expect(response.status).toBe(401);
    expect(JSON.stringify(await problem(response))).not.toContain("Theirs");
  });

  it("answers 404 for an account with no workspace and for one whose workspace is being deleted, and 401 without a session", async () => {
    const world = serve();
    const alone = await person(world);
    const leaving = await person(world);
    const going = await seedWorkspace(database(), { name: "Going", deleting: true });
    await seedMembership(database(), { workspaceId: going, accountId: leaving.account.id, role: "owner" });
    await setActiveWorkspace(database(), leaving.sessionId, going);

    expect((await send(world, "GET", WORKSPACE, { cookie: alone.cookie })).status).toBe(404);
    expect((await send(world, "GET", WORKSPACE, { cookie: leaving.cookie })).status).toBe(404);
    const anonymous = await send(world, "GET", WORKSPACE, {});
    expect(anonymous.status).toBe(401);
    expect(await problem(anonymous)).toMatchObject({ code: "unauthenticated" });
  });
});

describe("PATCH /api/v1/workspace", () => {
  it("lets an owner and an admin rename, moves the version, answers the new ETag and writes workspace.renamed with the old and the new name", async () => {
    const world = serve();
    const owner = await memberOf(world, "owner", { name: "Before" });
    const admin = await person(world);
    await seedMembership(database(), { workspaceId: owner.workspaceId, accountId: admin.account.id, role: "admin" });
    await setActiveWorkspace(database(), admin.sessionId, owner.workspaceId);

    const first = await send(world, "PATCH", WORKSPACE, { cookie: owner.cookie, "x-forwarded-for": "203.0.113.9" }, { name: "  Middle  " });
    const second = await send(world, "PATCH", WORKSPACE, { cookie: admin.cookie }, { name: "After" });

    expect(first.status).toBe(200);
    expect(first.headers.get("etag")).toBe('"2"');
    expect(await first.json()).toMatchObject({ id: owner.workspaceId, name: "Middle", role: "owner", memberCount: 2, version: 2 });
    expect(second.status).toBe(200);
    expect(second.headers.get("etag")).toBe('"3"');
    expect(await second.json()).toMatchObject({ name: "After", role: "admin", version: 3 });
    expect(await stored(owner.workspaceId)).toEqual({ name: "After", version: 3 });
    expect(await auditOf(owner.workspaceId)).toEqual([
      {
        action: "workspace.renamed",
        actor_type: "account",
        actor_account_id: owner.account.id,
        actor_label: "Test account",
        actor_token_id: null,
        entity_type: "workspace",
        entity_id: owner.workspaceId,
        metadata: { from: "Before", to: "Middle" },
        ip: null,
      },
      {
        action: "workspace.renamed",
        actor_type: "account",
        actor_account_id: admin.account.id,
        actor_label: "Test account",
        actor_token_id: null,
        entity_type: "workspace",
        entity_id: owner.workspaceId,
        metadata: { from: "Middle", to: "After" },
        ip: null,
      },
    ]);
  });

  it("refuses a plain member with 403 forbidden, and the workspace, its version and its audit log stay as they were", async () => {
    const world = serve();
    const member = await memberOf(world, "member", { name: "Mine" });
    const before = await contentOf(member.workspaceId);

    const response = await send(world, "PATCH", WORKSPACE, { cookie: member.cookie }, { name: "Taken over" });

    expect(response.status).toBe(403);
    expect(await problem(response)).toMatchObject({ code: "forbidden", status: 403 });
    expect(await stored(member.workspaceId)).toEqual({ name: "Mine", version: 1 });
    expect(await contentOf(member.workspaceId)).toBe(before);
    expect(await auditOf(member.workspaceId)).toEqual([]);
  });

  it("answers 404 to an account that is not a member of any workspace, and 401 without a session", async () => {
    const world = serve();
    const outsider = await person(world);
    const theirs = await workspaceWith({ name: "Theirs" });
    const before = await contentOf(theirs);
    await setActiveWorkspace(database(), outsider.sessionId, theirs);

    const response = await send(world, "PATCH", WORKSPACE, { cookie: outsider.cookie }, { name: "Mine now" });
    const anonymous = await send(world, "PATCH", WORKSPACE, {}, { name: "Mine now" });

    expect(response.status).toBe(404);
    expect(await problem(response)).toMatchObject({ code: "not_found" });
    expect(anonymous.status).toBe(401);
    expect(await stored(theirs)).toEqual({ name: "Theirs", version: 1 });
    expect(await contentOf(theirs)).toBe(before);
  });

  it("refuses a stale If-Match with 412 precondition_failed, so a newer name is not overwritten, and accepts the current ETag", async () => {
    const world = serve();
    const owner = await memberOf(world, "owner", { name: "First" });
    const read = await send(world, "GET", WORKSPACE, { cookie: owner.cookie });
    const etag = read.headers.get("etag");
    expect(etag).toBe('"1"');
    expect((await send(world, "PATCH", WORKSPACE, { cookie: owner.cookie, "if-match": etag ?? "" }, { name: "Second" })).status).toBe(200);
    const before = await contentOf(owner.workspaceId);

    const stale = await send(world, "PATCH", WORKSPACE, { cookie: owner.cookie, "if-match": etag ?? "" }, { name: "Overwrite" });

    expect(stale.status).toBe(412);
    expect(await problem(stale)).toMatchObject({ code: "precondition_failed", status: 412 });
    expect(await stored(owner.workspaceId)).toEqual({ name: "Second", version: 2 });
    expect(await contentOf(owner.workspaceId)).toBe(before);
    const current = await send(world, "PATCH", WORKSPACE, { cookie: owner.cookie, "if-match": '"2"' }, { name: "Third" });
    expect(current.status).toBe(200);
    expect(await stored(owner.workspaceId)).toEqual({ name: "Third", version: 3 });
  });

  it("reads If-Match as strong entity tags: * and a list holding the version pass, and a weak tag, a malformed value and an empty one are refused", async () => {
    const world = serve();
    const owner = await memberOf(world, "owner", { name: "Start" });

    for (const refused of ['W/"1"', "1", '"one"', '""', "", '"1', '"2"', '"0001x"']) {
      const response = await send(world, "PATCH", WORKSPACE, { cookie: owner.cookie, "if-match": refused }, { name: "Refused" });
      expect(response.status, `If-Match: ${refused}`).toBe(412);
    }
    expect(await stored(owner.workspaceId)).toEqual({ name: "Start", version: 1 });
    expect((await send(world, "PATCH", WORKSPACE, { cookie: owner.cookie, "if-match": "*" }, { name: "Star" })).status).toBe(200);
    expect((await send(world, "PATCH", WORKSPACE, { cookie: owner.cookie, "if-match": '"7", "2"' }, { name: "List" })).status).toBe(200);
    expect((await send(world, "PATCH", WORKSPACE, { cookie: owner.cookie }, { name: "None" })).status).toBe(200);
    expect(await stored(owner.workspaceId)).toEqual({ name: "None", version: 4 });
  });

  it("answers 200 and writes nothing for the name the workspace already has", async () => {
    const world = serve();
    const owner = await memberOf(world, "owner", { name: "Same" });

    const response = await send(world, "PATCH", WORKSPACE, { cookie: owner.cookie, "if-match": '"1"' }, { name: " Same " });

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe('"1"');
    expect(await stored(owner.workspaceId)).toEqual({ name: "Same", version: 1 });
    expect(await auditOf(owner.workspaceId)).toEqual([]);
  });

  it("refuses a name that is blank, longer than 64 characters or not a string, and a field the operation does not declare, with 422", async () => {
    const world = serve();
    const owner = await memberOf(world, "owner", { name: "Valid" });
    const before = await contentOf(owner.workspaceId);

    for (const body of [{ name: "" }, { name: "   " }, { name: "x".repeat(65) }, { name: 7 }, { name: null }, {}, { name: "Ok", version: 9 }, { name: "Ok", id: owner.workspaceId }]) {
      const response = await send(world, "PATCH", WORKSPACE, { cookie: owner.cookie }, body);
      expect(response.status, JSON.stringify(body)).toBe(422);
      expect(await problem(response)).toMatchObject({ code: "validation_failed" });
    }
    expect(await stored(owner.workspaceId)).toEqual({ name: "Valid", version: 1 });
    expect(await contentOf(owner.workspaceId)).toBe(before);
  });

  it("accepts 64 characters, counted as characters and not as bytes", async () => {
    const world = serve();
    const owner = await memberOf(world, "owner");

    const response = await send(world, "PATCH", WORKSPACE, { cookie: owner.cookie }, { name: "😀".repeat(64) });

    expect(response.status).toBe(200);
    expect(((await response.json()) as WorkspaceBody).name).toBe("😀".repeat(64));
  });

  it("refuses an API token of any scope with 403 forbidden and a request from another origin with 403 cross_site_request, and writes nothing", async () => {
    const world = serve();
    const owner = await memberOf(world, "owner", { name: "Safe" });
    const before = await contentOf(owner.workspaceId);

    for (const scope of ["read", "read-write"] as const) {
      const response = await send(world, "PATCH", WORKSPACE, asToken(scope, owner.account.id, owner.workspaceId), { name: "Token" });
      expect(response.status).toBe(403);
      expect(await problem(response)).toMatchObject({ code: "forbidden" });
    }
    const foreign = await send(world, "PATCH", WORKSPACE, { cookie: owner.cookie, origin: "https://elsewhere.example" }, { name: "Elsewhere" });
    expect(foreign.status).toBe(403);
    expect(await problem(foreign)).toMatchObject({ code: "cross_site_request" });
    expect(await stored(owner.workspaceId)).toEqual({ name: "Safe", version: 1 });
    expect(await contentOf(owner.workspaceId)).toBe(before);
  });

  it("renames only the workspace the session acts in and leaves every other workspace of the account as it was", async () => {
    const world = serve();
    const owner = await memberOf(world, "owner", { name: "Active" });
    const other = await workspaceWith({ name: "Other" });
    await seedMembership(database(), { workspaceId: other, accountId: owner.account.id, role: "owner" });
    const before = await everythingOf(other);

    expect((await send(world, "PATCH", WORKSPACE, { cookie: owner.cookie }, { name: "Renamed" })).status).toBe(200);

    expect(await stored(other)).toEqual({ name: "Other", version: 1 });
    expect(await everythingOf(other)).toBe(before);
  });

  it("leaves the name and the version as they were when the audit event cannot be written", async () => {
    const world = serve();
    const owner = await memberOf(world, "owner", { name: "Atomic" });
    await database().owner`REVOKE INSERT ON audit_events FROM slugbase_app`;
    try {
      const response = await send(world, "PATCH", WORKSPACE, { cookie: owner.cookie }, { name: "Half" });
      expect(response.status).toBe(500);
    } finally {
      await database().owner`GRANT INSERT ON audit_events TO slugbase_app`;
    }

    expect(await stored(owner.workspaceId)).toEqual({ name: "Atomic", version: 1 });
    expect(await auditOf(owner.workspaceId)).toEqual([]);
  });

  it("lets only one of two concurrent renames made against the same version succeed", async () => {
    const world = serve();
    const owner = await memberOf(world, "owner", { name: "Race" });

    const responses = await Promise.all(
      ["Left", "Right"].map((name) => send(world, "PATCH", WORKSPACE, { cookie: owner.cookie, "if-match": '"1"' }, { name })),
    );

    expect(responses.map((response) => response.status).sort()).toEqual([200, 412]);
    expect((await stored(owner.workspaceId)).version).toBe(2);
    expect(await auditOf(owner.workspaceId)).toHaveLength(1);
  });
});

describe("GET /api/v1/workspace/settings", () => {
  it("shows the settings to an owner and an admin", async () => {
    const world = serve();
    const owner = await memberOf(world, "owner", { aiEnabled: false });
    const admin = await person(world);
    await seedMembership(database(), { workspaceId: owner.workspaceId, accountId: admin.account.id, role: "admin" });
    await setActiveWorkspace(database(), admin.sessionId, owner.workspaceId);

    const asOwner = await send(world, "GET", SETTINGS, { cookie: owner.cookie });
    const asAdmin = await send(world, "GET", SETTINGS, { cookie: admin.cookie });

    expect(asOwner.status).toBe(200);
    expect(await asOwner.json()).toEqual({ aiEnabled: false });
    expect(await asAdmin.json()).toEqual({ aiEnabled: false });
  });

  it("defaults to AI suggestions on", async () => {
    const world = serve();
    const owner = await memberOf(world, "owner");

    expect(await (await send(world, "GET", SETTINGS, { cookie: owner.cookie })).json()).toEqual({ aiEnabled: true });
  });

  it("refuses a plain member with 403 forbidden and an account without a workspace with 404", async () => {
    const world = serve();
    const member = await memberOf(world, "member", { aiEnabled: false });
    const alone = await person(world);

    const refused = await send(world, "GET", SETTINGS, { cookie: member.cookie });
    const none = await send(world, "GET", SETTINGS, { cookie: alone.cookie });

    expect(refused.status).toBe(403);
    const refusal = JSON.stringify(await problem(refused));
    expect(refusal).toContain("forbidden");
    expect(refusal).not.toContain("aiEnabled");
    expect(none.status).toBe(404);
  });

  it("cannot be read by a token, bound to the workspace or not, and a session shows the settings of its own workspace and never another's", async () => {
    const world = serve();
    const a = await memberOf(world, "owner", { name: "A", aiEnabled: true });
    const b = await workspaceWith({ name: "B", aiEnabled: false });
    await seedMembership(database(), { workspaceId: b, accountId: a.account.id, role: "owner" });

    for (const scope of ["read", "read-write"] as const) {
      for (const workspaceId of [a.workspaceId, b]) {
        const response = await send(world, "GET", SETTINGS, asToken(scope, a.account.id, workspaceId));
        expect(response.status).toBe(403);
        expect(await problem(response)).toMatchObject({ code: "forbidden" });
      }
    }
    const own = await send(world, "GET", SETTINGS, { cookie: a.cookie });
    expect(await own.json()).toEqual({ aiEnabled: true });
    const stranger = await memberOf(world, "owner", { name: "C", aiEnabled: true });
    expect(await (await send(world, "GET", SETTINGS, { cookie: stranger.cookie })).json()).toEqual({ aiEnabled: true });
  });

  it("answers 404 when the workspace has no settings row", async () => {
    const world = serve();
    const as = await person(world);
    const bare = await seedWorkspace(database(), { name: "Bare" });
    await seedMembership(database(), { workspaceId: bare, accountId: as.account.id, role: "owner" });
    await setActiveWorkspace(database(), as.sessionId, bare);

    expect((await send(world, "GET", SETTINGS, { cookie: as.cookie })).status).toBe(404);
  });
});

describe("PATCH /api/v1/workspace/settings", () => {
  it("lets an admin turn AI suggestions off, answers the new settings and writes workspace.settings_changed with the setting and its old and new value", async () => {
    const world = serve();
    const owner = await memberOf(world, "owner");
    const admin = await person(world);
    await seedMembership(database(), { workspaceId: owner.workspaceId, accountId: admin.account.id, role: "admin" });
    await setActiveWorkspace(database(), admin.sessionId, owner.workspaceId);

    const off = await send(world, "PATCH", SETTINGS, { cookie: admin.cookie }, { aiEnabled: false });
    const on = await send(world, "PATCH", SETTINGS, { cookie: owner.cookie }, { aiEnabled: true });

    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ aiEnabled: false });
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ aiEnabled: true });
    expect(await storedSettings(owner.workspaceId)).toEqual({ aiEnabled: true, updatedBy: owner.account.id });
    expect((await auditOf(owner.workspaceId)).map(({ action, actor_account_id, entity_type, entity_id, metadata }) => ({ action, actor_account_id, entity_type, entity_id, metadata }))).toEqual([
      {
        action: "workspace.settings_changed",
        actor_account_id: admin.account.id,
        entity_type: "workspace",
        entity_id: owner.workspaceId,
        metadata: { setting: "aiEnabled", from: "true", to: "false" },
      },
      {
        action: "workspace.settings_changed",
        actor_account_id: owner.account.id,
        entity_type: "workspace",
        entity_id: owner.workspaceId,
        metadata: { setting: "aiEnabled", from: "false", to: "true" },
      },
    ]);
  });

  it("writes no audit event for a request that changes no value", async () => {
    const world = serve();
    const owner = await memberOf(world, "owner", { aiEnabled: true });

    for (const body of [{ aiEnabled: true }, {}]) {
      const response = await send(world, "PATCH", SETTINGS, { cookie: owner.cookie }, body);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ aiEnabled: true });
    }
    expect(await auditOf(owner.workspaceId)).toEqual([]);
  });

  it("refuses an unknown field, a value of the wrong type and a field of another table with 422, and changes nothing", async () => {
    const world = serve();
    const owner = await memberOf(world, "owner", { aiEnabled: true });
    const before = await contentOf(owner.workspaceId);

    for (const body of [{ unknown: 1 }, { aiEnabled: "no" }, { aiEnabled: 0 }, { aiEnabled: null }, { aiEnabled: false, name: "Renamed" }, { aiEnabled: false, workspaceId: owner.workspaceId }, { aiEnabled: false, updatedBy: owner.account.id }]) {
      const response = await send(world, "PATCH", SETTINGS, { cookie: owner.cookie }, body);
      expect(response.status, JSON.stringify(body)).toBe(422);
      expect(await problem(response)).toMatchObject({ code: "validation_failed" });
    }
    expect(await storedSettings(owner.workspaceId)).toEqual({ aiEnabled: true, updatedBy: null });
    expect(await contentOf(owner.workspaceId)).toBe(before);
  });

  it("refuses a plain member with 403 forbidden, a token of any scope with 403, another origin with 403 cross_site_request and a request with no workspace with 404", async () => {
    const world = serve();
    const member = await memberOf(world, "member", { aiEnabled: true });
    const owner = await memberOf(world, "owner", { aiEnabled: true });
    const alone = await person(world);
    const before = await contentOf(member.workspaceId);

    const asMember = await send(world, "PATCH", SETTINGS, { cookie: member.cookie }, { aiEnabled: false });
    expect(asMember.status).toBe(403);
    expect(await problem(asMember)).toMatchObject({ code: "forbidden" });
    for (const scope of ["read", "read-write"] as const) {
      const response = await send(world, "PATCH", SETTINGS, asToken(scope, owner.account.id, owner.workspaceId), { aiEnabled: false });
      expect(response.status).toBe(403);
      expect(await problem(response)).toMatchObject({ code: "forbidden" });
    }
    const foreign = await send(world, "PATCH", SETTINGS, { cookie: owner.cookie, origin: "https://elsewhere.example" }, { aiEnabled: false });
    expect(foreign.status).toBe(403);
    expect(await problem(foreign)).toMatchObject({ code: "cross_site_request" });
    expect((await send(world, "PATCH", SETTINGS, { cookie: alone.cookie }, { aiEnabled: false })).status).toBe(404);

    expect(await storedSettings(member.workspaceId)).toEqual({ aiEnabled: true, updatedBy: null });
    expect(await storedSettings(owner.workspaceId)).toEqual({ aiEnabled: true, updatedBy: null });
    expect(await contentOf(member.workspaceId)).toBe(before);
  });

  it("changes the settings of the workspace the session acts in only", async () => {
    const world = serve();
    const a = await memberOf(world, "owner", { name: "A", aiEnabled: true });
    const b = await workspaceWith({ name: "B", aiEnabled: true });
    await seedMembership(database(), { workspaceId: b, accountId: a.account.id, role: "owner" });
    const before = await everythingOf(b);

    expect((await send(world, "PATCH", SETTINGS, { cookie: a.cookie }, { aiEnabled: false })).status).toBe(200);

    expect(await storedSettings(a.workspaceId)).toMatchObject({ aiEnabled: false });
    expect(await storedSettings(b)).toEqual({ aiEnabled: true, updatedBy: null });
    expect(await everythingOf(b)).toBe(before);
  });

  it("leaves the setting as it was when the audit event cannot be written", async () => {
    const world = serve();
    const owner = await memberOf(world, "owner", { aiEnabled: true });
    await database().owner`REVOKE INSERT ON audit_events FROM slugbase_app`;
    try {
      const response = await send(world, "PATCH", SETTINGS, { cookie: owner.cookie }, { aiEnabled: false });
      expect(response.status).toBe(500);
    } finally {
      await database().owner`GRANT INSERT ON audit_events TO slugbase_app`;
    }

    expect(await storedSettings(owner.workspaceId)).toEqual({ aiEnabled: true, updatedBy: null });
    expect(await auditOf(owner.workspaceId)).toEqual([]);
  });
});
