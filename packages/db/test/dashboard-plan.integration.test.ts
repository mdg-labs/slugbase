import { BOOKMARK_SORTS, dashboard } from "@slugbase/core";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookmarkRepository, dashboardRepository, tagRepository } from "../src/index.ts";
import { pinnedQuery, quickAccessQuery, sharedCountsStatement, sharedQuickAccessStatement, summaryStatement } from "../src/repositories/dashboard.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { vacuumUntilAllVisible } from "./support/vacuum-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The plan and the time of the dashboard on a workspace of 50 000 bookmarks (doc 08 section 5.3, doc 05 section 2.4): the quick access reads `bookmarks_owner_popular_idx` and the pinned
// bookmarks `bookmarks_pinned_idx`, no statement reads the table of bookmarks sequentially, and the whole dashboard, the tags with their counts among it, answers in under 100 ms at the 95th
// percentile through the repositories as slugbase_app, the round trip included. The failure scenario: a statement that does not match its index (a missing owner, a different direction of the
// key) plans a scan and a sort of the whole library, which this test sees as a sequential scan. The library also holds shares: the other member shares 600 of its bookmarks with the owner (a
// quarter of them forwarding), and the owner shares 300 of its bookmarks directly and 200 through a folder, so the quick access of the shared bookmarks and the sharing counts are planned and
// timed over a realistic number of grants, and none of them scans the table of bookmarks. The file runs in the quiet project (vitest.config.ts) so that no other database-heavy file
// shares the machine with its timings.

const HOOK_TIMEOUT_MS = 300_000;
const BOOKMARKS = 50_000;
const SMALL_WORKSPACES = 2_000;
const SMALL_BOOKMARKS = 50;
const TAGS = 40;
const RUNS = 40;
const P95_BUDGET_MS = 100;
const FIXTURE_TABLES = ["bookmarks", "tags", "bookmark_tags", "folders", "bookmark_shares", "folder_shares", "folder_bookmarks"] as const;

let db: TestDatabase;
let accountId: string;
let otherId: string;
let workspaceId: string;
let sharedFolder: string;

const dialect = new PgDialect({ casing: "snake_case" });

beforeAll(async () => {
  db = await createTestDatabase();
  accountId = freshId();
  otherId = freshId();
  await seedAccount(db, { id: accountId, email: "dashboard-plan-owner@example.test", passwordHash: "$argon2id$stub" });
  await seedAccount(db, { id: otherId, email: "dashboard-plan-other@example.test", passwordHash: "$argon2id$stub" });
  workspaceId = await seedWorkspace(db, { name: "Dashboard plan test" });
  await seedMember(db, { workspaceId, accountId, role: "owner" });
  await seedMember(db, { workspaceId, accountId: otherId });
  // The shape of a real library: a tenth belongs to the other member, about 4 % is pinned, a twentieth forwards by a slug, opens repeat, a hundredth is plan-archived.
  await asSystem(db, (tx) => tx`
    INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, slug, forwarding, pinned_at, open_count, plan_archived_at)
    SELECT gen_random_uuid(), ${workspaceId}, CASE WHEN n % 10 = 0 THEN ${otherId}::uuid ELSE ${accountId}::uuid END,
           'https://example.com/' || n, 'https://example.com/' || n, 'example.com', 'Title ' || (n % 997),
           CASE WHEN n % 5 = 0 THEN 'slug-' || n END, n % 20 = 5 OR n % 40 = 0, CASE WHEN n % 25 = 0 THEN now() - (n % 5000) * interval '1 minute' END, n % 50,
           CASE WHEN n % 100 = 1 THEN now() END
    FROM generate_series(1, ${BOOKMARKS}) AS n`);
  await asSystem(db, (tx) => tx`
    INSERT INTO folders (id, workspace_id, owner_id, name)
    SELECT gen_random_uuid(), ${workspaceId}, ${accountId}, 'Folder ' || n FROM generate_series(1, 30) AS n`);
  await asSystem(db, (tx) => tx`
    INSERT INTO tags (id, workspace_id, owner_id, name)
    SELECT gen_random_uuid(), ${workspaceId}, ${accountId}, 'tag-' || n FROM generate_series(1, ${TAGS}) AS n`);
  await asSystem(db, (tx) => tx`
    INSERT INTO tags (id, workspace_id, owner_id, name)
    SELECT gen_random_uuid(), ${workspaceId}, ${otherId}, 'other-tag-' || n FROM generate_series(1, ${TAGS}) AS n`);
  // About 40 % of the owner's bookmarks carry one tag and a third of those a second one, which is about 24 000 links.
  await asSystem(db, (tx) => tx`
    WITH mine AS (SELECT id, row_number() OVER (ORDER BY id) AS n FROM bookmarks WHERE workspace_id = ${workspaceId} AND owner_id = ${accountId}),
         ranked AS (SELECT id, row_number() OVER (ORDER BY name) AS n FROM tags WHERE workspace_id = ${workspaceId} AND owner_id = ${accountId})
    INSERT INTO bookmark_tags (workspace_id, bookmark_id, tag_id)
    SELECT ${workspaceId}::uuid, mine.id, ranked.id FROM mine JOIN ranked ON ranked.n = 1 + mine.n % ${TAGS}::int WHERE mine.n % 5 < 2
    UNION
    SELECT ${workspaceId}::uuid, mine.id, ranked.id FROM mine JOIN ranked ON ranked.n = 1 + (mine.n * 7 + 3) % ${TAGS}::int WHERE mine.n % 5 < 2 AND mine.n % 3 = 0`);
  // The shares: 300 of the other member's forwarding bookmarks and 300 of its others are shared with the owner, 300 of the owner's bookmarks are shared with the other member directly, and
  // 200 more are filed in a folder of the owner that is shared with the other member.
  sharedFolder = freshId();
  await asSystem(db, async (tx) => {
    await tx`
      INSERT INTO bookmark_shares (id, workspace_id, bookmark_id, target_account_id, granted_by)
      SELECT gen_random_uuid(), ${workspaceId}, id, ${accountId}, ${otherId} FROM (
        (SELECT id FROM bookmarks WHERE workspace_id = ${workspaceId} AND owner_id = ${otherId} AND forwarding ORDER BY id LIMIT 300)
        UNION ALL (SELECT id FROM bookmarks WHERE workspace_id = ${workspaceId} AND owner_id = ${otherId} AND NOT forwarding ORDER BY id LIMIT 300)) picked`;
    await tx`
      INSERT INTO bookmark_shares (id, workspace_id, bookmark_id, target_account_id, granted_by)
      SELECT gen_random_uuid(), ${workspaceId}, id, ${otherId}, ${accountId} FROM bookmarks WHERE workspace_id = ${workspaceId} AND owner_id = ${accountId} ORDER BY id LIMIT 300`;
    await tx`INSERT INTO folders (id, workspace_id, owner_id, name) VALUES (${sharedFolder}, ${workspaceId}, ${accountId}, 'Shared folder')`;
    await tx`
      INSERT INTO folder_bookmarks (workspace_id, folder_id, bookmark_id)
      SELECT ${workspaceId}, ${sharedFolder}, id FROM bookmarks WHERE workspace_id = ${workspaceId} AND owner_id = ${accountId} ORDER BY id DESC LIMIT 200`;
    await tx`INSERT INTO folder_shares (id, workspace_id, folder_id, target_account_id, granted_by) VALUES (${freshId()}, ${workspaceId}, ${sharedFolder}, ${otherId}, ${accountId})`;
  });
  // Many small workspaces beside it, so no workspace dominates a table.
  await asSystem(db, (tx) => tx`
    INSERT INTO workspaces (id, name)
    SELECT ('00000000-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid, 'Small ' || n FROM generate_series(1, ${SMALL_WORKSPACES}) AS n`);
  await asSystem(db, (tx) => tx`
    INSERT INTO workspace_members (workspace_id, account_id, role)
    SELECT ('00000000-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid, ${accountId}, 'owner' FROM generate_series(1, ${SMALL_WORKSPACES}) AS n`);
  await asSystem(db, (tx) => tx`
    INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, slug, forwarding, pinned_at)
    SELECT gen_random_uuid(), ('00000000-0000-7000-8000-' || lpad(w::text, 12, '0'))::uuid, ${accountId},
           'https://example.com/s' || w || '/' || n, 'https://example.com/s' || w || '/' || n, 'example.com', 'Small ' || w || ' ' || n,
           CASE WHEN n % 5 = 0 THEN 'small-' || w || '-' || n END, n % 20 = 5, CASE WHEN n % 25 = 0 THEN now() END
    FROM generate_series(1, ${SMALL_WORKSPACES}) AS w CROSS JOIN generate_series(1, ${SMALL_BOOKMARKS}) AS n`);
  // A running instance has its tables vacuumed and analysed, and a vacuum marks all-visible each page whose rows every transaction can see, so an Index Only Scan answers for the entries on those pages from the index alone: the fixture vacuums until the map covers every page, so the map is part of the fixture.
  await db.owner.unsafe("ALTER TABLE bookmarks ALTER COLUMN workspace_id SET STATISTICS 10000, ALTER COLUMN owner_id SET STATISTICS 10000, ALTER COLUMN forwarding SET STATISTICS 10000");
  await vacuumUntilAllVisible(db, FIXTURE_TABLES);
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

function inTenant<T>(work: Parameters<typeof db.tenant.withTenant<T>>[1]): Promise<T> {
  return db.tenant.withTenant({ accountId, workspaceId, requestId: "dashboard-plan-test" }, work);
}

/** The nodes of the plan of a statement, as the database plans it for a transaction of `slugbase_app` with the settings of `withTenant`. */
async function planOf(statement: { sql: string; params: unknown[] }): Promise<PlanNode[]> {
  const result = await db.app.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${accountId}, true), set_config('app.workspace_id', ${workspaceId}, true)`;
    const rows = await tx.unsafe<{ "QUERY PLAN": { Plan: PlanNode }[] }[]>(`EXPLAIN (FORMAT JSON) ${statement.sql}`, statement.params as never[]);
    return rows[0]?.["QUERY PLAN"][0]?.Plan;
  });
  if (result === undefined) {
    throw new Error("EXPLAIN returned no plan");
  }
  return nodesOf(result);
}

const indexesOf = (nodes: readonly PlanNode[]): string[] => nodes.map((node) => node["Index Name"]).filter((name) => name !== undefined);

describe("the dashboard on a workspace of 50 000 bookmarks", () => {
  it("plans the quick access from bookmarks_owner_popular_idx, with no sequential scan and no sort", async () => {
    const statement = await inTenant((tx) => Promise.resolve(quickAccessQuery(tx, accountId, 8).toSQL()));

    const nodes = await planOf(statement);

    expect(nodes.map((node) => node["Node Type"])).not.toContain("Seq Scan");
    expect(nodes.map((node) => node["Node Type"])).not.toContain("Sort");
    expect(indexesOf(nodes)).toEqual(["bookmarks_owner_popular_idx"]);
  });

  it("plans the pinned bookmarks from bookmarks_pinned_idx, with no sequential scan", async () => {
    const statement = await inTenant((tx) => Promise.resolve(pinnedQuery(tx, accountId, 12).toSQL()));

    const nodes = await planOf(statement);

    expect(nodes.map((node) => node["Node Type"])).not.toContain("Seq Scan");
    expect(indexesOf(nodes)).toEqual(["bookmarks_pinned_idx"]);
  });

  it("plans the counts and the checklist facts with no sequential scan of the bookmarks", async () => {
    const statement = await inTenant((tx) => Promise.resolve(dialect.sqlToQuery(summaryStatement(tx, accountId))));

    const nodes = await planOf(statement);

    expect(nodes.filter((node) => node["Node Type"] === "Seq Scan" && node["Relation Name"] === "bookmarks")).toEqual([]);
    // The two "has any" facts are index lookups of their own: the first bookmark in the order of the title index, and the first slug of the owner.
    expect(indexesOf(nodes)).toEqual(expect.arrayContaining(["bookmarks_owner_title_idx", "bookmarks_owner_slug_key"]));
  });

  it("plans the forwarding bookmarks shared with the owner from the set of its grants, with no sequential scan of the bookmarks", async () => {
    const statement = await inTenant((tx) => Promise.resolve(dialect.sqlToQuery(sharedQuickAccessStatement(tx, accountId, 8))));

    const nodes = await planOf(statement);

    expect(nodes.filter((node) => node["Node Type"] === "Seq Scan" && node["Relation Name"] === "bookmarks")).toEqual([]);
    expect(indexesOf(nodes)).toContain("bookmarks_workspace_id_id_key");
  });

  it("plans the sharing counts with no sequential scan of the bookmarks", async () => {
    const statement = await inTenant((tx) => Promise.resolve(dialect.sqlToQuery(sharedCountsStatement(tx, accountId))));

    const nodes = await planOf(statement);

    expect(nodes.filter((node) => node["Node Type"] === "Seq Scan" && node["Relation Name"] === "bookmarks")).toEqual([]);
  });

  it("counts the shares as the lists of the shared scopes list them, and ranks the shared bookmarks into the quick access by their opens", async () => {
    const answer = await inTenant((tx) => dashboard({ store: dashboardRepository(tx), tags: tagRepository(tx) }, { accountId, sharing: true }));
    const listed = async (scope: "shared_with_me" | "shared_by_me"): Promise<number> => {
      const rows = await inTenant((tx) => bookmarkRepository(tx).list({ filter: { ownerId: accountId, scope }, sort: BOOKMARK_SORTS[0], after: undefined, limit: 5_000 }));
      return rows.length;
    };

    expect(answer?.sharing).toEqual({ sharedWithYou: 600, sharedByYou: await listed("shared_by_me") });
    expect(answer?.sharing?.sharedWithYou).toBe(await listed("shared_with_me"));
    expect(answer?.sharing?.sharedByYou).toBeGreaterThan(0);
    const opens = answer?.quickAccess.map((entry) => entry.openCount) ?? [];
    expect(opens).toEqual(opens.toSorted((a, b) => b - a));
  });

  it("answers the library the test seeded: eight, twelve and twelve entries, and the counts of the owner", async () => {
    const answer = await inTenant((tx) => dashboard({ store: dashboardRepository(tx), tags: tagRepository(tx) }, { accountId, sharing: true }));

    expect(answer?.quickAccess).toHaveLength(8);
    expect(answer?.pinned).toHaveLength(12);
    expect(answer?.topTags).toHaveLength(12);
    expect(answer?.counts.bookmarks).toBe(44_500);
    expect(answer?.counts).toMatchObject({ folders: 31, tags: TAGS });
  });

  it("measures tables whose every page the visibility map marks all-visible", async () => {
    const rows = await db.owner<{ name: string; pages: number; visible: number }[]>`
      SELECT relname AS name, relpages AS pages, relallvisible AS visible FROM pg_class WHERE oid = ANY (${FIXTURE_TABLES.map((table) => `public.${table}`)}::regclass[]) ORDER BY relname`;

    expect(rows.map((row) => row.name)).toEqual([...FIXTURE_TABLES].sort());
    expect(rows.filter((row) => row.visible < row.pages)).toEqual([]);
  });

  it(`answers in under ${String(P95_BUDGET_MS)} ms at the 95th percentile`, async () => {
    const times: number[] = [];
    for (let run = 0; run < RUNS + 1; run += 1) {
      const started = performance.now();
      const answer = await inTenant((tx) => dashboard({ store: dashboardRepository(tx), tags: tagRepository(tx) }, { accountId, sharing: true }));
      const elapsed = performance.now() - started;
      expect(answer?.topTags).toHaveLength(12);
      if (run > 0) {
        times.push(elapsed);
      }
    }
    times.sort((a, b) => a - b);

    expect(times[Math.ceil(RUNS * 0.95) - 1]).toBeLessThan(P95_BUDGET_MS);
  });
});
