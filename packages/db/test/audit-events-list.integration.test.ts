import type { AuditEventPosition, AuditEventRecord } from "@slugbase/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEventRepository } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// Reading the audit log of a workspace (doc 04 section 10.5, doc 05 section 2.9, doc 10 T1). The failure scenario: an admin of workspace A who
// lists with a position taken from workspace B's log, with the identifier of an entity or an account of B, and with a filter that matches the
// events of the deployment (which have no workspace), and sees no event of B and none of the instance stream. Besides that: the order is newest
// first with the identifier as the tiebreak and a page resumes exactly after the last event of the one before, down to the microsecond; each
// filter narrows as the contract says; an event keeps the label its actor had when an account is deleted, and the result names no network.

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
  await seedAccount(db, { id, email: `audit-list${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub" });
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

interface Seeded {
  readonly workspaceId: string | null;
  readonly actorAccountId?: string | null;
  readonly actorLabel?: string;
  readonly action?: string;
  readonly entityType?: string | null;
  readonly entityId?: string | null;
  /** RFC 3339 with up to six decimals. */
  readonly createdAt: string;
  readonly id?: string;
}

/** Writes an event as the system, which is the one role that may name a time and a workspace of its own, so a test fixes the order it reads back. */
async function seedEvent(event: Seeded): Promise<string> {
  const id = event.id ?? freshId();
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, entity_type, entity_id, metadata, ip_prefix, created_at)
      VALUES (${id}, ${event.workspaceId}, ${event.actorAccountId === null || event.actorAccountId === undefined ? "system" : "account"}, ${event.actorAccountId ?? null},
              ${event.actorLabel ?? "Ada"}, ${event.action ?? "workspace.renamed"}, ${event.entityType ?? null}, ${event.entityId ?? null},
              '{"from":"A","to":"B"}'::jsonb, '203.0.0.0/16', ${event.createdAt}::text::timestamptz)`,
  );
  return id;
}

const list = (tenant: Tenant, query: Parameters<ReturnType<typeof auditEventRepository>["list"]>[0]): Promise<readonly AuditEventRecord[]> =>
  db.tenant.withTenant({ accountId: tenant.accountId, workspaceId: tenant.workspaceId, requestId: "audit-list-test" }, (tx) => auditEventRepository(tx).list(query));

const ids = (events: readonly AuditEventRecord[]): string[] => events.map((event) => event.id);

describe("the order and the pages", () => {
  it("lists newest first with the identifier as the tiebreak, and a page resumes exactly after the last event of the one before", async () => {
    const a = await tenantWith("Order");
    const tied = "2026-03-01T10:00:00.000000Z";
    const events = [
      await seedEvent({ workspaceId: a.workspaceId, createdAt: "2026-03-01T10:00:00.000001Z", id: "0192f3a0-1111-7000-8000-000000000001" }),
      await seedEvent({ workspaceId: a.workspaceId, createdAt: tied, id: "0192f3a0-1111-7000-8000-000000000009" }),
      await seedEvent({ workspaceId: a.workspaceId, createdAt: tied, id: "0192f3a0-1111-7000-8000-000000000005" }),
      await seedEvent({ workspaceId: a.workspaceId, createdAt: tied, id: "0192f3a0-1111-7000-8000-000000000002" }),
      await seedEvent({ workspaceId: a.workspaceId, createdAt: "2026-02-28T23:59:59.999999Z", id: "0192f3a0-1111-7000-8000-000000000003" }),
    ];
    const newestFirst = [events[0], events[1], events[2], events[3], events[4]];

    const all = await list(a, { after: undefined, limit: 50 });
    expect(ids(all)).toEqual(newestFirst);
    expect(all.map((event) => event.createdAt)).toEqual([
      "2026-03-01T10:00:00.000001Z",
      tied,
      tied,
      tied,
      "2026-02-28T23:59:59.999999Z",
    ]);

    const walked: string[] = [];
    let after: AuditEventPosition | undefined;
    for (let page = 0; page < 5; page += 1) {
      const fetched = await list(a, { after, limit: 2 });
      walked.push(...ids(fetched));
      const last = fetched.at(-1);
      if (fetched.length < 2 || last === undefined) {
        break;
      }
      after = { createdAt: last.createdAt, id: last.id };
    }
    expect(walked).toEqual(newestFirst);
  });
});

describe("the filters", () => {
  it("narrow by actor, action, entity and time, each alone and together", async () => {
    const a = await tenantWith("Filters");
    const other = await account();
    const entityOne = freshId();
    const entityTwo = freshId();
    const early = await seedEvent({ workspaceId: a.workspaceId, createdAt: "2026-01-10T00:00:00Z", actorAccountId: a.accountId, action: "workspace.renamed", entityType: "workspace", entityId: entityOne });
    const middle = await seedEvent({ workspaceId: a.workspaceId, createdAt: "2026-01-20T00:00:00Z", actorAccountId: other, action: "member.removed", entityType: "member", entityId: entityTwo });
    const late = await seedEvent({ workspaceId: a.workspaceId, createdAt: "2026-01-30T00:00:00Z", actorAccountId: a.accountId, action: "member.joined", entityType: "member", entityId: entityTwo });
    const system = await seedEvent({ workspaceId: a.workspaceId, createdAt: "2026-01-31T00:00:00Z", action: "workspace.renamed" });
    const ask = (query: Partial<Parameters<ReturnType<typeof auditEventRepository>["list"]>[0]>) => list(a, { after: undefined, limit: 50, ...query });

    expect(ids(await ask({}))).toEqual([system, late, middle, early]);
    expect(ids(await ask({ actorAccountId: a.accountId }))).toEqual([late, early]);
    expect(ids(await ask({ actorAccountId: other }))).toEqual([middle]);
    expect(ids(await ask({ actions: ["workspace.renamed"] }))).toEqual([system, early]);
    expect(ids(await ask({ actions: ["member.removed", "member.joined"] }))).toEqual([late, middle]);
    expect(ids(await ask({ entityType: "member" }))).toEqual([late, middle]);
    expect(ids(await ask({ entityId: entityTwo }))).toEqual([late, middle]);
    expect(ids(await ask({ entityType: "workspace", entityId: entityTwo }))).toEqual([]);
    // From is inclusive and to is exclusive.
    expect(ids(await ask({ from: "2026-01-20T00:00:00Z" }))).toEqual([system, late, middle]);
    expect(ids(await ask({ to: "2026-01-30T00:00:00Z" }))).toEqual([middle, early]);
    expect(ids(await ask({ from: "2026-01-20T00:00:00Z", to: "2026-01-31T00:00:00Z" }))).toEqual([late, middle]);
    expect(ids(await ask({ actorAccountId: a.accountId, actions: ["member.joined"], entityType: "member", from: "2026-01-25T00:00:00Z" }))).toEqual([late]);
    expect(await ask({ from: "2026-02-01T00:00:00Z" })).toEqual([]);
  });

  it("returns the fields of an event and nothing of the network it was made from", async () => {
    const a = await tenantWith("Fields");
    const entity = freshId();
    const id = await seedEvent({ workspaceId: a.workspaceId, createdAt: "2026-01-10T12:30:45.123456Z", actorAccountId: a.accountId, actorLabel: "Ada L.", entityType: "workspace", entityId: entity });

    const [event, ...rest] = await list(a, { after: undefined, limit: 10 });

    expect(rest).toEqual([]);
    expect(event).toEqual({
      id,
      createdAt: "2026-01-10T12:30:45.123456Z",
      actorType: "account",
      actorAccountId: a.accountId,
      actorLabel: "Ada L.",
      action: "workspace.renamed",
      entityType: "workspace",
      entityId: entity,
      metadata: { from: "A", to: "B" },
    });
    expect(JSON.stringify(event)).not.toMatch(/203\.0\.0|ip/i);
  });

  it("keeps the label of an actor whose account is deleted, and drops the reference to the account", async () => {
    const a = await tenantWith("Deleted actor");
    const leaver = await account();
    const id = await seedEvent({ workspaceId: a.workspaceId, createdAt: "2026-01-10T00:00:00Z", actorAccountId: leaver, actorLabel: "Leaver at the time" });
    expect((await list(a, { after: undefined, limit: 10 })).map((event) => event.actorAccountId)).toEqual([leaver]);

    await asSystem(db, (tx) => tx`DELETE FROM accounts WHERE id = ${leaver}`);

    const [event] = await list(a, { after: undefined, limit: 10 });
    expect(event).toMatchObject({ id, actorType: "account", actorAccountId: null, actorLabel: "Leaver at the time" });
    expect(await list(a, { after: undefined, limit: 10, actorAccountId: leaver })).toEqual([]);
  });

  it("needs a transaction opened with a workspace", async () => {
    const a = await tenantWith("No workspace");
    await expect(
      db.tenant.withTenant({ accountId: a.accountId, requestId: "audit-list-test" }, (tx) => auditEventRepository(tx).list({ after: undefined, limit: 10 })),
    ).rejects.toMatchObject({ name: "TenantContextError", code: "workspace_required" });
  });
});

describe("an admin of workspace A and the events of workspace B and of the deployment (T1)", () => {
  it("sees no event of B and none of the instance stream, with a position, an entity, an account or an action that names them", async () => {
    const a = await tenantWith("Workspace A");
    const b = await tenantWith("Workspace B");
    const entityOfB = freshId();
    const entityOfInstance = freshId();
    const accountOfInstance = await account();
    const own = await seedEvent({ workspaceId: a.workspaceId, createdAt: "2026-01-10T00:00:00Z", actorAccountId: a.accountId, action: "workspace.renamed", entityType: "workspace", entityId: a.workspaceId });
    const ofB = await seedEvent({ workspaceId: b.workspaceId, createdAt: "2026-01-11T00:00:00Z", actorAccountId: b.accountId, action: "workspace.renamed", entityType: "bookmark", entityId: entityOfB });
    const ofB2 = await seedEvent({ workspaceId: b.workspaceId, createdAt: "2026-01-12T00:00:00Z", actorAccountId: b.accountId, action: "workspace.renamed", entityType: "bookmark", entityId: entityOfB });
    const ofInstance = await seedEvent({ workspaceId: null, createdAt: "2026-01-13T00:00:00Z", actorAccountId: accountOfInstance, action: "workspace.renamed", entityType: "workspace", entityId: entityOfInstance });
    const ofInstanceSystem = await seedEvent({ workspaceId: null, createdAt: "2026-01-14T00:00:00Z", action: "workspace.renamed", entityType: "workspace", entityId: entityOfInstance });
    const ask = (query: Partial<Parameters<ReturnType<typeof auditEventRepository>["list"]>[0]>) => list(a, { after: undefined, limit: 100, ...query });
    const foreign = new Set([ofB, ofB2, ofInstance, ofInstanceSystem]);

    // An unfiltered page is the log of A.
    expect(ids(await ask({}))).toEqual([own]);
    // A position taken from the log of B, from the instance stream, or from the future: the page is still A's events after it, and no event of B.
    for (const createdAt of ["2026-01-12T00:00:00.000000Z", "2026-01-14T00:00:00.000000Z", "2099-01-01T00:00:00.000000Z", "2000-01-01T00:00:00.000000Z"]) {
      const resumed = await ask({ after: { createdAt, id: ofB2 } });
      expect(ids(resumed).filter((id) => foreign.has(id))).toEqual([]);
    }
    expect(ids(await ask({ after: { createdAt: "2099-01-01T00:00:00.000000Z", id: ofB2 } }))).toEqual([own]);
    // The entity of B, the account of B, the entity and account of the instance stream, and the action every stream shares.
    expect(await ask({ entityId: entityOfB })).toEqual([]);
    expect(await ask({ entityType: "bookmark" })).toEqual([]);
    expect(await ask({ actorAccountId: b.accountId })).toEqual([]);
    expect(await ask({ entityId: entityOfInstance })).toEqual([]);
    expect(await ask({ actorAccountId: accountOfInstance })).toEqual([]);
    expect(ids(await ask({ actions: ["workspace.renamed"], limit: 100 }))).toEqual([own]);
    expect(ids(await ask({ from: "2000-01-01T00:00:00Z", to: "2100-01-01T00:00:00Z" }))).toEqual([own]);
  });

  it("sees nothing of A from a transaction of B", async () => {
    const a = await tenantWith("Workspace A");
    const b = await tenantWith("Workspace B");
    await seedEvent({ workspaceId: a.workspaceId, createdAt: "2026-01-10T00:00:00Z", actorAccountId: a.accountId });

    expect(await list(b, { after: undefined, limit: 100 })).toEqual([]);
    expect(await list(b, { after: undefined, limit: 100, actorAccountId: a.accountId })).toEqual([]);
  });
});
