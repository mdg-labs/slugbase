import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { apiTokenRepository, isLastOwnerViolation, memberRepository } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, freshToken, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace, workspaceChecksum, type Role } from "./support/workspace-fixture.ts";

// Removing a member from a workspace (doc 02 section 3.6, doc 05 section 2.2, doc 04 section 10.5, doc 10 T1
// and T2). The failure scenarios: a membership deleted in a workspace the transaction does not act in, a
// removed member whose API token stays alive, the last owner removed, a job announcing a removal that did not
// happen (or a removal without its job), and a longest-standing owner read from another workspace. The
// RLS-only checks run statements as slugbase_app with the tenant settings of A and no application layer.

const HOOK_TIMEOUT_MS = 300_000;
const QUEUE = "event.member.left";

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
async function account(): Promise<string> {
  emailNumber += 1;
  const id = freshId();
  await seedAccount(db, { id, email: `removal${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub" });
  return id;
}

interface Workspace {
  readonly workspaceId: string;
  readonly members: readonly { readonly accountId: string; readonly role: Role }[];
}

/** A workspace with one member of each role given, in that order; each joins a second after the one before. */
async function workspaceOf(...roles: Role[]): Promise<Workspace> {
  const workspaceId = await seedWorkspace(db, { name: "Removal test" });
  const members: { accountId: string; role: Role }[] = [];
  const start = Date.now() - 3_600_000;
  for (const [index, role] of roles.entries()) {
    const accountId = await account();
    await seedMember(db, { workspaceId, accountId, role, joinedAt: new Date(start + index * 1000) });
    members.push({ accountId, role });
  }
  return { workspaceId, members };
}

function who(workspace: Workspace, index: number): string {
  const member = workspace.members[index];
  if (member === undefined) {
    throw new Error("no such member");
  }
  return member.accountId;
}

function inTenant<T>(tenant: { accountId: string; workspaceId?: string }, work: Parameters<typeof db.tenant.withTenant<T>>[1]): Promise<T> {
  return db.tenant.withTenant({ ...tenant, requestId: "member-removal-test" }, work);
}

/** Runs `work` as slugbase_app with the settings of withTenant and nothing else: no repository, no application layer. */
async function appAs<T>(settings: { accountId: string; workspaceId?: string }, work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  const result = await db.app.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${settings.accountId}, true), set_config('app.workspace_id', ${settings.workspaceId ?? ""}, true)`;
    return { value: await work(tx) };
  });
  return result.value;
}

async function memberIds(workspaceId: string): Promise<string[]> {
  const rows = await asSystem(db, (tx) => tx<{ account_id: string }[]>`SELECT account_id FROM workspace_members WHERE workspace_id = ${workspaceId} ORDER BY account_id`);
  return rows.map((row) => row.account_id);
}

async function queued(): Promise<Record<string, unknown>[]> {
  const rows = await db.owner<{ data: Record<string, unknown> }[]>`SELECT data FROM pgboss.job WHERE name = ${QUEUE} ORDER BY id`;
  return rows.map((row) => row.data);
}

function job(workspaceId: string, accountId: string, transferTo: string) {
  const eventId = freshId();
  return { id: eventId, queue: QUEUE, data: { eventId, workspaceId, accountId, content: "transfer", transferTo } };
}

async function seedToken(accountId: string, workspaceId: string): Promise<string> {
  const id = freshId();
  const token = freshToken();
  const outcome = await inTenant({ accountId }, (tx) =>
    apiTokenRepository(tx).create({ id, workspaceId, name: `CI ${id}`, scope: "read", tokenHash: token.hash, tokenPrefix: "abcdef", expiresInDays: 90, limit: 10 }),
  );
  expect(outcome.kind).toBe("created");
  return id;
}

async function tokenIds(workspaceId: string): Promise<string[]> {
  const rows = await asSystem(db, (tx) => tx<{ id: string }[]>`SELECT id FROM api_tokens WHERE workspace_id = ${workspaceId} ORDER BY id`);
  return rows.map((row) => row.id);
}

describe("the privileges behind removing a member", () => {
  it("lets the application role delete a membership row and nothing else of the workspace tables, and no token", async () => {
    const rows = await db.owner<{ table: string; allowed: boolean }[]>`
      SELECT t AS table, has_table_privilege('slugbase_app', 'public.' || t, 'DELETE') AS allowed
      FROM unnest(ARRAY['workspace_members', 'workspaces', 'workspace_settings', 'api_tokens']) AS t
      ORDER BY t`;
    expect(Object.fromEntries(rows.map((row) => [row.table, row.allowed]))).toEqual({ api_tokens: false, workspace_members: true, workspace_settings: false, workspaces: false });
  });
});

describe("memberRepository.remove, row-level security alone", () => {
  it("deletes no membership of another workspace, whatever the statement names, and leaves workspace B as it was", async () => {
    const a = await workspaceOf("owner", "admin");
    const b = await workspaceOf("owner", "admin", "member");
    const before = await workspaceChecksum(db, b.workspaceId);
    const actor = { accountId: who(a, 0), workspaceId: a.workspaceId };

    const byWorkspace = await appAs(actor, (tx) => tx`DELETE FROM workspace_members WHERE workspace_id = ${b.workspaceId} RETURNING account_id`);
    const byAccount = await appAs(actor, (tx) => tx`DELETE FROM workspace_members WHERE account_id = ${who(b, 2)} RETURNING account_id`);
    const withoutWorkspace = await appAs({ accountId: who(a, 0) }, (tx) => tx`DELETE FROM workspace_members WHERE account_id = ${who(a, 1)} RETURNING account_id`);

    expect([...byWorkspace]).toEqual([]);
    expect([...byAccount]).toEqual([]);
    expect([...withoutWorkspace]).toEqual([]);
    expect(await workspaceChecksum(db, b.workspaceId)).toBe(before);
    expect(await memberIds(a.workspaceId)).toHaveLength(2);
  });

  it("reads the owners of the active workspace only when the statement names no workspace", async () => {
    const a = await workspaceOf("owner", "member");
    const b = await workspaceOf("owner", "owner");

    const owners = await appAs(
      { accountId: who(a, 0), workspaceId: a.workspaceId },
      (tx) => tx<{ account_id: string }[]>`SELECT account_id FROM workspace_members WHERE role = 'owner' AND account_id <> ${freshId()} ORDER BY joined_at, account_id`,
    );

    expect(owners.map((row) => row.account_id)).toEqual([who(a, 0)]);
    expect(await memberIds(b.workspaceId)).toHaveLength(2);
  });

  it("deletes a membership of the active workspace", async () => {
    const a = await workspaceOf("owner", "member");

    const removed = await appAs({ accountId: who(a, 0), workspaceId: a.workspaceId }, (tx) => tx<{ account_id: string }[]>`DELETE FROM workspace_members WHERE account_id = ${who(a, 1)} RETURNING account_id`);

    expect(removed.map((row) => row.account_id)).toEqual([who(a, 1)]);
  });
});

describe("memberRepository.remove", () => {
  it("deletes the membership, deletes the tokens bound to it and no other, and queues the jobs in the same transaction", async () => {
    const a = await workspaceOf("owner", "member");
    const other = await workspaceOf("owner");
    await seedMember(db, { workspaceId: other.workspaceId, accountId: who(a, 1), role: "member" });
    const gone = await seedToken(who(a, 1), a.workspaceId);
    const kept = await seedToken(who(a, 1), other.workspaceId);
    const ownersToken = await seedToken(who(a, 0), a.workspaceId);

    const removed = await inTenant({ accountId: who(a, 0), workspaceId: a.workspaceId }, (tx) => memberRepository(tx).remove(who(a, 1), [job(a.workspaceId, who(a, 1), who(a, 0))]));

    expect(removed).toBe(true);
    expect(await memberIds(a.workspaceId)).toEqual([who(a, 0)]);
    expect(await tokenIds(a.workspaceId)).toEqual([ownersToken]);
    expect(await tokenIds(other.workspaceId)).toEqual([kept]);
    expect(await tokenIds(a.workspaceId)).not.toContain(gone);
    expect(await queued()).toMatchObject([{ workspaceId: a.workspaceId, accountId: who(a, 1), content: "transfer", transferTo: who(a, 0) }]);
    expect(await memberIds(other.workspaceId)).toContain(who(a, 1));
  });

  it("finds no member of another workspace or of none, deletes nothing there and queues no job", async () => {
    const a = await workspaceOf("owner");
    const b = await workspaceOf("owner", "member");
    const before = await workspaceChecksum(db, b.workspaceId);

    const foreign = await inTenant({ accountId: who(a, 0), workspaceId: a.workspaceId }, (tx) => memberRepository(tx).remove(who(b, 1), [job(a.workspaceId, who(b, 1), who(a, 0))]));
    const unknown = await inTenant({ accountId: who(a, 0), workspaceId: a.workspaceId }, (tx) => memberRepository(tx).remove(freshId(), [job(a.workspaceId, who(a, 0), who(a, 0))]));

    expect(foreign).toBe(false);
    expect(unknown).toBe(false);
    expect(await workspaceChecksum(db, b.workspaceId)).toBe(before);
    expect(await queued()).toEqual([]);
  });

  it("refuses the commit that removes the last owner, and leaves the membership, the tokens and the job queue as they were", async () => {
    const a = await workspaceOf("owner", "admin");
    const token = await seedToken(who(a, 0), a.workspaceId);

    const error = await inTenant({ accountId: who(a, 0), workspaceId: a.workspaceId }, (tx) =>
      memberRepository(tx).remove(who(a, 0), [job(a.workspaceId, who(a, 0), who(a, 1))]),
    ).catch((caught: unknown) => caught);

    expect(isLastOwnerViolation(error)).toBe(true);
    expect(await memberIds(a.workspaceId)).toHaveLength(2);
    expect(await tokenIds(a.workspaceId)).toEqual([token]);
    expect(await queued()).toEqual([]);
  });

  it("removes an owner while another owner remains", async () => {
    const a = await workspaceOf("owner", "owner");

    const removed = await inTenant({ accountId: who(a, 1), workspaceId: a.workspaceId }, (tx) => memberRepository(tx).remove(who(a, 0), []));

    expect(removed).toBe(true);
    expect(await memberIds(a.workspaceId)).toEqual([who(a, 1)]);
  });

  it("queues no job when the queue of one does not exist, and deletes no membership then", async () => {
    const a = await workspaceOf("owner", "member");

    const error = await inTenant({ accountId: who(a, 0), workspaceId: a.workspaceId }, (tx) =>
      memberRepository(tx).remove(who(a, 1), [{ id: freshId(), queue: "event.no.such.queue", data: {} }]),
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ name: "QueueMissingError" });
    expect(await memberIds(a.workspaceId)).toHaveLength(2);
  });

  it("needs a transaction opened with a workspace", async () => {
    const a = await workspaceOf("owner", "member");

    await expect(inTenant({ accountId: who(a, 0) }, (tx) => memberRepository(tx).remove(who(a, 1), []))).rejects.toMatchObject({ name: "TenantContextError" });
  });
});

describe("memberRepository.longestStandingOwner", () => {
  it("is the owner who joined first other than the one excluded, then the lowest account identifier", async () => {
    const a = await workspaceOf("owner", "admin", "owner", "owner");

    const [first, withoutFirst, withoutThird] = await inTenant({ accountId: who(a, 0), workspaceId: a.workspaceId }, async (tx) => {
      const repository = memberRepository(tx);
      return [await repository.longestStandingOwner(who(a, 1)), await repository.longestStandingOwner(who(a, 0)), await repository.longestStandingOwner(who(a, 2))];
    });

    expect(first).toBe(who(a, 0));
    expect(withoutFirst).toBe(who(a, 2));
    expect(withoutThird).toBe(who(a, 0));
  });

  it("ties on the join time by the lowest account identifier", async () => {
    const workspaceId = await seedWorkspace(db);
    const joinedAt = new Date(Date.now() - 1000);
    const ids = [await account(), await account(), await account()];
    for (const accountId of ids) {
      await seedMember(db, { workspaceId, accountId, role: "owner", joinedAt });
    }
    const lowest = [...ids].sort()[0];
    const next = [...ids].sort()[1];

    const result = await inTenant({ accountId: ids[0] ?? "", workspaceId }, async (tx) => ({
      plain: await memberRepository(tx).longestStandingOwner(freshId()),
      withoutLowest: await memberRepository(tx).longestStandingOwner(lowest ?? ""),
    }));

    expect(result).toEqual({ plain: lowest, withoutLowest: next });
  });

  it("is undefined for a workspace whose only owner is the one excluded, and reads no owner of another workspace", async () => {
    const a = await workspaceOf("owner", "member");
    const b = await workspaceOf("owner", "owner");

    const result = await inTenant({ accountId: who(a, 0), workspaceId: a.workspaceId }, async (tx) => ({
      alone: await memberRepository(tx).longestStandingOwner(who(a, 0)),
      other: await memberRepository(tx).longestStandingOwner(who(b, 0)),
    }));

    expect(result.alone).toBeUndefined();
    expect(result.other).toBe(who(a, 0));
  });
});
