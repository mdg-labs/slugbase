import { parseAuditMetadata, type InstanceWorkspaceCreation } from "@slugbase/core";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  apiTokenRepository,
  createAuthStore,
  instanceRepository,
  invitationAcceptanceRepository,
  invitationRepository as invitationRepositoryOf,
  workspaceRepository,
  type AuthStore,
  type QueuedJob,
  type TenantTx,
} from "../src/index.ts";
import { systemOperations } from "../src/system/registry.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { bindWorkspaceDeletionStore } from "../src/system/workspace-deletion.ts";
import { asSystem, freshId, freshToken, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace, type Role } from "./support/workspace-fixture.ts";

// The workspace operations of the instance admin (doc 05 sections 2.2, 2.9 and 3.3, doc 02 section 11.1, doc 10 T1
// and T18). The failure scenarios: an account that is not an instance admin with a second factor that reaches a
// sys_instance_*_workspace function, which must raise and write, create, hide or queue nothing; a list that carries
// anything of a workspace beyond its name, owners, member count and creation time, or that lets the admin read or act
// in a workspace they are not a member of; an owner invitation that the public invitation path can write; a creation
// or a deletion that leaves a half-made state or an event behind when a later step of its transaction fails; and a
// deletion that does not hide the workspace, end its sessions' use of it and revoke its tokens in the call that
// records it.

const HOOK_TIMEOUT_MS = 300_000;
const INSUFFICIENT_PRIVILEGE = "42501";
const INVALID_PARAMETER = "22023";
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const DELETE_QUEUE = "workspace.delete";
const EVENT_QUEUE = "event.workspace.created";
const JOINED_QUEUE = "event.member.joined";
const MAIL_QUEUE = "invitation.send";

let db: TestDatabase;
let store: AuthStore;

function appUrl(database: TestDatabase): string {
  const { options } = database.app;
  const url = new URL("postgres://localhost");
  url.hostname = String(options.host[0]);
  url.port = String(options.port[0]);
  url.username = options.user;
  url.password = String(options.pass);
  url.pathname = `/${options.database}`;
  return url.href;
}

beforeAll(async () => {
  db = await createTestDatabase();
  store = createAuthStore({ url: appUrl(db), poolSize: 2 });
  // The queue and job tables `migrate` creates through pg-boss, reduced to the columns the enqueue writes and reads.
  await db.owner.unsafe(`
    CREATE TABLE pgboss.queue (
      name text PRIMARY KEY, retention_seconds int NOT NULL, expire_seconds int NOT NULL, deletion_seconds int NOT NULL,
      retry_limit int NOT NULL, retry_delay int NOT NULL, retry_backoff boolean NOT NULL, retry_delay_max int,
      policy text NOT NULL, dead_letter text, heartbeat_seconds int);
    CREATE TABLE pgboss.job (
      id uuid PRIMARY KEY, name text NOT NULL, data jsonb, keep_until timestamptz NOT NULL, expire_seconds int NOT NULL,
      deletion_seconds int NOT NULL, retry_limit int NOT NULL, retry_delay int NOT NULL, retry_backoff boolean NOT NULL,
      retry_delay_max int, policy text NOT NULL, dead_letter text, heartbeat_seconds int);
    INSERT INTO pgboss.queue VALUES
      ('${DELETE_QUEUE}', 3600, 900, 3600, 3, 5, true, NULL, 'standard', NULL, NULL),
      ('${EVENT_QUEUE}', 3600, 900, 3600, 3, 5, true, NULL, 'standard', NULL, NULL),
      ('${JOINED_QUEUE}', 3600, 900, 3600, 3, 5, true, NULL, 'standard', NULL, NULL),
      ('${MAIL_QUEUE}', 3600, 900, 3600, 3, 5, true, NULL, 'standard', NULL, NULL);`);
}, HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await db.owner`TRUNCATE pgboss.job`;
});

afterAll(async () => {
  await store.close();
  await db.drop();
}, HOOK_TIMEOUT_MS);

let emailNumber = 0;

interface Options {
  readonly admin?: boolean;
  readonly mfa?: boolean;
  readonly disabled?: boolean;
  readonly name?: string;
}

async function account(options: Options = {}): Promise<{ id: string; email: string }> {
  emailNumber += 1;
  const id = freshId();
  const email = `instance-workspaces${String(emailNumber)}@example.test`;
  await seedAccount(db, {
    id,
    email,
    passwordHash: "$argon2id$stub",
    isInstanceAdmin: options.admin === true,
    disabledAt: options.disabled === true ? new Date() : null,
    emailVerified: true,
  });
  if (options.name !== undefined) {
    await db.owner.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${id}, true)`;
      await tx`UPDATE accounts SET display_name = ${options.name ?? ""} WHERE id = ${id}`;
    });
  }
  if (options.mfa === true) {
    await db.owner.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${id}, true)`;
      await tx`UPDATE accounts SET mfa_enabled_at = now(), mfa_secret = ${Buffer.from("sealed")}, mfa_secret_key_id = 'key-1' WHERE id = ${id}`;
    });
  }
  return { id, email };
}

const admin = async (): Promise<string> => (await account({ admin: true, mfa: true })).id;

function withTenant<T>(accountId: string, work: (tx: TenantTx) => Promise<T>, workspaceId?: string): Promise<T> {
  return db.tenant.withTenant({ accountId, ...(workspaceId === undefined ? {} : { workspaceId }), requestId: "req-instance-workspaces" }, work);
}

async function refusedWith(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    let current: unknown = error;
    for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth += 1) {
      const { code, cause } = current as { code?: unknown; cause?: unknown };
      if (typeof code === "string") {
        return code;
      }
      current = cause;
    }
    throw error;
  }
  return undefined;
}

interface InstanceEventRow {
  id: string;
  actor_account_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  metadata: Record<string, unknown>;
  ip_prefix: string | null;
}

/** Every event with no workspace, read as slugbase_system, which stands for the reader of the stream. */
async function instanceEvents(): Promise<InstanceEventRow[]> {
  const rows = await asSystem(
    db,
    (tx) =>
      tx<InstanceEventRow[]>`
        SELECT id, actor_account_id, action, entity_type, entity_id, metadata, ip_prefix::text AS ip_prefix
        FROM audit_events WHERE workspace_id IS NULL ORDER BY created_at, id`,
  );
  return [...rows];
}

async function workspaceCount(): Promise<number> {
  const rows = await asSystem(db, (tx) => tx<{ count: number }[]>`SELECT count(*)::int AS count FROM workspaces`);
  return rows[0]?.count ?? 0;
}

async function jobsOf(queue: string): Promise<{ id: string; data: Record<string, unknown> }[]> {
  return [...(await db.owner<{ id: string; data: Record<string, unknown> }[]>`SELECT id, data FROM pgboss.job WHERE name = ${queue} ORDER BY id`)];
}

const accountOwned = (ownerId: string, name = "Owned by an account"): InstanceWorkspaceCreation => {
  const workspaceId = freshId();
  return { workspaceId, name, owner: { kind: "account", accountId: ownerId }, events: [{ eventId: freshId(), name: "workspace.created", payload: { workspaceId, accountId: ownerId } }] };
};

const eventJobs = (request: InstanceWorkspaceCreation): QueuedJob[] =>
  request.events.map((event) => ({ id: event.eventId, queue: EVENT_QUEUE, data: { eventId: event.eventId, ...event.payload } }));

const invited = (email: string, name = "Waiting for an owner"): InstanceWorkspaceCreation & { hash: Buffer } => {
  const { hash } = freshToken();
  return { workspaceId: freshId(), name, owner: { kind: "invitation", invitationId: freshId(), email, tokenHash: hash, ttlSeconds: 7 * 24 * 60 * 60 }, events: [], hash };
};

async function create(adminId: string, request: InstanceWorkspaceCreation, eventId = freshId(), ipPrefix: string | null = null) {
  return withTenant(adminId, (tx) => instanceRepository(tx).createWorkspace(request, eventId, ipPrefix, eventJobs(request)));
}

/** Runs `work` as slugbase_app with the settings of withTenant and nothing else: no repository, no application layer. */
async function appAs<T>(accountId: string, workspaceId: string | undefined, work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  const result = await db.app.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${accountId}, true), set_config('app.workspace_id', ${workspaceId ?? ""}, true)`;
    return { value: await work(tx) };
  });
  return result.value;
}

async function ownersOf(workspaceId: string): Promise<string[]> {
  const rows = await asSystem(db, (tx) => tx<{ account_id: string }[]>`SELECT account_id FROM workspace_members WHERE workspace_id = ${workspaceId} AND role = 'owner'`);
  return rows.map((row) => row.account_id);
}

async function workspaceOf(owner: string, ...others: readonly [string, Role][]): Promise<string> {
  const workspaceId = await seedWorkspace(db, { name: "Somebody else's workspace" });
  await seedMember(db, { workspaceId, accountId: owner, role: "owner" });
  for (const [accountId, role] of others) {
    await seedMember(db, { workspaceId, accountId, role });
  }
  return workspaceId;
}

describe("the system operations are entered in the registry", () => {
  it("lists the functions of the workspace operations", () => {
    expect(systemOperations).toEqual(
      expect.arrayContaining([
        "sys_instance_list_workspaces",
        "sys_instance_create_workspace",
        "sys_instance_reissue_owner_invitation",
        "sys_instance_delete_workspace",
        "sys_instance_add_membership",
      ]),
    );
  });
});

describe("sys_instance_list_workspaces", () => {
  it("lists a workspace the admin is not a member of with its name, owners, member count and creation time, and nothing else", async () => {
    const caller = await admin();
    const owner = await account({ name: "Olivia Owner" });
    const member = await account();
    const workspaceId = await workspaceOf(owner.id, [member.id, "member"]);

    const listed = await withTenant(caller, (tx) => instanceRepository(tx).listWorkspaces(freshId(), null));

    const found = listed.find((workspace) => workspace.id === workspaceId);
    expect(found).toEqual({
      id: workspaceId,
      name: "Somebody else's workspace",
      createdAt: expect.any(Date) as Date,
      memberCount: 2,
      owners: [{ accountId: owner.id, displayName: "Olivia Owner", email: owner.email }],
    });
    // The member who is no owner is not named anywhere in the answer.
    expect(JSON.stringify(listed)).not.toContain(member.email);
    expect(Object.keys(found ?? {}).sort()).toEqual(["createdAt", "id", "memberCount", "name", "owners"]);
  });

  it("lists a workspace that waits for its first owner with no owners and no members, and one that is being deleted not at all", async () => {
    const caller = await admin();
    const waiting = await seedWorkspace(db, { name: "Ownerless" });
    const going = await seedWorkspace(db, { name: "Going", deletingAt: new Date() });

    const listed = await withTenant(caller, (tx) => instanceRepository(tx).listWorkspaces(freshId(), null));

    expect(listed.find((workspace) => workspace.id === waiting)).toMatchObject({ memberCount: 0, owners: [] });
    expect(listed.map((workspace) => workspace.id)).not.toContain(going);
  });

  it("writes one instance audit event for the admin with no metadata, in the same call", async () => {
    const caller = await admin();
    const before = (await instanceEvents()).length;
    const eventId = freshId();

    await withTenant(caller, (tx) => instanceRepository(tx).listWorkspaces(eventId, "203.0.0.0/16"));

    const events = await instanceEvents();
    expect(events).toHaveLength(before + 1);
    expect(events.at(-1)).toMatchObject({ id: eventId, actor_account_id: caller, action: "instance.workspaces_viewed", entity_type: null, entity_id: null, metadata: {}, ip_prefix: "203.0.0.0/16" });
  });

  it("gives the admin no way into a workspace they are not a member of: it is not theirs to list, switch to, read or write as a tenant", async () => {
    const caller = await admin();
    const owner = await account();
    const workspaceId = await workspaceOf(owner.id);
    const listed = await withTenant(caller, (tx) => instanceRepository(tx).listWorkspaces(freshId(), null));
    expect(listed.map((workspace) => workspace.id)).toContain(workspaceId);

    expect(await withTenant(caller, (tx) => workspaceRepository(tx).list())).toEqual([]);
    expect(await withTenant(caller, (tx) => workspaceRepository(tx).current(), workspaceId)).toBeUndefined();
    const seen = await appAs(caller, undefined, async (tx) => ({
      workspaces: await tx`SELECT id FROM workspaces WHERE id = ${workspaceId}`,
      members: await tx`SELECT account_id FROM workspace_members WHERE workspace_id = ${workspaceId}`,
      settings: await tx`SELECT workspace_id FROM workspace_settings WHERE workspace_id = ${workspaceId}`,
      invitations: await tx`SELECT id FROM workspace_invitations WHERE workspace_id = ${workspaceId}`,
    }));
    expect(Object.values(seen).map((rows) => rows.length)).toEqual([0, 0, 0, 0]);
  });

  it.each([
    ["a member who holds no flag", { mfa: true }],
    ["an admin who has no second factor enrolled", { admin: true }],
    ["a disabled admin", { admin: true, mfa: true, disabled: true }],
    ["an account with neither", {}],
  ] satisfies [string, Options][])("raises for %s and writes no event", async (_name, options) => {
    const caller = await account(options);
    const events = await instanceEvents();

    expect(await refusedWith(withTenant(caller.id, (tx) => instanceRepository(tx).listWorkspaces(freshId(), null)))).toBe(INSUFFICIENT_PRIVILEGE);

    expect(await instanceEvents()).toEqual(events);
  });

  it("raises when no account is set for the transaction, and for a missing event id", async () => {
    expect(await refusedWith(db.app`SELECT * FROM sys_instance_list_workspaces(${freshId()}::uuid, NULL::cidr)`)).toBe(INSUFFICIENT_PRIVILEGE);
    const caller = await admin();
    expect(await refusedWith(withTenant(caller, (tx) => instanceRepository(tx).listWorkspaces(null as unknown as string, null)))).toBe(INVALID_PARAMETER);
  });
});

describe("sys_instance_create_workspace for an owner account", () => {
  it("creates the workspace with that account as its owner and its settings row, queues the event and writes the instance audit event", async () => {
    const caller = await admin();
    const owner = await account();
    const request = accountOwned(owner.id);
    const eventId = freshId();

    const result = await create(caller, request, eventId, "203.0.0.0/16");

    expect(result).toEqual({ kind: "created", invitationExpiresAt: null });
    expect(await ownersOf(request.workspaceId)).toEqual([owner.id]);
    const rows = await asSystem(db, (tx) => tx<{ name: string; created_by: string; settings: number; members: number }[]>`
      SELECT w.name, w.created_by::text AS created_by,
        (SELECT count(*)::int FROM workspace_settings s WHERE s.workspace_id = w.id) AS settings,
        (SELECT count(*)::int FROM workspace_members m WHERE m.workspace_id = w.id) AS members
      FROM workspaces w WHERE w.id = ${request.workspaceId}`);
    expect(rows[0]).toEqual({ name: "Owned by an account", created_by: caller, settings: 1, members: 1 });
    expect((await jobsOf(EVENT_QUEUE)).map((job) => job.data)).toEqual([{ eventId: request.events[0]?.eventId, workspaceId: request.workspaceId, accountId: owner.id }]);
    expect((await instanceEvents()).at(-1)).toEqual({
      id: eventId,
      actor_account_id: caller,
      action: "instance.workspace_created",
      entity_type: "workspace",
      entity_id: request.workspaceId,
      metadata: { owner: "account" },
      ip_prefix: "203.0.0.0/16",
    });
  });

  it("does not make an owner of an account that is unknown or disabled, and writes, queues and records nothing", async () => {
    const caller = await admin();
    const disabled = await account({ disabled: true });
    const workspaces = await workspaceCount();
    const events = await instanceEvents();

    for (const ownerId of [freshId(), disabled.id]) {
      expect(await create(caller, accountOwned(ownerId))).toEqual({ kind: "unknown_account" });
    }

    expect(await workspaceCount()).toBe(workspaces);
    expect(await instanceEvents()).toEqual(events);
    expect(await jobsOf(EVENT_QUEUE)).toEqual([]);
  });

  it("is atomic: a job that cannot be queued rolls back the workspace, its owner, its settings and its audit event", async () => {
    const caller = await admin();
    const owner = await account();
    const request = accountOwned(owner.id);
    const workspaces = await workspaceCount();
    const events = await instanceEvents();

    await expect(
      withTenant(caller, (tx) => instanceRepository(tx).createWorkspace(request, freshId(), null, [{ id: freshId(), queue: "no.such.queue", data: {} }])),
    ).rejects.toThrow(/does not exist/);

    expect(await workspaceCount()).toBe(workspaces);
    expect(await ownersOf(request.workspaceId)).toEqual([]);
    expect(await instanceEvents()).toEqual(events);
  });

  it.each([
    ["a member who holds no flag", { mfa: true }],
    ["an admin who has no second factor enrolled", { admin: true }],
    ["a disabled admin", { admin: true, mfa: true, disabled: true }],
    ["an account with neither", {}],
  ] satisfies [string, Options][])("is refused to %s, which writes and queues nothing", async (_name, options) => {
    const caller = await account(options);
    const owner = await account();
    const workspaces = await workspaceCount();
    const events = await instanceEvents();

    expect(await refusedWith(create(caller.id, accountOwned(owner.id)))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(create(caller.id, invited("someone@example.test")))).toBe(INSUFFICIENT_PRIVILEGE);

    expect(await workspaceCount()).toBe(workspaces);
    expect(await instanceEvents()).toEqual(events);
    expect(await jobsOf(EVENT_QUEUE)).toEqual([]);
  });

  it("refuses a name outside 1 to 64 characters, and a call that names both owners or neither, writing nothing", async () => {
    const caller = await admin();
    const owner = await account();
    const workspaces = await workspaceCount();
    const events = await instanceEvents();
    const call = (ownerAccountId: string | null, ownerEmail: string | null) =>
      appAs(
        caller,
        undefined,
        (tx) => tx`
          SELECT * FROM sys_instance_create_workspace(
            ${freshId()}::uuid, NULL::cidr, ${freshId()}::uuid, 'Named', ${ownerAccountId}::uuid, ${ownerEmail}::citext, ${freshId()}::uuid, ${freshToken().hash}::bytea, 3600)`,
      );

    expect(await refusedWith(create(caller, accountOwned(owner.id, "n".repeat(65))))).toBe(CHECK_VIOLATION);
    expect(await refusedWith(create(caller, accountOwned(owner.id, "")))).toBe(CHECK_VIOLATION);
    expect(await refusedWith(call(owner.id, "both@example.test"))).toBe(INVALID_PARAMETER);
    expect(await refusedWith(call(null, null))).toBe(INVALID_PARAMETER);
    expect(await refusedWith(call(owner.id, null))).toBeUndefined();

    expect(await workspaceCount()).toBe(workspaces + 1);
    expect(await instanceEvents()).toHaveLength(events.length + 1);
  });
});

describe("sys_instance_create_workspace for an owner invitation", () => {
  it("creates a workspace with no member and one pending owner invitation that only the system function can write", async () => {
    const caller = await admin();
    const request = invited("First.Owner@Example.test");
    const eventId = freshId();

    const result = await create(caller, request, eventId, null);

    expect(result.kind).toBe("created");
    const expiresAt = result.kind === "created" ? result.invitationExpiresAt : null;
    expect(expiresAt).toBeInstanceOf(Date);
    const seconds = ((expiresAt?.getTime() ?? 0) - Date.now()) / 1000;
    expect(seconds).toBeGreaterThan(7 * 24 * 60 * 60 - 60);
    expect(seconds).toBeLessThanOrEqual(7 * 24 * 60 * 60 + 5);
    expect(await ownersOf(request.workspaceId)).toEqual([]);
    const invitations = await asSystem(
      db,
      (tx) => tx<{ email: string; role: string; instance_issued: boolean; status: string; invited_by: string; mail_ticket: string | null; token_hash: Buffer; members: number; settings: number }[]>`
        SELECT i.email::text AS email, i.role::text AS role, i.instance_issued, i.status, i.invited_by::text AS invited_by, i.mail_ticket::text AS mail_ticket, i.token_hash,
          (SELECT count(*)::int FROM workspace_members m WHERE m.workspace_id = i.workspace_id) AS members,
          (SELECT count(*)::int FROM workspace_settings s WHERE s.workspace_id = i.workspace_id) AS settings
        FROM workspace_invitations i WHERE i.workspace_id = ${request.workspaceId}`,
    );
    expect(invitations).toHaveLength(1);
    expect(invitations[0]).toMatchObject({
      email: "First.Owner@Example.test",
      role: "owner",
      instance_issued: true,
      status: "pending",
      invited_by: caller,
      mail_ticket: request.owner.kind === "invitation" ? request.owner.invitationId : null,
      members: 0,
      settings: 1,
    });
    expect(invitations[0]?.token_hash.equals(request.hash)).toBe(true);
    expect((await instanceEvents()).at(-1)).toMatchObject({ id: eventId, action: "instance.workspace_created", entity_id: request.workspaceId, metadata: { owner: "invitation" } });
    expect(JSON.stringify(await instanceEvents())).not.toContain("First.Owner");
    expect(await jobsOf(EVENT_QUEUE)).toEqual([]);
  });

  it("gives the owner role to the account that holds the address when it accepts, and to no other account", async () => {
    const caller = await admin();
    const invitee = await account();
    const stranger = await account();
    const request = invited(invitee.email);
    await create(caller, request);

    const refused = await withTenant(stranger.id, (tx) => invitationAcceptanceRepository(tx).accept(request.hash, null));
    expect(refused.kind).not.toBe("accepted");
    expect(await ownersOf(request.workspaceId)).toEqual([]);

    const accepted = await withTenant(invitee.id, (tx) => invitationAcceptanceRepository(tx).accept(request.hash, null));
    expect(accepted).toMatchObject({ kind: "accepted", workspaceId: request.workspaceId, role: "owner" });
    expect(await ownersOf(request.workspaceId)).toEqual([invitee.id]);
  });

  it("cannot be reached through the public invitation path: the application role writes neither an owner nor the flag", async () => {
    const owner = await account();
    const workspaceId = await workspaceOf(owner.id);
    const insert = (role: string, flag: boolean) =>
      appAs(owner.id, workspaceId, (tx) =>
        flag
          ? tx`INSERT INTO workspace_invitations (id, workspace_id, email, role, instance_issued, token_hash, expires_at) VALUES (${freshId()}, ${workspaceId}, 'o@example.test', ${role}::member_role, true, ${freshToken().hash}, now() + interval '1 day')`
          : tx`INSERT INTO workspace_invitations (id, workspace_id, email, role, token_hash, expires_at) VALUES (${freshId()}, ${workspaceId}, 'o@example.test', ${role}::member_role, ${freshToken().hash}, now() + interval '1 day')`,
      );

    expect(await refusedWith(insert("owner", false))).toBe(CHECK_VIOLATION);
    expect(await refusedWith(insert("owner", true))).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("is atomic: an invitation that cannot be inserted rolls back the workspace, its settings and its audit event", async () => {
    const caller = await admin();
    const first = invited("atomic@example.test");
    await create(caller, first);
    const workspaces = await workspaceCount();
    const events = await instanceEvents();
    const second = invited("atomic-again@example.test");

    // The token hash of the first invitation again: the insert of the invitation fails on its unique key after the workspace and its settings were written.
    const duplicate: InstanceWorkspaceCreation = { ...second, owner: { ...(second.owner as Extract<InstanceWorkspaceCreation["owner"], { kind: "invitation" }>), tokenHash: first.hash } };
    expect(await refusedWith(create(caller, duplicate))).toBe(UNIQUE_VIOLATION);

    expect(await workspaceCount()).toBe(workspaces);
    expect(await instanceEvents()).toEqual(events);
  });
});

describe("sys_instance_reissue_owner_invitation", () => {
  interface InvitationRow {
    id: string;
    email: string;
    role: string;
    instance_issued: boolean;
    status: string;
    invited_by: string | null;
    mail_ticket: string | null;
    closed: boolean;
    expired: boolean;
    token_hash: Buffer;
  }

  const invitationsOf = async (workspaceId: string): Promise<InvitationRow[]> => [
    ...(await asSystem(
      db,
      (tx) => tx<InvitationRow[]>`
        SELECT id, email::text AS email, role::text AS role, instance_issued, status, invited_by::text AS invited_by, mail_ticket::text AS mail_ticket,
          closed_at IS NOT NULL AS closed, expires_at <= now() AS expired, token_hash
        FROM workspace_invitations WHERE workspace_id = ${workspaceId} ORDER BY created_at, id`,
    )),
  ];

  /** A workspace that waits for the owner of the address, created the way the instance admin creates one. */
  async function waiting(caller: string, email: string) {
    const request = invited(email);
    await create(caller, request);
    return { workspaceId: request.workspaceId, first: request };
  }

  const reissue = (
    caller: string,
    workspaceId: string,
    options: { email?: string; hash?: Buffer; invitationId?: string; eventId?: string; ipPrefix?: string | null; jobs?: readonly QueuedJob[] } = {},
  ) => {
    const { hash } = freshToken();
    const invitationId = options.invitationId ?? freshId();
    return withTenant(caller, (tx) =>
      instanceRepository(tx).reissueOwnerInvitation(
        {
          workspaceId,
          ...(options.email === undefined ? {} : { email: options.email }),
          invitationId,
          tokenHash: options.hash ?? hash,
          ttlSeconds: 7 * 24 * 60 * 60,
        },
        options.eventId ?? freshId(),
        options.ipPrefix ?? null,
        options.jobs ?? [],
      ),
    ).then((result) => ({ result, invitationId, hash: options.hash ?? hash }));
  };

  const mailJob = (invitationId: string, workspaceId: string, accountId: string): QueuedJob => ({
    id: freshId(),
    queue: MAIL_QUEUE,
    data: { invitationId, workspaceId, accountId, locale: "en", mailTicket: invitationId },
  });

  it("replaces an expired owner invitation: the new link makes the invitee the owner and the old link no longer works", async () => {
    const caller = await admin();
    const invitee = await account();
    const { workspaceId, first } = await waiting(caller, invitee.email);
    await asSystem(db, (tx) => tx`UPDATE workspace_invitations SET expires_at = now() - interval '1 hour' WHERE workspace_id = ${workspaceId}`);
    // The expired link is already refused; it stays refused after the replacement, which is the part the scenario is about.
    expect((await withTenant(invitee.id, (tx) => invitationAcceptanceRepository(tx).accept(first.hash, null))).kind).toBe("gone");

    const { result, hash } = await reissue(caller, workspaceId);

    expect(result).toMatchObject({ kind: "issued", email: invitee.email });
    expect(await ownersOf(workspaceId)).toEqual([]);
    expect((await withTenant(invitee.id, (tx) => invitationAcceptanceRepository(tx).accept(first.hash, null))).kind).toBe("gone");
    expect(await ownersOf(workspaceId)).toEqual([]);
    expect(await withTenant(invitee.id, (tx) => invitationAcceptanceRepository(tx).accept(hash, null))).toMatchObject({ kind: "accepted", workspaceId, role: "owner" });
    expect(await ownersOf(workspaceId)).toEqual([invitee.id]);
  });

  it("ends the link of a pending owner invitation at once, revoking it, and leaves exactly one pending owner invitation", async () => {
    const caller = await admin();
    const invitee = await account();
    const { workspaceId, first } = await waiting(caller, invitee.email);
    const { invitationId, hash } = await reissue(caller, workspaceId);

    expect((await withTenant(invitee.id, (tx) => invitationAcceptanceRepository(tx).accept(first.hash, null))).kind).toBe("gone");

    const rows = await invitationsOf(workspaceId);
    expect(rows.map((row) => [row.status, row.closed])).toEqual([
      ["revoked", true],
      ["pending", false],
    ]);
    expect(rows[1]).toMatchObject({ id: invitationId, email: invitee.email, role: "owner", instance_issued: true, invited_by: caller, mail_ticket: invitationId, expired: false });
    expect(rows[1]?.token_hash.equals(hash)).toBe(true);
    expect(rows[0]?.token_hash.equals(first.hash)).toBe(true);
  });

  it("invites the given address instead of the previous one, in the case it was written, and the previous invitee's link ends", async () => {
    const caller = await admin();
    const previous = await account();
    const next = await account();
    const { workspaceId, first } = await waiting(caller, previous.email);

    const { result, hash } = await reissue(caller, workspaceId, { email: "New.Owner@Example.test" });

    expect(result).toMatchObject({ kind: "issued", email: "New.Owner@Example.test" });
    expect((await withTenant(previous.id, (tx) => invitationAcceptanceRepository(tx).accept(first.hash, null))).kind).toBe("gone");
    expect((await withTenant(next.id, (tx) => invitationAcceptanceRepository(tx).accept(hash, null))).kind).toBe("email_mismatch");
    expect(await ownersOf(workspaceId)).toEqual([]);
  });

  it("takes the previous address from the latest owner invitation whatever became of it, including a revoked one, and after two reissues", async () => {
    const caller = await admin();
    const { workspaceId } = await waiting(caller, "Kept.Address@Example.test");
    await asSystem(db, (tx) => tx`UPDATE workspace_invitations SET status = 'revoked', closed_at = now() WHERE workspace_id = ${workspaceId}`);

    expect(await reissue(caller, workspaceId).then(({ result }) => result)).toMatchObject({ kind: "issued", email: "Kept.Address@Example.test" });
    expect(await reissue(caller, workspaceId, { email: "second@example.test" }).then(({ result }) => result)).toMatchObject({ kind: "issued", email: "second@example.test" });
    expect(await reissue(caller, workspaceId).then(({ result }) => result)).toMatchObject({ kind: "issued", email: "second@example.test" });

    expect((await invitationsOf(workspaceId)).filter((row) => row.status === "pending")).toHaveLength(1);
  });

  it("writes one instance audit event for the workspace in the same call, naming no address, and queues the mail job with it", async () => {
    const caller = await admin();
    const { workspaceId } = await waiting(caller, "mailed-owner@example.test");
    const eventId = freshId();
    const invitationId = freshId();
    const before = (await instanceEvents()).length;

    await reissue(caller, workspaceId, { invitationId, eventId, ipPrefix: "203.0.0.0/16", jobs: [mailJob(invitationId, workspaceId, caller)] });

    const events = (await instanceEvents()).slice(before);
    expect(events).toEqual([
      { id: eventId, actor_account_id: caller, action: "instance.workspace_owner_invited", entity_type: "workspace", entity_id: workspaceId, metadata: {}, ip_prefix: "203.0.0.0/16" },
    ]);
    expect(JSON.stringify(events)).not.toContain("mailed-owner");
    expect((await jobsOf(MAIL_QUEUE)).map((job) => job.data)).toEqual([{ invitationId, workspaceId, accountId: caller, locale: "en", mailTicket: invitationId }]);
  });

  it("lets the mail job issue a token for the invitation as the admin acting in a workspace they are no member of, and for no other invitation of it", async () => {
    const caller = await admin();
    const invitee = await account();
    const { workspaceId } = await waiting(caller, invitee.email);
    const { invitationId } = await reissue(caller, workspaceId);
    const { hash } = freshToken();

    const issued = await withTenant(caller, (tx) => invitationRepositoryOf(tx).issueToken(invitationId, invitationId, hash), workspaceId);

    expect(issued).toMatchObject({ email: invitee.email, role: "owner", instanceIssued: true, workspaceName: "Waiting for an owner" });
    expect((await withTenant(invitee.id, (tx) => invitationAcceptanceRepository(tx).accept(hash, null))).kind).toBe("accepted");
    // An invitation that a later reissue revoked is not the job's any more.
    const { workspaceId: other } = await waiting(caller, invitee.email);
    const first = await reissue(caller, other);
    await reissue(caller, other);
    expect(await withTenant(caller, (tx) => invitationRepositoryOf(tx).issueToken(first.invitationId, first.invitationId, freshToken().hash), other)).toBeUndefined();
  });

  it("answers has_owner for a workspace that has an owner, and revokes, writes and queues nothing", async () => {
    const caller = await admin();
    const owner = await account();
    const workspaceId = await workspaceOf(owner.id);
    await asSystem(
      db,
      (tx) => tx`
        INSERT INTO workspace_invitations (id, workspace_id, email, role, instance_issued, token_hash, expires_at)
        VALUES (${freshId()}, ${workspaceId}, 'leftover@example.test', 'owner', true, ${freshToken().hash}, now() + interval '1 day')`,
    );
    const events = await instanceEvents();
    const rows = await invitationsOf(workspaceId);
    const invitationId = freshId();

    const { result } = await reissue(caller, workspaceId, { email: "other@example.test", invitationId, jobs: [mailJob(invitationId, workspaceId, caller)] });

    expect(result).toEqual({ kind: "has_owner" });
    expect(await invitationsOf(workspaceId)).toEqual(rows);
    expect(await instanceEvents()).toEqual(events);
    expect(await jobsOf(MAIL_QUEUE)).toEqual([]);
  });

  it("answers has_owner once the first invitation was accepted", async () => {
    const caller = await admin();
    const invitee = await account();
    const { workspaceId, first } = await waiting(caller, invitee.email);
    await withTenant(invitee.id, (tx) => invitationAcceptanceRepository(tx).accept(first.hash, null));

    expect((await reissue(caller, workspaceId)).result).toEqual({ kind: "has_owner" });

    expect(await ownersOf(workspaceId)).toEqual([invitee.id]);
  });

  it("answers unknown_workspace for a workspace that does not exist or is being deleted, writing nothing", async () => {
    const caller = await admin();
    const { workspaceId } = await waiting(caller, "going@example.test");
    await withTenant(caller, (tx) => instanceRepository(tx).markWorkspaceDeleting(workspaceId, freshId(), null, []));
    const events = await instanceEvents();
    const rows = await invitationsOf(workspaceId);

    expect((await reissue(caller, workspaceId, { email: "x@example.test" })).result).toEqual({ kind: "unknown_workspace" });
    expect((await reissue(caller, freshId(), { email: "x@example.test" })).result).toEqual({ kind: "unknown_workspace" });

    expect(await invitationsOf(workspaceId)).toEqual(rows);
    expect(await instanceEvents()).toEqual(events);
  });

  it("answers email_required for a workspace with no owner invitation and no address given, and revokes and writes nothing", async () => {
    const caller = await admin();
    const workspaceId = await seedWorkspace(db, { name: "Never invited" });
    const events = await instanceEvents();

    expect((await reissue(caller, workspaceId)).result).toEqual({ kind: "email_required" });
    expect(await instanceEvents()).toEqual(events);
    expect((await reissue(caller, workspaceId, { email: "first@example.test" })).result).toMatchObject({ kind: "issued", email: "first@example.test" });
  });

  it("is atomic: a job that cannot be queued keeps the pending invitation, writes no new one and no audit event", async () => {
    const caller = await admin();
    const invitee = await account();
    const { workspaceId, first } = await waiting(caller, invitee.email);
    const events = await instanceEvents();
    const rows = await invitationsOf(workspaceId);

    await expect(reissue(caller, workspaceId, { jobs: [{ id: freshId(), queue: "no.such.queue", data: {} }] })).rejects.toThrow(/does not exist/);

    expect(await invitationsOf(workspaceId)).toEqual(rows);
    expect(await instanceEvents()).toEqual(events);
    expect(await withTenant(invitee.id, (tx) => invitationAcceptanceRepository(tx).accept(first.hash, null))).toMatchObject({ kind: "accepted" });
  });

  it("is atomic: a token hash that is taken rolls back the revocation and the audit event", async () => {
    const caller = await admin();
    const { workspaceId, first } = await waiting(caller, "taken-hash@example.test");
    const events = await instanceEvents();
    const rows = await invitationsOf(workspaceId);

    expect(await refusedWith(reissue(caller, workspaceId, { hash: first.hash }))).toBe(UNIQUE_VIOLATION);

    expect(await invitationsOf(workspaceId)).toEqual(rows);
    expect(await instanceEvents()).toEqual(events);
  });

  it.each([
    ["a member who holds no flag", { mfa: true }],
    ["an admin who has no second factor enrolled", { admin: true }],
    ["a disabled admin", { admin: true, mfa: true, disabled: true }],
    ["an account with neither", {}],
  ] satisfies [string, Options][])("is refused to %s, which revokes, writes and queues nothing", async (_name, options) => {
    const adminId = await admin();
    const caller = await account(options);
    const { workspaceId } = await waiting(adminId, "refused@example.test");
    const events = await instanceEvents();
    const rows = await invitationsOf(workspaceId);
    const invitationId = freshId();

    expect(await refusedWith(reissue(caller.id, workspaceId, { invitationId, jobs: [mailJob(invitationId, workspaceId, caller.id)] }))).toBe(INSUFFICIENT_PRIVILEGE);

    expect(await invitationsOf(workspaceId)).toEqual(rows);
    expect(await instanceEvents()).toEqual(events);
    expect(await jobsOf(MAIL_QUEUE)).toEqual([]);
  });

  it("is not reachable by the owner of another workspace, or by a direct call without an account, and refuses a call without its identifiers", async () => {
    const caller = await admin();
    const owner = await account();
    const ownWorkspace = await workspaceOf(owner.id);
    const { workspaceId } = await waiting(caller, "target@example.test");
    const rows = await invitationsOf(workspaceId);
    const call = (accountId: string | undefined, workspace: string | null, invitation: string | null, hash: Buffer | null, ttl: number | null) =>
      appAs(
        accountId ?? "",
        undefined,
        (tx) => tx`SELECT * FROM sys_instance_reissue_owner_invitation(${freshId()}::uuid, NULL::cidr, ${workspace}::uuid, NULL::citext, ${invitation}::uuid, ${hash}::bytea, ${ttl}::integer)`,
      );

    expect(await refusedWith(reissue(owner.id, workspaceId))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(db.app`SELECT * FROM sys_instance_reissue_owner_invitation(${freshId()}::uuid, NULL::cidr, ${workspaceId}::uuid, NULL::citext, ${freshId()}::uuid, ${freshToken().hash}::bytea, 3600)`)).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await refusedWith(call(caller, null, freshId(), freshToken().hash, 3600))).toBe(INVALID_PARAMETER);
    expect(await refusedWith(call(caller, workspaceId, null, freshToken().hash, 3600))).toBe(INVALID_PARAMETER);
    expect(await refusedWith(call(caller, workspaceId, freshId(), null, 3600))).toBe(INVALID_PARAMETER);
    expect(await refusedWith(call(caller, workspaceId, freshId(), Buffer.alloc(8), 3600))).toBe(INVALID_PARAMETER);
    expect(await refusedWith(call(caller, workspaceId, freshId(), freshToken().hash, 0))).toBe(INVALID_PARAMETER);
    expect(ownWorkspace).not.toBe(workspaceId);
    expect(await invitationsOf(workspaceId)).toEqual(rows);
  });
});

describe("sys_instance_delete_workspace", () => {
  async function liveWorkspace() {
    const owner = await account();
    const member = await account();
    const workspaceId = await workspaceOf(owner.id, [member.id, "member"]);
    await asSystem(db, (tx) => tx`INSERT INTO workspace_settings (workspace_id) VALUES (${workspaceId})`);
    const sessionId = freshId();
    await asSystem(
      db,
      (tx) => tx`
        INSERT INTO sessions (id, token_hash, account_id, level, active_workspace_id, remember, expires_at, absolute_expires_at)
        VALUES (${sessionId}, ${freshToken().hash}, ${owner.id}, 'full', ${workspaceId}, false, now() + interval '1 day', now() + interval '2 days')`,
    );
    const tokenId = freshId();
    const outcome = await withTenant(owner.id, (tx) =>
      apiTokenRepository(tx).create({ id: tokenId, workspaceId, name: "CI", scope: "read", tokenHash: freshToken().hash, tokenPrefix: "abcdef", expiresInDays: 90, limit: 10 }),
    );
    expect(outcome.kind).toBe("created");
    return { owner, member, workspaceId, sessionId, tokenId };
  }

  const job = (workspaceId: string): QueuedJob => ({ id: freshId(), queue: DELETE_QUEUE, data: { workspaceId } });

  it("hides the workspace, points its sessions at none, revokes its tokens, queues the job and writes the instance audit event, all in one call", async () => {
    const caller = await admin();
    const { owner, workspaceId, sessionId, tokenId } = await liveWorkspace();
    const queued = job(workspaceId);
    const eventId = freshId();

    const marked = await withTenant(caller, (tx) => instanceRepository(tx).markWorkspaceDeleting(workspaceId, eventId, "203.0.0.0/16", [queued]));

    expect(marked).toBe(true);
    const rows = await asSystem(db, (tx) => tx<{ deleting: boolean }[]>`SELECT deleting_at IS NOT NULL AS deleting FROM workspaces WHERE id = ${workspaceId}`);
    expect(rows[0]?.deleting).toBe(true);
    expect(await withTenant(owner.id, (tx) => workspaceRepository(tx).list())).toEqual([]);
    const session = await asSystem(db, (tx) => tx<{ active_workspace_id: string | null }[]>`SELECT active_workspace_id FROM sessions WHERE id = ${sessionId}`);
    expect(session[0]?.active_workspace_id).toBeNull();
    const token = await asSystem(db, (tx) => tx<{ revoked: boolean }[]>`SELECT revoked_at IS NOT NULL AS revoked FROM api_tokens WHERE id = ${tokenId}`);
    expect(token[0]?.revoked).toBe(true);
    expect((await jobsOf(DELETE_QUEUE)).map((row) => row.data)).toEqual([{ workspaceId }]);
    expect((await instanceEvents()).at(-1)).toEqual({
      id: eventId,
      actor_account_id: caller,
      action: "instance.workspace_deletion_requested",
      entity_type: "workspace",
      entity_id: workspaceId,
      metadata: {},
      ip_prefix: "203.0.0.0/16",
    });
  });

  it("leaves the audit event in the instance stream when the background job has removed every row of the workspace", async () => {
    const caller = await admin();
    const { workspaceId } = await liveWorkspace();
    await withTenant(caller, (tx) => instanceRepository(tx).markWorkspaceDeleting(workspaceId, freshId(), null, [job(workspaceId)]));
    const deletion = bindWorkspaceDeletionStore(db.app);

    await deletion.purgeRows(workspaceId);
    expect(await deletion.finish(workspaceId, [])).toBe(true);

    const rows = await asSystem(db, (tx) => tx<{ count: number }[]>`SELECT count(*)::int AS count FROM workspaces WHERE id = ${workspaceId}`);
    expect(rows[0]?.count).toBe(0);
    expect((await instanceEvents()).filter((event) => event.entity_id === workspaceId).map((event) => event.action)).toEqual(["instance.workspace_deletion_requested"]);
  });

  it("answers false for a workspace that is already being deleted or does not exist, writing, recording and queuing nothing", async () => {
    const caller = await admin();
    const { workspaceId } = await liveWorkspace();
    await withTenant(caller, (tx) => instanceRepository(tx).markWorkspaceDeleting(workspaceId, freshId(), null, [job(workspaceId)]));
    const events = await instanceEvents();
    const jobs = await jobsOf(DELETE_QUEUE);

    expect(await withTenant(caller, (tx) => instanceRepository(tx).markWorkspaceDeleting(workspaceId, freshId(), null, [job(workspaceId)]))).toBe(false);
    expect(await withTenant(caller, (tx) => instanceRepository(tx).markWorkspaceDeleting(freshId(), freshId(), null, [job(freshId())]))).toBe(false);

    expect(await instanceEvents()).toEqual(events);
    expect(await jobsOf(DELETE_QUEUE)).toEqual(jobs);
  });

  it.each([
    ["a member who holds no flag", { mfa: true }],
    ["an admin who has no second factor enrolled", { admin: true }],
    ["a disabled admin", { admin: true, mfa: true, disabled: true }],
    ["an account with neither", {}],
  ] satisfies [string, Options][])("is refused to %s, which leaves the workspace visible and queues nothing", async (_name, options) => {
    const caller = await account(options);
    const { owner, workspaceId } = await liveWorkspace();
    const events = await instanceEvents();

    expect(await refusedWith(withTenant(caller.id, (tx) => instanceRepository(tx).markWorkspaceDeleting(workspaceId, freshId(), null, [job(workspaceId)])))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );

    expect((await withTenant(owner.id, (tx) => workspaceRepository(tx).list())).map((workspace) => workspace.id)).toEqual([workspaceId]);
    expect(await instanceEvents()).toEqual(events);
    expect(await jobsOf(DELETE_QUEUE)).toEqual([]);
  });

  it("is atomic: a job that cannot be queued rolls back the mark and the audit event", async () => {
    const caller = await admin();
    const { owner, workspaceId } = await liveWorkspace();
    const events = await instanceEvents();

    await expect(
      withTenant(caller, (tx) => instanceRepository(tx).markWorkspaceDeleting(workspaceId, freshId(), null, [{ id: freshId(), queue: "no.such.queue", data: {} }])),
    ).rejects.toThrow(/does not exist/);

    expect((await withTenant(owner.id, (tx) => workspaceRepository(tx).list())).map((workspace) => workspace.id)).toEqual([workspaceId]);
    expect(await instanceEvents()).toEqual(events);
  });

  it("is not reachable by the owner of a workspace for another workspace, or by a direct call without an account", async () => {
    const { owner, workspaceId } = await liveWorkspace();
    const other = await liveWorkspace();

    expect(await refusedWith(withTenant(owner.id, (tx) => instanceRepository(tx).markWorkspaceDeleting(other.workspaceId, freshId(), null, []), workspaceId))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await refusedWith(db.app`SELECT sys_instance_delete_workspace(${freshId()}::uuid, NULL::cidr, ${other.workspaceId}::uuid)`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect((await jobsOf(DELETE_QUEUE)).length).toBe(0);
  });
});

describe("sys_instance_add_membership", () => {
  interface MemberRow {
    account_id: string;
    role: string;
  }
  interface LogRow {
    id: string;
    actor_type: string;
    actor_account_id: string | null;
    actor_label: string;
    action: string;
    entity_type: string | null;
    entity_id: string | null;
    metadata: Record<string, unknown>;
    ip_prefix: string | null;
  }

  const membersOf = async (workspaceId: string): Promise<MemberRow[]> => [
    ...(await asSystem(db, (tx) => tx<MemberRow[]>`SELECT account_id, role::text AS role FROM workspace_members WHERE workspace_id = ${workspaceId} ORDER BY joined_at, account_id`)),
  ];
  const logOf = async (workspaceId: string): Promise<LogRow[]> => [
    ...(await asSystem(
      db,
      (tx) => tx<LogRow[]>`
        SELECT id, actor_type, actor_account_id, actor_label, action, entity_type, entity_id, metadata, ip_prefix::text AS ip_prefix
        FROM audit_events WHERE workspace_id = ${workspaceId} ORDER BY created_at, id`,
    )),
  ];
  const joinedJob = (workspaceId: string, accountId: string, eventId = freshId()): QueuedJob => ({
    id: eventId,
    queue: JOINED_QUEUE,
    data: { eventId, workspaceId, accountId, role: "member" },
  });
  const ids = () => ({ workspace: freshId(), instance: freshId() });
  const add = (accountId: string, workspaceId: string, eventIds = ids(), ipPrefix: string | null = null, jobs: readonly QueuedJob[] = []) =>
    withTenant(accountId, (tx) => instanceRepository(tx).addMembership({ workspaceId, eventIds }, ipPrefix, jobs));

  /** Resolves when a backend of this database waits for a lock. The text of another role's statement is hidden from the owner, so the wait is all that can be told. */
  async function waitForLockWait(): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const rows = await db.owner<{ waiting: number }[]>`
        SELECT count(DISTINCT l.pid)::int AS waiting
        FROM pg_locks l JOIN pg_stat_activity s ON s.pid = l.pid
        WHERE NOT l.granted AND s.datname = current_database()`;
      if ((rows[0]?.waiting ?? 0) > 0) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("no statement ever waited for a lock");
  }

  function gate(): { opened: Promise<void>; open: () => void } {
    let open: () => void = () => undefined;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { opened, open };
  }

  it("makes the caller a member with the member role and writes the workspace's own event and the instance event, under the identifiers the caller generated", async () => {
    const caller = await admin();
    const owner = await account();
    const workspaceId = await workspaceOf(owner.id);
    const eventIds = ids();
    const label = (await asSystem(db, (tx) => tx<{ display_name: string }[]>`SELECT display_name FROM accounts WHERE id = ${caller}`))[0]?.display_name;
    const instanceBefore = (await instanceEvents()).length;

    const result = await add(caller, workspaceId, eventIds, "203.0.0.0/16");

    expect(result).toEqual({ kind: "added" });
    expect((await membersOf(workspaceId)).map((member) => [member.account_id, member.role]).sort()).toEqual([[caller, "member"], [owner.id, "owner"]].sort());
    expect(await logOf(workspaceId)).toEqual([
      {
        id: eventIds.workspace,
        actor_type: "account",
        actor_account_id: caller,
        actor_label: label,
        action: "member.instance_admin_joined",
        entity_type: "member",
        entity_id: caller,
        metadata: { role: "member" },
        ip_prefix: "203.0.0.0/16",
      },
    ]);
    // The row is one the workspace catalog describes: the audit log reads it back and the metadata is the closed object of member.instance_admin_joined.
    expect(parseAuditMetadata("member.instance_admin_joined", (await logOf(workspaceId))[0]?.metadata)).toEqual({ role: "member" });
    const instance = await instanceEvents();
    expect(instance).toHaveLength(instanceBefore + 1);
    expect(instance.at(-1)).toEqual({
      id: eventIds.instance,
      actor_account_id: caller,
      action: "instance.workspace_joined",
      entity_type: "workspace",
      entity_id: workspaceId,
      metadata: {},
      ip_prefix: "203.0.0.0/16",
    });
  });

  it("lets the owners of the workspace read the event as tenants, and the admin the membership gives the same view as any member and no more", async () => {
    const caller = await admin();
    const owner = await account();
    const workspaceId = await workspaceOf(owner.id);
    const eventIds = ids();
    await add(caller, workspaceId, eventIds);

    const seen = await appAs(owner.id, workspaceId, (tx) => tx<{ id: string; action: string }[]>`SELECT id, action FROM audit_events WHERE workspace_id = ${workspaceId}`);
    expect(seen.map((row) => [row.id, row.action])).toEqual([[eventIds.workspace, "member.instance_admin_joined"]]);
    // An owner reading the log can tell the operator privilege from an invitation acceptance: the action is not member.joined.
    expect(seen.map((row) => row.action)).not.toContain("member.joined");
    // The instance event is in no tenant's view.
    const instanceSeen = await appAs(owner.id, workspaceId, (tx) => tx`SELECT id FROM audit_events WHERE id = ${eventIds.instance}`);
    expect(instanceSeen).toHaveLength(0);
    expect((await withTenant(caller, (tx) => workspaceRepository(tx).list())).map((workspace) => workspace.id)).toEqual([workspaceId]);
  });

  it("queues the jobs it is given, in the same transaction, when the membership is made", async () => {
    const caller = await admin();
    const workspaceId = await workspaceOf((await account()).id);
    const job = joinedJob(workspaceId, caller);

    await add(caller, workspaceId, ids(), null, [job]);

    expect((await jobsOf(JOINED_QUEUE)).map((row) => row.data)).toEqual([job.data]);
  });

  it("adds a workspace that waits for its first owner as a member, not as its owner", async () => {
    const caller = await admin();
    const request = invited("waiting-owner@example.test");
    await create(caller, request);

    expect(await add(caller, request.workspaceId)).toEqual({ kind: "added" });

    expect(await membersOf(request.workspaceId)).toEqual([{ account_id: caller, role: "member" }]);
    expect(await ownersOf(request.workspaceId)).toEqual([]);
  });

  it("adds the calling admin and nobody else: another admin's call leaves the first admin out", async () => {
    const first = await admin();
    const second = await admin();
    const workspaceId = await workspaceOf((await account()).id);

    expect(await add(second, workspaceId)).toEqual({ kind: "added" });

    const members = (await membersOf(workspaceId)).map((member) => member.account_id);
    expect(members).toContain(second);
    expect(members).not.toContain(first);
    expect((await logOf(workspaceId)).map((event) => event.actor_account_id)).toEqual([second]);
  });

  it.each(["owner", "admin", "member"] as const)("answers already_member for an account that holds the %s role, writing and queuing nothing", async (role) => {
    const caller = await admin();
    const owner = await account();
    const workspaceId = await workspaceOf(owner.id, [caller, role]);
    const instance = await instanceEvents();
    const log = await logOf(workspaceId);
    const members = await membersOf(workspaceId);

    expect(await add(caller, workspaceId, ids(), null, [joinedJob(workspaceId, caller)])).toEqual({ kind: "already_member" });

    expect(await membersOf(workspaceId)).toEqual(members);
    expect(await logOf(workspaceId)).toEqual(log);
    expect(await instanceEvents()).toEqual(instance);
    expect(await jobsOf(JOINED_QUEUE)).toEqual([]);
  });

  it("answers unknown_workspace for a workspace that does not exist or is being deleted, writing and queuing nothing", async () => {
    const caller = await admin();
    const going = await seedWorkspace(db, { name: "Going", deletingAt: new Date() });
    const instance = await instanceEvents();

    expect(await add(caller, going, ids(), null, [joinedJob(going, caller)])).toEqual({ kind: "unknown_workspace" });
    const missing = freshId();
    expect(await add(caller, missing, ids(), null, [joinedJob(missing, caller)])).toEqual({ kind: "unknown_workspace" });

    expect(await membersOf(going)).toEqual([]);
    expect(await logOf(going)).toEqual([]);
    expect(await instanceEvents()).toEqual(instance);
    expect(await jobsOf(JOINED_QUEUE)).toEqual([]);
  });

  it.each([
    ["a member who holds no flag", { mfa: true }],
    ["an admin who has no second factor enrolled", { admin: true }],
    ["a disabled admin", { admin: true, mfa: true, disabled: true }],
    ["an account with neither", {}],
  ] satisfies [string, Options][])("is refused to %s, which becomes no member and writes and queues nothing", async (_name, options) => {
    const caller = await account(options);
    const workspaceId = await workspaceOf((await account()).id);
    const instance = await instanceEvents();

    expect(await refusedWith(add(caller.id, workspaceId, ids(), null, [joinedJob(workspaceId, caller.id)]))).toBe(INSUFFICIENT_PRIVILEGE);
    // The refusal comes before the workspace is looked up, so it is the same for a workspace that does not exist.
    expect(await refusedWith(add(caller.id, freshId()))).toBe(INSUFFICIENT_PRIVILEGE);

    expect((await membersOf(workspaceId)).map((member) => member.account_id)).not.toContain(caller.id);
    expect(await logOf(workspaceId)).toEqual([]);
    expect(await instanceEvents()).toEqual(instance);
    expect(await jobsOf(JOINED_QUEUE)).toEqual([]);
  });

  it("raises when no account is set for the transaction, and for a missing identifier", async () => {
    const workspaceId = await workspaceOf((await account()).id);
    expect(await refusedWith(db.app`SELECT sys_instance_add_membership(${freshId()}::uuid, ${freshId()}::uuid, NULL::cidr, ${workspaceId}::uuid)`)).toBe(INSUFFICIENT_PRIVILEGE);
    const caller = await admin();
    for (const eventIds of [{ workspace: null, instance: freshId() }, { workspace: freshId(), instance: null }]) {
      expect(await refusedWith(add(caller, workspaceId, eventIds as unknown as ReturnType<typeof ids>))).toBe(INVALID_PARAMETER);
    }
    expect(await refusedWith(add(caller, null as unknown as string))).toBe(INVALID_PARAMETER);
    expect(await membersOf(workspaceId)).toHaveLength(1);
  });

  it("is atomic: a job that cannot be queued rolls back the membership and both audit events", async () => {
    const caller = await admin();
    const workspaceId = await workspaceOf((await account()).id);
    const instance = await instanceEvents();

    await expect(add(caller, workspaceId, ids(), null, [{ id: freshId(), queue: "no.such.queue", data: {} }])).rejects.toThrow(/does not exist/);

    expect((await membersOf(workspaceId)).map((member) => member.account_id)).not.toContain(caller);
    expect(await logOf(workspaceId)).toEqual([]);
    expect(await instanceEvents()).toEqual(instance);
  });

  it("is atomic: an event identifier that is taken rolls back the membership", async () => {
    const caller = await admin();
    const workspaceId = await workspaceOf((await account()).id);
    const taken = freshId();
    await add(caller, await workspaceOf((await account()).id), { workspace: taken, instance: freshId() });
    const instance = await instanceEvents();

    expect(await refusedWith(add(caller, workspaceId, { workspace: taken, instance: freshId() }))).toBe(UNIQUE_VIOLATION);
    expect(await refusedWith(add(caller, workspaceId, { workspace: freshId(), instance: taken }))).toBe(UNIQUE_VIOLATION);

    expect((await membersOf(workspaceId)).map((member) => member.account_id)).not.toContain(caller);
    expect(await logOf(workspaceId)).toEqual([]);
    expect(await instanceEvents()).toEqual(instance);
  });

  it("is not a way for a tenant to join: the application role cannot insert the membership or the instance event itself", async () => {
    const caller = await admin();
    const workspaceId = await workspaceOf((await account()).id);

    const refusedMember = await refusedWith(
      appAs(caller, workspaceId, (tx) => tx`INSERT INTO workspace_members (workspace_id, account_id, role) VALUES (${workspaceId}, ${caller}, 'member')`),
    );
    const refusedInstance = await refusedWith(
      appAs(
        caller,
        undefined,
        (tx) => tx`INSERT INTO audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, metadata) VALUES (${freshId()}, NULL, 'account', ${caller}, 'x', 'instance.workspace_joined', '{}')`,
      ),
    );

    expect(refusedMember).toBeDefined();
    expect(refusedInstance).toBeDefined();
    expect((await membersOf(workspaceId)).map((member) => member.account_id)).not.toContain(caller);
  });

  it("waits for a deletion that is already marking the workspace: whichever commits first, the membership either is refused or is there with both events", async () => {
    const caller = await admin();
    const other = await admin();
    const workspaceId = await workspaceOf((await account()).id);
    const held = gate();
    const made = gate();
    const eventIds = ids();

    const adding = withTenant(caller, async (tx) => {
      const result = await instanceRepository(tx).addMembership({ workspaceId, eventIds }, null, []);
      made.open();
      await held.opened;
      return result;
    });
    // The membership is made and not committed; the deletion has to wait for the lock of the workspace row.
    await made.opened;
    const deleting = withTenant(other, (tx) => instanceRepository(tx).markWorkspaceDeleting(workspaceId, freshId(), null, []));
    await waitForLockWait();
    held.open();

    expect(await adding).toEqual({ kind: "added" });
    expect(await deleting).toBe(true);
    expect((await membersOf(workspaceId)).map((member) => member.account_id)).toContain(caller);
    expect((await logOf(workspaceId)).map((event) => event.id)).toEqual([eventIds.workspace]);
  });

  it("is refused for a workspace whose deletion committed first, and leaves nothing behind", async () => {
    const caller = await admin();
    const other = await admin();
    const workspaceId = await workspaceOf((await account()).id);
    const held = gate();
    const marked = gate();

    const deleting = withTenant(other, async (tx) => {
      const done = await instanceRepository(tx).markWorkspaceDeleting(workspaceId, freshId(), null, []);
      marked.open();
      await held.opened;
      return done;
    });
    await marked.opened;
    const adding = add(caller, workspaceId);
    await waitForLockWait();
    held.open();

    expect(await deleting).toBe(true);
    expect(await adding).toEqual({ kind: "unknown_workspace" });
    expect((await membersOf(workspaceId)).map((member) => member.account_id)).not.toContain(caller);
    expect(await logOf(workspaceId)).toEqual([]);
  });

  it("checks the admin again under its lock: a demotion that commits while the call waits ends the call, and no membership or event is left", async () => {
    const caller = await admin();
    const demoter = await admin();
    const workspaceId = await workspaceOf((await account()).id);
    const instance = await instanceEvents();
    const held = gate();
    const demoted = gate();

    const demoting = withTenant(demoter, async (tx) => {
      const outcome = await instanceRepository(tx).updateAccount(caller, { isInstanceAdmin: false }, { admin: freshId(), disabled: freshId(), verified: freshId() }, null, []);
      demoted.open();
      await held.opened;
      return outcome;
    });
    await demoted.opened;
    const adding = refusedWith(add(caller, workspaceId));
    await waitForLockWait();
    held.open();

    expect((await demoting).kind).toBe("updated");
    expect(await adding).toBe(INSUFFICIENT_PRIVILEGE);
    expect((await membersOf(workspaceId)).map((member) => member.account_id)).not.toContain(caller);
    expect(await logOf(workspaceId)).toEqual([]);
    expect((await instanceEvents()).filter((event) => event.action === "instance.workspace_joined")).toEqual(instance.filter((event) => event.action === "instance.workspace_joined"));
  });
});
