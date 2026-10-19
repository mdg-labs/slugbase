import { InMemoryMail } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import type { MailPort } from "@slugbase/core";
import type { AuthStore } from "@slugbase/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAccountOnlyTenantResolver } from "../../src/auth/tenant-resolver.ts";
import { createServer, type Authenticator, type Server } from "../../src/create-server.ts";
import { runMigrations } from "../../src/migrate/index.ts";
import { seedAccount, seedMembership, seedWorkspace, sessionRows, setActiveWorkspace, storeFor, workspaceChecksum, type SeededAccount } from "../auth/support.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { urlOf } from "../migrate/support.ts";
import { adapters, recordingLogger, serverConfig } from "../support.ts";

// POST /api/v1/workspace/transfer-ownership through the whole chain over the migrated database (doc 04 section
// 10.4, doc 02 section 3.3, doc 10 T1, T2 and T18). The failure scenarios: a transfer by a session that has not
// re-authenticated, by an admin, by a member or by a token that goes through; a recipient outside the workspace
// (or in another one) that is promoted or told apart from one that does not exist; a promotion committed without
// the demotion it was asked together with, or the other way round; a workspace left without an owner by two
// owners stepping down at the same moment; a caller who steps down and keeps the token of the session they had as
// an owner; and an email that is queued for a transfer that did not commit, or not queued for one that did.

const TRANSFER = "/api/v1/workspace/transfer-ownership";
const MEMBERS = "/api/v1/members";
const REAUTH = "/api/v1/me/reauth";
const SESSION_COOKIE = "__Host-slugbase_session";
const HOOK_TIMEOUT_MS = 300_000;
const MAIL_JOB = "mail.send";
const UNKNOWN_ACCOUNT = "0192f3a0-ffff-7000-8000-000000000001";

const database = useTestDatabase();
let store: AuthStore;

beforeAll(async () => {
  store = storeFor(database());
  // The queue of the mail job exists once the image entrypoint has run migrate.
  await runMigrations({ url: urlOf(database().owner) });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await store.close();
});

beforeEach(async () => {
  await database().owner`DELETE FROM pgboss.job WHERE name = ${MAIL_JOB}`;
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

const inbox = new InMemoryMail();
/** A mail port that can send: the transfer queues the recipient's email only for one. */
const canSend: MailPort = { available: true, send: (message) => inbox.send(message) };

function serve(mail?: MailPort): World {
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
    adapters: { ...adapters(config), ...(mail === undefined ? {} : { mail }), tenantResolver: createAccountOnlyTenantResolver() },
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
  /** The cookie header of a full session that re-authenticated just now. */
  readonly cookie: string;
  /** The cookie header of a full session that has not. */
  readonly stale: string;
  /** The session `cookie` belongs to. */
  readonly sessionId: string;
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
  const sessions = await sessionRows(database(), account.id);
  const sessionId = sessions[0]?.id;
  if (sessionId === undefined) {
    throw new Error("the account has no session");
  }
  return { account, cookie, stale, sessionId };
}

type Role = "owner" | "admin" | "member";

/** A workspace with a signed-in member of each role given, in that order, all acting in it. */
async function workspaceOf(world: World, ...roles: Role[]): Promise<{ readonly workspaceId: string; readonly people: readonly (Person & { readonly role: Role })[] }> {
  const workspaceId = await seedWorkspace(database(), { name: "Ownership test" });
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`INSERT INTO workspace_settings (workspace_id) VALUES (${workspaceId})`;
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

interface JobRow {
  readonly data: Record<string, unknown>;
}

async function mailJobs(): Promise<JobRow[]> {
  return [...(await database().app<JobRow[]>`SELECT data FROM pgboss.job WHERE name = ${MAIL_JOB} ORDER BY created_on`)];
}

interface MemberBody {
  accountId: string;
  role: string;
}

describe("POST /api/v1/workspace/transfer-ownership", () => {
  it("makes the recipient an owner and keeps the caller one, with the audit event and the recipient's email queued", async () => {
    const world = serve(canSend);
    const { workspaceId, people } = await workspaceOf(world, "owner", "member");
    const [owner, recipient] = [only(people, 0), only(people, 1)];
    const before = await tokenHashOf(owner.sessionId, owner.account.id);

    const response = await send(world, "POST", TRANSFER, { cookie: owner.cookie, "x-forwarded-for": "203.0.113.9" }, { accountId: recipient.account.id, demoteSelf: false });

    expect(response.status).toBe(200);
    expect((await response.json()) as MemberBody).toMatchObject({ accountId: recipient.account.id, role: "owner" });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await rolesOf(workspaceId)).toEqual({ [owner.account.id]: "owner", [recipient.account.id]: "owner" });
    expect(await auditOf(workspaceId)).toEqual([
      {
        action: "workspace.ownership_transferred",
        actor_type: "account",
        actor_account_id: owner.account.id,
        entity_type: "member",
        entity_id: recipient.account.id,
        metadata: { demoteSelf: "false" },
      },
    ]);
    expect(await mailJobs()).toEqual([{ data: { template: "ownershipTransferred", accountId: recipient.account.id, workspaceId, fromAccountId: owner.account.id } }]);
    expect(await tokenHashOf(owner.sessionId, owner.account.id)).toBe(before);
    expect((await send(world, "GET", MEMBERS, { cookie: owner.cookie })).status).toBe(200);
  });

  it("promotes the recipient and demotes the caller in one request, rotates the caller's token and refuses the one they had as an owner", async () => {
    const world = serve(canSend);
    const { workspaceId, people } = await workspaceOf(world, "owner", "admin");
    const [owner, recipient] = [only(people, 0), only(people, 1)];
    const before = await tokenHashOf(owner.sessionId, owner.account.id);

    const response = await send(world, "POST", TRANSFER, { cookie: owner.cookie }, { accountId: recipient.account.id, demoteSelf: true });

    expect(response.status).toBe(200);
    expect((await response.json()) as MemberBody).toMatchObject({ accountId: recipient.account.id, role: "owner" });
    expect(await rolesOf(workspaceId)).toEqual({ [owner.account.id]: "admin", [recipient.account.id]: "owner" });
    const setCookie = response.headers.get("set-cookie") ?? "";
    const fresh = new RegExp(`^${SESSION_COOKIE}=([A-Za-z0-9_-]{43});`).exec(setCookie)?.[1];
    expect(fresh).toBeDefined();
    expect(setCookie).toContain("HttpOnly");
    expect(`${SESSION_COOKIE}=${fresh ?? ""}`).not.toBe(owner.cookie);
    expect(await tokenHashOf(owner.sessionId, owner.account.id)).not.toBe(before);
    expect((await send(world, "GET", MEMBERS, { cookie: owner.cookie })).status).toBe(401);
    expect((await send(world, "GET", MEMBERS, { cookie: `${SESSION_COOKIE}=${fresh ?? ""}` })).status).toBe(200);
    expect(await auditOf(workspaceId)).toMatchObject([{ action: "workspace.ownership_transferred", metadata: { demoteSelf: "true" } }]);
    expect(await mailJobs()).toHaveLength(1);
  });

  it("refuses a session that has not re-authenticated within ten minutes with 401 reauth_required, and changes, queues and writes nothing", async () => {
    const world = serve(canSend);
    const { workspaceId, people } = await workspaceOf(world, "owner", "member");
    const [owner, recipient] = [only(people, 0), only(people, 1)];
    const before = await tokenHashOf(owner.sessionId, owner.account.id);

    for (const demoteSelf of [false, true]) {
      const response = await send(world, "POST", TRANSFER, { cookie: owner.stale }, { accountId: recipient.account.id, demoteSelf });

      expect(response.status).toBe(401);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await problem(response)).toMatchObject({ code: "reauth_required", status: 401 });
    }

    expect(await rolesOf(workspaceId)).toEqual({ [owner.account.id]: "owner", [recipient.account.id]: "member" });
    expect(await auditOf(workspaceId)).toEqual([]);
    expect(await mailJobs()).toEqual([]);
    expect(await tokenHashOf(owner.sessionId, owner.account.id)).toBe(before);
  });

  it("refuses an admin and a member with 403, whoever they name, and changes, queues and writes nothing", async () => {
    const world = serve(canSend);
    const { workspaceId, people } = await workspaceOf(world, "owner", "admin", "member");
    const [owner, admin, member] = [only(people, 0), only(people, 1), only(people, 2)];
    const roles = await rolesOf(workspaceId);

    const attempts: [Person, string][] = [
      [admin, member.account.id],
      [admin, owner.account.id],
      [admin, admin.account.id],
      [member, member.account.id],
      [member, admin.account.id],
    ];
    for (const [caller, target] of attempts) {
      for (const demoteSelf of [false, true]) {
        const response = await send(world, "POST", TRANSFER, { cookie: caller.cookie }, { accountId: target, demoteSelf });

        expect(response.status).toBe(403);
        expect(response.headers.get("set-cookie")).toBeNull();
        expect(await problem(response)).toMatchObject({ code: "forbidden", status: 403 });
      }
    }

    expect(await rolesOf(workspaceId)).toEqual(roles);
    expect(await auditOf(workspaceId)).toEqual([]);
    expect(await mailJobs()).toEqual([]);
  });

  it("refuses an API token of the owner with 403 and changes nothing", async () => {
    const world = serve(canSend);
    const { workspaceId, people } = await workspaceOf(world, "owner", "member");
    const [owner, recipient] = [only(people, 0), only(people, 1)];
    const roles = await rolesOf(workspaceId);

    for (const scope of ["read", "read-write"] as const) {
      const response = await send(
        world,
        "POST",
        TRANSFER,
        { authorization: `Bearer token:${scope}:${owner.account.id}:${workspaceId}` },
        { accountId: recipient.account.id, demoteSelf: false },
      );

      expect(response.status).toBe(403);
    }

    expect(await rolesOf(workspaceId)).toEqual(roles);
    expect(await auditOf(workspaceId)).toEqual([]);
  });

  it("answers 404 for a recipient that is no member of the workspace, a member of another workspace included, and leaves both workspaces as they were", async () => {
    const world = serve(canSend);
    const { workspaceId, people } = await workspaceOf(world, "owner", "member");
    const other = await workspaceOf(world, "owner", "member");
    const outsider = await person(world);
    const owner = only(people, 0);
    const beforeOther = await workspaceChecksum(database(), other.workspaceId);
    const before = await tokenHashOf(owner.sessionId, owner.account.id);
    const roles = await rolesOf(workspaceId);

    const targets = [only(other.people, 0).account.id, only(other.people, 1).account.id, outsider.account.id, UNKNOWN_ACCOUNT];
    const unknown = await send(world, "POST", TRANSFER, { cookie: owner.cookie }, { accountId: UNKNOWN_ACCOUNT, demoteSelf: true });
    for (const target of targets) {
      for (const demoteSelf of [false, true]) {
        const response = await send(world, "POST", TRANSFER, { cookie: owner.cookie }, { accountId: target, demoteSelf });

        expect(response.status).toBe(404);
        expect(response.headers.get("set-cookie")).toBeNull();
        expect(await problem(response)).toMatchObject({ status: 404 });
      }
    }

    // the answer for an account of another workspace is the answer for one that does not exist
    const foreign = await send(world, "POST", TRANSFER, { cookie: owner.cookie }, { accountId: only(other.people, 0).account.id, demoteSelf: true });
    const { requestId: foreignRequest, ...foreignProblem } = await problem(foreign);
    const { requestId: unknownRequest, ...unknownProblem } = await problem(unknown);
    expect(foreignProblem).toEqual(unknownProblem);
    expect(foreignRequest).not.toBe(unknownRequest);
    expect(await workspaceChecksum(database(), other.workspaceId)).toBe(beforeOther);
    expect(await rolesOf(workspaceId)).toEqual(roles);
    expect(await auditOf(workspaceId)).toEqual([]);
    expect(await auditOf(other.workspaceId)).toEqual([]);
    expect(await mailJobs()).toEqual([]);
    expect(await tokenHashOf(owner.sessionId, owner.account.id)).toBe(before);
  });

  it("refuses an owner who names themselves with 422 naming accountId, and changes nothing", async () => {
    const world = serve(canSend);
    const { workspaceId, people } = await workspaceOf(world, "owner", "member");
    const [owner, member] = [only(people, 0), only(people, 1)];
    const roles = await rolesOf(workspaceId);

    for (const demoteSelf of [false, true]) {
      const response = await send(world, "POST", TRANSFER, { cookie: owner.cookie }, { accountId: owner.account.id.toUpperCase(), demoteSelf });

      expect(response.status).toBe(422);
      expect(await problem(response)).toMatchObject({ code: "validation_failed", errors: [{ path: "accountId", code: "invalid_recipient" }] });
    }

    expect(await rolesOf(workspaceId)).toEqual(roles);
    expect(roles[member.account.id]).toBe("member");
    expect(await auditOf(workspaceId)).toEqual([]);
  });

  it.each([
    ["a field the operation does not declare", { accountId: "RECIPIENT", demoteSelf: false, role: "owner" }],
    ["a missing demoteSelf", { accountId: "RECIPIENT" }],
    ["a demoteSelf that is not a boolean", { accountId: "RECIPIENT", demoteSelf: "yes" }],
    ["an identifier that is not a UUID", { accountId: "not-a-uuid", demoteSelf: false }],
    ["no accountId", { demoteSelf: false }],
  ])("answers 422 for %s and changes nothing", async (_name, template) => {
    const world = serve(canSend);
    const { workspaceId, people } = await workspaceOf(world, "owner", "member");
    const [owner, recipient] = [only(people, 0), only(people, 1)];
    const roles = await rolesOf(workspaceId);
    const body = JSON.parse(JSON.stringify(template).replace("RECIPIENT", recipient.account.id)) as unknown;

    const response = await send(world, "POST", TRANSFER, { cookie: owner.cookie }, body);

    expect(response.status).toBe(422);
    expect(await rolesOf(workspaceId)).toEqual(roles);
    expect(await auditOf(workspaceId)).toEqual([]);
  });

  it("writes nothing and queues no email when the recipient is an owner already and the caller stays one", async () => {
    const world = serve(canSend);
    const { workspaceId, people } = await workspaceOf(world, "owner", "owner");
    const [owner, recipient] = [only(people, 0), only(people, 1)];

    const response = await send(world, "POST", TRANSFER, { cookie: owner.cookie }, { accountId: recipient.account.id, demoteSelf: false });

    expect(response.status).toBe(200);
    expect((await response.json()) as MemberBody).toMatchObject({ accountId: recipient.account.id, role: "owner" });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await rolesOf(workspaceId)).toEqual({ [owner.account.id]: "owner", [recipient.account.id]: "owner" });
    expect(await auditOf(workspaceId)).toEqual([]);
    expect(await mailJobs()).toEqual([]);
  });

  it("only steps the caller down when the recipient is an owner already, and tells the recipient nothing", async () => {
    const world = serve(canSend);
    const { workspaceId, people } = await workspaceOf(world, "owner", "owner");
    const [owner, recipient] = [only(people, 0), only(people, 1)];

    const response = await send(world, "POST", TRANSFER, { cookie: owner.cookie }, { accountId: recipient.account.id, demoteSelf: true });

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=`);
    expect(await rolesOf(workspaceId)).toEqual({ [owner.account.id]: "admin", [recipient.account.id]: "owner" });
    expect(await auditOf(workspaceId)).toHaveLength(1);
    expect(await mailJobs()).toEqual([]);
  });

  it("commits the transfer on an instance that sends no mail and queues no email", async () => {
    const world = serve();
    const { workspaceId, people } = await workspaceOf(world, "owner", "member");
    const [owner, recipient] = [only(people, 0), only(people, 1)];

    const response = await send(world, "POST", TRANSFER, { cookie: owner.cookie }, { accountId: recipient.account.id, demoteSelf: false });

    expect(response.status).toBe(200);
    expect(await rolesOf(workspaceId)).toEqual({ [owner.account.id]: "owner", [recipient.account.id]: "owner" });
    expect(await auditOf(workspaceId)).toHaveLength(1);
    expect(await mailJobs()).toEqual([]);
  });

  it("is one transaction: when the commit is refused neither role changes, no email is queued, no audit event stays and the caller keeps their token", async () => {
    const world = serve(canSend);
    const { workspaceId, people } = await workspaceOf(world, "owner", "member");
    const [owner, recipient] = [only(people, 0), only(people, 1)];
    const before = await tokenHashOf(owner.sessionId, owner.account.id);
    const roles = await rolesOf(workspaceId);
    await database().owner.unsafe(`
      CREATE FUNCTION refuse_ownership_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'workspace.ownership_transferred' THEN RAISE EXCEPTION 'the commit is refused'; END IF;
        RETURN NEW;
      END $$;
      CREATE CONSTRAINT TRIGGER refuse_ownership_audit AFTER INSERT ON audit_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_ownership_audit();`);
    try {
      const response = await send(world, "POST", TRANSFER, { cookie: owner.cookie }, { accountId: recipient.account.id, demoteSelf: true });

      expect(response.status).toBe(500);
      expect(response.headers.get("set-cookie")).toBeNull();
    } finally {
      await database().owner.unsafe("DROP TRIGGER refuse_ownership_audit ON audit_events; DROP FUNCTION refuse_ownership_audit();");
    }

    expect(await rolesOf(workspaceId)).toEqual(roles);
    expect(await auditOf(workspaceId)).toEqual([]);
    expect(await mailJobs()).toEqual([]);
    expect(await tokenHashOf(owner.sessionId, owner.account.id)).toBe(before);
    expect((await send(world, "GET", MEMBERS, { cookie: owner.cookie })).status).toBe(200);
  });

  it("answers 409 last_owner when the database refuses the commit for want of an owner, and the roles, the audit log, the email and the token stay as they were", async () => {
    const world = serve(canSend);
    const { workspaceId, people } = await workspaceOf(world, "owner", "member");
    const [owner, recipient] = [only(people, 0), only(people, 1)];
    const before = await tokenHashOf(owner.sessionId, owner.account.id);
    const roles = await rolesOf(workspaceId);
    // The owner rule is the database's; this trigger refuses the commit as it does, with the same error.
    await database().owner.unsafe(`
      CREATE FUNCTION refuse_ownerless() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'a workspace needs an owner' USING ERRCODE = '23514', CONSTRAINT = 'workspace_members_owner_required';
      END $$;
      CREATE CONSTRAINT TRIGGER refuse_ownerless AFTER INSERT ON audit_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_ownerless();`);
    try {
      const response = await send(world, "POST", TRANSFER, { cookie: owner.cookie }, { accountId: recipient.account.id, demoteSelf: true });

      expect(response.status).toBe(409);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await problem(response)).toMatchObject({ code: "last_owner", status: 409 });
    } finally {
      await database().owner.unsafe("DROP TRIGGER refuse_ownerless ON audit_events; DROP FUNCTION refuse_ownerless();");
    }

    expect(await rolesOf(workspaceId)).toEqual(roles);
    expect(await auditOf(workspaceId)).toEqual([]);
    expect(await mailJobs()).toEqual([]);
    expect(await tokenHashOf(owner.sessionId, owner.account.id)).toBe(before);
  });

  it("leaves an owner when two owners step down to each other at the same moment", async () => {
    const world = serve(canSend);
    const { workspaceId, people } = await workspaceOf(world, "owner", "owner");
    const [first, second] = [only(people, 0), only(people, 1)];

    const responses = await Promise.all([
      send(world, "POST", TRANSFER, { cookie: first.cookie }, { accountId: second.account.id, demoteSelf: true }),
      send(world, "POST", TRANSFER, { cookie: second.cookie }, { accountId: first.account.id, demoteSelf: true }),
    ]);

    // the second to take the workspace's lock finds the first an admin and the other way round: both are the owner's, one after the other
    expect(responses.map((response) => response.status).sort()).toEqual([200, 200]);
    const roles = Object.values(await rolesOf(workspaceId));
    expect(roles.filter((role) => role === "owner")).toHaveLength(1);
    expect(roles.filter((role) => role === "admin")).toHaveLength(1);
    expect(await auditOf(workspaceId)).toHaveLength(2);
  });
});
