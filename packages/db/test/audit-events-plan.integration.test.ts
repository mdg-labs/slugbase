import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listAuditEventsStatement } from "../src/repositories/audit-events.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The plan of the audit log's list on a large event table (doc 05 section 2.9, doc 08 section 5.3): 10 000 events in the workspace that is read, 200 000 in
// 400 others and 5 000 of the deployment with no workspace. Every statement the list can run, with each filter alone and together and with a position to resume
// from, is planned as slugbase_app with the settings of `withTenant` and none reads the table sequentially: each is served by one of the indexes of the table
// (workspace and time, workspace and actor, workspace and entity). The failure scenario is a statement that does not match them, which scans every workspace's
// events for one workspace's page.

const HOOK_TIMEOUT_MS = 300_000;
const OWN_EVENTS = 10_000;
const OTHER_WORKSPACES = 400;
const EVENTS_PER_OTHER_WORKSPACE = 500;
const INSTANCE_EVENTS = 5_000;
const ACTORS = 25;
const ENTITIES = 2_000;

let db: TestDatabase;
let accountId: string;
let workspaceId: string;
let actorId: string;
let entityId: string;

const dialect = new PgDialect({ casing: "snake_case" });

beforeAll(async () => {
  db = await createTestDatabase();
  accountId = freshId();
  await seedAccount(db, { id: accountId, email: "audit-plan-owner@example.test", passwordHash: "$argon2id$stub" });
  workspaceId = await seedWorkspace(db, { name: "Audit plan test", createdBy: accountId });
  await seedMember(db, { workspaceId, accountId, role: "owner" });
  for (let n = 1; n <= ACTORS; n += 1) {
    await seedAccount(db, { id: `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`, email: `actor${String(n)}@example.test`, passwordHash: "$argon2id$stub" });
  }
  await asSystem(db, (tx) => tx`
    INSERT INTO workspaces (id, name)
    SELECT ('10000000-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid, 'Other ' || n FROM generate_series(1, ${OTHER_WORKSPACES}) AS n`);
  // The events of the workspace that is read: spread over a year, a few actors, about 2 000 entities, the actions of several categories.
  await asSystem(db, (tx) => tx`
    INSERT INTO audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, entity_type, entity_id, metadata, created_at)
    SELECT gen_random_uuid(), ${workspaceId}, 'account', ('00000000-0000-7000-8000-' || lpad((1 + n % ${ACTORS}::int)::text, 12, '0'))::uuid, 'Actor',
           (ARRAY['workspace.renamed', 'member.role_changed', 'team.created', 'bookmark.exported', 'share.granted', 'member.removed'])[1 + n % 6],
           (ARRAY['workspace', 'member', 'team', 'bookmark'])[1 + n % 4],
           ('20000000-0000-7000-8000-' || lpad((n % ${ENTITIES}::int)::text, 12, '0'))::uuid, '{}'::jsonb, now() - n * interval '47 minutes'
    FROM generate_series(1, ${OWN_EVENTS}) AS n`);
  await asSystem(db, (tx) => tx`
    INSERT INTO audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, entity_type, entity_id, metadata, created_at)
    SELECT gen_random_uuid(), ('10000000-0000-7000-8000-' || lpad(w::text, 12, '0'))::uuid, 'account',
           ('00000000-0000-7000-8000-' || lpad((1 + n % ${ACTORS}::int)::text, 12, '0'))::uuid, 'Actor',
           (ARRAY['workspace.renamed', 'member.role_changed', 'team.created', 'bookmark.exported', 'share.granted', 'member.removed'])[1 + n % 6],
           (ARRAY['workspace', 'member', 'team', 'bookmark'])[1 + n % 4],
           ('20000000-0000-7000-8000-' || lpad((n % ${ENTITIES}::int)::text, 12, '0'))::uuid, '{}'::jsonb, now() - n * interval '3 hours'
    FROM generate_series(1, ${OTHER_WORKSPACES}) AS w CROSS JOIN generate_series(1, ${EVENTS_PER_OTHER_WORKSPACE}) AS n`);
  await asSystem(db, (tx) => tx`
    INSERT INTO audit_events (id, workspace_id, actor_type, actor_label, action, metadata, created_at)
    SELECT gen_random_uuid(), NULL, 'system', 'SlugBase', 'workspace.renamed', '{}'::jsonb, now() - n * interval '5 minutes'
    FROM generate_series(1, ${INSTANCE_EVENTS}) AS n`);
  await db.owner.unsafe("VACUUM (ANALYZE) audit_events");
  actorId = "00000000-0000-7000-8000-000000000003";
  entityId = "20000000-0000-7000-8000-000000000007";
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await db.drop();
}, HOOK_TIMEOUT_MS);

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
}

function nodesOf(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(nodesOf)];
}

/** The nodes of the plan of the statement the list runs for `query`, as the database plans it for a transaction of `slugbase_app` with the settings of `withTenant`. */
async function planOf(query: Parameters<typeof listAuditEventsStatement>[1]): Promise<PlanNode[]> {
  const statement = dialect.sqlToQuery(listAuditEventsStatement(workspaceId, query));
  const plan = await db.app.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${accountId}, true), set_config('app.workspace_id', ${workspaceId}, true)`;
    const rows = await tx.unsafe<{ "QUERY PLAN": { Plan: PlanNode }[] }[]>(`EXPLAIN (FORMAT JSON) ${statement.sql}`, statement.params as never[]);
    return rows[0]?.["QUERY PLAN"][0]?.Plan;
  });
  if (plan === undefined) {
    throw new Error("EXPLAIN returned no plan");
  }
  return nodesOf(plan);
}

const indexesOf = (nodes: readonly PlanNode[]): string[] => nodes.map((node) => node["Index Name"]).filter((name) => name !== undefined);

const PAGE = { after: undefined, limit: 51 } as const;
const NEXT = { after: { createdAt: "2026-06-01T00:00:00.000000Z", id: "0192f3a0-1111-7000-8000-000000000001" }, limit: 51 } as const;
const CATEGORY = ["member.role_changed", "member.removed", "member.joined", "member.left", "member.instance_admin_joined"];

const STATEMENTS: readonly [string, Parameters<typeof listAuditEventsStatement>[1]][] = [
  ["the first page", PAGE],
  ["a page after a position", NEXT],
  ["an actor", { ...PAGE, actorAccountId: "00000000-0000-7000-8000-000000000003" }],
  ["an actor after a position", { ...NEXT, actorAccountId: "00000000-0000-7000-8000-000000000003" }],
  ["an action", { ...PAGE, actions: ["team.created"] }],
  ["the actions of a category", { ...PAGE, actions: CATEGORY }],
  ["an action that nothing recorded", { ...PAGE, actions: ["workspace.deletion_requested"] }],
  ["an entity type", { ...PAGE, entityType: "bookmark" }],
  ["an entity", { ...PAGE, entityId: "20000000-0000-7000-8000-000000000007" }],
  ["an entity type and an entity", { ...PAGE, entityType: "member", entityId: "20000000-0000-7000-8000-000000000007" }],
  ["a time range", { ...PAGE, from: "2026-01-01T00:00:00.000Z", to: "2026-03-01T00:00:00.000Z" }],
  ["a time range after a position", { ...NEXT, from: "2026-01-01T00:00:00.000Z", to: "2026-03-01T00:00:00.000Z" }],
  ["every filter", { ...NEXT, actorAccountId: "00000000-0000-7000-8000-000000000003", actions: CATEGORY, entityType: "member", entityId: "20000000-0000-7000-8000-000000000007", from: "2026-01-01T00:00:00.000Z", to: "2026-12-01T00:00:00.000Z" }],
];

describe("the audit log's list on a table of 215 000 events", () => {
  it("holds the events the plans are made for", async () => {
    const [row] = await asSystem(db, (tx) => tx<{ own: string; total: string; instance: string }[]>`
      SELECT count(*) FILTER (WHERE workspace_id = ${workspaceId})::text AS own, count(*)::text AS total, count(*) FILTER (WHERE workspace_id IS NULL)::text AS instance FROM audit_events`);
    expect(row).toEqual({ own: String(OWN_EVENTS), total: String(OWN_EVENTS + OTHER_WORKSPACES * EVENTS_PER_OTHER_WORKSPACE + INSTANCE_EVENTS), instance: String(INSTANCE_EVENTS) });
  });

  for (const [name, query] of STATEMENTS) {
    it(`plans ${name} with no sequential scan, from an index of audit_events`, async () => {
      const nodes = await planOf(query);

      expect(nodes.filter((node) => node["Node Type"] === "Seq Scan")).toEqual([]);
      const indexes = indexesOf(nodes);
      expect(indexes.length).toBeGreaterThan(0);
      expect(indexes.every((index) => index.startsWith("audit_events_"))).toBe(true);
    });
  }

  it("serves the first page from the index on the workspace, the time and the identifier, with no sort", async () => {
    const nodes = await planOf(PAGE);

    expect(indexesOf(nodes)).toEqual(["audit_events_workspace_id_created_at_idx"]);
    expect(nodes.map((node) => node["Node Type"])).not.toContain("Sort");
  });

  it("serves an actor's events from the index on the workspace, the actor and the time, and an entity's from the one on the workspace, the type and the entity", async () => {
    expect(indexesOf(await planOf({ ...PAGE, actorAccountId: actorId }))).toContain("audit_events_workspace_id_actor_account_id_idx");
    expect(indexesOf(await planOf({ ...PAGE, entityType: "member", entityId }))).toContain("audit_events_workspace_id_entity_idx");
  });
});
