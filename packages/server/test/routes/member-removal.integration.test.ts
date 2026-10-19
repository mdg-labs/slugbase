import { useTestDatabase } from "@slugbase/testing/db";
import type { AuthStore } from "@slugbase/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAccountOnlyTenantResolver } from "../../src/auth/tenant-resolver.ts";
import { createServer, type Server } from "../../src/create-server.ts";
import { runMigrations } from "../../src/migrate/index.ts";
import { seedAccount, seedApiToken, seedMembership, seedWorkspace, sessionRows, setActiveWorkspace, storeFor, workspaceChecksum, type SeededAccount } from "../auth/support.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { urlOf } from "../migrate/support.ts";
import { adapters, recordingLogger, serverConfig } from "../support.ts";

// DELETE /api/v1/members/{accountId} and POST /api/v1/workspace/leave through the whole chain over the migrated
// database (doc 04 sections 10.4 and 10.5, doc 02 sections 3.3 and 3.6, doc 05 section 2.2, doc 10 T1 and T2). The
// failure scenarios: a removed member whose next request still reaches the workspace, a removed member's API
// token that still answers, the last owner removed or leaving, an admin removing an owner, a recipient that is
// no member (of this workspace or of another one), a removal that leaves a job or an audit event behind a
// refusal, and a member of workspace B reached by its account identifier.

const MEMBERS = "/api/v1/members";
const LEAVE = "/api/v1/workspace/leave";
const WORKSPACE = "/api/v1/workspace";
const SESSION_COOKIE = "__Host-slugbase_session";
const HOOK_TIMEOUT_MS = 300_000;
const QUEUE = "event.member.left";

const database = useTestDatabase();
let store: AuthStore;

beforeAll(async () => {
  store = storeFor(database());
  // The event queues exist once the image entrypoint has run migrate.
  await runMigrations({ url: urlOf(database().owner) });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await store.close();
});

beforeEach(async () => {
  await database().owner`DELETE FROM pgboss.job WHERE name = ${QUEUE}`;
});

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
    modules: [],
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

/** A workspace with a signed-in member of each role given, in that order, all acting in it. */
async function workspaceOf(world: World, ...roles: Role[]): Promise<{ readonly workspaceId: string; readonly people: readonly (Person & { readonly role: Role })[] }> {
  const workspaceId = await seedWorkspace(database(), { name: "Removal test" });
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`INSERT INTO workspace_settings (workspace_id) VALUES (${workspaceId})`;
  });
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

async function memberIds(workspaceId: string): Promise<string[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ account_id: string }[]>`SELECT account_id FROM workspace_members WHERE workspace_id = ${workspaceId} ORDER BY account_id`;
  });
  return rows.map((row) => row.account_id);
}

async function tokenIds(workspaceId: string): Promise<string[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ id: string }[]>`SELECT id FROM api_tokens WHERE workspace_id = ${workspaceId} ORDER BY id`;
  });
  return rows.map((row) => row.id);
}

interface AuditRow {
  action: string;
  actor_account_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  metadata: Record<string, unknown>;
}

async function auditOf(workspaceId: string): Promise<AuditRow[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<AuditRow[]>`
      SELECT action, actor_account_id, entity_type, entity_id, metadata
      FROM audit_events WHERE workspace_id = ${workspaceId} ORDER BY created_at, id`;
  });
  return [...rows];
}

async function jobs(): Promise<Record<string, unknown>[]> {
  const rows = await database().owner<{ data: Record<string, unknown> }[]>`SELECT data FROM pgboss.job WHERE name = ${QUEUE} ORDER BY created_on, id`;
  return rows.map((row) => row.data);
}

const bearer = (value: string): Record<string, string> => ({ authorization: `Bearer ${value}` });

describe("DELETE /api/v1/members/{accountId}", () => {
  it("lets an admin remove a member at once: the membership and the member's tokens go, the content goes to the admin by default, and member.left and member.removed record it", async () => {
    const world = serve();
    const { workspaceId, people } = await workspaceOf(world, "owner", "admin", "member");
    const [owner, admin, member] = [only(people, 0), only(people, 1), only(people, 2)];
    const token = await seedApiToken(database(), { accountId: member.account.id, workspaceId });
    const ownersToken = await seedApiToken(database(), { accountId: owner.account.id, workspaceId });
    expect((await send(world, "GET", MEMBERS, bearer(token.value))).status).toBe(200);

    const response = await send(world, "DELETE", `${MEMBERS}/${member.account.id}`, { cookie: admin.cookie }, { content: "transfer" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ content: "transfer", transferTo: admin.account.id });
    expect(await memberIds(workspaceId)).toEqual([owner.account.id, admin.account.id].sort());
    expect(await tokenIds(workspaceId)).toEqual([ownersToken.id]);
    expect(await jobs()).toEqual([{ eventId: expect.any(String) as string, workspaceId, accountId: member.account.id, content: "transfer", transferTo: admin.account.id }]);
    expect(await auditOf(workspaceId)).toEqual([
      { action: "member.removed", actor_account_id: admin.account.id, entity_type: "member", entity_id: member.account.id, metadata: { content: "transfer", transferTo: admin.account.id } },
    ]);
  });

  it("ends access on the next request: the removed member's session acts in no workspace and its token is refused", async () => {
    const world = serve();
    const { workspaceId, people } = await workspaceOf(world, "owner", "member");
    const [owner, member] = [only(people, 0), only(people, 1)];
    const token = await seedApiToken(database(), { accountId: member.account.id, workspaceId });
    expect((await send(world, "GET", WORKSPACE, { cookie: member.cookie })).status).toBe(200);

    await send(world, "DELETE", `${MEMBERS}/${member.account.id}`, { cookie: owner.cookie }, { content: "delete" });

    const session = await send(world, "GET", WORKSPACE, { cookie: member.cookie });
    expect(session.status).toBe(404);
    expect((await send(world, "GET", MEMBERS, { cookie: member.cookie })).status).toBe(404);
    expect((await send(world, "DELETE", `${MEMBERS}/${owner.account.id}`, { cookie: member.cookie }, { content: "delete" })).status).toBe(404);
    const dead = await send(world, "GET", MEMBERS, bearer(token.value));
    expect(dead.status).toBe(401);
    expect(await problem(dead)).toMatchObject({ code: "unauthenticated" });
    expect(await memberIds(workspaceId)).toEqual([owner.account.id]);
  });

  it("moves the removed member's session to the workspace it still belongs to, and keeps the other workspace's content and tokens", async () => {
    const world = serve();
    const { workspaceId, people } = await workspaceOf(world, "owner", "member");
    const [owner, member] = [only(people, 0), only(people, 1)];
    const other = await workspaceOf(world, "owner");
    await seedMembership(database(), { workspaceId: other.workspaceId, accountId: member.account.id, role: "member" });
    const kept = await seedApiToken(database(), { accountId: member.account.id, workspaceId: other.workspaceId });

    await send(world, "DELETE", `${MEMBERS}/${member.account.id}`, { cookie: owner.cookie }, { content: "transfer" });

    const after = await send(world, "GET", WORKSPACE, { cookie: member.cookie });
    expect(after.status).toBe(200);
    expect(((await after.json()) as { id: string }).id).toBe(other.workspaceId);
    expect(await tokenIds(other.workspaceId)).toEqual([kept.id]);
    expect(await memberIds(other.workspaceId)).toContain(member.account.id);
    expect(await memberIds(workspaceId)).toEqual([owner.account.id]);
  });

  it("hands the content to the member named and carries the choice to delete with the recipient", async () => {
    const world = serve();
    const { workspaceId, people } = await workspaceOf(world, "owner", "admin", "member");
    const [owner, admin, member] = [only(people, 0), only(people, 1), only(people, 2)];

    const response = await send(world, "DELETE", `${MEMBERS}/${member.account.id}`, { cookie: admin.cookie }, { content: "delete", transferTo: owner.account.id.toUpperCase() });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ content: "delete", transferTo: owner.account.id });
    expect(await jobs()).toMatchObject([{ workspaceId, accountId: member.account.id, content: "delete", transferTo: owner.account.id }]);
    expect((await auditOf(workspaceId))[0]?.metadata).toEqual({ content: "delete", transferTo: owner.account.id });
  });

  it("lets an owner remove another owner, and an admin remove an admin", async () => {
    const world = serve();
    const { workspaceId, people } = await workspaceOf(world, "owner", "owner", "admin", "admin");
    const [first, second, thirdAdmin, fourthAdmin] = [only(people, 0), only(people, 1), only(people, 2), only(people, 3)];

    const owner = await send(world, "DELETE", `${MEMBERS}/${second.account.id}`, { cookie: first.cookie }, { content: "transfer" });
    const admin = await send(world, "DELETE", `${MEMBERS}/${fourthAdmin.account.id}`, { cookie: thirdAdmin.cookie }, { content: "transfer" });

    expect(owner.status).toBe(200);
    expect(admin.status).toBe(200);
    expect(await memberIds(workspaceId)).toEqual([first.account.id, thirdAdmin.account.id].sort());
  });

  it("refuses an admin who removes an owner and a member who removes anybody, and removes nobody", async () => {
    const world = serve();
    const { workspaceId, people } = await workspaceOf(world, "owner", "owner", "admin", "member");
    const [owner, , admin, member] = [only(people, 0), only(people, 1), only(people, 2), only(people, 3)];
    const before = await memberIds(workspaceId);
    const token = await seedApiToken(database(), { accountId: owner.account.id, workspaceId });

    const byAdmin = await send(world, "DELETE", `${MEMBERS}/${owner.account.id}`, { cookie: admin.cookie }, { content: "transfer" });
    const byMember = await send(world, "DELETE", `${MEMBERS}/${admin.account.id}`, { cookie: member.cookie }, { content: "transfer" });

    expect(byAdmin.status).toBe(403);
    expect(await problem(byAdmin)).toMatchObject({ code: "forbidden" });
    expect(byMember.status).toBe(403);
    expect(await memberIds(workspaceId)).toEqual(before);
    expect(await tokenIds(workspaceId)).toEqual([token.id]);
    expect(await jobs()).toEqual([]);
    expect(await auditOf(workspaceId)).toEqual([]);
  });

  it("refuses to remove the last owner with 409 last_owner, with a recipient named or not, and leaves the membership, the tokens, the jobs and the audit log as they were", async () => {
    const world = serve();
    const { workspaceId, people } = await workspaceOf(world, "owner", "admin");
    const [owner, admin] = [only(people, 0), only(people, 1)];
    const token = await seedApiToken(database(), { accountId: owner.account.id, workspaceId });

    const byDefault = await send(world, "DELETE", `${MEMBERS}/${owner.account.id}`, { cookie: owner.cookie }, { content: "transfer" });
    const named = await send(world, "DELETE", `${MEMBERS}/${owner.account.id}`, { cookie: owner.cookie }, { content: "transfer", transferTo: admin.account.id });

    for (const response of [byDefault, named]) {
      expect(response.status).toBe(409);
      expect(await problem(response)).toMatchObject({ code: "last_owner" });
    }
    expect(await memberIds(workspaceId)).toEqual([owner.account.id, admin.account.id].sort());
    expect(await tokenIds(workspaceId)).toEqual([token.id]);
    expect(await jobs()).toEqual([]);
    expect(await auditOf(workspaceId)).toEqual([]);
    expect((await send(world, "GET", MEMBERS, bearer(token.value))).status).toBe(200);
  });

  it("lets exactly one of two owners remove the other when they do it at the same moment", async () => {
    const world = serve();
    const { workspaceId, people } = await workspaceOf(world, "owner", "owner");
    const [first, second] = [only(people, 0), only(people, 1)];

    const responses = await Promise.all([
      send(world, "DELETE", `${MEMBERS}/${second.account.id}`, { cookie: first.cookie }, { content: "transfer" }),
      send(world, "DELETE", `${MEMBERS}/${first.account.id}`, { cookie: second.cookie }, { content: "transfer" }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 404]);
    expect(await memberIds(workspaceId)).toHaveLength(1);
    expect(await jobs()).toHaveLength(1);
  });

  it("refuses a recipient who is no member of the workspace or is a member of another workspace with 404, and the member who is removed with 422, both naming transferTo, and removes nobody", async () => {
    const world = serve();
    const { workspaceId, people } = await workspaceOf(world, "owner", "member");
    const other = await workspaceOf(world, "owner");
    const [owner, member] = [only(people, 0), only(people, 1)];
    const stranger = await person(world);
    const before = await workspaceChecksum(database(), other.workspaceId);

    for (const transferTo of [stranger.account.id, only(other.people, 0).account.id]) {
      const response = await send(world, "DELETE", `${MEMBERS}/${member.account.id}`, { cookie: owner.cookie }, { content: "transfer", transferTo });
      expect(response.status).toBe(404);
      expect(await problem(response)).toMatchObject({ code: "not_found", errors: [{ path: "transferTo", code: "not_found" }] });
    }
    const itself = await send(world, "DELETE", `${MEMBERS}/${member.account.id}`, { cookie: owner.cookie }, { content: "transfer", transferTo: member.account.id });
    expect(itself.status).toBe(422);
    expect(await problem(itself)).toMatchObject({ code: "validation_failed", errors: [{ path: "transferTo", code: "invalid_recipient" }] });

    expect(await memberIds(workspaceId)).toEqual([owner.account.id, member.account.id].sort());
    expect(await workspaceChecksum(database(), other.workspaceId)).toBe(before);
    expect(await jobs()).toEqual([]);
  });

  it("answers 404 to an account that is no member of the workspace, a member of workspace B included, and leaves B as it was", async () => {
    const world = serve();
    const { workspaceId, people } = await workspaceOf(world, "owner");
    const other = await workspaceOf(world, "owner", "member");
    const owner = only(people, 0);
    const before = await workspaceChecksum(database(), other.workspaceId);
    const token = await seedApiToken(database(), { accountId: only(other.people, 1).account.id, workspaceId: other.workspaceId });

    for (const target of [only(other.people, 0), only(other.people, 1)]) {
      const response = await send(world, "DELETE", `${MEMBERS}/${target.account.id}`, { cookie: owner.cookie }, { content: "delete" });
      expect(response.status).toBe(404);
      expect(await problem(response)).toMatchObject({ code: "not_found" });
    }

    expect(await workspaceChecksum(database(), other.workspaceId)).toBe(before);
    expect(await tokenIds(other.workspaceId)).toEqual([token.id]);
    expect(await memberIds(workspaceId)).toEqual([owner.account.id]);
    expect(await jobs()).toEqual([]);
  });

  it("treats an admin who names themselves as a member who leaves: the content goes to the longest-standing owner and member.left is recorded", async () => {
    const world = serve();
    const { workspaceId, people } = await workspaceOf(world, "owner", "admin");
    const [owner, admin] = [only(people, 0), only(people, 1)];

    const response = await send(world, "DELETE", `${MEMBERS}/${admin.account.id}`, { cookie: admin.cookie }, { content: "transfer" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ content: "transfer", transferTo: owner.account.id });
    expect((await auditOf(workspaceId)).map((row) => row.action)).toEqual(["member.left"]);
  });

  it("refuses a token and a request without a session, and a body that is not the operation's", async () => {
    const world = serve();
    const { workspaceId, people } = await workspaceOf(world, "owner", "member");
    const [owner, member] = [only(people, 0), only(people, 1)];
    const token = await seedApiToken(database(), { accountId: owner.account.id, workspaceId, scope: "read-write" });
    const path = `${MEMBERS}/${member.account.id}`;

    const byToken = await send(world, "DELETE", path, bearer(token.value), { content: "transfer" });
    const anonymous = await send(world, "DELETE", path, {}, { content: "transfer" });
    const noChoice = await send(world, "DELETE", path, { cookie: owner.cookie }, {});
    const noBody = await send(world, "DELETE", path, { cookie: owner.cookie });
    const wrongChoice = await send(world, "DELETE", path, { cookie: owner.cookie }, { content: "keep" });
    const extra = await send(world, "DELETE", path, { cookie: owner.cookie }, { content: "transfer", accountId: owner.account.id });
    const notAnId = await send(world, "DELETE", path, { cookie: owner.cookie }, { content: "transfer", transferTo: "someone" });
    const badPath = await send(world, "DELETE", `${MEMBERS}/not-an-id`, { cookie: owner.cookie }, { content: "transfer" });

    expect(byToken.status).toBe(403);
    expect(anonymous.status).toBe(401);
    for (const response of [noChoice, wrongChoice, extra, notAnId, badPath]) {
      expect(response.status).toBe(422);
    }
    expect(noBody.status).toBeGreaterThanOrEqual(400);
    expect(await memberIds(workspaceId)).toEqual([owner.account.id, member.account.id].sort());
  });

  it("answers 404 to an account that acts in no workspace", async () => {
    const world = serve();
    const alone = await person(world);

    const response = await send(world, "DELETE", `${MEMBERS}/${alone.account.id}`, { cookie: alone.cookie }, { content: "transfer" });

    expect(response.status).toBe(404);
  });
});

describe("POST /api/v1/workspace/leave", () => {
  it("lets a member leave at once: the membership and the member's tokens go, the content goes to the longest-standing owner by default, and member.left records it", async () => {
    const world = serve();
    const { workspaceId, people } = await workspaceOf(world, "owner", "owner", "member");
    const [first, second, member] = [only(people, 0), only(people, 1), only(people, 2)];
    const token = await seedApiToken(database(), { accountId: member.account.id, workspaceId });

    const response = await send(world, "POST", LEAVE, { cookie: member.cookie }, { content: "transfer" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ content: "transfer", transferTo: first.account.id });
    expect(await memberIds(workspaceId)).toEqual([first.account.id, second.account.id].sort());
    expect(await tokenIds(workspaceId)).toEqual([]);
    expect(await jobs()).toEqual([{ eventId: expect.any(String) as string, workspaceId, accountId: member.account.id, content: "transfer", transferTo: first.account.id }]);
    expect(await auditOf(workspaceId)).toEqual([
      { action: "member.left", actor_account_id: member.account.id, entity_type: "member", entity_id: member.account.id, metadata: { content: "transfer", transferTo: first.account.id } },
    ]);
    expect((await send(world, "GET", WORKSPACE, { cookie: member.cookie })).status).toBe(404);
    expect((await send(world, "GET", MEMBERS, bearer(token.value))).status).toBe(401);
  });

  it("hands the content to the longest-standing owner other than the owner who leaves", async () => {
    const world = serve();
    const { workspaceId, people } = await workspaceOf(world, "owner", "owner", "owner");
    const [first, second] = [only(people, 0), only(people, 1)];

    const response = await send(world, "POST", LEAVE, { cookie: first.cookie }, { content: "delete" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ content: "delete", transferTo: second.account.id });
    expect(await memberIds(workspaceId)).toHaveLength(2);
  });

  it("hands the content to the member named, who must be another current member", async () => {
    const world = serve();
    const { people } = await workspaceOf(world, "owner", "admin", "member");
    const [, admin, member] = [only(people, 0), only(people, 1), only(people, 2)];
    const stranger = await person(world);

    const named = await send(world, "POST", LEAVE, { cookie: member.cookie }, { content: "transfer", transferTo: admin.account.id });
    const refused = await send(world, "POST", LEAVE, { cookie: admin.cookie }, { content: "transfer", transferTo: stranger.account.id });
    const itself = await send(world, "POST", LEAVE, { cookie: admin.cookie }, { content: "transfer", transferTo: admin.account.id });

    expect(named.status).toBe(200);
    expect(await named.json()).toEqual({ content: "transfer", transferTo: admin.account.id });
    expect(refused.status).toBe(404);
    expect(await problem(refused)).toMatchObject({ code: "not_found", errors: [{ path: "transferTo", code: "not_found" }] });
    expect(itself.status).toBe(422);
  });

  it("refuses the last owner with 409 last_owner, with a recipient named or not, and changes nothing", async () => {
    const world = serve();
    const { workspaceId, people } = await workspaceOf(world, "owner", "member");
    const [owner, member] = [only(people, 0), only(people, 1)];
    const token = await seedApiToken(database(), { accountId: owner.account.id, workspaceId });

    const byDefault = await send(world, "POST", LEAVE, { cookie: owner.cookie }, { content: "transfer" });
    const named = await send(world, "POST", LEAVE, { cookie: owner.cookie }, { content: "delete", transferTo: member.account.id });

    for (const response of [byDefault, named]) {
      expect(response.status).toBe(409);
      expect(await problem(response)).toMatchObject({ code: "last_owner" });
    }
    expect(await memberIds(workspaceId)).toEqual([owner.account.id, member.account.id].sort());
    expect(await tokenIds(workspaceId)).toEqual([token.id]);
    expect(await jobs()).toEqual([]);
    expect(await auditOf(workspaceId)).toEqual([]);
    expect((await send(world, "GET", WORKSPACE, { cookie: owner.cookie })).status).toBe(200);
  });

  it("lets exactly one of two owners leave when both do it at the same moment", async () => {
    const world = serve();
    const { workspaceId, people } = await workspaceOf(world, "owner", "owner");

    const responses = await Promise.all(people.map((member) => send(world, "POST", LEAVE, { cookie: member.cookie }, { content: "transfer" })));

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await memberIds(workspaceId)).toHaveLength(1);
    expect(await jobs()).toHaveLength(1);
  });

  it("leaves a workspace B that the recipient belongs to as it was", async () => {
    const world = serve();
    const { people } = await workspaceOf(world, "owner", "member");
    const other = await workspaceOf(world, "owner");
    const before = await workspaceChecksum(database(), other.workspaceId);

    const response = await send(world, "POST", LEAVE, { cookie: only(people, 1).cookie }, { content: "transfer", transferTo: only(other.people, 0).account.id });

    expect(response.status).toBe(404);
    expect(await workspaceChecksum(database(), other.workspaceId)).toBe(before);
    expect(await jobs()).toEqual([]);
  });

  it("refuses a token and a request without a session, answers 404 to an account with no workspace, and 422 to a body that is not the operation's", async () => {
    const world = serve();
    const { workspaceId, people } = await workspaceOf(world, "owner", "member");
    const member = only(people, 1);
    const token = await seedApiToken(database(), { accountId: member.account.id, workspaceId, scope: "read-write" });
    const alone = await person(world);

    const byToken = await send(world, "POST", LEAVE, bearer(token.value), { content: "transfer" });
    const anonymous = await send(world, "POST", LEAVE, {}, { content: "transfer" });
    const nowhere = await send(world, "POST", LEAVE, { cookie: alone.cookie }, { content: "transfer" });
    const noChoice = await send(world, "POST", LEAVE, { cookie: member.cookie }, {});
    const extra = await send(world, "POST", LEAVE, { cookie: member.cookie }, { content: "transfer", accountId: member.account.id });

    expect(byToken.status).toBe(403);
    expect(anonymous.status).toBe(401);
    expect(nowhere.status).toBe(404);
    expect(noChoice.status).toBe(422);
    expect(extra.status).toBe(422);
    expect(await memberIds(workspaceId)).toHaveLength(2);
  });

  it("answers 404 to a member whose workspace is being deleted", async () => {
    const world = serve();
    const leaving = await person(world);
    const going = await seedWorkspace(database(), { name: "Going", deleting: true });
    await seedMembership(database(), { workspaceId: going, accountId: leaving.account.id, role: "owner" });
    await setActiveWorkspace(database(), leaving.sessionId, going);

    const response = await send(world, "POST", LEAVE, { cookie: leaving.cookie }, { content: "transfer" });

    expect(response.status).toBe(404);
    expect(await memberIds(going)).toEqual([leaving.account.id]);
  });
});
