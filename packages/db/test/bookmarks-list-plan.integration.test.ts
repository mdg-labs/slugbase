import { BOOKMARK_SORTS, type BookmarkListFilter, type BookmarkListRequest, type BookmarkSort } from "@slugbase/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookmarkRepository, TenantContextError } from "../src/index.ts";
import { countQuery, listQuery } from "../src/repositories/bookmarks.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { blocksOfStatement } from "./support/plan-work.ts";
import { vacuumUntilAllVisible, visibilityOf } from "./support/vacuum-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The list budget of doc 01 section 9.3 and doc 08 section 5.3 on a workspace of 50 000 bookmarks: every sort is read from the index
// that serves it, not sorted from a scan of the table, and the first page and a page deep in the library, a page under each filter and the capped
// count each touch no more buffers than the plan that serves them. The failure scenario: a sort whose ordering does not match its index (the wrong direction of NULLS, a missing tiebreak
// column) plans a sort of the whole library, which this test sees as a sequential scan or a sort node, and reads far more blocks. The time of the same reads through the repository is reported, not asserted
// (the work and the time, below).

const HOOK_TIMEOUT_MS = 300_000;
const FIXTURE_TABLES = ["bookmarks"] as const;
const BOOKMARKS = 50_000;
const RUNS = 5;
const PAGE = 48;
const DEEP = 40_000;

const INDEX_OF: Readonly<Record<BookmarkSort, string>> = {
  recent: "bookmarks_owner_recent_idx",
  oldest: "bookmarks_owner_recent_idx",
  title_asc: "bookmarks_owner_title_idx",
  title_desc: "bookmarks_owner_title_idx",
  most_used: "bookmarks_owner_popular_idx",
  recently_opened: "bookmarks_owner_opened_idx",
};

let db: TestDatabase;
let accountId: string;
let workspaceId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  accountId = freshId();
  const other = freshId();
  await seedAccount(db, { id: accountId, email: "plan-owner@example.test", passwordHash: "$argon2id$stub" });
  await seedAccount(db, { id: other, email: "plan-other@example.test", passwordHash: "$argon2id$stub" });
  workspaceId = await seedWorkspace(db, { name: "Plan test" });
  const otherWorkspace = await seedWorkspace(db, { name: "Plan test, another workspace" });
  await seedMember(db, { workspaceId, accountId, role: "owner" });
  await seedMember(db, { workspaceId, accountId: other });
  await seedMember(db, { workspaceId: otherWorkspace, accountId, role: "owner" });
  // The shape of the seeded large instance (doc 08 section 3.4): about 4 % pinned, a little over half opened, titles and counts that
  // repeat, creation times that tie in groups of three, a tenth of the workspace owned by someone else and a small workspace beside it.
  await asSystem(db, (tx) => tx`
    INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, slug, forwarding, pinned_at, open_count, last_opened_at, created_at)
    SELECT gen_random_uuid(), ${workspaceId}, CASE WHEN n % 10 = 0 THEN ${other}::uuid ELSE ${accountId}::uuid END,
           'https://example.com/' || n, 'https://example.com/' || n, 'example.com', 'Title ' || (n % 997),
           CASE WHEN n % 5 = 0 THEN 'slug-' || n END, n % 20 = 0, CASE WHEN n % 25 = 0 THEN now() END, n % 50,
           CASE WHEN n % 2 = 0 THEN timestamptz '2026-02-01' + (n % 3000) * interval '1 minute' + (n % 7) * interval '1 microsecond' END,
           timestamptz '2026-01-01' + (n / 3) * interval '1 second' + interval '123456 microseconds'
    FROM generate_series(1, ${BOOKMARKS}) AS n`);
  await asSystem(db, (tx) => tx`
    INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title)
    SELECT gen_random_uuid(), ${otherWorkspace}, ${accountId}, 'https://example.com/o' || n, 'https://example.com/o' || n, 'example.com', 'Other ' || n
    FROM generate_series(1, 500) AS n`);
  // A running instance has its tables vacuumed and analysed: the fixture vacuums until the visibility map covers every page, so the state a read finds does not depend on whether autovacuum has reached the table in the middle of the file.
  await vacuumUntilAllVisible(db, FIXTURE_TABLES);
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await db.drop();
}, HOOK_TIMEOUT_MS);

interface PlanNode {
  "Node Type": string;
  "Index Name"?: string;
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
  return db.tenant.withTenant({ accountId, workspaceId, requestId: "bookmarks-plan-test" }, work);
}

async function deepPosition(sort: BookmarkSort): Promise<BookmarkListRequest["after"]> {
  const rows = await inTenant((tx) => bookmarkRepository(tx).list({ filter: { ownerId: accountId }, sort, after: undefined, limit: DEEP }));
  const last = rows.at(-1);
  if (last === undefined) {
    throw new Error("the library is smaller than the deep page");
  }
  return { key: last.key, id: last.bookmark.id };
}

/** The median of `RUNS` runs of a read, in milliseconds, after one run that is not counted. */
async function median(work: () => Promise<unknown>): Promise<number> {
  await work();
  const times: number[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    const started = performance.now();
    await work();
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(RUNS / 2)] ?? Number.POSITIVE_INFINITY;
}

// The work and the time. A read through the repository took 1 to 26 ms here (the median of five runs), but a time measured in a suite moves with what else runs on the host while the plan does not, so what is
// asserted is the work of the plan: `Shared Hit Blocks` plus `Shared Read Blocks` of `EXPLAIN (ANALYZE, BUFFERS)` (`support/plan-work.ts`) of the statement of a page and of the count, as slugbase_app in a tenant
// transaction. Each bound is 5 % and 16 blocks over the most that read touched in 12 runs of this file on PostgreSQL 17 and 18, rounded up to ten, and the higher of the two versions where they differ (the page of the forwarding bookmarks by oldest touched 3 438 to 3 452 blocks on PostgreSQL 17 and 2 664 to 2 700 on 18, the deep page by title_desc 41 003 to 41 008 and 40 513 to 40 529).
// The median time of each read is reported at the end and not asserted. What this does not hold: the 100 ms. A regression that costs CPU and reads no more blocks
// passes. And a bound above the 1 659 pages of the table cannot tell a scan of the table from the plan it holds. These reads are over it: the deep page by title (an index walk that filters 40 000 entries with the keyset
// condition), the pages of the pinned filter by title, most used and last opened, of the with-a-slug filter by most used and last opened, of the forwarding filter in every sort, and the page of one canonical URL, which reads
// 1 659 blocks in every sort and is a sequential scan of the table in the sort by recency. For those reads the bound holds the plan's own cost, and only the unfiltered pages above are also checked for a scan and a sort.
const BLOCKS_OF_SORT: Readonly<Record<BookmarkSort, { first: number; deep: number }>> = {
  recent: { first: 30, deep: 30 },
  oldest: { first: 30, deep: 30 },
  title_asc: { first: 80, deep: 42_580 },
  title_desc: { first: 80, deep: 43_080 },
  most_used: { first: 80, deep: 80 },
  recently_opened: { first: 80, deep: 80 },
};
const measured = new Map<string, string>();

afterAll(() => {
  process.stdout.write(`list work (buffers of the statement) and median time (ms, reported not asserted): ${JSON.stringify(Object.fromEntries(measured))}\n`);
});

describe("the fixture", () => {
  it("measures a table whose every page the visibility map marks all-visible", async () => {
    const rows = await visibilityOf(db, FIXTURE_TABLES);

    expect(rows.map((row) => row.name)).toEqual([...FIXTURE_TABLES].sort());
    expect(rows.filter((row) => row.visible < row.pages)).toEqual([]);
  });
});

describe.each(BOOKMARK_SORTS)("the list sorted by %s on a workspace of 50 000 bookmarks", (sort) => {
  let deep: BookmarkListRequest["after"];

  beforeAll(async () => {
    deep = await deepPosition(sort);
  }, HOOK_TIMEOUT_MS);

  it.each([
    ["the first page", undefined],
    ["a page deep in the library", "deep"],
  ] as const)("plans %s from the index of the sort, with no sequential scan and no sort", async (_name, where) => {
    const request: BookmarkListRequest = { filter: { ownerId: accountId }, sort, after: where === "deep" ? deep : undefined, limit: PAGE + 1 };
    const statement = await inTenant((tx) => Promise.resolve(listQuery(tx, request).toSQL()));

    const nodes = await planOf(statement);

    expect(nodes.map((node) => node["Node Type"])).not.toContain("Seq Scan");
    expect(nodes.map((node) => node["Node Type"])).not.toContain("Sort");
    expect(nodes.map((node) => node["Index Name"]).filter((name) => name !== undefined)).toEqual([INDEX_OF[sort]]);
  });

  it.each([
    ["the first page", undefined],
    ["a page deep in the library", "deep"],
  ] as const)("reads %s within the work of its plan", async (name, where) => {
    const after = where === "deep" ? deep : undefined;
    const bound = BLOCKS_OF_SORT[sort][where === "deep" ? "deep" : "first"];
    const statement = await inTenant((tx) => Promise.resolve(listQuery(tx, { filter: { ownerId: accountId }, sort, after, limit: PAGE + 1 }).toSQL()));

    const blocks = await blocksOfStatement(db, { accountId, workspaceId }, statement, bound);
    const elapsed = await inTenant(async (tx) => {
      const repository = bookmarkRepository(tx);
      let rows = 0;
      const time = await median(async () => {
        rows = (await repository.list({ filter: { ownerId: accountId }, sort, after, limit: PAGE + 1 })).length;
      });
      expect(rows).toBe(PAGE + 1);
      return time;
    });
    measured.set(`${sort} ${name}`, `${String(blocks)} ${elapsed.toFixed(0)}`);

    expect(blocks, `${sort}, ${name}`).toBeLessThan(bound);
  }, HOOK_TIMEOUT_MS);
});

describe("the filters on a workspace of 50 000 bookmarks", () => {
  const filters: readonly { name: string; filter: Omit<BookmarkListFilter, "ownerId"> }[] = [
    { name: "pinned", filter: { pinned: true } },
    { name: "with a slug", filter: { hasSlug: true } },
    { name: "forwarding", filter: { forwarding: true } },
    { name: "of one canonical URL", filter: { urlCanonical: "https://example.com/12345" } },
  ];
  const BLOCKS_OF_FILTER: Readonly<Record<string, Readonly<Record<BookmarkSort, number>>>> = {
    pinned: { recent: 150, oldest: 270, title_asc: 2360, title_desc: 2370, most_used: 23_450, recently_opened: 22_940 },
    "with a slug": { recent: 50, oldest: 70, title_asc: 500, title_desc: 500, most_used: 4330, recently_opened: 21_630 },
    forwarding: { recent: 2870, oldest: 3650, title_asc: 47_830, title_desc: 48_400, most_used: 47_850, recently_opened: 47_890 },
    "of one canonical URL": { recent: 1760, oldest: 1760, title_asc: 1760, title_desc: 1760, most_used: 1760, recently_opened: 1760 },
  };


  it.each(filters)("reads a page of the bookmarks that are $name within the work of its plan", async ({ name, filter }) => {
    for (const sort of BOOKMARK_SORTS) {
      const bound = BLOCKS_OF_FILTER[name]?.[sort] ?? Number.NaN;
      const statement = await inTenant((tx) => Promise.resolve(listQuery(tx, { filter: { ownerId: accountId, ...filter }, sort, after: undefined, limit: PAGE + 1 }).toSQL()));
      const blocks = await blocksOfStatement(db, { accountId, workspaceId }, statement, bound);
      const elapsed = await inTenant(async (tx) => {
        const repository = bookmarkRepository(tx);
        return median(() => repository.list({ filter: { ownerId: accountId, ...filter }, sort, after: undefined, limit: PAGE + 1 }));
      });
      measured.set(`${name} ${sort}`, `${String(blocks)} ${elapsed.toFixed(0)}`);

      expect(blocks, `${name}, ${sort}`).toBeLessThan(bound);
    }
  }, HOOK_TIMEOUT_MS);

  it("counts the library, up to the cap, within the work of its plan", async () => {
    const bound = 400;
    const statement = await inTenant((tx) => Promise.resolve(countQuery(tx, { ownerId: accountId }, 10_001).toSQL()));
    const blocks = await blocksOfStatement(db, { accountId, workspaceId }, statement, bound);
    const elapsed = await inTenant(async (tx) => {
      const repository = bookmarkRepository(tx);
      expect(await repository.count({ ownerId: accountId }, 10_001)).toBe(10_001);
      expect(await repository.count({ ownerId: accountId, pinned: true }, 10_001)).toBe(1000);
      return median(() => repository.count({ ownerId: accountId }, 10_001));
    });
    measured.set("count", `${String(blocks)} ${elapsed.toFixed(0)}`);

    expect(blocks).toBeLessThan(bound);
  }, HOOK_TIMEOUT_MS);

  it("plans the count so that it reads no more rows than the cap", async () => {
    const statement = await inTenant((tx) => Promise.resolve(countQuery(tx, { ownerId: accountId }, 10_001).toSQL()));

    const nodes = await planOf(statement);

    expect(nodes.map((node) => node["Node Type"])).toContain("Limit");
  });

  it("refuses to plan a statement in a transaction opened without a workspace", async () => {
    await expect(db.tenant.withTenant({ accountId, requestId: "bookmarks-plan-test" }, (tx) => Promise.resolve(listQuery(tx, { filter: { ownerId: accountId }, sort: "recent", after: undefined, limit: 1 })))).rejects.toBeInstanceOf(TenantContextError);
  });
});
