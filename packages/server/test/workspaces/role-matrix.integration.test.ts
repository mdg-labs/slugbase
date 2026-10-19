import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ACTIVE_WORKSPACE,
  HOOK_TIMEOUT_MS,
  LEAVE,
  MEMBERS,
  SETTINGS,
  TRANSFER,
  WORKSPACE,
  WORKSPACES,
  bearer,
  send,
  workspaceHarness,
  type Person,
  type Role,
  type World,
  type Workspace,
} from "./support.ts";

// The roles table of doc 02 section 3.3 run against every workspace and membership operation of the workspace
// epic, as an owner, an admin, a member and an API token (doc 04 sections 1.2, 4.2 and 10.4, doc 10 T2 and T3).
// The failure scenarios: an operation that answers a role the table does not give it, a refusal that has
// changed something before it refused, an API token that reaches an operation that declares no scope (or one
// that asks for re-authentication), and a member who has left or been removed and still reaches an operation
// on the next request, by session or by token.

const database = useTestDatabase();
const harness = workspaceHarness(database);

interface Fixture {
  readonly workspace: Workspace;
  readonly o1: Person;
  readonly o2: Person;
  readonly a1: Person;
  readonly m1: Person;
  readonly m2: Person;
}

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

interface Operation {
  readonly name: string;
  readonly call: (fixture: Fixture) => Call;
  /** The status for a session of each role of the workspace. */
  readonly session: Readonly<Record<Role, number>>;
  /** The status for an API token of the caller; 200 where the operation declares a read scope and 403 where it does not. */
  readonly token: 200 | 403;
  /** The status for a session whose account is no member of the workspace, or undefined for an operation that is not about a workspace. */
  readonly outsider?: number;
  /** The audit action a successful call writes, or undefined for a call that writes none. */
  readonly audit?: string;
  /** The operation asks for a re-authentication within ten minutes. */
  readonly reauth?: true;
  /** Needs a server whose composition lets accounts create workspaces. */
  readonly creation?: true;
}

const ALL = (status: number): Record<Role, number> => ({ owner: status, admin: status, member: status });
const ADMIN_AND_UP = { owner: 200, admin: 200, member: 403 } as const;
const OWNER_ONLY = (status: number): Record<Role, number> => ({ owner: status, admin: 403, member: 403 });

// Who may do what, row by row, is doc 02 section 3.3. The targets are other accounts than the caller: o1 and o2
// are owners, a1 an admin, m1 and m2 members. The caller of a role is o1, a1 and m1.
const OPERATIONS: readonly Operation[] = [
  { name: "listWorkspaces", call: () => ({ method: "GET", path: WORKSPACES }), session: ALL(200), token: 403, outsider: 200 },
  {
    name: "createWorkspace",
    call: () => ({ method: "POST", path: WORKSPACES, body: { name: "Created in the suite" } }),
    session: ALL(201),
    token: 403,
    creation: true,
  },
  { name: "setActiveWorkspace", call: (f) => ({ method: "PUT", path: ACTIVE_WORKSPACE, body: { workspaceId: f.workspace.workspaceId } }), session: ALL(204), token: 403, outsider: 404 },
  { name: "getWorkspace", call: () => ({ method: "GET", path: WORKSPACE }), session: ALL(200), token: 200, outsider: 404 },
  { name: "renameWorkspace", call: () => ({ method: "PATCH", path: WORKSPACE, body: { name: "Renamed" } }), session: ADMIN_AND_UP, token: 403, outsider: 404, audit: "workspace.renamed" },
  { name: "getWorkspaceSettings", call: () => ({ method: "GET", path: SETTINGS }), session: ADMIN_AND_UP, token: 403, outsider: 404 },
  {
    name: "updateWorkspaceSettings",
    call: () => ({ method: "PATCH", path: SETTINGS, body: { aiEnabled: false } }),
    session: ADMIN_AND_UP,
    token: 403,
    outsider: 404,
    audit: "workspace.settings_changed",
  },
  { name: "listMembers", call: () => ({ method: "GET", path: MEMBERS }), session: ALL(200), token: 200, outsider: 404 },
  {
    name: "updateMember: a member becomes an admin",
    call: (f) => ({ method: "PATCH", path: `${MEMBERS}/${f.m2.account.id}`, body: { role: "admin" } }),
    session: ADMIN_AND_UP,
    token: 403,
    outsider: 404,
    audit: "member.role_changed",
  },
  {
    name: "updateMember: a member becomes an owner",
    call: (f) => ({ method: "PATCH", path: `${MEMBERS}/${f.m2.account.id}`, body: { role: "owner" } }),
    session: OWNER_ONLY(200),
    token: 403,
    outsider: 404,
    audit: "member.role_changed",
  },
  {
    name: "updateMember: an owner becomes an admin",
    call: (f) => ({ method: "PATCH", path: `${MEMBERS}/${f.o2.account.id}`, body: { role: "admin" } }),
    session: OWNER_ONLY(200),
    token: 403,
    outsider: 404,
    audit: "member.role_changed",
  },
  {
    name: "removeMember: a member",
    call: (f) => ({ method: "DELETE", path: `${MEMBERS}/${f.m2.account.id}`, body: { content: "transfer" } }),
    session: ADMIN_AND_UP,
    token: 403,
    outsider: 404,
    audit: "member.removed",
  },
  {
    name: "removeMember: an owner",
    call: (f) => ({ method: "DELETE", path: `${MEMBERS}/${f.o2.account.id}`, body: { content: "transfer" } }),
    session: OWNER_ONLY(200),
    token: 403,
    outsider: 404,
    audit: "member.removed",
  },
  { name: "leaveWorkspace", call: () => ({ method: "POST", path: LEAVE, body: { content: "transfer" } }), session: ALL(200), token: 403, outsider: 404, audit: "member.left" },
  {
    name: "transferWorkspaceOwnership",
    call: (f) => ({ method: "POST", path: TRANSFER, body: { accountId: f.m2.account.id, demoteSelf: false } }),
    session: OWNER_ONLY(200),
    token: 403,
    outsider: 404,
    audit: "workspace.ownership_transferred",
    reauth: true,
  },
  { name: "deleteWorkspace", call: () => ({ method: "DELETE", path: WORKSPACE }), session: OWNER_ONLY(202), token: 403, outsider: 404, audit: "workspace.deletion_requested", reauth: true },
];

let world: World;
let creationWorld: World;
let owners: readonly [Person, Person];
let admin: Person;
let members: readonly [Person, Person];
let outsider: Person;

beforeAll(async () => {
  await harness.start();
  world = harness.serve();
  creationWorld = harness.serve({ allowWorkspaceCreation: true });
  owners = [await harness.person(world), await harness.person(world)];
  admin = await harness.person(world);
  members = [await harness.person(world), await harness.person(world)];
  outsider = await harness.person(world);
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await harness.stop();
});

/** A workspace of two owners, an admin and two members, and the member given, which every session of them is acting in. */
async function fixture(extra?: { readonly person: Person; readonly role: Role }): Promise<Fixture> {
  const [o1, o2] = owners;
  const [m1, m2] = members;
  const workspace = await harness.workspaceOf([
    { person: o1, role: "owner" },
    { person: o2, role: "owner" },
    { person: admin, role: "admin" },
    { person: m1, role: "member" },
    { person: m2, role: "member" },
    ...(extra === undefined ? [] : [extra]),
  ]);
  return { workspace, o1, o2, a1: admin, m1, m2 };
}

function callerOf(f: Fixture, role: Role): Person {
  return role === "owner" ? f.o1 : role === "admin" ? f.a1 : f.m1;
}

function serving(operation: Operation): World {
  return operation.creation === true ? creationWorld : world;
}

async function problemCode(response: Response): Promise<string> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return ((await response.json()) as { code: string }).code;
}

describe("the role matrix of doc 02 section 3.3", () => {
  it.each(OPERATIONS)(
    "$name: answers an owner, an admin and a member by the table, and a refusal changes nothing",
    async (operation) => {
      for (const role of ["owner", "admin", "member"] as const) {
        const f = await fixture();
        const caller = callerOf(f, role);
        const { workspaceId } = f.workspace;
        const rolesBefore = await harness.rolesOf(workspaceId);
        if (operation.reauth === true) {
          await harness.reauthenticate(world, caller);
        }
        const call = operation.call(f);

        const response = await send(serving(operation), call.method, call.path, { cookie: caller.cookie }, call.body);

        const expected = operation.session[role];
        expect(response.status, `${operation.name} as ${role}`).toBe(expected);
        if (expected === 403) {
          expect(await problemCode(response), `${operation.name} as ${role}`).toBe("forbidden");
        }
        const audit = await harness.auditActions(workspaceId);
        if (expected >= 400 || operation.audit === undefined) {
          expect(audit, `${operation.name} as ${role} writes no audit event`).toEqual([]);
        } else {
          expect(audit, `${operation.name} as ${role} writes its audit event`).toEqual([operation.audit]);
        }
        if (expected >= 400) {
          expect(await harness.rolesOf(workspaceId), `${operation.name} as ${role} leaves the roles`).toEqual(rolesBefore);
        }
      }
    },
    HOOK_TIMEOUT_MS,
  );

  it.each(OPERATIONS)(
    "$name: answers an API token of an owner, an admin and a member as the operation's scope says, and a refusal changes nothing",
    async (operation) => {
      for (const role of ["owner", "admin", "member"] as const) {
        const f = await fixture();
        const caller = callerOf(f, role);
        const { workspaceId } = f.workspace;
        // A token that declares a scope is read-only here: the broadest token refuses the operations that declare none.
        const token = await harness.token(workspaceId, caller, operation.token === 200 ? "read" : "read-write");
        const rolesBefore = await harness.rolesOf(workspaceId);
        const call = operation.call(f);

        const response = await send(serving(operation), call.method, call.path, bearer(token), call.body);

        expect(response.status, `${operation.name} by a token of ${role}`).toBe(operation.token);
        if (operation.token === 403) {
          expect(await problemCode(response), `${operation.name} by a token of ${role}`).toBe("forbidden");
        }
        expect(await harness.auditActions(workspaceId), `${operation.name} by a token of ${role} writes no audit event`).toEqual([]);
        expect(await harness.rolesOf(workspaceId), `${operation.name} by a token of ${role} leaves the roles`).toEqual(rolesBefore);
      }
    },
    HOOK_TIMEOUT_MS,
  );

  it.each(OPERATIONS.filter((operation) => operation.outsider !== undefined))(
    "$name: answers an account that is no member of the workspace by the table, and changes nothing",
    async (operation) => {
      const f = await fixture();
      const { workspaceId } = f.workspace;
      const rolesBefore = await harness.rolesOf(workspaceId);
      const call = operation.call(f);

      const response = await send(serving(operation), call.method, call.path, { cookie: outsider.cookie }, call.body);

      expect(response.status).toBe(operation.outsider);
      expect(await harness.rolesOf(workspaceId)).toEqual(rolesBefore);
      expect(await harness.auditActions(workspaceId)).toEqual([]);
    },
    HOOK_TIMEOUT_MS,
  );
});

interface Departure {
  readonly name: string;
  /** The role the member has when the membership ends. */
  readonly role: Role;
  /** Ends the membership of `victim` and says what the workspace's audit log records for it. */
  readonly end: (f: Fixture, victim: Person) => Promise<{ readonly response: Response; readonly audit: string }>;
}

const removedBy = (by: "o1" | "a1"): Departure["end"] => async (f, victim) => ({
  response: await send(world, "DELETE", `${MEMBERS}/${victim.account.id}`, { cookie: f[by].cookie }, { content: "transfer" }),
  audit: "member.removed",
});

const DEPARTURES: readonly Departure[] = [
  { name: "a member removed by an admin", role: "member", end: removedBy("a1") },
  { name: "an admin removed by an admin", role: "admin", end: removedBy("a1") },
  { name: "an admin removed by an owner", role: "admin", end: removedBy("o1") },
  { name: "an owner removed by an owner", role: "owner", end: removedBy("o1") },
  ...(["member", "admin", "owner"] as const).map(
    (role): Departure => ({
      name: `${role === "admin" ? "an" : "a"} ${role} who leaves`,
      role,
      end: async (_f, victim) => ({ response: await send(world, "POST", LEAVE, { cookie: victim.cookie }, { content: "transfer" }), audit: "member.left" }),
    }),
  ),
];

describe("a member whose membership has ended", () => {
  it.each(DEPARTURES)(
    "loses access through every operation on the very next request, by session and by token: $name",
    async ({ role, end }) => {
      const victim = await harness.person(world);
      const f = await fixture({ person: victim, role });
      const { workspaceId } = f.workspace;
      const token = await harness.token(workspaceId, victim, "read");
      expect((await send(world, "GET", WORKSPACE, { cookie: victim.cookie })).status, "the member reaches the workspace before").toBe(200);
      expect((await send(world, "GET", MEMBERS, bearer(token))).status, "the member's token works before").toBe(200);

      const ended = await end(f, victim);

      expect(ended.response.status).toBe(200);
      const roles = await harness.rolesOf(workspaceId);
      expect(Object.keys(roles)).not.toContain(victim.account.id);
      const audit = await harness.auditActions(workspaceId);
      expect(audit).toEqual([ended.audit]);
      for (const operation of OPERATIONS.filter((candidate) => candidate.outsider !== undefined)) {
        await harness.reauthenticate(world, victim);
        const call = operation.call(f);

        const bySession = await send(world, call.method, call.path, { cookie: victim.cookie }, call.body);
        const byToken = await send(world, call.method, call.path, bearer(token), call.body);

        expect(bySession.status, `${operation.name} by the session after the membership ended`).toBe(operation.outsider);
        expect(byToken.status, `${operation.name} by the token after the membership ended`).toBe(401);
      }
      const listed = (await (await send(world, "GET", WORKSPACES, { cookie: victim.cookie })).json()) as { items: { id: string }[] };
      expect(listed.items.map((item) => item.id)).not.toContain(workspaceId);
      expect(await harness.rolesOf(workspaceId), "no refused call changed a role or a membership").toEqual(roles);
      expect(await harness.auditActions(workspaceId), "no refused call wrote an audit event").toEqual(audit);
    },
    HOOK_TIMEOUT_MS,
  );
});
