import { randomUUID } from "node:crypto";
import { useTestDatabase } from "@slugbase/testing/db";
import type { AuthStore } from "@slugbase/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAccountOnlyTenantResolver } from "../../src/auth/tenant-resolver.ts";
import { createServer, type Authenticator, type Server } from "../../src/create-server.ts";
import { seedAccount, seedMembership, seedWorkspace, sessionRows, setActiveWorkspace, storeFor, workspaceChecksum, type SeededAccount } from "../auth/support.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { adapters, recordingLogger, serverConfig } from "../support.ts";

// GET /api/v1/members and PATCH /api/v1/members/{accountId} through the whole chain over the migrated database
// (doc 04 section 10.5, doc 02 section 3.3, doc 05 sections 2.1 and 2.2, doc 10 T1, T2 and T3). The failure
// scenarios: two owners demoting each other at the same moment, the last owner demoted, an admin promoting
// themselves to owner or touching an owner, a plain member changing a role, a member of another workspace
// reached by its account identifier, a role change that leaves the caller's old session token valid, and a
// list that quotes more of an account than its display name and email address.

const MEMBERS = "/api/v1/members";
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
      (scope !== "read" && scope !== "read-write") || accountId === undefined || workspaceId === undefined ? undefined : { kind: "api-token", tokenId: "stub-token", accountId, workspaceId, scope },
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

type Role = "owner" | "admin" | "member";

async function workspaceWith(name: string): Promise<string> {
  const id = await seedWorkspace(database(), { name });
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`INSERT INTO workspace_settings (workspace_id) VALUES (${id})`;
  });
  return id;
}

/** A workspace with a signed-in member of each role given, in that order, all acting in it. */
async function workspaceOf(world: World, ...roles: Role[]): Promise<{ readonly workspaceId: string; readonly people: readonly (Person & { readonly role: Role })[] }> {
  const workspaceId = await workspaceWith("Members test");
  const people: (Person & { role: Role })[] = [];
  for (const role of roles) {
    const as = await person(world);
    await seedMembership(database(), { workspaceId, accountId: as.account.id, role });
    await setActiveWorkspace(database(), as.sessionId, workspaceId);
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

async function rolesOf(workspaceId: string): Promise<Record<string, string>> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ account_id: string; role: string }[]>`SELECT account_id, role::text AS role FROM workspace_members WHERE workspace_id = ${workspaceId}`;
  });
  return Object.fromEntries(rows.map((row) => [row.account_id, row.role]));
}

interface AuditRow {
  action: string;
  actor_type: string;
  actor_account_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  metadata: Record<string, unknown>;
}

async function auditOf(workspaceId: string): Promise<AuditRow[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<AuditRow[]>`
      SELECT action, actor_type, actor_account_id, entity_type, entity_id, metadata
      FROM audit_events WHERE workspace_id = ${workspaceId} ORDER BY created_at, id`;
  });
  return [...rows];
}

async function tokenHashOf(sessionId: string, accountId: string): Promise<string | undefined> {
  return (await sessionRows(database(), accountId)).find((row) => row.id === sessionId)?.token_hash.toString("hex");
}

const asToken = (scope: "read" | "read-write", accountId: string, workspaceId: string): Record<string, string> => ({ authorization: `Bearer token:${scope}:${accountId}:${workspaceId}` });

interface MemberBody {
  accountId: string;
  displayName: string;
  email: string;
  role: string;
  joinedAt: string;
  lastActiveAt: string | null;
  teams: { id: string; name: string }[];
}

describe("GET /api/v1/members", () => {
  it("lists the members of the workspace the session acts in with their account's display name and email, role and times, and nothing else of the account", async () => {
    const world = serve();
    const { workspaceId, people } = await workspaceOf(world, "owner", "admin", "member");
    const other = await workspaceOf(world, "owner");
    const caller = only(people, 2);

    const response = await send(world, "GET", MEMBERS, { cookie: caller.cookie });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { items: MemberBody[]; nextCursor: string | null };
    expect(body.nextCursor).toBeNull();
    expect(body.items.map((item) => item.accountId)).toEqual(people.map((member) => member.account.id).sort());
    const owner = body.items.find((item) => item.accountId === only(people, 0).account.id);
    expect(owner).toEqual({
      accountId: only(people, 0).account.id,
      displayName: "Test account",
      email: only(people, 0).account.email,
      role: "owner",
      joinedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/) as string,
      lastActiveAt: null,
      teams: [],
    });
    expect(body.items.find((item) => item.accountId === caller.account.id)?.lastActiveAt).toEqual(expect.stringMatching(/^\d{4}-/) as string);
    expect(JSON.stringify(body)).not.toContain(only(other.people, 0).account.id);
    expect(JSON.stringify(body)).not.toMatch(/password|mfa|argon/i);
    expect(workspaceId).not.toBe(other.workspaceId);
  });

  it("gives each member the teams of this workspace it belongs to by name, and shows no team of another workspace", async () => {
    const world = serve();
    const { workspaceId, people } = await workspaceOf(world, "owner", "member");
    const other = await workspaceOf(world, "owner");
    const joined = only(people, 1);
    const teamIds = { support: randomUUID(), design: randomUUID(), elsewhere: randomUUID() };
    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`INSERT INTO teams (id, workspace_id, name) VALUES (${teamIds.support}, ${workspaceId}, 'support'), (${teamIds.design}, ${workspaceId}, 'Design'), (${teamIds.elsewhere}, ${other.workspaceId}, 'Elsewhere')`;
      await tx`INSERT INTO team_members (workspace_id, team_id, account_id) VALUES (${workspaceId}, ${teamIds.support}, ${joined.account.id}), (${workspaceId}, ${teamIds.design}, ${joined.account.id}), (${other.workspaceId}, ${teamIds.elsewhere}, ${only(other.people, 0).account.id})`;
    });

    const response = await send(world, "GET", MEMBERS, { cookie: only(people, 0).cookie });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: MemberBody[] };
    expect(body.items.find((item) => item.accountId === joined.account.id)?.teams).toEqual([
      { id: teamIds.design, name: "Design" },
      { id: teamIds.support, name: "support" },
    ]);
    expect(body.items.find((item) => item.accountId === only(people, 0).account.id)?.teams).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("Elsewhere");
  });

  it("is callable with a read-scope token and a read-write one, which list the workspace they are bound to", async () => {
    const world = serve();
    const { workspaceId, people } = await workspaceOf(world, "owner", "member");
    const caller = only(people, 1);

    const read = await send(world, "GET", MEMBERS, asToken("read", caller.account.id, workspaceId));
    const write = await send(world, "GET", MEMBERS, asToken("read-write", caller.account.id, workspaceId));

    expect(read.status).toBe(200);
    expect(((await read.json()) as { items: unknown[] }).items).toHaveLength(2);
    expect(write.status).toBe(200);
  });

  it("pages by account identifier with a cursor that only the workspace it was issued for accepts", async () => {
    const world = serve();
    const { people } = await workspaceOf(world, "owner", "admin", "member", "member", "member");
    const other = await workspaceOf(world, "owner");
    const caller = only(people, 0);
    const ids = people.map((member) => member.account.id).sort();

    const first = (await (await send(world, "GET", `${MEMBERS}?limit=2`, { cookie: caller.cookie })).json()) as { items: MemberBody[]; nextCursor: string };
    const second = (await (await send(world, "GET", `${MEMBERS}?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`, { cookie: caller.cookie })).json()) as {
      items: MemberBody[];
      nextCursor: string;
    };
    const third = (await (await send(world, "GET", `${MEMBERS}?limit=2&cursor=${encodeURIComponent(second.nextCursor)}`, { cookie: caller.cookie })).json()) as {
      items: MemberBody[];
      nextCursor: string | null;
    };
    const foreign = await send(world, "GET", `${MEMBERS}?cursor=${encodeURIComponent(first.nextCursor)}`, { cookie: only(other.people, 0).cookie });
    const forged = await send(world, "GET", `${MEMBERS}?cursor=not-a-cursor`, { cookie: caller.cookie });

    expect([...first.items, ...second.items, ...third.items].map((item) => item.accountId)).toEqual(ids);
    expect(first.items).toHaveLength(2);
    expect(third.nextCursor).toBeNull();
    expect(foreign.status).toBe(400);
    expect(forged.status).toBe(400);
    expect(await problem(forged)).toMatchObject({ code: "bad_request" });
  });

  it("answers 404 to an account with no workspace and to one whose workspace is being deleted, 422 to a limit out of range and 401 without a session", async () => {
    const world = serve();
    const alone = await person(world);
    const leaving = await person(world);
    const going = await seedWorkspace(database(), { name: "Going", deleting: true });
    await seedMembership(database(), { workspaceId: going, accountId: leaving.account.id, role: "owner" });
    await setActiveWorkspace(database(), leaving.sessionId, going);

    expect((await send(world, "GET", MEMBERS, { cookie: alone.cookie })).status).toBe(404);
    expect((await send(world, "GET", MEMBERS, { cookie: leaving.cookie })).status).toBe(404);
    expect((await send(world, "GET", `${MEMBERS}?limit=0`, { cookie: alone.cookie })).status).toBe(422);
    expect((await send(world, "GET", MEMBERS, {})).status).toBe(401);
  });
});

describe("PATCH /api/v1/members/{accountId}", () => {
  it("lets an owner promote a member to admin and an admin to owner and demote them again, and writes member.role_changed with the old and the new role each time", async () => {
    const world = serve();
    const { workspaceId, people } = await workspaceOf(world, "owner", "member");
    const owner = only(people, 0);
    const member = only(people, 1);

    const toAdmin = await send(world, "PATCH", `${MEMBERS}/${member.account.id}`, { cookie: owner.cookie }, { role: "admin" });
    const toOwner = await send(world, "PATCH", `${MEMBERS}/${member.account.id}`, { cookie: owner.cookie }, { role: "owner" });
    const toMember = await send(world, "PATCH", `${MEMBERS}/${member.account.id}`, { cookie: owner.cookie }, { role: "member" });

    expect(toAdmin.status).toBe(200);
    expect(await toAdmin.json()).toEqual({
      accountId: member.account.id,
      displayName: "Test account",
      email: member.account.email,
      role: "admin",
      joinedAt: expect.any(String) as string,
      lastActiveAt: null,
      teams: [],
    });
    expect(((await toOwner.json()) as MemberBody).role).toBe("owner");
    expect(((await toMember.json()) as MemberBody).role).toBe("member");
    expect(await rolesOf(workspaceId)).toEqual({ [owner.account.id]: "owner", [member.account.id]: "member" });
    expect(await auditOf(workspaceId)).toEqual(
      [
        ["member", "admin"],
        ["admin", "owner"],
        ["owner", "member"],
      ].map(([from, to]) => ({
        action: "member.role_changed",
        actor_type: "account",
        actor_account_id: owner.account.id,
        entity_type: "member",
        entity_id: member.account.id,
        metadata: { from, to },
      })),
    );
  });

  it("does not rotate the caller's session for a change to somebody else's role", async () => {
    const world = serve();
    const { people } = await workspaceOf(world, "owner", "member");
    const owner = only(people, 0);
    const before = await tokenHashOf(owner.sessionId, owner.account.id);

    const response = await send(world, "PATCH", `${MEMBERS}/${only(people, 1).account.id}`, { cookie: owner.cookie }, { role: "admin" });

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await tokenHashOf(owner.sessionId, owner.account.id)).toBe(before);
    expect((await send(world, "GET", MEMBERS, { cookie: owner.cookie })).status).toBe(200);
  });

  it("lets an admin switch a member to admin and back, and refuses what only an owner may do: promoting to owner, promoting themselves, and touching an owner", async () => {
    const world = serve();
    const { workspaceId, people } = await workspaceOf(world, "owner", "admin", "member");
    const [owner, admin, member] = [only(people, 0), only(people, 1), only(people, 2)];

    const promoted = await send(world, "PATCH", `${MEMBERS}/${member.account.id}`, { cookie: admin.cookie }, { role: "admin" });
    const demoted = await send(world, "PATCH", `${MEMBERS}/${member.account.id}`, { cookie: admin.cookie }, { role: "member" });
    const before = await rolesOf(workspaceId);
    const auditBefore = await auditOf(workspaceId);
    const refused = await Promise.all([
      send(world, "PATCH", `${MEMBERS}/${member.account.id}`, { cookie: admin.cookie }, { role: "owner" }),
      send(world, "PATCH", `${MEMBERS}/${admin.account.id}`, { cookie: admin.cookie }, { role: "owner" }),
      send(world, "PATCH", `${MEMBERS}/${owner.account.id}`, { cookie: admin.cookie }, { role: "member" }),
      send(world, "PATCH", `${MEMBERS}/${owner.account.id}`, { cookie: admin.cookie }, { role: "owner" }),
    ]);

    expect(promoted.status).toBe(200);
    expect(demoted.status).toBe(200);
    for (const response of refused) {
      expect(response.status).toBe(403);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await problem(response)).toMatchObject({ code: "forbidden", status: 403 });
    }
    expect(await rolesOf(workspaceId)).toEqual(before);
    expect(await rolesOf(workspaceId)).toEqual({ [owner.account.id]: "owner", [admin.account.id]: "admin", [member.account.id]: "member" });
    expect(await auditOf(workspaceId)).toEqual(auditBefore);
  });

  it("refuses a plain member with 403 and writes nothing", async () => {
    const world = serve();
    const { workspaceId, people } = await workspaceOf(world, "owner", "member", "member");
    const member = only(people, 1);
    const before = await rolesOf(workspaceId);

    const response = await send(world, "PATCH", `${MEMBERS}/${only(people, 2).account.id}`, { cookie: member.cookie }, { role: "admin" });
    const self = await send(world, "PATCH", `${MEMBERS}/${member.account.id}`, { cookie: member.cookie }, { role: "owner" });

    expect(response.status).toBe(403);
    expect(self.status).toBe(403);
    expect(await rolesOf(workspaceId)).toEqual(before);
    expect(await auditOf(workspaceId)).toEqual([]);
  });

  it("answers a role the member already has with 200 and writes no audit event and rotates no token", async () => {
    const world = serve();
    const { workspaceId, people } = await workspaceOf(world, "owner", "admin");
    const owner = only(people, 0);
    const before = await tokenHashOf(owner.sessionId, owner.account.id);

    const same = await send(world, "PATCH", `${MEMBERS}/${only(people, 1).account.id}`, { cookie: owner.cookie }, { role: "admin" });
    const self = await send(world, "PATCH", `${MEMBERS}/${owner.account.id}`, { cookie: owner.cookie }, { role: "owner" });

    expect(same.status).toBe(200);
    expect(self.status).toBe(200);
    expect(self.headers.get("set-cookie")).toBeNull();
    expect(await auditOf(workspaceId)).toEqual([]);
    expect(await tokenHashOf(owner.sessionId, owner.account.id)).toBe(before);
  });

  it("rotates the session token of a caller who changes their own role: the response sets a new cookie, the old token is refused and the audit event is written", async () => {
    const world = serve();
    const { workspaceId, people } = await workspaceOf(world, "owner", "owner");
    const caller = only(people, 0);
    const before = await tokenHashOf(caller.sessionId, caller.account.id);

    const response = await send(world, "PATCH", `${MEMBERS}/${caller.account.id}`, { cookie: caller.cookie, "x-forwarded-for": "203.0.113.9" }, { role: "admin" });

    expect(response.status).toBe(200);
    expect(((await response.json()) as MemberBody).role).toBe("admin");
    const setCookie = response.headers.get("set-cookie") ?? "";
    const fresh = new RegExp(`^${SESSION_COOKIE}=([A-Za-z0-9_-]{43});`).exec(setCookie)?.[1];
    expect(fresh).toBeDefined();
    expect(setCookie).toContain("HttpOnly");
    expect(`${SESSION_COOKIE}=${fresh ?? ""}`).not.toBe(caller.cookie);
    expect(await tokenHashOf(caller.sessionId, caller.account.id)).not.toBe(before);
    expect((await send(world, "GET", MEMBERS, { cookie: caller.cookie })).status).toBe(401);
    const next = await send(world, "GET", MEMBERS, { cookie: `${SESSION_COOKIE}=${fresh ?? ""}` });
    expect(next.status).toBe(200);
    expect(await auditOf(workspaceId)).toEqual([
      {
        action: "member.role_changed",
        actor_type: "account",
        actor_account_id: caller.account.id,
        entity_type: "member",
        entity_id: caller.account.id,
        metadata: { from: "owner", to: "admin" },
      },
    ]);
  });

  it("rotates the token of an admin who steps down to member, who then may no longer change roles", async () => {
    const world = serve();
    const { people } = await workspaceOf(world, "owner", "admin", "member");
    const admin = only(people, 1);

    const response = await send(world, "PATCH", `${MEMBERS}/${admin.account.id}`, { cookie: admin.cookie }, { role: "member" });
    const fresh = new RegExp(`^${SESSION_COOKIE}=([A-Za-z0-9_-]{43});`).exec(response.headers.get("set-cookie") ?? "")?.[1];
    const again = await send(world, "PATCH", `${MEMBERS}/${only(people, 2).account.id}`, { cookie: `${SESSION_COOKIE}=${fresh ?? ""}` }, { role: "admin" });

    expect(response.status).toBe(200);
    expect(fresh).toBeDefined();
    expect(again.status).toBe(403);
  });

  it("refuses to demote the last owner with 409 last_owner, and the role, the audit log and the session token stay as they were", async () => {
    const world = serve();
    const { workspaceId, people } = await workspaceOf(world, "owner", "admin");
    const owner = only(people, 0);
    const before = await tokenHashOf(owner.sessionId, owner.account.id);

    const response = await send(world, "PATCH", `${MEMBERS}/${owner.account.id}`, { cookie: owner.cookie }, { role: "admin" });

    expect(response.status).toBe(409);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await problem(response)).toMatchObject({ code: "last_owner", status: 409 });
    expect(await rolesOf(workspaceId)).toEqual({ [owner.account.id]: "owner", [only(people, 1).account.id]: "admin" });
    expect(await auditOf(workspaceId)).toEqual([]);
    expect(await tokenHashOf(owner.sessionId, owner.account.id)).toBe(before);
    expect((await send(world, "GET", MEMBERS, { cookie: owner.cookie })).status).toBe(200);
  });

  it("leaves exactly one owner when two owners demote each other at the same moment", async () => {
    const world = serve();
    const { workspaceId, people } = await workspaceOf(world, "owner", "owner");
    const [first, second] = [only(people, 0), only(people, 1)];

    const responses = await Promise.all([
      send(world, "PATCH", `${MEMBERS}/${second.account.id}`, { cookie: first.cookie }, { role: "admin" }),
      send(world, "PATCH", `${MEMBERS}/${first.account.id}`, { cookie: second.cookie }, { role: "admin" }),
    ]);

    // whichever is judged first wins; the other is then an admin who may not touch an owner
    expect(responses.map((response) => response.status).sort()).toEqual([200, 403]);
    const roles = Object.values(await rolesOf(workspaceId));
    expect(roles.filter((role) => role === "owner")).toHaveLength(1);
    expect(roles.filter((role) => role === "admin")).toHaveLength(1);
    expect(await auditOf(workspaceId)).toHaveLength(1);
  });

  it("answers 404 for an account that is not a member of the workspace, a member of another workspace included, and changes nothing there", async () => {
    const world = serve();
    const { workspaceId, people } = await workspaceOf(world, "owner", "admin");
    const other = await workspaceOf(world, "owner", "member");
    const outsider = await person(world);
    const foreignOwner = only(other.people, 0);
    const foreignMember = only(other.people, 1);
    const before = await workspaceChecksum(database(), other.workspaceId);

    const pairs: [Person, string][] = [
        [only(people, 0), foreignOwner.account.id],
        [only(people, 0), foreignMember.account.id],
        [only(people, 1), foreignOwner.account.id],
        [only(people, 1), foreignMember.account.id],
        [only(people, 0), outsider.account.id],
        [only(people, 0), "0192f3a0-ffff-7000-8000-000000000001"],
    ];
    const attempts = await Promise.all(pairs.map(([caller, target]) => send(world, "PATCH", `${MEMBERS}/${target}`, { cookie: caller.cookie }, { role: "owner" })));

    for (const response of attempts) {
      expect(response.status).toBe(404);
      expect(JSON.stringify(await problem(response))).not.toContain(other.workspaceId);
    }
    expect(await workspaceChecksum(database(), other.workspaceId)).toBe(before);
    expect(await rolesOf(other.workspaceId)).toEqual({ [foreignOwner.account.id]: "owner", [foreignMember.account.id]: "member" });
    expect(await auditOf(other.workspaceId)).toEqual([]);
    expect(await auditOf(workspaceId)).toEqual([]);
  });

  it("refuses a token (it declares no scope), a request from another site and a request without a session, and writes nothing", async () => {
    const world = serve();
    const { workspaceId, people } = await workspaceOf(world, "owner", "member");
    const owner = only(people, 0);
    const target = `${MEMBERS}/${only(people, 1).account.id}`;

    const token = await send(world, "PATCH", target, asToken("read-write", owner.account.id, workspaceId), { role: "admin" });
    const crossSite = await send(world, "PATCH", target, { cookie: owner.cookie, origin: "https://evil.example" }, { role: "admin" });
    const anonymous = await send(world, "PATCH", target, {}, { role: "admin" });

    expect(token.status).toBe(403);
    expect(crossSite.status).toBe(403);
    expect(await problem(crossSite)).toMatchObject({ code: "cross_site_request" });
    expect(anonymous.status).toBe(401);
    expect(await rolesOf(workspaceId)).toEqual({ [owner.account.id]: "owner", [only(people, 1).account.id]: "member" });
    expect(await auditOf(workspaceId)).toEqual([]);
  });

  it("answers 422 for a role outside owner, admin and member, a field the operation does not declare and an identifier that is not a UUID", async () => {
    const world = serve();
    const { people } = await workspaceOf(world, "owner", "member");
    const owner = only(people, 0);
    const target = `${MEMBERS}/${only(people, 1).account.id}`;

    expect((await send(world, "PATCH", target, { cookie: owner.cookie }, { role: "superuser" })).status).toBe(422);
    expect((await send(world, "PATCH", target, { cookie: owner.cookie }, {})).status).toBe(422);
    expect((await send(world, "PATCH", target, { cookie: owner.cookie }, { role: "admin", accountId: owner.account.id })).status).toBe(422);
    expect((await send(world, "PATCH", `${MEMBERS}/not-a-uuid`, { cookie: owner.cookie }, { role: "admin" })).status).toBe(422);
  });
});
