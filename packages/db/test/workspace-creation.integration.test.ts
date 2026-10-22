import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { workspaceRepository, type NewWorkspace } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { tenantHandle } from "../src/tenant.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace, workspaceChecksum } from "./support/workspace-fixture.ts";

// Listing and creating the workspaces of the signed-in account (doc 05 sections 2.2 and 3.3, doc 04 section
// 10.4, doc 10 T1). The failure scenarios: a workspace made for an account other than the one the transaction
// acts for (which would get round the limit on the workspaces an account owns), a workspace that exists
// without its owner, its settings or the job that announces it, a list or a count that reaches a workspace
// the account is not a member of, and a member count that names a member. The ceiling `workspaces.ownMax` (doc
// 10 T11) is judged where the workspace is inserted, under the lock of the account's row: a second creation at the
// ceiling, a pair that runs in parallel at the ceiling minus one, and the personal workspace of an account at it.

const HOOK_TIMEOUT_MS = 300_000;
const QUEUE = "event.workspace.created";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
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
    INSERT INTO pgboss.queue VALUES ('${QUEUE}', 3600, 900, 3600, 3, 5, true, NULL, 'standard', NULL, NULL);`);
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await db.drop();
}, HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await db.owner`TRUNCATE pgboss.job`;
});

let emailNumber = 0;
async function account(options: { disabled?: boolean } = {}): Promise<string> {
  emailNumber += 1;
  const id = freshId();
  await seedAccount(db, {
    id,
    email: `workspaces${String(emailNumber)}@example.test`,
    passwordHash: "$argon2id$stub",
    disabledAt: options.disabled === true ? new Date() : null,
  });
  return id;
}

function accountLevel<T>(accountId: string, work: Parameters<typeof db.tenant.withTenant<T>>[1]): Promise<T> {
  return db.tenant.withTenant({ accountId, requestId: "workspaces-test" }, work);
}

function newWorkspace(overrides: Partial<NewWorkspace> = {}): NewWorkspace {
  return { id: freshId(), name: "Research", ownedMax: null, jobs: [], ...overrides };
}

function jobFor(workspaceId: string, accountId: string, queue = QUEUE) {
  return { id: freshId(), queue, data: { eventId: freshId(), workspaceId, accountId } };
}

interface Stored {
  workspace: { id: string; name: string; created_by: string | null } | undefined;
  members: { account_id: string; role: string }[];
  settings: number;
}

async function stored(workspaceId: string): Promise<Stored> {
  return asSystem(db, async (tx) => {
    const [workspace] = await tx<{ id: string; name: string; created_by: string | null }[]>`SELECT id, name, created_by FROM workspaces WHERE id = ${workspaceId}`;
    const members = await tx<{ account_id: string; role: string }[]>`SELECT account_id, role FROM workspace_members WHERE workspace_id = ${workspaceId}`;
    const [settings] = await tx<{ n: string }[]>`SELECT count(*)::text AS n FROM workspace_settings WHERE workspace_id = ${workspaceId}`;
    return { workspace, members: [...members], settings: Number(settings?.n) };
  });
}

async function ownedBy(accountId: string): Promise<number> {
  const rows = await asSystem(db, (tx) => tx<{ n: string }[]>`SELECT count(*)::text AS n FROM workspace_members WHERE account_id = ${accountId}`);
  return Number(rows[0]?.n);
}

describe("create", () => {
  it("makes the workspace with the account of the transaction as its owner, and its settings row", async () => {
    const owner = await account();
    const workspace = newWorkspace({ name: "Ada's research" });

    expect(await accountLevel(owner, (tx) => workspaceRepository(tx).create(workspace))).toEqual({ kind: "created" });

    expect(await stored(workspace.id)).toEqual({
      workspace: { id: workspace.id, name: "Ada's research", created_by: owner },
      members: [{ account_id: owner, role: "owner" }],
      settings: 1,
    });
  });

  it("queues the jobs in the same transaction", async () => {
    const owner = await account();
    const workspace = newWorkspace();
    const job = jobFor(workspace.id, owner);

    await accountLevel(owner, (tx) => workspaceRepository(tx).create({ ...workspace, jobs: [job] }));

    expect(await db.app<{ id: string; name: string }[]>`SELECT id, name FROM pgboss.job`).toEqual([{ id: job.id, name: QUEUE }]);
  });

  it("leaves no workspace, owner, settings or job when a job cannot be queued, because its queue does not exist", async () => {
    const owner = await account();
    const workspace = newWorkspace();

    await expect(
      accountLevel(owner, (tx) => workspaceRepository(tx).create({ ...workspace, jobs: [jobFor(workspace.id, owner, "event.missing.queue")] })),
    ).rejects.toMatchObject({ name: "QueueMissingError" });

    expect(await stored(workspace.id)).toEqual({ workspace: undefined, members: [], settings: 0 });
    expect(await db.app`SELECT id FROM pgboss.job`).toEqual([]);
  });

  it("writes nothing and queues nothing for a disabled account", async () => {
    const owner = await account({ disabled: true });
    const workspace = newWorkspace();

    expect(await accountLevel(owner, (tx) => workspaceRepository(tx).create({ ...workspace, jobs: [jobFor(workspace.id, owner)] }))).toEqual({ kind: "unavailable" });

    expect(await stored(workspace.id)).toEqual({ workspace: undefined, members: [], settings: 0 });
    expect(await db.app`SELECT id FROM pgboss.job`).toEqual([]);
  });

  it("writes nothing when the transaction around it rolls back", async () => {
    const owner = await account();
    const workspace = newWorkspace();

    await expect(
      accountLevel(owner, async (tx) => {
        await workspaceRepository(tx).create(workspace);
        throw new Error("the audit write failed");
      }),
    ).rejects.toThrow("the audit write failed");

    expect(await stored(workspace.id)).toEqual({ workspace: undefined, members: [], settings: 0 });
  });
});

describe("sys_create_workspace named for another account", () => {
  it("creates nothing when a transaction acting for one account names another as the owner, and the other account owns nothing", async () => {
    const caller = await account();
    const victim = await account();
    const id = freshId();

    const rows = await db.tenant.withTenant({ accountId: caller, requestId: "workspaces-test" }, async (tx) => {
      // A caller that reached the system operation with the victim's id, as a handler that passed the wrong account would.
      return tenantHandle(tx).execute<{ created: boolean }>(sql`SELECT public.sys_create_workspace(${victim}::uuid, ${id}::uuid, 'Stolen'::text) AS created`);
    });

    expect(rows[0]?.created).toBe(false);
    expect(await stored(id)).toEqual({ workspace: undefined, members: [], settings: 0 });
    expect(await ownedBy(victim)).toBe(0);
  });

  it("still creates the workspace of the account it names when no account is set, as setup and registration do", async () => {
    const owner = await account();
    const id = freshId();

    const [row] = await db.app<{ created: boolean }[]>`SELECT sys_create_workspace(${owner}::uuid, ${id}::uuid, 'First workspace'::text) AS created`;

    expect(row?.created).toBe(true);
    expect((await stored(id)).members).toEqual([{ account_id: owner, role: "owner" }]);
  });

  it("refuses a name the table does not accept", async () => {
    const owner = await account();

    await expect(db.app`SELECT sys_create_workspace(${owner}::uuid, ${freshId()}::uuid, ${"x".repeat(65)}::text)`).rejects.toMatchObject({ code: "23514" });
  });
});

const ceiling = (ownedMax: number | null) => ({ ownedMax });

async function createdBy(owner: string, overrides: Partial<NewWorkspace> = {}) {
  const workspace = newWorkspace(overrides);
  const result = await accountLevel(owner, (tx) => workspaceRepository(tx).create(workspace));
  return { workspace, result };
}

describe("the ceiling on the workspaces an account owns", () => {
  it("makes the workspace of an account below its ceiling", async () => {
    const owner = await account();
    await createdBy(owner, ceiling(2));

    const { workspace, result } = await createdBy(owner, ceiling(2));

    expect(result).toEqual({ kind: "created" });
    expect((await stored(workspace.id)).members).toEqual([{ account_id: owner, role: "owner" }]);
  });

  it("refuses the creation at the ceiling with the number of workspaces owned, and writes and queues nothing", async () => {
    const owner = await account();
    await createdBy(owner, ceiling(1));
    const second = newWorkspace({ ...ceiling(1), jobs: [] });
    const withJob = { ...second, jobs: [jobFor(second.id, owner)] };

    const result = await accountLevel(owner, (tx) => workspaceRepository(tx).create(withJob));

    expect(result).toEqual({ kind: "limit_reached", used: 1 });
    expect(await stored(second.id)).toEqual({ workspace: undefined, members: [], settings: 0 });
    expect(await db.app`SELECT id FROM pgboss.job`).toEqual([]);
    expect(await ownedBy(owner)).toBe(1);
  });

  it("reports as the usage the count of workspaces the refusal was judged against, not the ceiling", async () => {
    const owner = await account();
    await createdBy(owner, ceiling(null));
    await createdBy(owner, ceiling(null));
    await createdBy(owner, ceiling(null));

    const { result } = await createdBy(owner, ceiling(2));

    expect(result).toEqual({ kind: "limit_reached", used: 3 });
  });

  it("refuses every creation under a ceiling of zero", async () => {
    const owner = await account();

    const { workspace, result } = await createdBy(owner, ceiling(0));

    expect(result).toEqual({ kind: "limit_reached", used: 0 });
    expect(await stored(workspace.id)).toEqual({ workspace: undefined, members: [], settings: 0 });
  });

  it("counts the workspaces the account owns and not those it only belongs to, or those being deleted", async () => {
    const owner = await account();
    const other = await account();
    const joined = await seedWorkspace(db, { name: "Joined" });
    const administered = await seedWorkspace(db, { name: "Administered" });
    const going = await seedWorkspace(db, { name: "Going", deletingAt: new Date() });
    await seedMember(db, { workspaceId: joined, accountId: owner, role: "member" });
    await seedMember(db, { workspaceId: administered, accountId: owner, role: "admin" });
    await seedMember(db, { workspaceId: going, accountId: owner, role: "owner" });
    await seedMember(db, { workspaceId: joined, accountId: other, role: "owner" });

    const { result } = await createdBy(owner, ceiling(1));

    expect(result).toEqual({ kind: "created" });
  });

  it("does not count the workspaces of another account", async () => {
    const busy = await account();
    const owner = await account();
    await createdBy(busy, ceiling(null));
    await createdBy(busy, ceiling(null));

    expect((await createdBy(owner, ceiling(1))).result).toEqual({ kind: "created" });
  });

  it("makes one workspace of two creations that run in parallel at the ceiling minus one", async () => {
    const owner = await account();
    const first = newWorkspace(ceiling(1));
    const second = newWorkspace(ceiling(1));
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstInserted: () => void = () => undefined;
    const inserted = new Promise<void>((resolve) => {
      firstInserted = resolve;
    });

    // The first transaction has inserted and not committed when the second starts, so only the lock on the account's
    // row keeps the second from counting the state before the first workspace.
    const one = accountLevel(owner, async (tx) => {
      const result = await workspaceRepository(tx).create(first);
      firstInserted();
      await held;
      return result;
    });
    await inserted;
    let settled = false;
    const two = accountLevel(owner, (tx) => workspaceRepository(tx).create(second)).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(settled).toBe(false);
    release();
    const results = await Promise.all([one, two]);

    expect(results).toEqual([{ kind: "created" }, { kind: "limit_reached", used: 1 }]);
    expect(await ownedBy(owner)).toBe(1);
    expect((await stored(second.id)).workspace).toBeUndefined();
  });

  it("counts a workspace the first transaction made when the second one starts after it commits", async () => {
    const owner = await account();
    const [one, two] = await Promise.all([createdBy(owner, ceiling(1)), createdBy(owner, ceiling(1))]);

    expect([one.result.kind, two.result.kind].sort()).toEqual(["created", "limit_reached"]);
    expect(await ownedBy(owner)).toBe(1);
  });

  it("refuses a negative ceiling", async () => {
    const owner = await account();

    await expect(createdBy(owner, ceiling(-1))).rejects.toMatchObject({ cause: { code: "22023" } });
  });

  it("creates nothing for the account it names when a transaction acts for another", async () => {
    const caller = await account();
    const victim = await account();
    const id = freshId();

    const rows = await db.tenant.withTenant({ accountId: caller, requestId: "workspaces-test" }, (tx) =>
      tenantHandle(tx).execute<{ outcome: string }>(sql`SELECT outcome FROM public.sys_create_workspace_limited(${victim}::uuid, ${id}::uuid, 'Stolen'::text, NULL::integer)`),
    );

    expect(rows[0]?.outcome).toBe("unavailable");
    expect(await stored(id)).toEqual({ workspace: undefined, members: [], settings: 0 });
  });
});

describe("sys_create_personal_workspace_limited", () => {
  const SUFFIX = "'s workspace";

  function personal(accountId: string, ownedMax: number | null) {
    const id = freshId();
    return db.app<{ outcome: string }[]>`
      SELECT sys_create_personal_workspace_limited(${accountId}::uuid, ${id}::uuid, ${SUFFIX}::text, ${ownedMax}::integer) AS outcome`.then((rows) => ({ id, outcome: rows[0]?.outcome }));
  }

  it("creates the workspace of an account that owns none and is below its ceiling, and names it after the account", async () => {
    const owner = await account();

    const { id, outcome } = await personal(owner, 1);

    expect(outcome).toBe("created");
    expect((await stored(id)).workspace?.name).toMatch(/'s workspace$/);
  });

  it("creates no workspace for an account whose ceiling allows none, and does not fail", async () => {
    const owner = await account();

    const { id, outcome } = await personal(owner, 0);

    expect(outcome).toBe("limit_reached");
    expect(await stored(id)).toEqual({ workspace: undefined, members: [], settings: 0 });
    expect(await ownedBy(owner)).toBe(0);
  });

  it("answers exists for an account that owns a workspace already, whatever its ceiling", async () => {
    const owner = await account();
    await personal(owner, null);

    expect((await personal(owner, 0)).outcome).toBe("exists");
    expect((await personal(owner, null)).outcome).toBe("exists");
    expect(await ownedBy(owner)).toBe(1);
  });

  it("answers unavailable for a disabled account and an account that does not exist", async () => {
    const disabled = await account({ disabled: true });

    expect((await personal(disabled, null)).outcome).toBe("unavailable");
    expect((await personal(freshId(), null)).outcome).toBe("unavailable");
  });
});

describe("list", () => {
  it("lists the workspaces of the account with its role and the number of members, the most recently active first", async () => {
    const me = await account();
    const other = await account();
    const third = await account();
    const older = await seedWorkspace(db, { name: "Older" });
    const newer = await seedWorkspace(db, { name: "Newer" });
    const never = await seedWorkspace(db, { name: "Never active" });
    await seedMember(db, { workspaceId: older, accountId: me, role: "owner", lastActiveAt: new Date(Date.now() - 60_000) });
    await seedMember(db, { workspaceId: newer, accountId: me, role: "member", lastActiveAt: new Date() });
    await seedMember(db, { workspaceId: never, accountId: me, role: "admin" });
    await seedMember(db, { workspaceId: older, accountId: other, role: "member" });
    await seedMember(db, { workspaceId: older, accountId: third, role: "admin" });
    await seedMember(db, { workspaceId: newer, accountId: other, role: "owner" });

    const listed = await accountLevel(me, (tx) => workspaceRepository(tx).list());

    expect(listed).toEqual([
      { id: newer, name: "Newer", role: "member", memberCount: 2 },
      { id: older, name: "Older", role: "owner", memberCount: 3 },
      { id: never, name: "Never active", role: "admin", memberCount: 1 },
    ]);
  });

  it("does not list, or count, a workspace the account is not a member of, and the other account sees its own", async () => {
    const me = await account();
    const stranger = await account();
    const mine = await seedWorkspace(db, { name: "Mine" });
    const theirs = await seedWorkspace(db, { name: "Theirs" });
    await seedMember(db, { workspaceId: mine, accountId: me, role: "owner" });
    await seedMember(db, { workspaceId: theirs, accountId: stranger, role: "owner" });
    const before = await workspaceChecksum(db, theirs);

    const listed = await accountLevel(me, (tx) => workspaceRepository(tx).list());
    const strangers = await accountLevel(stranger, (tx) => workspaceRepository(tx).list());

    expect(listed).toEqual([{ id: mine, name: "Mine", role: "owner", memberCount: 1 }]);
    expect(strangers).toEqual([{ id: theirs, name: "Theirs", role: "owner", memberCount: 1 }]);
    expect(await workspaceChecksum(db, theirs)).toBe(before);
  });

  it("leaves out a workspace that is being deleted", async () => {
    const me = await account();
    const live = await seedWorkspace(db, { name: "Live" });
    const going = await seedWorkspace(db, { name: "Going", deletingAt: new Date() });
    await seedMember(db, { workspaceId: live, accountId: me, role: "owner" });
    await seedMember(db, { workspaceId: going, accountId: me, role: "owner" });

    expect((await accountLevel(me, (tx) => workspaceRepository(tx).list())).map((workspace) => workspace.id)).toEqual([live]);
  });

  it("is empty for an account without a workspace", async () => {
    const me = await account();

    expect(await accountLevel(me, (tx) => workspaceRepository(tx).list())).toEqual([]);
  });

  it("lists the workspace it has just created, in the same transaction", async () => {
    const me = await account();
    const workspace = newWorkspace({ name: "Fresh" });

    const listed = await accountLevel(me, async (tx) => {
      await workspaceRepository(tx).create(workspace);
      return workspaceRepository(tx).list();
    });

    expect(listed).toEqual([{ id: workspace.id, name: "Fresh", role: "owner", memberCount: 1 }]);
  });
});

describe("app_member_workspace_counts", () => {
  it("answers nothing outside a tenant transaction and no member's identity inside one", async () => {
    const me = await account();
    const other = await account();
    const workspaceId = await seedWorkspace(db, { name: "Shared" });
    await seedMember(db, { workspaceId, accountId: me, role: "owner" });
    await seedMember(db, { workspaceId, accountId: other, role: "member" });

    expect(await db.app`SELECT * FROM app_member_workspace_counts()`).toEqual([]);
    const rows = await db.app.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${me}, true)`;
      return tx<Record<string, unknown>[]>`SELECT * FROM app_member_workspace_counts()`;
    });
    expect(rows).toEqual([{ workspace_id: workspaceId, member_count: "2" }]);
  });
});
