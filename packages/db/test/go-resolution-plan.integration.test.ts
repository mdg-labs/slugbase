import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { goRepository } from "../src/index.ts";
import { candidatesStatement } from "../src/repositories/go.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The plan of the candidate scan of doc 05 section 4 on a workspace of 50 000 bookmarks, beside many small workspaces whose bookmarks and choices carry the
// same slug (doc 08 section 5.3): the scan is an Index Only Scan of bookmarks_slug_idx whose index condition holds the slug and not only the workspace
// (the slow plan the doc describes is an Index Only Scan too), and no sequential scan appears anywhere in the statement, the read of the remembered choice
// included. The failure scenario: a slug column whose equality is not leakproof, or an access predicate that reads a column the index does not hold, turns the
// scan into a filter over the workspace's rows or a read of the table, which this test sees as a missing slug in the index condition, a Seq Scan or an
// Index Scan that fetches heap rows.

const HOOK_TIMEOUT_MS = 300_000;
const BOOKMARKS = 50_000;
const SMALL_WORKSPACES = 1_500;

let db: TestDatabase;
let accountId: string;
let otherId: string;
let workspaceId: string;
let hotBookmarkId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  accountId = freshId();
  otherId = freshId();
  await seedAccount(db, { id: accountId, email: "go-plan-owner@example.test", passwordHash: "$argon2id$stub" });
  await seedAccount(db, { id: otherId, email: "go-plan-other@example.test", passwordHash: "$argon2id$stub" });
  workspaceId = await seedWorkspace(db, { name: "Go plan test" });
  await seedMember(db, { workspaceId, accountId, role: "owner" });
  await seedMember(db, { workspaceId, accountId: otherId });
  // The large workspace: a fifth of its bookmarks have a slug (a fifteenth of them forward), a tenth belong to the other member, and one slug is shared by both members.
  await asSystem(db, (tx) => tx`
    INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, slug, forwarding)
    SELECT gen_random_uuid(), ${workspaceId}, CASE WHEN n % 10 = 0 THEN ${otherId}::uuid ELSE ${accountId}::uuid END,
           'https://example.com/' || n, 'https://example.com/' || n, 'example.com', 'Title ' || (n % 997),
           CASE WHEN n % 5 = 0 THEN 'slug-' || n END, n % 15 = 0
    FROM generate_series(1, ${BOOKMARKS}) AS n`);
  hotBookmarkId = freshId();
  await asSystem(db, (tx) => tx`
    INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, slug, forwarding)
    VALUES (${hotBookmarkId}, ${workspaceId}, ${accountId}, 'https://example.com/hot', 'https://example.com/hot', 'example.com', 'Hot', 'mail', true),
           (${freshId()}, ${workspaceId}, ${otherId}, 'https://example.com/hot2', 'https://example.com/hot2', 'example.com', 'Hot 2', 'mail', true)`);
  await asSystem(db, (tx) => tx`INSERT INTO slug_preferences (workspace_id, account_id, slug, bookmark_id) VALUES (${workspaceId}, ${accountId}, 'mail', ${hotBookmarkId})`);
  // Many small workspaces, each with one member, one forwarding bookmark with the same slug and one remembered choice, so no workspace dominates a table.
  await asSystem(db, (tx) => tx`
    INSERT INTO workspaces (id, name)
    SELECT ('00000000-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid, 'Small ' || n FROM generate_series(1, ${SMALL_WORKSPACES}) AS n`);
  await asSystem(db, (tx) => tx`
    INSERT INTO workspace_members (workspace_id, account_id, role)
    SELECT ('00000000-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid, ${accountId}, 'owner' FROM generate_series(1, ${SMALL_WORKSPACES}) AS n`);
  await asSystem(db, (tx) => tx`
    INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, slug, forwarding)
    SELECT ('00000001-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid, ('00000000-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid, ${accountId},
           'https://example.com/s' || n, 'https://example.com/s' || n, 'example.com', 'Small ' || n, 'mail', true
    FROM generate_series(1, ${SMALL_WORKSPACES}) AS n`);
  await asSystem(db, (tx) => tx`
    INSERT INTO slug_preferences (workspace_id, account_id, slug, bookmark_id)
    SELECT ('00000000-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid, ${accountId}, 'mail', ('00000001-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid
    FROM generate_series(1, ${SMALL_WORKSPACES}) AS n`);
  // A running instance has had its tables vacuumed, so an Index Only Scan reads no heap pages: the visibility map is part of the fixture.
  await db.owner.unsafe("VACUUM (ANALYZE) bookmarks");
  await db.owner.unsafe("VACUUM (ANALYZE) slug_preferences");
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await db.drop();
}, HOOK_TIMEOUT_MS);

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Index Cond"?: string;
  Plans?: PlanNode[];
}

function nodesOf(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(nodesOf)];
}

/** The nodes of the plan of a statement, as the database plans it for a transaction of `slugbase_app` with the settings of `withTenant`. */
async function planOf(statement: { sql: string; params: unknown[] }): Promise<PlanNode[]> {
  const result = await db.app.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${accountId}, true), set_config('app.workspace_id', ${workspaceId}, true)`;
    const rows = await tx.unsafe<{ "QUERY PLAN": { Plan: PlanNode }[] }[]>(`EXPLAIN (FORMAT JSON) ${statement.sql}`, statement.params as never[]);
    return { plan: rows[0]?.["QUERY PLAN"][0]?.Plan };
  });
  if (result.plan === undefined) {
    throw new Error("EXPLAIN returned no plan");
  }
  return nodesOf(result.plan);
}

function inTenant<T>(work: Parameters<typeof db.tenant.withTenant<T>>[1]): Promise<T> {
  return db.tenant.withTenant({ accountId, workspaceId, requestId: "go-plan-test" }, work);
}

describe.each(["mail", "slug-15", "slug-5"])("the candidate scan of the slug %s on a workspace of 50 000 bookmarks", (slug) => {
  it("is an Index Only Scan of bookmarks_slug_idx with the slug in its index condition and no sequential scan anywhere", async () => {
    const statement = await inTenant((tx) => Promise.resolve(new PgDialect({ casing: "snake_case" }).sqlToQuery(candidatesStatement(tx, { slug, accountId }))));

    const nodes = await planOf(statement);

    expect(nodes.map((node) => node["Node Type"])).not.toContain("Seq Scan");
    const scans = nodes.filter((node) => node["Index Name"] === "bookmarks_slug_idx");
    expect(scans.map((node) => node["Node Type"])).toEqual(["Index Only Scan"]);
    expect(scans[0]?.["Index Cond"]).toContain(`slug = '${slug}'::text`);
    expect(scans[0]?.["Index Cond"]).toContain("workspace_id");
    expect(nodes.filter((node) => node["Relation Name"] === "bookmarks").map((node) => node["Node Type"])).toEqual(["Index Only Scan"]);
  });
});

describe("the candidates on a workspace of 50 000 bookmarks", () => {
  it("find the caller's own bookmark of a slug and the remembered choice, and no other member's", async () => {
    const found = await inTenant((tx) => goRepository(tx).candidates({ slug: "mail", accountId }));

    expect(found.candidates.map((candidate) => candidate.id)).toEqual([hotBookmarkId]);
    expect(found.preferredId).toBe(hotBookmarkId);
  });

  it("find the caller's own forwarding bookmark among the many that have a slug", async () => {
    const found = await inTenant((tx) => goRepository(tx).candidates({ slug: "slug-15", accountId }));

    expect(found.candidates).toEqual([expect.objectContaining({ ownerId: accountId, url: "https://example.com/15", access: "owner" })]);
    expect(found.preferredId).toBeUndefined();
  });

  it("find nothing for a slug of another member's, a slug that forwards nowhere and an unknown one", async () => {
    // slug-30 forwards and belongs to the other member; slug-5 is the caller's and does not forward; nothing has "nowhere".
    for (const slug of ["slug-30", "slug-5", "nowhere"]) {
      const found = await inTenant((tx) => goRepository(tx).candidates({ slug, accountId }));
      expect(found, slug).toEqual({ candidates: [], preferredId: undefined });
    }
  });
});
