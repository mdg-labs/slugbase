import { useTestDatabase } from "@slugbase/testing/db";
import type { AuthStore } from "@slugbase/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAccountOnlyTenantResolver } from "../../src/auth/tenant-resolver.ts";
import { createServer, type Authenticator, type Server } from "../../src/create-server.ts";
import { runMigrations } from "../../src/migrate/index.ts";
import { seedAccount, seedMembership, seedWorkspace, sessionRows, setActiveWorkspace, storeFor, workspaceChecksum, type SeededAccount } from "../auth/support.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { urlOf } from "../migrate/support.ts";
import { adapters, recordingLogger, serverConfig } from "../support.ts";

// GET /api/v1/workspaces and POST /api/v1/workspaces through the whole chain over the migrated database (doc
// 04 section 10.4, doc 02 section 3.2, doc 05 sections 2.2 and 2.9, doc 10 T1). The failure scenarios: a
// workspace made for an account other than the one that asked (which would get round the limit on the
// workspaces an account owns), one made where the deployment does not allow it or for an account that has not
// verified its address, a workspace that exists without its audit event, its event job or its owner, a list
// or a count that reaches a workspace the account does not belong to, and an audit event that carries
// anything but the workspace's name.

const WORKSPACES = "/api/v1/workspaces";
const ME = "/api/v1/me";
const SESSION_COOKIE = "__Host-slugbase_session";
const HOOK_TIMEOUT_MS = 300_000;

const database = useTestDatabase();
let store: AuthStore;

beforeAll(async () => {
  store = storeFor(database());
  // Creating a workspace queues the workspace.created event, so the queues exist, as they do once the image entrypoint has run migrate.
  await runMigrations({ url: urlOf(database().owner) });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await store.close();
});

beforeEach(async () => {
  await database().owner`DELETE FROM pgboss.job WHERE name = 'event.workspace.created'`;
});

/** An API token for an account and a workspace: `Bearer token:<account>:<workspace>`. */
const bearer: Authenticator = {
  credential: "bearer",
  authenticate: (authorization) => {
    const [, accountId, workspaceId] = /^Bearer token:([^:]+):([^:]+)$/.exec(authorization) ?? [];
    return Promise.resolve(accountId === undefined || workspaceId === undefined ? undefined : { kind: "api-token", accountId, workspaceId, scope: "read-write" });
  },
};

interface World {
  readonly server: Server;
  readonly origin: string;
}

function serve(options: { allow?: boolean; env?: Record<string, string> } = {}): World {
  const config = serverConfig({
    NODE_ENV: "test",
    DATABASE_URL: appUrl(database()),
    RATE_LIMIT_LOGIN_IP: "1000/min",
    RATE_LIMIT_LOGIN_EMAIL: "1000/hour",
    RATE_LIMIT_WRITE_IP: "1000/min",
    RATE_LIMIT_WRITE_ACCOUNT: "1000/min",
    RATE_LIMIT_READ_IP: "1000/min",
    RATE_LIMIT_READ_ACCOUNT: "1000/min",
    ...options.env,
  });
  const server = createServer({
    config,
    adapters: { ...adapters(config), tenantResolver: createAccountOnlyTenantResolver() },
    modules: [{ name: "bearer", register: () => ({ routes: [], authenticators: [bearer] }) }],
    migrations: [],
    logger: recordingLogger(),
    database: tenantDatabase(database()),
    authStore: store,
    ...(options.allow === undefined ? {} : { allowWorkspaceCreation: options.allow }),
  });
  return { server, origin: config.APP_ORIGIN };
}

function send(world: World, method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<Response> {
  // A request that changes state must come from the app's own origin and be JSON, with or without a body.
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

async function person(world: World, options: { verified?: boolean } = {}): Promise<Person> {
  const account = await seedAccount(database(), { emailVerified: options.verified !== false });
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

const list = (world: World, as: Person) => send(world, "GET", WORKSPACES, { cookie: as.cookie });
const create = (world: World, as: Person, body: unknown) => send(world, "POST", WORKSPACES, { cookie: as.cookie }, body);

interface Summary {
  id: string;
  name: string;
  role: string;
  memberCount: number;
}

async function listed(world: World, as: Person): Promise<{ items: Summary[]; canCreate: boolean }> {
  const response = await list(world, as);
  expect(response.status).toBe(200);
  return (await response.json()) as { items: Summary[]; canCreate: boolean };
}

async function problem(response: Response): Promise<Record<string, unknown>> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return (await response.json()) as Record<string, unknown>;
}

interface Written {
  workspaces: number;
  members: number;
  settings: number;
  audit: number;
  jobs: number;
}

/** What creating a workspace writes, counted as the table owner so a row the application cannot see is counted too. */
async function written(): Promise<Written> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<Omit<Written, "jobs">[]>`
      SELECT (SELECT count(*) FROM workspaces)::int AS workspaces,
             (SELECT count(*) FROM workspace_members)::int AS members,
             (SELECT count(*) FROM workspace_settings)::int AS settings,
             (SELECT count(*) FROM audit_events)::int AS audit`;
  });
  const [row] = rows;
  if (row === undefined) {
    throw new Error("the count query returned no row");
  }
  return { ...row, jobs: (await queuedEvents()).length };
}

/** The data of every queued workspace.created event; pgboss is closed to slugbase_system, so the owner reads it. */
async function queuedEvents(): Promise<Record<string, unknown>[]> {
  const rows = await database().owner<{ data: Record<string, unknown> }[]>`SELECT data FROM pgboss.job WHERE name = 'event.workspace.created' ORDER BY created_on, id`;
  return rows.map((row) => row.data);
}

async function ownedWorkspaces(accountId: string): Promise<number> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ n: number }[]>`SELECT count(*)::int AS n FROM workspace_members WHERE account_id = ${accountId}`;
  });
  return rows[0]?.n ?? -1;
}

/** A digest of the workspace's rows in the workspace tables and its audit events, read as slugbase_system. */
async function everythingOf(workspaceId: string): Promise<string> {
  const audit = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ digest: string }[]>`SELECT md5(coalesce(string_agg(e::text, '|' ORDER BY e.id), '')) AS digest FROM audit_events e WHERE e.workspace_id = ${workspaceId}`;
  });
  return `${await workspaceChecksum(database(), workspaceId)}/${audit[0]?.digest ?? ""}`;
}

describe("GET /api/v1/workspaces", () => {
  it("lists the account's workspaces with its role and the number of members, the most recently active first, and no member's identity", async () => {
    const world = serve();
    const alice = await person(world);
    const bob = await seedAccount(database(), { emailVerified: true });
    const mine = await seedWorkspace(database(), { name: "Mine" });
    const shared = await seedWorkspace(database(), { name: "Shared" });
    await seedMembership(database(), { workspaceId: mine, accountId: alice.account.id, role: "owner", lastActiveAt: new Date(Date.now() - 60_000) });
    await seedMembership(database(), { workspaceId: shared, accountId: alice.account.id, role: "member", lastActiveAt: new Date() });
    await seedMembership(database(), { workspaceId: shared, accountId: bob.id, role: "owner" });

    const response = await list(world, alice);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      items: [
        { id: shared, name: "Shared", role: "member", memberCount: 2 },
        { id: mine, name: "Mine", role: "owner", memberCount: 1 },
      ],
      canCreate: false,
    });
    expect(text).not.toContain(bob.id);
    expect(text).not.toContain(bob.email);
  });

  it("is empty for an account without a workspace", async () => {
    const world = serve();
    const alice = await person(world);

    expect(await listed(world, alice)).toEqual({ items: [], canCreate: false });
  });

  it("does not list or count a workspace the account is not a member of, and leaves that workspace as it was", async () => {
    const world = serve({ allow: true });
    const alice = await person(world);
    const stranger = await seedAccount(database(), { emailVerified: true });
    const mine = await seedWorkspace(database(), { name: "Mine" });
    const theirs = await seedWorkspace(database(), { name: "Theirs" });
    await seedMembership(database(), { workspaceId: mine, accountId: alice.account.id, role: "owner" });
    await seedMembership(database(), { workspaceId: theirs, accountId: stranger.id, role: "owner" });
    const before = await everythingOf(theirs);

    const { items } = await listed(world, alice);
    const created = await create(world, alice, { name: "Another of mine" });

    expect(items).toEqual([{ id: mine, name: "Mine", role: "owner", memberCount: 1 }]);
    expect(created.status).toBe(201);
    expect(JSON.stringify(await listed(world, alice))).not.toContain(theirs);
    expect(await everythingOf(theirs)).toBe(before);
  });

  it("reports whether the account can create a workspace: the deployment allows it and the address is verified", async () => {
    const closed = serve();
    const open = serve({ allow: true });
    const verified = await person(open);
    const unverified = await person(open, { verified: false });

    expect((await listed(closed, verified)).canCreate).toBe(false);
    expect((await listed(open, verified)).canCreate).toBe(true);
    expect((await listed(open, unverified)).canCreate).toBe(false);
    expect((await listed(closed, unverified)).canCreate).toBe(false);
  });

  it("answers 401 without a session and refuses an API token, whose operation declares no scope", async () => {
    const world = serve();
    const alice = await person(world);
    const workspaceId = await seedWorkspace(database());
    await seedMembership(database(), { workspaceId, accountId: alice.account.id });

    const anonymous = await send(world, "GET", WORKSPACES, {});
    const token = await send(world, "GET", WORKSPACES, { authorization: `Bearer token:${alice.account.id}:${workspaceId}` });

    expect(anonymous.status).toBe(401);
    expect(await problem(anonymous)).toMatchObject({ code: "unauthenticated" });
    expect(token.status).toBe(403);
    expect(await problem(token)).toMatchObject({ code: "forbidden" });
  });
});

describe("POST /api/v1/workspaces", () => {
  it("creates the workspace with the account as its owner, writes its audit event and queues its event, and answers 201", async () => {
    const world = serve({ allow: true, env: { TRUSTED_PROXY_HOPS: "1" } });
    const alice = await person(world);
    const before = await written();

    const response = await send(world, "POST", WORKSPACES, { cookie: alice.cookie, "x-forwarded-for": "203.0.113.9" }, { name: "  Research  " });

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as Summary;
    expect(body).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/) as string, name: "Research", role: "owner", memberCount: 1 });
    expect(await written()).toEqual({ workspaces: before.workspaces + 1, members: before.members + 1, settings: before.settings + 1, audit: before.audit + 1, jobs: before.jobs + 1 });

    const stored = await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      return {
        workspace: (await tx<Record<string, unknown>[]>`SELECT name, created_by FROM workspaces WHERE id = ${body.id}`)[0],
        members: await tx<Record<string, unknown>[]>`SELECT account_id, role FROM workspace_members WHERE workspace_id = ${body.id}`,
        audit: await tx<Record<string, unknown>[]>`
          SELECT workspace_id, actor_type, actor_account_id, actor_label, actor_token_id, action, entity_type, entity_id, metadata, host(ip_prefix) AS ip
          FROM audit_events WHERE workspace_id = ${body.id}`,
      };
    });
    const job = (await queuedEvents()).find((data) => data["workspaceId"] === body.id);
    expect(stored.workspace).toEqual({ name: "Research", created_by: alice.account.id });
    expect(stored.members).toEqual([{ account_id: alice.account.id, role: "owner" }]);
    expect(stored.audit).toEqual([
      {
        workspace_id: body.id,
        actor_type: "account",
        actor_account_id: alice.account.id,
        actor_label: "Test account",
        actor_token_id: null,
        action: "workspace.created",
        entity_type: "workspace",
        entity_id: body.id,
        metadata: { name: "Research" },
        ip: "203.0.0.0",
      },
    ]);
    expect(job).toEqual({ eventId: expect.stringMatching(/^[0-9a-f-]{36}$/) as string, workspaceId: body.id, accountId: alice.account.id });
    expect(await listed(world, alice)).toMatchObject({ items: [{ id: body.id, name: "Research", role: "owner", memberCount: 1 }] });
  });

  it("does not change the active workspace of the session", async () => {
    const world = serve({ allow: true });
    const alice = await person(world);
    const home = await seedWorkspace(database(), { name: "Home" });
    await seedMembership(database(), { workspaceId: home, accountId: alice.account.id, role: "owner" });
    await setActiveWorkspace(database(), alice.sessionId, home);

    expect((await create(world, alice, { name: "Second" })).status).toBe(201);

    expect((await sessionRows(database(), alice.account.id))[0]).toMatchObject({ id: alice.sessionId });
    const me = (await (await send(world, "GET", ME, { cookie: alice.cookie })).json()) as { activeWorkspaceId: string | null };
    expect(me.activeWorkspaceId).toBe(home);
  });

  it("answers 403 forbidden and writes nothing where the deployment does not let accounts create workspaces", async () => {
    const world = serve();
    const alice = await person(world);
    const before = await written();

    const response = await create(world, alice, { name: "Research" });

    expect(response.status).toBe(403);
    expect(await problem(response)).toMatchObject({ code: "forbidden", status: 403 });
    expect(await written()).toEqual(before);
    expect(await ownedWorkspaces(alice.account.id)).toBe(0);
  });

  it("answers 403 email_unverified and writes nothing for an account whose address is not verified", async () => {
    const world = serve({ allow: true });
    const alice = await person(world, { verified: false });
    const before = await written();

    const response = await create(world, alice, { name: "Research" });

    expect(response.status).toBe(403);
    expect(await problem(response)).toMatchObject({ code: "email_unverified" });
    expect(await written()).toEqual(before);
  });

  it("answers 401 without a session and 403 forbidden for an API token, and writes nothing", async () => {
    const world = serve({ allow: true });
    const alice = await person(world);
    const workspaceId = await seedWorkspace(database());
    await seedMembership(database(), { workspaceId, accountId: alice.account.id });
    const before = await written();

    const anonymous = await send(world, "POST", WORKSPACES, {}, { name: "Research" });
    const token = await send(world, "POST", WORKSPACES, { authorization: `Bearer token:${alice.account.id}:${workspaceId}` }, { name: "Research" });

    expect(anonymous.status).toBe(401);
    expect(token.status).toBe(403);
    expect(await problem(token)).toMatchObject({ code: "forbidden" });
    expect(await written()).toEqual(before);
  });

  it("refuses a request from another origin and writes nothing", async () => {
    const world = serve({ allow: true });
    const alice = await person(world);
    const before = await written();

    const response = await send(world, "POST", WORKSPACES, { cookie: alice.cookie, origin: "https://elsewhere.example" }, { name: "Research" });

    expect(response.status).toBe(403);
    expect(await problem(response)).toMatchObject({ code: "cross_site_request" });
    expect(await written()).toEqual(before);
  });

  it("makes the workspace for the account that asked and for no other: a body naming an owner is refused and creates nothing", async () => {
    const world = serve({ allow: true });
    const alice = await person(world);
    const victim = await seedAccount(database(), { emailVerified: true });
    const before = await written();

    for (const extra of [{ accountId: victim.id }, { ownerId: victim.id }, { createdBy: victim.id }, { role: "owner" }, { workspaceId: victim.id }]) {
      const response = await create(world, alice, { name: "Stolen", ...extra });
      expect(response.status).toBe(422);
      expect(await problem(response)).toMatchObject({ code: "validation_failed" });
    }

    expect(await written()).toEqual(before);
    expect(await ownedWorkspaces(victim.id)).toBe(0);
    expect(await ownedWorkspaces(alice.account.id)).toBe(0);
  });

  it("owns the new workspace by the session's account, whatever other accounts exist", async () => {
    const world = serve({ allow: true });
    const alice = await person(world);
    const bob = await person(world);

    const created = (await (await create(world, alice, { name: "Alice's" })).json()) as Summary;

    expect(await ownedWorkspaces(alice.account.id)).toBe(1);
    expect(await ownedWorkspaces(bob.account.id)).toBe(0);
    expect((await listed(world, bob)).items).toEqual([]);
    expect((await listed(world, alice)).items.map((item) => item.id)).toEqual([created.id]);
  });

  it("refuses a name that is blank, longer than 64 characters or not a string with 422, and writes nothing", async () => {
    const world = serve({ allow: true });
    const alice = await person(world);
    const before = await written();

    for (const name of ["", "   ", "x".repeat(65), 7, null]) {
      const response = await create(world, alice, { name });
      expect(response.status).toBe(422);
      expect(await problem(response)).toMatchObject({ code: "validation_failed" });
    }
    expect((await create(world, alice, {})).status).toBe(422);

    expect(await written()).toEqual(before);
  });

  it("accepts 64 characters, counted as characters and not as bytes, and stores the name trimmed", async () => {
    const world = serve({ allow: true });
    const alice = await person(world);

    const emoji = await create(world, alice, { name: "😀".repeat(64) });
    const spaced = await create(world, alice, { name: ` ${"y".repeat(64)} ` });

    expect(emoji.status).toBe(201);
    expect(spaced.status).toBe(201);
    expect(((await spaced.json()) as Summary).name).toBe("y".repeat(64));
    expect((await listed(world, alice)).items.map((item) => item.name).sort()).toEqual(["y".repeat(64), "😀".repeat(64)].sort());
  });

  it("carries nothing but the workspace's name in the audit event and the event job", async () => {
    const world = serve({ allow: true });
    const alice = await person(world);

    const response = await create(world, alice, { name: "Research" });
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as Summary;

    const audit = await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      return tx<{ metadata: Record<string, unknown> }[]>`SELECT metadata FROM audit_events WHERE workspace_id = ${id}`;
    });
    const jobs = (await queuedEvents()).filter((data) => data["workspaceId"] === id);
    expect(audit.map((row) => Object.keys(row.metadata))).toEqual([["name"]]);
    expect(jobs.map((data) => Object.keys(data).sort())).toEqual([["accountId", "eventId", "workspaceId"]]);
    const text = JSON.stringify({ audit, jobs });
    for (const secret of [alice.account.password, alice.account.email, "$argon2id$", alice.cookie.split("=")[1] ?? "?"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("leaves no workspace, owner, settings row or event job when the audit event cannot be written", async () => {
    const world = serve({ allow: true });
    const alice = await person(world);
    const before = await written();
    await database().owner`REVOKE INSERT ON audit_events FROM slugbase_app`;
    try {
      const response = await create(world, alice, { name: "Research" });
      expect(response.status).toBe(500);
      expect(await problem(response)).toMatchObject({ code: "internal" });
    } finally {
      await database().owner`GRANT INSERT ON audit_events TO slugbase_app`;
    }

    expect(await written()).toEqual(before);
    expect(await ownedWorkspaces(alice.account.id)).toBe(0);
  });

  it("leaves no workspace and no audit event when the event job cannot be queued", async () => {
    const world = serve({ allow: true });
    const alice = await person(world);
    const before = await written();
    await database().owner`UPDATE pgboss.queue SET name = 'event.workspace.created.away' WHERE name = 'event.workspace.created'`;
    try {
      const response = await create(world, alice, { name: "Research" });
      expect(response.status).toBe(500);
    } finally {
      await database().owner`UPDATE pgboss.queue SET name = 'event.workspace.created' WHERE name = 'event.workspace.created.away'`;
    }

    expect(await written()).toEqual(before);
  });

  it("leaves another workspace's rows and audit events as they were, and never shows them to the creator", async () => {
    const world = serve({ allow: true });
    const alice = await person(world);
    const owner = await seedAccount(database(), { emailVerified: true });
    const theirs = await seedWorkspace(database(), { name: "Theirs" });
    await seedMembership(database(), { workspaceId: theirs, accountId: owner.id, role: "owner" });
    const before = await everythingOf(theirs);

    for (const name of ["One", "Two"]) {
      expect((await create(world, alice, { name })).status).toBe(201);
    }

    expect(await everythingOf(theirs)).toBe(before);
    expect(JSON.stringify(await listed(world, alice))).not.toContain(theirs);
  });
});
