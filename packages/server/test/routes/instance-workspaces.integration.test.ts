import { createHash } from "node:crypto";
import type { EntitlementCheck } from "@slugbase/core";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HookResult, type DeletionGuardInput, type ServerHooks } from "../../src/hooks/index.ts";
import type { ServerModule } from "../../src/create-server.ts";
import { seedAccount } from "../auth/support.ts";
import { recordingLogger } from "../support.ts";
import { HOOK_TIMEOUT_MS, SESSION_COOKIE, bearer, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// GET, POST and DELETE /instance/workspaces through the whole chain over the migrated database (doc 04 section
// 10.10, doc 02 section 11.1, doc 01 section 13.2, doc 10 T1 and T18). The failure scenarios: a caller the
// instanceAdmin policy excludes that lists, creates or deletes a workspace; a list that carries more than a
// workspace's name, owners, member count and creation time, or that opens a workspace the admin is not a member of;
// an owner invitation that the public invitation operation can write, or whose token is stored or returned twice; a
// creation that leaves a half-made workspace behind when the owner is refused; and a deletion that skips the
// re-authentication or the deletion guard, or is marked or queued when either refuses; and, for the membership, a way
// to gain access to a workspace without the membership and the events in its own log and the instance stream (doc 10
// T15), an admin who is added by another admin's call, and a workspace that is being deleted that takes the admin in.

const LIST = "/api/v1/instance/workspaces";
const WORKSPACES = "/api/v1/workspaces";
const INVITATIONS = "/api/v1/invitations";
const LOGIN = "/api/v1/auth/login";
const DELETE_JOB = "workspace.delete";
const EVENT_JOB = "event.workspace.created";
const JOINED_JOB = "event.member.joined";
const MEMBERS = "/api/v1/members";
const TEAMS = "/api/v1/teams";
const TEAMS_GRANTED: EntitlementCheck = (entitlement) => entitlement === "teams.manage";
const ACTIVE_WORKSPACE = "/api/v1/session/active-workspace";

const database = useTestDatabase();
const harness = workspaceHarness(database);

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);
afterAll(() => harness.stop());

beforeEach(async () => {
  await database().owner`DELETE FROM pgboss.job WHERE name IN (${DELETE_JOB}, ${EVENT_JOB}, ${JOINED_JOB})`;
});

const codeOf = async (response: Response): Promise<string> => ((await response.json()) as { code: string }).code;

/** What another admin's demotion of the caller does, committed while the caller's request is in flight. */
async function loseFlag(accountId: string): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${accountId}, true)`;
    await tx`UPDATE accounts SET is_instance_admin = false WHERE id = ${accountId}`;
  });
}

async function enrolSecondFactor(accountId: string): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${accountId}, true)`;
    await tx`UPDATE accounts SET mfa_enabled_at = now(), mfa_secret = ${Buffer.from("sealed")}, mfa_secret_key_id = 'key-1' WHERE id = ${accountId}`;
  });
}

interface Caller {
  readonly accountId: string;
  readonly email: string;
  readonly cookie: string;
}

/** A signed-in account with the flag and the second factor the options give, that has not re-authenticated. */
async function caller(world: World, options: { flag: boolean; mfa: boolean }): Promise<Caller> {
  const account = await seedAccount(database(), { emailVerified: true, instanceAdmin: options.flag });
  const response = await send(world, "POST", LOGIN, {}, { email: account.email, password: account.password, remember: false });
  const token = new RegExp(`^${SESSION_COOKIE}=([A-Za-z0-9_-]{43});`).exec(response.headers.get("set-cookie") ?? "")?.[1];
  if (response.status !== 200 || token === undefined) {
    throw new Error(`could not sign in: ${String(response.status)}`);
  }
  if (options.mfa) {
    await enrolSecondFactor(account.id);
  }
  return { accountId: account.id, email: account.email, cookie: `${SESSION_COOKIE}=${token}` };
}

/** An instance admin with a second factor whose session re-authenticated just now. */
async function admin(world: World): Promise<Caller & { readonly person: Person }> {
  const person = await harness.person(world);
  await database().owner.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${person.account.id}, true)`;
    await tx`UPDATE accounts SET is_instance_admin = true WHERE id = ${person.account.id}`;
  });
  await enrolSecondFactor(person.account.id);
  return { accountId: person.account.id, email: person.account.email, cookie: person.cookie, person };
}

interface EventRow {
  actor_account_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  metadata: Record<string, unknown>;
}

async function instanceEvents(): Promise<EventRow[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<EventRow[]>`SELECT actor_account_id, action, entity_type, entity_id, metadata FROM audit_events WHERE workspace_id IS NULL ORDER BY created_at, id`;
  });
  return [...rows];
}

async function workspaceCount(): Promise<number> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ count: number }[]>`SELECT count(*)::int AS count FROM workspaces`;
  });
  return rows[0]?.count ?? 0;
}

interface InvitationRow {
  id: string;
  role: string;
  instance_issued: boolean;
  status: string;
  token_hash: Buffer;
}

async function invitationsOf(workspaceId: string): Promise<InvitationRow[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<InvitationRow[]>`SELECT id, role::text AS role, instance_issued, status, token_hash FROM workspace_invitations WHERE workspace_id = ${workspaceId}`;
  });
  return [...rows];
}

async function jobs(queue: string): Promise<Record<string, unknown>[]> {
  return (await database().owner<{ data: Record<string, unknown> }[]>`SELECT data FROM pgboss.job WHERE name = ${queue} ORDER BY created_on`).map((row) => row.data);
}

interface Listed {
  readonly id: string;
  readonly name: string;
  readonly owners: readonly { accountId: string; displayName: string; email: string }[];
  readonly memberCount: number;
  readonly createdAt: string;
}

async function listed(world: World, as: { cookie: string }): Promise<Listed[]> {
  const response = await send(world, "GET", LIST, { cookie: as.cookie });
  expect(response.status).toBe(200);
  return ((await response.json()) as { items: Listed[] }).items;
}

const guardModule = (guard: NonNullable<ServerHooks["deletionGuard"]>): ServerModule => ({
  name: "test/billing",
  hooks: { deletionGuard: guard },
  hookRefusals: { deletionGuard: ["billing_active"] },
  register: () => ({}),
});

describe("GET /instance/workspaces", () => {
  it("lists a workspace the admin is not a member of with its name, owners, member count and creation time, and nothing else", async () => {
    const world = harness.serve();
    const root = await admin(world);
    const owner = await harness.person(world);
    const member = await harness.person(world);
    const { workspaceId } = await harness.workspaceOf([
      { person: owner, role: "owner" },
      { person: member, role: "member" },
    ]);

    const response = await send(world, "GET", LIST, { cookie: root.cookie });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Record<string, unknown>[] };
    expect(Object.keys(body)).toEqual(["items"]);
    const found = body.items.find((item) => item["id"] === workspaceId);
    expect(found).toEqual({
      id: workspaceId,
      name: "Authorization suite",
      owners: [{ accountId: owner.account.id, displayName: "Test account", email: owner.account.email }],
      memberCount: 2,
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/) as string,
    });
    expect(JSON.stringify(body)).not.toContain(member.account.email);
  });

  it("lists a workspace that waits for its first owner with no owners, and writes one instance audit event per read", async () => {
    const world = harness.serve();
    const root = await admin(world);
    const created = await send(world, "POST", LIST, { cookie: root.cookie }, { name: "Waiting", ownerEmail: "first-owner@example.test" });
    const { id } = (await created.json()) as { id: string };
    const before = (await instanceEvents()).filter((event) => event.action === "instance.workspaces_viewed").length;

    const items = await listed(world, root);

    expect(items.find((item) => item.id === id)).toMatchObject({ name: "Waiting", owners: [], memberCount: 0 });
    const events = (await instanceEvents()).filter((event) => event.action === "instance.workspaces_viewed");
    expect(events).toHaveLength(before + 1);
    expect(events.at(-1)).toEqual({ actor_account_id: root.accountId, action: "instance.workspaces_viewed", entity_type: null, entity_id: null, metadata: {} });
  });

  it("does not make the admin a member of what it lists: the workspace is in no list of theirs and no operation acts in it for them", async () => {
    const world = harness.serve();
    const root = await admin(world);
    const owner = await harness.person(world);
    const { workspaceId } = await harness.workspaceOf([{ person: owner, role: "owner" }]);
    expect((await listed(world, root)).map((item) => item.id)).toContain(workspaceId);

    const own = (await (await send(world, "GET", WORKSPACES, { cookie: root.cookie })).json()) as { items: { id: string }[] };
    expect(own.items.map((item) => item.id)).not.toContain(workspaceId);
    const switched = await send(world, "PUT", "/api/v1/session/active-workspace", { cookie: root.cookie }, { workspaceId });
    expect(switched.status).toBe(404);
    expect((await send(world, "GET", "/api/v1/workspace", { cookie: root.cookie })).status).toBe(404);
    expect((await send(world, "GET", "/api/v1/members", { cookie: root.cookie })).status).toBe(404);
    expect(await harness.rolesOf(workspaceId)).toEqual({ [owner.account.id]: "owner" });
  });
});

describe("POST /instance/workspaces for an owner account", () => {
  it("creates the workspace with that account as its owner, announces workspace.created and writes the instance audit event, and the admin does not become a member", async () => {
    const world = harness.serve();
    const root = await admin(world);
    const owner = await harness.person(world);

    const response = await send(world, "POST", LIST, { cookie: root.cookie }, { name: "  Acme  ", ownerAccountId: owner.account.id });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string; name: string; ownerInvitation: unknown };
    expect(body).toEqual({ id: expect.any(String) as string, name: "Acme", ownerInvitation: null });
    expect(await harness.rolesOf(body.id)).toEqual({ [owner.account.id]: "owner" });
    const mine = (await (await send(world, "GET", WORKSPACES, { cookie: owner.cookie })).json()) as { items: { id: string; role: string }[] };
    expect(mine.items.find((item) => item.id === body.id)?.role).toBe("owner");
    expect(await jobs(EVENT_JOB)).toEqual([{ eventId: expect.any(String) as string, workspaceId: body.id, accountId: owner.account.id }]);
    expect((await instanceEvents()).at(-1)).toEqual({
      actor_account_id: root.accountId,
      action: "instance.workspace_created",
      entity_type: "workspace",
      entity_id: body.id,
      metadata: { owner: "account" },
    });
  });

  it("answers 422 unknown_account for an account that does not exist and creates nothing", async () => {
    const world = harness.serve();
    const root = await admin(world);
    const workspaces = await workspaceCount();
    const events = await instanceEvents();

    const response = await send(world, "POST", LIST, { cookie: root.cookie }, { name: "Orphan", ownerAccountId: "0192f3a0-aaaa-7000-8000-00000000dead" });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "validation_failed", errors: [{ path: "ownerAccountId", code: "unknown_account" }] });
    expect(await workspaceCount()).toBe(workspaces);
    expect(await instanceEvents()).toEqual(events);
    expect(await jobs(EVENT_JOB)).toEqual([]);
  });

  it("answers 422 unknown_account for a disabled account and creates nothing", async () => {
    const world = harness.serve();
    const root = await admin(world);
    const disabled = await seedAccount(database(), { emailVerified: true, disabled: true });
    const workspaces = await workspaceCount();

    const response = await send(world, "POST", LIST, { cookie: root.cookie }, { name: "Orphan", ownerAccountId: disabled.id });

    expect(response.status).toBe(422);
    expect(await workspaceCount()).toBe(workspaces);
    expect(await jobs(EVENT_JOB)).toEqual([]);
  });

  it.each([
    ["neither an owner account nor an owner address", { name: "Acme" }],
    ["both an owner account and an owner address", { name: "Acme", ownerAccountId: "0192f3a0-aaaa-7000-8000-00000000dead", ownerEmail: "owner@example.test" }],
    ["a name that is blank", { name: "   ", ownerEmail: "owner@example.test" }],
    ["a name of 65 characters", { name: "n".repeat(65), ownerEmail: "owner@example.test" }],
    ["an address that is none", { name: "Acme", ownerEmail: "not an address" }],
    ["an account identifier that is none", { name: "Acme", ownerAccountId: "not-a-uuid" }],
    ["a field the operation does not declare", { name: "Acme", ownerEmail: "owner@example.test", role: "owner" }],
  ])("answers 422 for %s and creates nothing", async (_name, body) => {
    const world = harness.serve();
    const root = await admin(world);
    const workspaces = await workspaceCount();
    const events = await instanceEvents();

    const response = await send(world, "POST", LIST, { cookie: root.cookie }, body);

    expect(response.status).toBe(422);
    expect(await workspaceCount()).toBe(workspaces);
    expect(await instanceEvents()).toEqual(events);
  });
});

describe("POST /instance/workspaces for an owner invitation", () => {
  const INVITATION_LINK = /^https?:\/\/[^/]+\/invite\/([A-Za-z0-9_-]{43})$/;

  it("creates a workspace with no member and one pending owner invitation, returns the link once, and stores only the hash of its token", async () => {
    const world = harness.serve();
    const root = await admin(world);

    const response = await send(world, "POST", LIST, { cookie: root.cookie }, { name: "Waiting", ownerEmail: "First.Owner@Example.test" });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string; ownerInvitation: { id: string; email: string; expiresAt: string; link: string } };
    expect(body.ownerInvitation).toMatchObject({ email: "First.Owner@Example.test", link: expect.stringMatching(INVITATION_LINK) as string });
    const token = INVITATION_LINK.exec(body.ownerInvitation.link)?.[1] ?? "";
    expect(new Date(body.ownerInvitation.expiresAt).getTime() - Date.now()).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000);
    expect(await harness.rolesOf(body.id)).toEqual({});
    const rows = await invitationsOf(body.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: body.ownerInvitation.id, role: "owner", instance_issued: true, status: "pending" });
    expect(rows[0]?.token_hash.equals(createHash("sha256").update(Buffer.from(token, "base64url")).digest())).toBe(true);
    expect(await jobs(EVENT_JOB)).toEqual([]);
    const events = await instanceEvents();
    expect(events.at(-1)).toEqual({ actor_account_id: root.accountId, action: "instance.workspace_created", entity_type: "workspace", entity_id: body.id, metadata: { owner: "invitation" } });
    expect(JSON.stringify(events)).not.toContain(token);
    expect(JSON.stringify(events)).not.toContain("example.test");
  });

  it("is the link the owner redeems: the inspection names the workspace, and the account that holds the address becomes its owner", async () => {
    const world = harness.serve({ entitlements: () => true });
    const root = await admin(world);
    const invitee = await harness.person(world);
    const created = await send(world, "POST", LIST, { cookie: root.cookie }, { name: "Waiting", ownerEmail: invitee.account.email });
    const body = (await created.json()) as { id: string; ownerInvitation: { link: string } };
    const token = INVITATION_LINK.exec(body.ownerInvitation.link)?.[1] ?? "";

    const inspected = await send(world, "POST", `${INVITATIONS}/inspect`, {}, { token });
    expect(inspected.status).toBe(200);
    expect(await inspected.json()).toMatchObject({ workspaceName: "Waiting", role: "owner" });
    const stranger = await harness.person(world);
    expect((await send(world, "POST", `${INVITATIONS}/accept`, { cookie: stranger.cookie }, { token })).status).toBe(403);
    expect(await harness.rolesOf(body.id)).toEqual({});

    const accepted = await send(world, "POST", `${INVITATIONS}/accept`, { cookie: invitee.cookie }, { token });

    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ workspaceId: body.id, role: "owner" });
    expect(await harness.rolesOf(body.id)).toEqual({ [invitee.account.id]: "owner" });
    expect((await listed(world, root)).find((item) => item.id === body.id)).toMatchObject({ owners: [{ accountId: invitee.account.id }], memberCount: 1 });
    expect((await send(world, "POST", `${INVITATIONS}/accept`, { cookie: invitee.cookie }, { token })).status).toBe(410);
  });

  it("is not something the public invitation operation can write: it still refuses the owner role, for an owner of a workspace too", async () => {
    const world = harness.serve({ entitlements: () => true });
    const owner = await harness.person(world);
    const { workspaceId } = await harness.workspaceOf([{ person: owner, role: "owner" }]);
    const before = await invitationsOf(workspaceId);

    const response = await send(world, "POST", INVITATIONS, { cookie: owner.cookie }, { email: "owner-by-invitation@example.test", role: "owner" });

    expect(response.status).toBe(422);
    expect(await invitationsOf(workspaceId)).toEqual(before);
  });
});

describe("DELETE /instance/workspaces/{id}", () => {
  async function victim(world: World) {
    const owner = await harness.person(world);
    const { workspaceId } = await harness.workspaceOf([{ person: owner, role: "owner" }]);
    const token = await harness.token(workspaceId, owner, "read");
    return { owner, workspaceId, token };
  }

  const remove = (world: World, as: { cookie: string }, workspaceId: string, headers: Record<string, string> = {}) =>
    send(world, "DELETE", `${LIST}/${workspaceId}`, { cookie: as.cookie, ...headers });

  it("answers 202, hides the workspace from its members and the list, revokes its tokens, queues the job of DELETE /workspace and writes the instance audit event", async () => {
    const asked: DeletionGuardInput[] = [];
    const world = harness.serve({
      modules: [
        guardModule((input) => {
          asked.push(input);
          return HookResult.allow();
        }),
      ],
    });
    const root = await admin(world);
    const { owner, workspaceId, token } = await victim(world);
    expect((await send(world, "GET", "/api/v1/workspace", bearer(token))).status).toBe(200);

    const response = await remove(world, root, workspaceId);

    expect(response.status).toBe(202);
    expect(asked).toEqual([{ kind: "workspace", workspaceId, accountId: root.accountId, requestedBy: "instanceAdmin" }]);
    const mine = (await (await send(world, "GET", WORKSPACES, { cookie: owner.cookie })).json()) as { items: { id: string }[] };
    expect(mine.items.map((item) => item.id)).not.toContain(workspaceId);
    expect((await listed(world, root)).map((item) => item.id)).not.toContain(workspaceId);
    expect((await send(world, "GET", "/api/v1/workspace", bearer(token))).status).toBe(401);
    expect(await jobs(DELETE_JOB)).toEqual([{ workspaceId }]);
    expect((await instanceEvents()).filter((event) => event.action === "instance.workspace_deletion_requested")).toEqual([
      {
      actor_account_id: root.accountId,
      action: "instance.workspace_deletion_requested",
      entity_type: "workspace",
      entity_id: workspaceId,
      metadata: {},
      },
    ]);
  });

  it("answers 404 for a workspace that is already being deleted or does not exist, writing and queuing nothing", async () => {
    const world = harness.serve();
    const root = await admin(world);
    const { workspaceId } = await victim(world);
    expect((await remove(world, root, workspaceId)).status).toBe(202);
    const events = await instanceEvents();
    const queued = await jobs(DELETE_JOB);

    expect((await remove(world, root, workspaceId)).status).toBe(404);
    const unknown = await remove(world, root, "0192f3a0-aaaa-7000-8000-00000000dead");
    expect(unknown.status).toBe(404);
    expect(await codeOf(unknown)).toBe("not_found");

    expect(await instanceEvents()).toEqual(events);
    expect(await jobs(DELETE_JOB)).toEqual(queued);
  });

  it("answers 409 billing_active when the deployment's guard refuses, and leaves the workspace, its tokens, the queue and the stream as they were", async () => {
    const world = harness.serve({ modules: [guardModule(() => HookResult.refuse("billing_active"))] });
    const root = await admin(world);
    const { owner, workspaceId, token } = await victim(world);
    const events = await instanceEvents();

    const response = await remove(world, root, workspaceId);

    expect(response.status).toBe(409);
    expect(await codeOf(response)).toBe("billing_active");
    const mine = (await (await send(world, "GET", WORKSPACES, { cookie: owner.cookie })).json()) as { items: { id: string }[] };
    expect(mine.items.map((item) => item.id)).toContain(workspaceId);
    expect((await send(world, "GET", "/api/v1/workspace", bearer(token))).status).toBe(200);
    expect(await jobs(DELETE_JOB)).toEqual([]);
    expect(await instanceEvents()).toEqual(events);
  });

  it("answers 403 forbidden, with nothing marked, queued or written and no error logged, when the caller loses the flag after the policy admitted the request", async () => {
    const logger = recordingLogger();
    const asking: { accountId: string } = { accountId: "" };
    const world = harness.serve({
      logger,
      modules: [
        guardModule(async () => {
          await loseFlag(asking.accountId);
          return HookResult.allow();
        }),
      ],
    });
    const root = await admin(world);
    asking.accountId = root.accountId;
    const { workspaceId } = await victim(world);
    const events = await instanceEvents();

    const response = await remove(world, root, workspaceId);

    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe("forbidden");
    expect(await jobs(DELETE_JOB)).toEqual([]);
    expect(await instanceEvents()).toEqual(events);
    expect([...logger.entries, ...logger.requests].filter((entry) => entry.level === "error")).toEqual([]);
  });

  it("answers 401 reauth_required to a session that has not re-authenticated within ten minutes, and marks nothing", async () => {
    const world = harness.serve();
    const stale = await caller(world, { flag: true, mfa: true });
    const { owner, workspaceId } = await victim(world);
    const events = await instanceEvents();

    const response = await remove(world, stale, workspaceId);

    expect(response.status).toBe(401);
    expect(await codeOf(response)).toBe("reauth_required");
    const mine = (await (await send(world, "GET", WORKSPACES, { cookie: owner.cookie })).json()) as { items: { id: string }[] };
    expect(mine.items.map((item) => item.id)).toContain(workspaceId);
    expect(await jobs(DELETE_JOB)).toEqual([]);
    expect(await instanceEvents()).toEqual(events);
  });
});

describe("POST /instance/workspaces/{id}/membership", () => {
  const join = (world: World, as: { cookie: string }, workspaceId: string, headers: Record<string, string> = {}) =>
    send(world, "POST", `${LIST}/${workspaceId}/membership`, { cookie: as.cookie, ...headers });

  interface LogRow {
    actor_account_id: string | null;
    actor_label: string;
    action: string;
    entity_type: string | null;
    entity_id: string | null;
    metadata: Record<string, unknown>;
  }

  async function workspaceLog(workspaceId: string): Promise<LogRow[]> {
    const rows = await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      return tx<LogRow[]>`
        SELECT actor_account_id, actor_label, action, entity_type, entity_id, metadata
        FROM audit_events WHERE workspace_id = ${workspaceId} ORDER BY created_at, id`;
    });
    return [...rows];
  }

  const joinedEvents = async (workspaceId: string) =>
    (await instanceEvents()).filter((event) => event.action === "instance.workspace_joined" && event.entity_id === workspaceId);

  async function memberList(world: World, as: { cookie: string }): Promise<{ accountId: string; role: string }[]> {
    const response = await send(world, "GET", MEMBERS, { cookie: as.cookie });
    expect(response.status).toBe(200);
    return ((await response.json()) as { items: { accountId: string; role: string }[] }).items;
  }

  it("answers 201 and makes the caller a member of the workspace: its owners see it in GET /members, with the member role and nothing more", async () => {
    const world = harness.serve();
    const root = await admin(world);
    const owner = await harness.person(world);
    const { workspaceId } = await harness.workspaceOf([{ person: owner, role: "owner" }]);
    expect(await harness.rolesOf(workspaceId)).toEqual({ [owner.account.id]: "owner" });

    const response = await join(world, root, workspaceId);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ workspaceId, role: "member" });
    expect(await harness.rolesOf(workspaceId)).toEqual({ [owner.account.id]: "owner", [root.accountId]: "member" });
    const seenByOwner = await memberList(world, owner);
    expect(seenByOwner.find((member) => member.accountId === root.accountId)).toMatchObject({ role: "member" });
    // The membership is a member's: the workspace is in the admin's list, and the roles above member stay closed to it.
    const mine = (await (await send(world, "GET", WORKSPACES, { cookie: root.cookie })).json()) as { items: { id: string; role: string }[] };
    expect(mine.items.find((item) => item.id === workspaceId)?.role).toBe("member");
    expect((await send(world, "POST", INVITATIONS, { cookie: root.cookie }, { email: "someone@example.test", role: "member" })).status).not.toBe(201);
  });

  it("writes member.instance_admin_joined into the workspace's own log and instance.workspace_joined into the instance stream, and announces member.joined", async () => {
    const world = harness.serve();
    const root = await admin(world);
    const owner = await harness.person(world);
    const { workspaceId } = await harness.workspaceOf([{ person: owner, role: "owner" }]);
    const logBefore = await workspaceLog(workspaceId);

    await join(world, root, workspaceId);

    const log = (await workspaceLog(workspaceId)).slice(logBefore.length);
    expect(log).toEqual([
      { actor_account_id: root.accountId, actor_label: "Test account", action: "member.instance_admin_joined", entity_type: "member", entity_id: root.accountId, metadata: { role: "member" } },
    ]);
    expect(log.map((event) => event.action)).not.toContain("member.joined");
    expect(await joinedEvents(workspaceId)).toEqual([
      { actor_account_id: root.accountId, action: "instance.workspace_joined", entity_type: "workspace", entity_id: workspaceId, metadata: {} },
    ]);
    expect(await jobs(JOINED_JOB)).toEqual([{ eventId: expect.any(String) as string, workspaceId, accountId: root.accountId, role: "member" }]);
  });

  it("moves the version of every team of the workspace, so a stale replacement cannot add the admin and one read after the join is applied", async () => {
    const world = harness.serve({ entitlements: TEAMS_GRANTED });
    const root = await admin(world);
    const owner = await harness.person(world);
    const { workspaceId } = await harness.workspaceOf([{ person: owner, role: "owner" }]);
    const teamOf = async (name: string): Promise<{ id: string; version: number }> => {
      const response = await send(world, "POST", TEAMS, { cookie: owner.cookie }, { name });
      expect(response.status).toBe(201);
      return (await response.json()) as { id: string; version: number };
    };
    const design = await teamOf("Design");
    const ops = await teamOf("Ops");
    const replace = (team: { id: string }, accountIds: string[], version: number) =>
      send(world, "PUT", `${TEAMS}/${team.id}/members`, { cookie: owner.cookie, "if-match": `"${String(version)}"` }, { accountIds });
    const versionOf = async (team: { id: string }): Promise<string | null> => (await send(world, "GET", `${TEAMS}/${team.id}`, { cookie: owner.cookie })).headers.get("etag");

    expect((await join(world, root, workspaceId)).status).toBe(201);

    expect(await versionOf(design)).toBe('"2"');
    expect(await versionOf(ops)).toBe('"2"');
    const stale = await replace(design, [owner.account.id, root.accountId], design.version);
    expect(stale.status).toBe(412);
    expect(((await stale.json()) as { code: string }).code).toBe("precondition_failed");
    expect(await versionOf(design)).toBe('"2"');
    const fresh = await replace(ops, [root.accountId], 2);
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get("etag")).toBe('"3"');
    expect(((await fresh.json()) as { members: { accountId: string }[] }).members.map((member) => member.accountId)).toEqual([root.accountId]);
  });

  it("does not move the session to the workspace: the admin switches to it as any member does", async () => {
    const world = harness.serve();
    const root = await admin(world);
    const owner = await harness.person(world);
    const { workspaceId } = await harness.workspaceOf([{ person: owner, role: "owner" }]);
    expect((await send(world, "PUT", ACTIVE_WORKSPACE, { cookie: root.cookie }, { workspaceId })).status).toBe(404);

    await join(world, root, workspaceId);

    expect((await send(world, "PUT", ACTIVE_WORKSPACE, { cookie: root.cookie }, { workspaceId })).status).toBe(204);
    expect((await memberList(world, root)).map((member) => member.accountId)).toContain(root.accountId);
  });

  it("adds a workspace that waits for its first owner as a member and leaves it without an owner", async () => {
    const world = harness.serve();
    const root = await admin(world);
    const created = await send(world, "POST", LIST, { cookie: root.cookie }, { name: "Waiting", ownerEmail: "first-owner@example.test" });
    const { id } = (await created.json()) as { id: string };

    expect((await join(world, root, id)).status).toBe(201);

    expect(await harness.rolesOf(id)).toEqual({ [root.accountId]: "member" });
  });

  it("adds the admin whose session asks and nobody else: another admin's request leaves the first admin out of the workspace", async () => {
    const world = harness.serve();
    const first = await admin(world);
    const second = await admin(world);
    const owner = await harness.person(world);
    const { workspaceId } = await harness.workspaceOf([{ person: owner, role: "owner" }]);

    expect((await join(world, second, workspaceId)).status).toBe(201);

    expect(await harness.rolesOf(workspaceId)).toEqual({ [owner.account.id]: "owner", [second.accountId]: "member" });
    expect(await harness.rolesOf(workspaceId)).not.toHaveProperty(first.accountId);
    expect((await workspaceLog(workspaceId)).map((event) => event.actor_account_id)).toEqual([second.accountId]);
    expect((await joinedEvents(workspaceId)).map((event) => event.actor_account_id)).toEqual([second.accountId]);
  });

  it.each(["owner", "admin", "member"] as const)("answers 409 already_member to an admin who is %s of the workspace already, writing and queuing nothing", async (role) => {
    const world = harness.serve();
    const root = await admin(world);
    const owner = await harness.person(world);
    const { workspaceId } = await harness.workspaceOf([
      { person: owner, role: "owner" },
      { person: root.person, role },
    ]);
    const log = await workspaceLog(workspaceId);
    const events = await instanceEvents();

    const response = await join(world, root, workspaceId);

    expect(response.status).toBe(409);
    expect(await codeOf(response)).toBe("already_member");
    expect(await harness.rolesOf(workspaceId)).toEqual({ [owner.account.id]: "owner", [root.accountId]: role });
    expect(await workspaceLog(workspaceId)).toEqual(log);
    expect(await instanceEvents()).toEqual(events);
    expect(await jobs(JOINED_JOB)).toEqual([]);
  });

  it("answers 409 to the second of two requests, which leaves one membership and one event of each log", async () => {
    const world = harness.serve();
    const root = await admin(world);
    const owner = await harness.person(world);
    const { workspaceId } = await harness.workspaceOf([{ person: owner, role: "owner" }]);

    const answers = await Promise.all([join(world, root, workspaceId), join(world, root, workspaceId)]);

    expect(answers.map((answer) => answer.status).sort()).toEqual([201, 409]);
    expect((await workspaceLog(workspaceId)).filter((event) => event.action === "member.instance_admin_joined")).toHaveLength(1);
    expect(await joinedEvents(workspaceId)).toHaveLength(1);
    expect(await jobs(JOINED_JOB)).toHaveLength(1);
  });

  it("answers 404 for a workspace that is being deleted or does not exist, writing and queuing nothing", async () => {
    const world = harness.serve();
    const root = await admin(world);
    const owner = await harness.person(world);
    const { workspaceId } = await harness.workspaceOf([{ person: owner, role: "owner" }]);
    expect((await send(world, "DELETE", `${LIST}/${workspaceId}`, { cookie: root.cookie })).status).toBe(202);
    const events = await instanceEvents();
    const log = await workspaceLog(workspaceId);
    const roles = await harness.rolesOf(workspaceId);

    const going = await join(world, root, workspaceId);
    const unknown = await join(world, root, "0192f3a0-aaaa-7000-8000-00000000dead");

    expect(going.status).toBe(404);
    expect(await codeOf(going)).toBe("not_found");
    expect(unknown.status).toBe(404);
    expect(await codeOf(unknown)).toBe("not_found");
    expect(await harness.rolesOf(workspaceId)).toEqual(roles);
    expect(await workspaceLog(workspaceId)).toEqual(log);
    expect(await instanceEvents()).toEqual(events);
    expect(await jobs(JOINED_JOB)).toEqual([]);
  });

  it("answers 401 reauth_required to a session that has not re-authenticated within ten minutes, and adds nobody", async () => {
    const world = harness.serve();
    const stale = await caller(world, { flag: true, mfa: true });
    const owner = await harness.person(world);
    const { workspaceId } = await harness.workspaceOf([{ person: owner, role: "owner" }]);
    const events = await instanceEvents();

    const response = await join(world, stale, workspaceId);

    expect(response.status).toBe(401);
    expect(await codeOf(response)).toBe("reauth_required");
    expect(await harness.rolesOf(workspaceId)).toEqual({ [owner.account.id]: "owner" });
    expect(await workspaceLog(workspaceId)).toEqual([]);
    expect(await instanceEvents()).toEqual(events);
    expect(await jobs(JOINED_JOB)).toEqual([]);
  });

  describe("refuses everyone the instanceAdmin policy excludes, and gives access to nobody", () => {
    async function target(world: World) {
      const owner = await harness.person(world);
      const { workspaceId } = await harness.workspaceOf([{ person: owner, role: "owner" }]);
      return { owner, workspaceId };
    }

    async function nothingChanged(workspaceId: string, owner: Person, events: Awaited<ReturnType<typeof instanceEvents>>) {
      expect(await harness.rolesOf(workspaceId)).toEqual({ [owner.account.id]: "owner" });
      expect(await workspaceLog(workspaceId)).toEqual([]);
      expect(await instanceEvents()).toEqual(events);
      expect(await jobs(JOINED_JOB)).toEqual([]);
    }

    it("answers 401 without a credential", async () => {
      const world = harness.serve();
      const { owner, workspaceId } = await target(world);
      const events = await instanceEvents();
      const response = await send(world, "POST", `${LIST}/${workspaceId}/membership`, {});
      expect(response.status).toBe(401);
      expect(await codeOf(response)).toBe("unauthenticated");
      await nothingChanged(workspaceId, owner, events);
    });

    it("answers 403 forbidden to an account that holds no flag, even with a second factor and a fresh re-authentication", async () => {
      const world = harness.serve();
      const { owner, workspaceId } = await target(world);
      const ordinary = await harness.person(world);
      await enrolSecondFactor(ordinary.account.id);
      const events = await instanceEvents();
      const response = await join(world, ordinary, workspaceId);
      expect(response.status).toBe(403);
      expect(await codeOf(response)).toBe("forbidden");
      await nothingChanged(workspaceId, owner, events);
    });

    it("answers 403 forbidden to an instance admin who has no second factor enrolled", async () => {
      const world = harness.serve();
      const { owner, workspaceId } = await target(world);
      const person = await harness.person(world);
      await database().owner.begin(async (tx) => {
        await tx`SELECT set_config('app.account_id', ${person.account.id}, true)`;
        await tx`UPDATE accounts SET is_instance_admin = true WHERE id = ${person.account.id}`;
      });
      const events = await instanceEvents();
      expect((await join(world, person, workspaceId)).status).toBe(403);
      await nothingChanged(workspaceId, owner, events);
    });

    it("answers 403 forbidden to an API token, even of an admin with a second factor", async () => {
      const world = harness.serve();
      const root = await admin(world);
      const { workspaceId: own } = await harness.workspaceOf([{ person: root.person, role: "owner" }]);
      const value = await harness.token(own, root.person, "read-write");
      const { owner, workspaceId } = await target(world);
      const events = await instanceEvents();
      const response = await send(world, "POST", `${LIST}/${workspaceId}/membership`, bearer(value));
      expect(response.status).toBe(403);
      await nothingChanged(workspaceId, owner, events);
    });

    it("answers 403 from another origin", async () => {
      const world = harness.serve();
      const root = await admin(world);
      const { owner, workspaceId } = await target(world);
      const events = await instanceEvents();
      const response = await join(world, root, workspaceId, { origin: "https://evil.example" });
      expect(response.status).toBe(403);
      await nothingChanged(workspaceId, owner, events);
    });
  });
});

describe("refuses everyone the instanceAdmin policy excludes, changing and reading nothing out", () => {
  const attempts = [
    ["GET", LIST, undefined],
    ["POST", LIST, { name: "Hijacked", ownerEmail: "hijack@example.test" }],
    ["DELETE", `${LIST}/0192f3a0-aaaa-7000-8000-00000000dead`, undefined],
  ] as const;

  it.each(attempts)("answers 401 to %s %s without a credential", async (method, path, body) => {
    const world = harness.serve();
    const workspaces = await workspaceCount();
    const response = await send(world, method, path, {}, body);
    expect(response.status).toBe(401);
    expect(await codeOf(response)).toBe("unauthenticated");
    expect(await workspaceCount()).toBe(workspaces);
  });

  it.each(attempts)("answers 403 forbidden to %s %s from an account that holds no flag, even with a second factor and a fresh re-authentication", async (method, path, body) => {
    const world = harness.serve();
    const root = await admin(world);
    const owner = await harness.person(world);
    const { workspaceId } = await harness.workspaceOf([{ person: owner, role: "owner" }]);
    const ordinary = await harness.person(world);
    await enrolSecondFactor(ordinary.account.id);
    const workspaces = await workspaceCount();
    const events = await instanceEvents();
    const target = method === "DELETE" ? `${LIST}/${workspaceId}` : path;

    const response = await send(world, method, target, { cookie: ordinary.cookie }, body);

    expect(response.status).toBe(403);
    const text = await response.text();
    expect((JSON.parse(text) as { code: string }).code).toBe("forbidden");
    expect(text).not.toContain(root.email);
    expect(text).not.toContain(owner.account.email);
    expect(await workspaceCount()).toBe(workspaces);
    expect(await instanceEvents()).toEqual(events);
    expect(await jobs(DELETE_JOB)).toEqual([]);
  });

  it.each(attempts)("answers 403 forbidden to %s %s from an instance admin who has no second factor enrolled", async (method, path, body) => {
    const world = harness.serve();
    const person = await harness.person(world);
    await database().owner.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${person.account.id}, true)`;
      await tx`UPDATE accounts SET is_instance_admin = true WHERE id = ${person.account.id}`;
    });
    const workspaces = await workspaceCount();

    const response = await send(world, method, path, { cookie: person.cookie }, body);

    expect(response.status).toBe(403);
    expect(await workspaceCount()).toBe(workspaces);
    expect(await jobs(DELETE_JOB)).toEqual([]);
  });

  it.each(attempts)("answers 403 forbidden to %s %s with an API token, even of an admin with a second factor", async (method, path, body) => {
    const world = harness.serve();
    const root = await admin(world);
    const { workspaceId } = await harness.workspaceOf([{ person: root.person, role: "owner" }]);
    const value = await harness.token(workspaceId, root.person, "read-write");
    const workspaces = await workspaceCount();

    const response = await send(world, method, path, bearer(value), body);

    expect(response.status).toBe(403);
    expect(await workspaceCount()).toBe(workspaces);
    expect(await jobs(DELETE_JOB)).toEqual([]);
  });

  it.each(attempts.filter(([method]) => method !== "GET"))("answers 403 to %s %s from another origin", async (method, path, body) => {
    const world = harness.serve();
    const root = await admin(world);
    const owner = await harness.person(world);
    const { workspaceId } = await harness.workspaceOf([{ person: owner, role: "owner" }]);
    const workspaces = await workspaceCount();
    const target = method === "DELETE" ? `${LIST}/${workspaceId}` : path;

    const response = await send(world, method, target, { cookie: root.cookie, origin: "https://evil.example" }, body);

    expect(response.status).toBe(403);
    expect(await workspaceCount()).toBe(workspaces);
    expect(await jobs(DELETE_JOB)).toEqual([]);
  });
});
