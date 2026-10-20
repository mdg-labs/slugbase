import { EntitlementVersionError, withEntitlementChange } from "@slugbase/core";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TenantContextError, entitlementRepository } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, freshToken, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace, workspaceChecksum, type Role } from "./support/workspace-fixture.ts";

// The reads behind the entitlement engine and the system operation that raises a workspace's entitlement version
// (doc 01 sections 7.5 and 8.3, doc 05 sections 2.2 and 3.3, doc 10 T1 and T11). The failure scenarios: a change
// to a workspace's plan that leaves the version where it was, so the process cache keeps serving what the change
// replaced; a version raised outside the transaction of the change, or left raised by a change that rolled back; and a
// transaction acting in one workspace that reads or raises another's. The RLS-only checks run statements as
// slugbase_app with the tenant settings of A and no application layer at all.

const HOOK_TIMEOUT_MS = 300_000;

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await db.drop();
}, HOOK_TIMEOUT_MS);

let emailNumber = 0;
async function account(): Promise<string> {
  emailNumber += 1;
  const id = freshId();
  await seedAccount(db, { id, email: `entitled${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub" });
  return id;
}

interface Tenant {
  readonly accountId: string;
  readonly workspaceId: string;
}

async function tenantWith(name: string, role: Role = "owner"): Promise<Tenant> {
  const accountId = await account();
  const workspaceId = await seedWorkspace(db, { name, createdBy: accountId });
  await seedMember(db, { workspaceId, accountId, role });
  return { accountId, workspaceId };
}

function inTenant<T>(tenant: { accountId: string; workspaceId?: string }, work: Parameters<typeof db.tenant.withTenant<T>>[1]): Promise<T> {
  return db.tenant.withTenant({ ...tenant, requestId: "entitlements-test" }, work);
}

async function appAs<T>(settings: { accountId: string; workspaceId?: string }, work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  const result = await db.app.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${settings.accountId}, true), set_config('app.workspace_id', ${settings.workspaceId ?? ""}, true)`;
    return { value: await work(tx) };
  });
  return result.value;
}

async function storedVersion(workspaceId: string): Promise<number> {
  const rows = await asSystem(db, (tx) => tx<{ entitlement_version: number }[]>`SELECT entitlement_version FROM workspaces WHERE id = ${workspaceId}`);
  const row = rows[0];
  if (row === undefined) {
    throw new Error("the workspace is gone");
  }
  return row.entitlement_version;
}

describe("the entitlement version", () => {
  it("starts at 1 and is read by the workspace of the transaction", async () => {
    const a = await tenantWith("Workspace A");

    expect(await inTenant(a, (tx) => entitlementRepository(tx).version())).toBe(1);
  });

  it("is raised by one, visible inside the transaction and committed with it", async () => {
    const a = await tenantWith("Workspace A");

    const seen = await inTenant(a, async (tx) => {
      const repository = entitlementRepository(tx);
      const bumped = await repository.bump();
      return { bumped, read: await repository.version() };
    });

    expect(seen).toEqual({ bumped: 2, read: 2 });
    expect(await storedVersion(a.workspaceId)).toBe(2);
    expect(await inTenant(a, (tx) => entitlementRepository(tx).version())).toBe(2);
  });

  it("is raised in the transaction of the change: a change that rolls back leaves the version where it was", async () => {
    const a = await tenantWith("Workspace A");

    await expect(
      inTenant(a, (tx) => withEntitlementChange(entitlementRepository(tx), () => Promise.reject(new Error("the change failed")))),
    ).rejects.toThrow("the change failed");
    await expect(
      inTenant(a, async (tx) => {
        await withEntitlementChange(entitlementRepository(tx), () => Promise.resolve());
        throw new Error("the transaction failed after the change");
      }),
    ).rejects.toThrow("the transaction failed after the change");

    expect(await storedVersion(a.workspaceId)).toBe(1);
  });

  it("is raised once for each change made through withEntitlementChange", async () => {
    const a = await tenantWith("Workspace A");

    await inTenant(a, (tx) => withEntitlementChange(entitlementRepository(tx), () => Promise.resolve()));
    await inTenant(a, (tx) => withEntitlementChange(entitlementRepository(tx), () => Promise.resolve()));

    expect(await storedVersion(a.workspaceId)).toBe(3);
  });

  it("leaves the ETag version and the name of the workspace where they were", async () => {
    const a = await tenantWith("Workspace A");

    await inTenant(a, (tx) => entitlementRepository(tx).bump());
    const rows = await asSystem(db, (tx) => tx<{ name: string; version: number }[]>`SELECT name, version FROM workspaces WHERE id = ${a.workspaceId}`);

    expect(rows).toMatchObject([{ name: "Workspace A", version: 1 }]);
  });

  it("is not raised for a workspace being deleted, and the answer is the same as for one that cannot be seen", async () => {
    const accountId = await account();
    const workspaceId = await seedWorkspace(db, { name: "Going", createdBy: accountId, deletingAt: new Date() });
    await seedMember(db, { workspaceId, accountId, role: "owner" });

    const outcome = await inTenant({ accountId, workspaceId }, async (tx) => ({
      bump: await entitlementRepository(tx).bump(),
      version: await entitlementRepository(tx).version(),
    }));

    expect(outcome).toEqual({ bump: undefined, version: undefined });
    expect(await storedVersion(workspaceId)).toBe(1);
    await expect(inTenant({ accountId, workspaceId }, (tx) => withEntitlementChange(entitlementRepository(tx), () => Promise.resolve()))).rejects.toBeInstanceOf(EntitlementVersionError);
  });

  it("reads no version and no usage for an account that is no member of the workspace it acts in", async () => {
    const a = await tenantWith("Workspace A");
    const outsider = await account();

    const outcome = await inTenant({ accountId: outsider, workspaceId: a.workspaceId }, async (tx) => ({
      version: await entitlementRepository(tx).version(),
      usage: await entitlementRepository(tx).usage(),
      bump: await entitlementRepository(tx).bump(),
    }));

    expect(outcome).toEqual({ version: undefined, usage: undefined, bump: undefined });
    expect(await storedVersion(a.workspaceId)).toBe(1);
  });

  it("needs a transaction opened with a workspace", async () => {
    const a = await tenantWith("Workspace A");

    await expect(inTenant({ accountId: a.accountId }, (tx) => entitlementRepository(tx).version())).rejects.toBeInstanceOf(TenantContextError);
    await expect(inTenant({ accountId: a.accountId }, (tx) => entitlementRepository(tx).bump())).rejects.toBeInstanceOf(TenantContextError);
    await expect(inTenant({ accountId: a.accountId }, (tx) => entitlementRepository(tx).usage())).rejects.toBeInstanceOf(TenantContextError);
  });

  it("refuses the application role a direct write to the column", async () => {
    const a = await tenantWith("Workspace A");

    await expect(appAs(a, (tx) => tx`UPDATE workspaces SET entitlement_version = 99 WHERE id = ${a.workspaceId}`)).rejects.toMatchObject({ code: "42501" });
    expect(await storedVersion(a.workspaceId)).toBe(1);
  });
});

describe("the cross-tenant boundary (RLS only)", () => {
  it("raises nothing in workspace B from a transaction acting in A, nor in A from one acting in B, nor for an account that is no member", async () => {
    const a = await tenantWith("Workspace A");
    const b = await tenantWith("Workspace B");
    const bump = (settings: { accountId: string; workspaceId?: string }, target: string) =>
      appAs(settings, (tx) => tx<{ version: number | null }[]>`SELECT public.sys_workspace_bump_entitlement_version(${target}::uuid) AS version`);
    const before = [await workspaceChecksum(db, a.workspaceId), await workspaceChecksum(db, b.workspaceId)];

    const answers = [
      await bump(a, b.workspaceId),
      await bump(b, a.workspaceId),
      await bump({ accountId: a.accountId }, a.workspaceId),
      await bump({ accountId: a.accountId, workspaceId: b.workspaceId }, b.workspaceId),
    ];

    expect(answers.map((rows) => rows[0]?.version ?? null)).toEqual([null, null, null, null]);
    expect([await workspaceChecksum(db, a.workspaceId), await workspaceChecksum(db, b.workspaceId)]).toEqual(before);
  });

  it("reads no version, usage or ownership of a workspace the account is no member of", async () => {
    const a = await tenantWith("Workspace A");
    const b = await tenantWith("Workspace B");

    const read = await appAs(a, async (tx) => ({
      version: await tx`SELECT entitlement_version FROM workspaces WHERE id = ${b.workspaceId}`,
      usage: await tx`SELECT bookmark_count FROM workspaces WHERE id = ${b.workspaceId}`,
      seats: await tx`SELECT count(*) FROM workspace_members WHERE workspace_id = ${b.workspaceId}`,
    }));

    expect(read.version).toHaveLength(0);
    expect(read.usage).toHaveLength(0);
    expect(read.seats).toMatchObject([{ count: "0" }]);
  });
});

describe("the usage counters", () => {
  it("count the bookmarks the workspace says it holds and its members, and nothing of another workspace", async () => {
    const a = await tenantWith("Workspace A");
    const b = await tenantWith("Workspace B");
    for (const role of ["admin", "member"] as const) {
      await seedMember(db, { workspaceId: a.workspaceId, accountId: await account(), role });
    }
    await asSystem(db, (tx) => tx`UPDATE workspaces SET bookmark_count = 7 WHERE id = ${a.workspaceId}`);
    await asSystem(db, (tx) => tx`UPDATE workspaces SET bookmark_count = 40 WHERE id = ${b.workspaceId}`);

    expect(await inTenant(a, (tx) => entitlementRepository(tx).usage())).toEqual({ bookmarksUsed: 7, seatsUsed: 3 });
    expect(await inTenant(b, (tx) => entitlementRepository(tx).usage())).toEqual({ bookmarksUsed: 40, seatsUsed: 1 });
  });

  it("count a pending invitation as no seat", async () => {
    const a = await tenantWith("Workspace A");
    await asSystem(
      db,
      (tx) => tx`
        INSERT INTO workspace_invitations (id, workspace_id, email, role, token_hash, invited_by, expires_at)
        VALUES (${freshId()}, ${a.workspaceId}, 'pending@example.test', 'member', ${freshToken().hash}, ${a.accountId}, now() + interval '7 days')`,
    );

    expect((await inTenant(a, (tx) => entitlementRepository(tx).usage()))?.seatsUsed).toBe(1);
  });

  it("answer nothing for a workspace being deleted", async () => {
    const accountId = await account();
    const workspaceId = await seedWorkspace(db, { name: "Going", createdBy: accountId, deletingAt: new Date() });
    await seedMember(db, { workspaceId, accountId, role: "owner" });

    expect(await inTenant({ accountId, workspaceId }, (tx) => entitlementRepository(tx).usage())).toBeUndefined();
  });

  it("count the workspaces the account owns, not those it is an admin or member of, and not one being deleted", async () => {
    const owner = await account();
    for (const [name, role, deletingAt] of [
      ["Owned 1", "owner", null],
      ["Owned 2", "owner", null],
      ["Administered", "admin", null],
      ["Joined", "member", null],
      ["Owned and going", "owner", new Date()],
    ] as const) {
      const workspaceId = await seedWorkspace(db, { name, deletingAt });
      await seedMember(db, { workspaceId, accountId: owner, role });
    }
    const other = await tenantWith("Someone else's");

    expect(await inTenant({ accountId: owner }, (tx) => entitlementRepository(tx).ownedWorkspaces())).toBe(2);
    expect(await inTenant({ accountId: other.accountId }, (tx) => entitlementRepository(tx).ownedWorkspaces())).toBe(1);
  });
});
