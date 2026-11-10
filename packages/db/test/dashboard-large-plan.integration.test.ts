import { dashboard } from "@slugbase/core";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dashboardRepository, tagRepository } from "../src/index.ts";
import { summaryStatement } from "../src/repositories/dashboard.ts";
import { tagsQuery } from "../src/repositories/tags.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { blocksOfStatement } from "./support/plan-work.ts";
import { vacuumUntilAllVisible, visibilityOf } from "./support/vacuum-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The counts and the top tags of the dashboard on the shape of the instance the `dashboard` budget is measured on (doc 08 section 5.3): one workspace of 49 000 bookmarks with two members, the owner's
// 39 200 of which carry 30 tags over about 35 600 links (0.91 a bookmark), 2 % of the bookmarks plan-archived, and 2 000 small workspaces beside it. `dashboard-plan.integration.test.ts` plans the same
// statements on a library with fewer tag links, and its plan is another one: the top tags there are 1 312 buffers, here a plan that visits the bookmark of every link of the owner would be 100 000 and more.
// Both statements are held to their work in two states of the table of bookmarks, since a table is vacuumed at the pace of its writes: with the visibility map empty, as a seed that vacuums once leaves it
// (the tags and the links are marked, the bookmarks, which the seed updates after it inserts them, are not), and with every page marked all-visible. Neither state sorts the owner's bookmarks to count them. The test reports
// the buffers of each statement and holds them to a bound that the plan before the fix (a visit to the bookmark of each link: 150 000 buffers here, and a sort of the owner's bookmarks) exceeds.

const HOOK_TIMEOUT_MS = 300_000;
const BOOKMARKS = 49_000;
const SMALL_WORKSPACES = 2_000;
const SMALL_BOOKMARKS = 10;
const TAGS = 30;
const OWNER_BOOKMARKS = 39_200;
const ARCHIVED_OF_OWNER = 980;
const TABLES = ["bookmarks", "tags", "bookmark_tags"] as const;
const TOP_TAGS = 12;
const ALL = 1_000;

// The most buffers each statement may touch. The top tags count the links of each tag from `bookmark_tags_tag_idx` and subtract those of the plan-archived bookmarks, found through `bookmarks_owner_archived_idx`:
// about 4 000 buffers on this fixture (5 000 with the bookmarks' map empty, which sends the archived entries to the heap). The counts read the owner's entries of an index of bookmarks (about 500) or,
// with no page marked all-visible, the pages of the table (2 000 to 5 000 by the plan).
const TOP_TAGS_BLOCKS = 10_000;
const COUNTS_BLOCKS: Readonly<Record<"empty" | "full", number>> = { empty: 6_000, full: 1_000 };

let db: TestDatabase;
let accountId: string;
let otherId: string;
let workspaceId: string;

const dialect = new PgDialect({ casing: "snake_case" });

beforeAll(async () => {
  db = await createTestDatabase();
  accountId = freshId();
  otherId = freshId();
  await seedAccount(db, { id: accountId, email: "dashboard-large-owner@example.test", passwordHash: "$argon2id$stub" });
  await seedAccount(db, { id: otherId, email: "dashboard-large-other@example.test", passwordHash: "$argon2id$stub" });
  workspaceId = await seedWorkspace(db, { name: "Dashboard large plan test" });
  await seedMember(db, { workspaceId, accountId, role: "owner" });
  await seedMember(db, { workspaceId, accountId: otherId });
  // Nothing vacuums these tables behind the test: the state of the visibility map is the one the test sets.
  for (const table of TABLES) {
    await db.owner.unsafe(`ALTER TABLE ${table} SET (autovacuum_enabled = false)`);
  }
  // A fifth of the bookmarks is the other member's. Of every fifty, one of the owner's and one of the other member's are plan-archived.
  await asSystem(db, (tx) => tx`
    INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, slug, forwarding, open_count, plan_archived_at)
    SELECT gen_random_uuid(), ${workspaceId}, CASE WHEN n % 5 = 0 THEN ${otherId}::uuid ELSE ${accountId}::uuid END,
           'https://example.com/' || n, 'https://example.com/' || n, 'example.com', 'Title ' || (n % 997),
           CASE WHEN n % 7 = 0 THEN 'slug-' || n END, n % 14 = 0, n % 50,
           CASE WHEN n % 50 IN (1, 10) THEN now() END
    FROM generate_series(1, ${BOOKMARKS}) AS n`);
  await asSystem(db, (tx) => tx`
    INSERT INTO folders (id, workspace_id, owner_id, name)
    SELECT gen_random_uuid(), ${workspaceId}, ${accountId}, 'Folder ' || n FROM generate_series(1, 12) AS n`);
  await asSystem(db, (tx) => tx`
    INSERT INTO tags (id, workspace_id, owner_id, name)
    SELECT gen_random_uuid(), ${workspaceId}, owner, 'tag-' || n FROM generate_series(1, ${TAGS}) AS n CROSS JOIN (VALUES (${accountId}::uuid), (${otherId}::uuid)) AS owners(owner)`);
  // The owner tags ten of every eleven bookmarks with one tag; the other member tags all of its own bookmarks with one of its tags.
  await asSystem(db, (tx) => tx`
    INSERT INTO bookmark_tags (workspace_id, bookmark_id, tag_id)
    WITH mine AS (SELECT id, owner_id, row_number() OVER (PARTITION BY owner_id ORDER BY id) AS n FROM bookmarks WHERE workspace_id = ${workspaceId}),
         ranked AS (SELECT id, owner_id, row_number() OVER (PARTITION BY owner_id ORDER BY name) AS n FROM tags WHERE workspace_id = ${workspaceId})
    SELECT ${workspaceId}::uuid, mine.id, ranked.id FROM mine JOIN ranked ON ranked.owner_id = mine.owner_id AND ranked.n = 1 + mine.n % ${TAGS}::int
    WHERE mine.owner_id = ${otherId} OR mine.n % 11 <> 0`);
  // Each small workspace has an owner of its own, as the instance's do.
  await asSystem(db, (tx) => tx`
    INSERT INTO accounts (id, email, display_name, password_hash)
    SELECT ('00000000-0000-7000-9000-' || lpad(n::text, 12, '0'))::uuid, 'dashboard-large-small-' || n || '@example.test', 'Small owner', '$argon2id$stub' FROM generate_series(1, ${SMALL_WORKSPACES}) AS n`);
  await asSystem(db, (tx) => tx`
    INSERT INTO workspaces (id, name)
    SELECT ('00000000-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid, 'Small ' || n FROM generate_series(1, ${SMALL_WORKSPACES}) AS n`);
  await asSystem(db, (tx) => tx`
    INSERT INTO workspace_members (workspace_id, account_id, role)
    SELECT ('00000000-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid, ('00000000-0000-7000-9000-' || lpad(n::text, 12, '0'))::uuid, 'owner' FROM generate_series(1, ${SMALL_WORKSPACES}) AS n`);
  await asSystem(db, (tx) => tx`
    INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title)
    SELECT gen_random_uuid(), ('00000000-0000-7000-8000-' || lpad(w::text, 12, '0'))::uuid, ('00000000-0000-7000-9000-' || lpad(w::text, 12, '0'))::uuid,
           'https://example.com/s' || w || '/' || n, 'https://example.com/s' || w || '/' || n, 'example.com', 'Small ' || w || ' ' || n
    FROM generate_series(1, ${SMALL_WORKSPACES}) AS w CROSS JOIN generate_series(1, ${SMALL_BOOKMARKS}) AS n`);
  // The small workspaces have three tags each and tag most of their bookmarks, as the instance's do, so the planner expects a tag to be linked to a handful of bookmarks and not to tens of thousands.
  await asSystem(db, (tx) => tx`
    INSERT INTO tags (id, workspace_id, owner_id, name)
    SELECT gen_random_uuid(), ('00000000-0000-7000-8000-' || lpad(w::text, 12, '0'))::uuid, ('00000000-0000-7000-9000-' || lpad(w::text, 12, '0'))::uuid, 'small-tag-' || k
    FROM generate_series(1, ${SMALL_WORKSPACES}) AS w CROSS JOIN generate_series(1, 3) AS k`);
  await asSystem(db, (tx) => tx`
    INSERT INTO bookmark_tags (workspace_id, bookmark_id, tag_id)
    WITH small AS (SELECT id, workspace_id, row_number() OVER (PARTITION BY workspace_id ORDER BY id) AS n FROM bookmarks WHERE workspace_id <> ${workspaceId}),
         ranked AS (SELECT id, workspace_id, row_number() OVER (PARTITION BY workspace_id ORDER BY name) AS n FROM tags WHERE workspace_id <> ${workspaceId})
    SELECT small.workspace_id, small.id, ranked.id FROM small JOIN ranked ON ranked.workspace_id = small.workspace_id AND ranked.n = 1 + small.n % 3 WHERE small.n <= 8`);
  await db.owner.unsafe("ALTER TABLE bookmarks ALTER COLUMN workspace_id SET STATISTICS 10000, ALTER COLUMN owner_id SET STATISTICS 10000");
  await db.owner.unsafe(`ANALYZE ${TABLES.join(", ")}`);
  // The state a seed that vacuums once leaves: the links and the tags are marked all-visible and the bookmarks, which the seed updates after it inserts them, are not.
  await vacuumUntilAllVisible(db, ["tags", "bookmark_tags"]);
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
  return db.tenant.withTenant({ accountId, workspaceId, requestId: "dashboard-large-plan-test" }, work);
}

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

const countsStatement = () => inTenant((tx) => Promise.resolve(dialect.sqlToQuery(summaryStatement(tx, accountId))));
const topTagsStatement = () => inTenant((tx) => Promise.resolve(tagsQuery(tx, { ownerId: accountId, sort: "count", after: undefined, limit: TOP_TAGS, tagId: undefined }).toSQL()));

/** What each tag of the owner is linked to that is not plan-archived, counted from the rows themselves as the system role reads them. */
async function expectedCounts(): Promise<Map<string, number>> {
  const rows = await asSystem(db, (tx) => tx<{ name: string; n: number }[]>`
    SELECT t.name::text AS name, count(b.id)::int AS n
    FROM tags t
    LEFT JOIN bookmark_tags bt ON bt.workspace_id = t.workspace_id AND bt.tag_id = t.id
    LEFT JOIN bookmarks b ON b.workspace_id = bt.workspace_id AND b.id = bt.bookmark_id AND b.plan_archived_at IS NULL AND b.owner_id = t.owner_id
    WHERE t.workspace_id = ${workspaceId} AND t.owner_id = ${accountId}
    GROUP BY t.id`);
  return new Map(rows.map((row) => [row.name, row.n]));
}

describe("the dashboard on the shape of the large instance", () => {
  it("holds the fixture to the shape of the instance", async () => {
    const [row] = await asSystem(db, (tx) => tx<{ owned: number; archived: number; links: number; tags: number }[]>`
      SELECT (SELECT count(*)::int FROM bookmarks WHERE workspace_id = ${workspaceId} AND owner_id = ${accountId}) AS owned,
             (SELECT count(*)::int FROM bookmarks WHERE workspace_id = ${workspaceId} AND owner_id = ${accountId} AND plan_archived_at IS NOT NULL) AS archived,
             (SELECT count(*)::int FROM bookmark_tags bt JOIN tags t ON t.workspace_id = bt.workspace_id AND t.id = bt.tag_id WHERE t.workspace_id = ${workspaceId} AND t.owner_id = ${accountId}) AS links,
             (SELECT count(*)::int FROM tags WHERE workspace_id = ${workspaceId} AND owner_id = ${accountId}) AS tags`);

    expect(row).toMatchObject({ owned: OWNER_BOOKMARKS, archived: ARCHIVED_OF_OWNER, tags: TAGS });
    expect((row?.links ?? 0) / OWNER_BOOKMARKS).toBeGreaterThan(0.85);
    expect((row?.links ?? 0) / OWNER_BOOKMARKS).toBeLessThan(0.95);
  });

  it.each(["empty", "full"] as const)("reads the top tags and the counts within their work, with the visibility map of the bookmarks %s", async (state) => {
    if (state === "full") {
      await vacuumUntilAllVisible(db, TABLES);
    }
    const [bookmarks] = (await visibilityOf(db, ["bookmarks"])).filter((row) => row.name === "bookmarks");
    expect(state === "empty" ? bookmarks?.visible === 0 : (bookmarks?.visible ?? 0) >= (bookmarks?.pages ?? 1), `the map of the bookmarks is ${state}`).toBe(true);

    const counts = await countsStatement();
    const topTags = await topTagsStatement();
    const countsNodes = await planOf(counts);
    const countsBlocks = await blocksOfStatement(db, { accountId, workspaceId }, counts, COUNTS_BLOCKS[state]);
    const topTagsBlocks = await blocksOfStatement(db, { accountId, workspaceId }, topTags, TOP_TAGS_BLOCKS);
    process.stdout.write(`dashboard large instance, map ${state}: counts ${String(countsBlocks)} buffers, top tags ${String(topTagsBlocks)} buffers\n`);

    expect(countsNodes.map((node) => node["Node Type"]), "the counts sort the owner's bookmarks").not.toContain("Sort");
    if (state === "full") {
      expect(countsNodes.filter((node) => node["Node Type"] === "Seq Scan" && node["Relation Name"] === "bookmarks")).toEqual([]);
    }
    expect(countsBlocks, "counts").toBeLessThan(COUNTS_BLOCKS[state]);
    expect(topTagsBlocks, "top tags").toBeLessThan(TOP_TAGS_BLOCKS);
  }, HOOK_TIMEOUT_MS);

  it("answers the top tags and the tag list with the counts of the bookmarks that are not plan-archived", async () => {
    const expected = await expectedCounts();
    const archivedLinks = await asSystem(db, (tx) => tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM bookmark_tags bt JOIN bookmarks b ON b.workspace_id = bt.workspace_id AND b.id = bt.bookmark_id JOIN tags t ON t.workspace_id = bt.workspace_id AND t.id = bt.tag_id
      WHERE t.owner_id = ${accountId} AND b.plan_archived_at IS NOT NULL`);
    const answer = await inTenant((tx) => dashboard({ store: dashboardRepository(tx), tags: tagRepository(tx) }, { accountId, sharing: false }));
    const byName = await inTenant((tx) => tagRepository(tx).list({ ownerId: accountId, sort: "name", after: undefined, limit: ALL }));
    const byCount = await inTenant((tx) => tagRepository(tx).list({ ownerId: accountId, sort: "count", after: undefined, limit: ALL }));

    expect(archivedLinks[0]?.n, "the fixture links plan-archived bookmarks").toBeGreaterThan(0);
    expect(byName).toHaveLength(TAGS);
    expect(new Map(byName.map((tag) => [tag.name, tag.bookmarkCount]))).toEqual(expected);
    expect(byCount.map((tag) => tag.id).toSorted()).toEqual(byName.map((tag) => tag.id).toSorted());
    expect(byCount.map((tag) => tag.bookmarkCount)).toEqual(byCount.map((tag) => tag.bookmarkCount).toSorted((a, b) => b - a));
    expect(answer?.topTags.map((tag) => [tag.name, tag.bookmarkCount])).toEqual(byCount.slice(0, TOP_TAGS).map((tag) => [tag.name, tag.bookmarkCount]));
    expect(answer?.counts.bookmarks).toBe(OWNER_BOOKMARKS - ARCHIVED_OF_OWNER);
  });

  it("pages the tags by count after the place a page ended at", async () => {
    const all = await inTenant((tx) => tagRepository(tx).list({ ownerId: accountId, sort: "count", after: undefined, limit: ALL }));
    const pageSize = 7;
    const pages: string[] = [];
    let after: { id: string; name: string; count: number } | undefined;
    for (let page = 0; page < 6; page += 1) {
      const rows = await inTenant((tx) => tagRepository(tx).list({ ownerId: accountId, sort: "count", after, limit: pageSize }));
      pages.push(...rows.map((tag) => tag.id));
      const last = rows.at(-1);
      if (last === undefined || rows.length < pageSize) {
        break;
      }
      after = { id: last.id, name: last.name, count: last.bookmarkCount };
    }

    expect(pages).toEqual(all.map((tag) => tag.id));
  });
});
