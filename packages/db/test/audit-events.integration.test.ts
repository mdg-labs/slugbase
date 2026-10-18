import type { AuditRecord } from "@slugbase/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEventRepository } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The audit log of a workspace (doc 05 section 2.9, doc 10 T1). The failure scenarios: a member of A who
// can see, count or write the audit events of B, and an application role that can change or delete an
// event. The RLS-only checks run statements as slugbase_app with the tenant settings of A and no
// application layer at all, so only the policies stand between the transaction and B's rows.

const HOOK_TIMEOUT_MS = 300_000;
const ROW_LEVEL_SECURITY = "42501";

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
  await seedAccount(db, { id, email: `audit${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub" });
  return id;
}

interface Tenant {
  readonly accountId: string;
  readonly workspaceId: string;
}

async function tenantWith(name: string): Promise<Tenant> {
  const accountId = await account();
  const workspaceId = await seedWorkspace(db, { name, createdBy: accountId });
  await seedMember(db, { workspaceId, accountId, role: "owner" });
  return { accountId, workspaceId };
}

function record(workspaceId: string, actorAccountId: string, overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    id: freshId(),
    workspaceId,
    actorType: "account",
    actorAccountId,
    actorLabel: "Test account",
    actorTokenId: null,
    action: "workspace.created",
    entityType: "workspace",
    entityId: workspaceId,
    metadata: { name: "Test workspace" },
    ipPrefix: "203.0.0.0/16",
    ...overrides,
  };
}

/** Runs `work` as slugbase_app in a transaction with the tenant settings of withTenant and nothing else: no repository, no application layer. */
async function appAs<T>(settings: { accountId: string; workspaceId?: string }, work: (tx: import("postgres").TransactionSql) => Promise<T>): Promise<T> {
  const result = await db.app.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${settings.accountId}, true), set_config('app.workspace_id', ${settings.workspaceId ?? ""}, true)`;
    return { value: await work(tx) };
  });
  return result.value;
}

async function insertRaw(tx: import("postgres").TransactionSql, row: AuditRecord): Promise<void> {
  await tx`
    INSERT INTO audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, entity_type, entity_id, metadata)
    VALUES (${row.id}, ${row.workspaceId}, ${row.actorType}, ${row.actorAccountId}, ${row.actorLabel}, ${row.action}, ${row.entityType},
            ${row.entityId}, ${JSON.stringify(row.metadata)}::text::jsonb)`;
}

/** The SQLSTATE a statement was refused with, looking through the causes a query builder wraps it in; undefined when it succeeded. */
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

async function auditCount(workspaceId: string): Promise<number> {
  const rows = await asSystem(db, (tx) => tx<{ n: string }[]>`SELECT count(*)::text AS n FROM audit_events WHERE workspace_id = ${workspaceId}`);
  return Number(rows[0]?.n);
}

/** A digest of every audit row of the workspace, read as slugbase_system, so a change to it is seen whatever path made it. */
async function auditChecksum(workspaceId: string): Promise<string> {
  const rows = await asSystem(
    db,
    (tx) => tx<{ digest: string }[]>`SELECT md5(coalesce(string_agg(e::text, '|' ORDER BY e.id), '')) AS digest FROM audit_events e WHERE e.workspace_id = ${workspaceId}`,
  );
  return rows[0]?.digest ?? "";
}

describe("the privileges of the application role on audit_events", () => {
  it("has row-level security enabled and forced", async () => {
    const [row] = await db.owner<{ enabled: boolean; forced: boolean }[]>`
      SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced FROM pg_class WHERE oid = 'public.audit_events'::regclass`;
    expect(row).toEqual({ enabled: true, forced: true });
  });

  it("holds INSERT and SELECT and no privilege that changes or removes a row", async () => {
    const [row] = await db.owner<Record<string, boolean>[]>`
      SELECT has_table_privilege('slugbase_app', 'public.audit_events', 'SELECT') AS can_select,
             has_table_privilege('slugbase_app', 'public.audit_events', 'INSERT') AS can_insert,
             has_table_privilege('slugbase_app', 'public.audit_events', 'UPDATE') AS can_update,
             has_table_privilege('slugbase_app', 'public.audit_events', 'DELETE') AS can_delete,
             has_table_privilege('slugbase_app', 'public.audit_events', 'TRUNCATE') AS can_truncate,
             has_table_privilege('slugbase_app', 'public.audit_events', 'TRIGGER') AS can_trigger,
             has_column_privilege('slugbase_app', 'public.audit_events', 'metadata', 'UPDATE') AS can_update_column`;
    expect(row).toEqual({ can_select: true, can_insert: true, can_update: false, can_delete: false, can_truncate: false, can_trigger: false, can_update_column: false });
  });

  it("refuses an UPDATE and a DELETE of the workspace's own event and leaves the event as it was", async () => {
    const a = await tenantWith("Workspace A");
    const event = record(a.workspaceId, a.accountId);
    await appAs(a, (tx) => insertRaw(tx, event));
    const before = await auditChecksum(a.workspaceId);

    expect(await refusedWith(appAs(a, (tx) => tx`UPDATE audit_events SET action = 'tampered' WHERE id = ${event.id}`))).toBe(ROW_LEVEL_SECURITY);
    expect(await refusedWith(appAs(a, (tx) => tx`UPDATE audit_events SET metadata = '{}'::jsonb`))).toBe(ROW_LEVEL_SECURITY);
    expect(await refusedWith(appAs(a, (tx) => tx`DELETE FROM audit_events WHERE id = ${event.id}`))).toBe(ROW_LEVEL_SECURITY);
    expect(await refusedWith(appAs(a, (tx) => tx`DELETE FROM audit_events`))).toBe(ROW_LEVEL_SECURITY);
    expect(await refusedWith(appAs(a, (tx) => tx`TRUNCATE audit_events`))).toBe(ROW_LEVEL_SECURITY);

    expect(await auditChecksum(a.workspaceId)).toBe(before);
  });
});

describe("a member of workspace A and the audit events of workspace B (T1)", () => {
  it("cannot see, count or select by id an event of B, and sees its own", async () => {
    const a = await tenantWith("Workspace A");
    const b = await tenantWith("Workspace B");
    const eventA = record(a.workspaceId, a.accountId);
    const eventB1 = record(b.workspaceId, b.accountId);
    const eventB2 = record(b.workspaceId, b.accountId, { action: "workspace.created" });
    await appAs(a, (tx) => insertRaw(tx, eventA));
    await appAs(b, (tx) => insertRaw(tx, eventB1));
    await appAs(b, (tx) => insertRaw(tx, eventB2));

    const seen = await appAs(a, (tx) => tx<{ id: string }[]>`SELECT id FROM audit_events ORDER BY id`);
    const counted = await appAs(a, (tx) => tx<{ n: string }[]>`SELECT count(*)::text AS n FROM audit_events`);
    const byId = await appAs(a, (tx) => tx<{ id: string }[]>`SELECT id FROM audit_events WHERE id IN (${eventB1.id}, ${eventB2.id})`);
    const byWorkspace = await appAs(a, (tx) => tx<{ id: string }[]>`SELECT id FROM audit_events WHERE workspace_id = ${b.workspaceId}`);

    expect(seen.map((row) => row.id)).toEqual([eventA.id]);
    expect(counted[0]?.n).toBe("1");
    expect(byId).toEqual([]);
    expect(byWorkspace).toEqual([]);
  });

  it("cannot write an event naming B, from a transaction acting in A or at account level, and B's events stay as they were", async () => {
    const a = await tenantWith("Workspace A");
    const b = await tenantWith("Workspace B");
    await appAs(b, (tx) => insertRaw(tx, record(b.workspaceId, b.accountId)));
    const before = await auditChecksum(b.workspaceId);

    const naming = record(b.workspaceId, a.accountId);
    expect(await refusedWith(appAs(a, (tx) => insertRaw(tx, naming)))).toBe(ROW_LEVEL_SECURITY);
    expect(await refusedWith(appAs({ accountId: a.accountId }, (tx) => insertRaw(tx, naming)))).toBe(ROW_LEVEL_SECURITY);

    expect(await auditChecksum(b.workspaceId)).toBe(before);
  });

  it("cannot write an event of a workspace it belongs to while acting in another workspace", async () => {
    const a = await tenantWith("Workspace A");
    const second = await seedWorkspace(db, { name: "Second workspace of A's account" });
    await seedMember(db, { workspaceId: second, accountId: a.accountId, role: "member" });

    expect(await refusedWith(appAs(a, (tx) => insertRaw(tx, record(second, a.accountId))))).toBe(ROW_LEVEL_SECURITY);
    expect(await refusedWith(appAs({ accountId: a.accountId, workspaceId: second }, (tx) => insertRaw(tx, record(a.workspaceId, a.accountId))))).toBe(
      ROW_LEVEL_SECURITY,
    );
  });

  it("writes an event of a workspace it is a member of from an account-level transaction, which is how a new workspace's creation is recorded", async () => {
    const a = await tenantWith("Workspace A");
    const event = record(a.workspaceId, a.accountId);

    await appAs({ accountId: a.accountId }, (tx) => insertRaw(tx, event));

    expect(await auditCount(a.workspaceId)).toBe(1);
    const seen = await appAs(a, (tx) => tx<{ id: string }[]>`SELECT id FROM audit_events`);
    expect(seen.map((row) => row.id)).toContain(event.id);
  });

  it("writes and sees nothing outside a tenant transaction", async () => {
    const a = await tenantWith("Workspace A");
    await appAs(a, (tx) => insertRaw(tx, record(a.workspaceId, a.accountId)));

    expect(await refusedWith(db.app.begin((tx) => insertRaw(tx, record(a.workspaceId, a.accountId))))).toBe(ROW_LEVEL_SECURITY);
    expect(await db.app`SELECT id FROM audit_events`).toEqual([]);
  });

  it("is refused an event with no workspace, which only a system operation may read", async () => {
    const a = await tenantWith("Workspace A");
    const eventId = freshId();

    for (const settings of [a, { accountId: a.accountId }]) {
      expect(
        await refusedWith(
          appAs(settings, (tx) => tx`
            INSERT INTO audit_events (id, workspace_id, actor_type, actor_label, action, metadata)
            VALUES (${eventId}, NULL, 'system', 'SlugBase', 'workspace.created', '{}'::jsonb)`),
        ),
      ).toBe(ROW_LEVEL_SECURITY);
    }
  });
});

describe("auditEventRepository", () => {
  it("inserts the record in a workspace transaction and stores the metadata as an object", async () => {
    const a = await tenantWith("Workspace A");
    const event = record(a.workspaceId, a.accountId, { metadata: { name: "Ada's workspace" } });

    await db.tenant.withTenant({ accountId: a.accountId, workspaceId: a.workspaceId, requestId: "audit-test" }, (tx) => auditEventRepository(tx).insert(event));

    const [row] = await asSystem(
      db,
      (tx) => tx<Record<string, unknown>[]>`
        SELECT workspace_id, actor_type, actor_account_id, actor_label, actor_token_id, action, entity_type, entity_id, host(ip_prefix) AS ip,
               jsonb_typeof(metadata) AS kind, metadata, created_at IS NOT NULL AS stamped
        FROM audit_events WHERE id = ${event.id}`,
    );
    expect(row).toMatchObject({
      workspace_id: a.workspaceId,
      actor_type: "account",
      actor_account_id: a.accountId,
      actor_label: "Test account",
      actor_token_id: null,
      action: "workspace.created",
      entity_type: "workspace",
      entity_id: a.workspaceId,
      kind: "object",
      metadata: { name: "Ada's workspace" },
      stamped: true,
    });
  });

  it("inserts a record for a workspace the account belongs to in an account-level transaction", async () => {
    const a = await tenantWith("Workspace A");
    const event = record(a.workspaceId, a.accountId);

    await db.tenant.withTenant({ accountId: a.accountId, requestId: "audit-test" }, (tx) => auditEventRepository(tx).insert(event));

    expect(await auditCount(a.workspaceId)).toBe(1);
  });

  it("refuses, before the database, a record naming another workspace than the transaction's", async () => {
    const a = await tenantWith("Workspace A");
    const b = await tenantWith("Workspace B");

    await expect(
      db.tenant.withTenant({ accountId: a.accountId, workspaceId: a.workspaceId, requestId: "audit-test" }, (tx) =>
        auditEventRepository(tx).insert(record(b.workspaceId, a.accountId)),
      ),
    ).rejects.toMatchObject({ name: "TenantContextError", code: "foreign_workspace" });
    expect(await auditCount(b.workspaceId)).toBe(0);
  });

  it("is refused by the database for a workspace the account does not belong to, in an account-level transaction", async () => {
    const a = await tenantWith("Workspace A");
    const b = await tenantWith("Workspace B");
    const before = await auditChecksum(b.workspaceId);

    const refused = await refusedWith(
      db.tenant.withTenant({ accountId: a.accountId, requestId: "audit-test" }, (tx) => auditEventRepository(tx).insert(record(b.workspaceId, a.accountId))),
    );

    expect(refused).toBe(ROW_LEVEL_SECURITY);
    expect(await auditChecksum(b.workspaceId)).toBe(before);
  });

  it("writes nothing when the transaction around it rolls back", async () => {
    const a = await tenantWith("Workspace A");
    const event = record(a.workspaceId, a.accountId);

    await expect(
      db.tenant.withTenant({ accountId: a.accountId, workspaceId: a.workspaceId, requestId: "audit-test" }, async (tx) => {
        await auditEventRepository(tx).insert(event);
        throw new Error("the change failed");
      }),
    ).rejects.toThrow("the change failed");

    expect(await auditCount(a.workspaceId)).toBe(0);
  });
});
