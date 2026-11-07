import { BOOKMARK_SORTS, type BookmarkListFilter, type BookmarkListRequest, type BookmarkSort } from "@slugbase/core";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookmarkRepository, TenantContextError } from "../src/index.ts";
import { countQuery, listQuery, pageStatement } from "../src/repositories/bookmarks.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { blocksOfStatement, STATEMENT_TIMEOUT_MS } from "./support/plan-work.ts";
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
const SHARED_WITH_ACCOUNT = 30;

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
  // Another member shares a few of their bookmarks with the account, so the list of the scope `all` has a shared leg with something in it.
  await asSystem(db, (tx) => tx`
    INSERT INTO bookmark_shares (id, workspace_id, bookmark_id, target_account_id, granted_by)
    SELECT gen_random_uuid(), ${workspaceId}, id, ${accountId}, ${other} FROM bookmarks WHERE workspace_id = ${workspaceId} AND owner_id = ${other} ORDER BY id LIMIT ${SHARED_WITH_ACCOUNT}`);
  // A running instance has its tables vacuumed and analysed: the fixture vacuums until the visibility map covers every page, so the state a read finds does not depend on whether autovacuum has reached the table in the middle of the file.
  await vacuumUntilAllVisible(db, FIXTURE_TABLES);
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await db.drop();
}, HOOK_TIMEOUT_MS);

interface PlanNode {
  "Node Type": string;
  "Index Name"?: string;
  "Function Name"?: string;
  "Index Cond"?: string;
  Filter?: string;
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

async function deepPosition(sort: BookmarkSort): Promise<NonNullable<BookmarkListRequest["after"]>> {
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
// transaction. Each bound is 5 % and 16 blocks over the most that read touched in 12 runs of this file on PostgreSQL 17 and 18, rounded up to ten, and the higher of the two versions where they differ (the page of the forwarding bookmarks by oldest touched 3 438 to 3 452 blocks on PostgreSQL 17 and 2 664 to 2 700 on 18). The deep page by title is read through `sys_bookmark_title_page` and touched 57 to 58 blocks in 5 runs and 63 in one under load on PostgreSQL 18 (it could not be run on 17 here, where CI's integration job runs it).
// The median time of each read is reported at the end and not asserted. What this does not hold: the 100 ms. A regression that costs CPU and reads no more blocks
// passes. And a bound above the 1 659 pages of the table cannot tell a scan of the table from the plan it holds. These reads are over it: the pages of the pinned filter by title, most used and last opened, of the with-a-slug filter by most used and last opened,
// and of the forwarding filter in every sort. For those reads the bound holds the plan's own cost, and only the unfiltered pages above and the page of one canonical URL are also checked for a scan and the index they read.
// A page after a cursor of a sort by title is the function's walk of the index for the page, whatever the depth.
const DEEP_TITLE_BLOCKS = 80;
// The calls of one connection at depths from 100 to 44 990 in both directions touch 57 to 63 blocks after the first of each direction.
const MIXED_TITLE_BLOCKS = 90;
const BLOCKS_OF_SORT: Readonly<Record<BookmarkSort, { first: number; deep: number }>> = {
  recent: { first: 30, deep: 30 },
  oldest: { first: 30, deep: 30 },
  title_asc: { first: 80, deep: DEEP_TITLE_BLOCKS },
  title_desc: { first: 80, deep: DEEP_TITLE_BLOCKS },
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
    if (where === "deep" && (sort === "title_asc" || sort === "title_desc")) {
      // The function reads the index (its own statement is not in this plan, see the deep page by title below); what is left to sort is the page it answered.
      expect(nodes.map((node) => node["Function Name"]).filter((name) => name !== undefined)).toEqual(["sys_bookmark_title_page"]);
      expect(nodes.map((node) => node["Index Name"]).filter((name) => name !== undefined)).toEqual([]);
      return;
    }
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
    "of one canonical URL": { recent: 30, oldest: 30, title_asc: 30, title_desc: 30, most_used: 30, recently_opened: 30 },
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

  it.each(BOOKMARK_SORTS)("plans a page of one canonical URL, sorted by %s, from the index of the URL: an index condition, no sequential scan", async (sort) => {
    const request: BookmarkListRequest = { filter: { ownerId: accountId, urlCanonical: "https://example.com/12345" }, sort, after: undefined, limit: PAGE + 1 };
    const statement = await inTenant((tx) => Promise.resolve(listQuery(tx, request).toSQL()));

    const nodes = await planOf(statement);

    expect(nodes.map((node) => node["Node Type"])).not.toContain("Seq Scan");
    const reads = nodes.filter((node) => node["Index Name"] !== undefined);
    expect(reads.map((node) => node["Index Name"])).toEqual(["bookmarks_owner_url_idx"]);
    expect(reads[0]?.["Index Cond"]).toContain("url_canonical = ");
    expect(reads[0]?.Filter).toBeUndefined();
    const rows = await inTenant((tx) => bookmarkRepository(tx).list(request));
    expect(rows.map((row) => row.bookmark.url)).toEqual(["https://example.com/12345"]);
  });

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

// The deep page by title, as a filter, reads 40 000 entries of `bookmarks_owner_title_idx` and drops them, 40 500 blocks, against about 50 when the keyset condition is an index condition. The index can serve it: as a role that
// bypasses the policy the condition is one, and the page touches 52 blocks. As `slugbase_app` it cannot, because the policy of `bookmarks` is `FORCE`d and a condition of the query is an index condition only if everything in it is leakproof
// (doc 05 section 4), and `lower()` is not: the comparison of the sort key (`lower(title)`, which the index is on) is a filter over what the index returns for the owner. `lower()` cannot be marked leakproof without a superuser;
// a generated column of the lower-cased title rewrites the table under an `ACCESS EXCLUSIVE` lock, which the migration check refuses once a release tag holds `bookmarks` (`v0.1.0` does not); a plain nullable column of it would
// serve the page but needs the writes that fill it, column grants in `src/sql/`, a backfill job and a later release. So the page after a cursor of a sort by title, of the owner's own bookmarks with no other filter, is read by the
// system operation `sys_bookmark_title_page` (src/sql/720-bookmark-title-page.sql), which runs as `slugbase_system` and applies the workspace and the owner itself. The first describe below holds the cause; the others hold the page the function
// reads and the boundary it keeps.
describe("the deep page by title on a workspace of 50 000 bookmarks", () => {
  /** The statement the list ran before the function: the keyset condition on `lower(title)` as a condition of the table, for the owner of the fixture. */
  function keysetStatement(sort: "title_asc" | "title_desc", after: NonNullable<BookmarkListRequest["after"]>): { sql: string; params: unknown[] } {
    const [op, dir] = sort === "title_asc" ? ([">", "ASC"] as const) : (["<", "DESC"] as const);
    return {
      sql: `SELECT id FROM bookmarks WHERE workspace_id = $1::uuid AND owner_id = $2::uuid AND plan_archived_at IS NULL AND (lower(title), id) ${op} ($3::text, $4::uuid) ORDER BY lower(title) ${dir}, id ${dir} LIMIT ${String(PAGE + 1)}`,
      params: [workspaceId, accountId, after.key, after.id],
    };
  }

  /** The nodes of the plan of a statement as `slugbase_system` with the tenant settings of `withTenant`: the role the policy of `bookmarks` does not bind. */
  async function systemPlanOf(statement: { sql: string; params: unknown[] }): Promise<PlanNode[]> {
    const plan = await db.owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`SELECT set_config('app.account_id', ${accountId}, true), set_config('app.workspace_id', ${workspaceId}, true)`;
      const rows = await tx.unsafe<{ "QUERY PLAN": { Plan: PlanNode }[] }[]>(`EXPLAIN (FORMAT JSON) ${statement.sql}`, statement.params as never[]);
      return rows[0]?.["QUERY PLAN"][0]?.Plan;
    });
    if (plan === undefined) {
      throw new Error("EXPLAIN returned no plan");
    }
    return nodesOf(plan);
  }

  it("is not an index condition for slugbase_app because lower() is not leakproof, and is one for a role the policy does not bind", async () => {
    const [{ leakproof } = { leakproof: undefined }] = await db.owner<{ leakproof: boolean }[]>`SELECT proleakproof AS leakproof FROM pg_proc WHERE oid = 'lower(text)'::regprocedure`;
    expect(leakproof).toBe(false);

    for (const sort of ["title_asc", "title_desc"] as const) {
      const statement = keysetStatement(sort, await deepPosition(sort));
      const bound = await planOf(statement);
      const unbound = await systemPlanOf(statement);

      const boundRead = bound.find((node) => node["Index Name"] === "bookmarks_owner_title_idx");
      const unboundRead = unbound.find((node) => node["Index Name"] === "bookmarks_owner_title_idx");
      expect(boundRead?.["Index Cond"], sort).not.toContain("lower(title)");
      expect(boundRead?.Filter, sort).toContain("lower(title)");
      expect(unboundRead?.["Index Cond"], sort).toContain("lower(title)");
      expect(await blocksOfStatement(db, { accountId, workspaceId }, statement, 1_000_000), sort).toBeGreaterThan(30_000);
    }
  }, HOOK_TIMEOUT_MS);

  it("is read from the function by the repository's statement, for the owner's own bookmarks with no filter but the owner, and by the statement of the table for any other page", async () => {
    const after = await deepPosition("title_asc");
    const calls = async (filter: BookmarkListFilter, sort: BookmarkSort = "title_asc", cursor: BookmarkListRequest["after"] | null = after) => {
      const statement = await inTenant((tx) => Promise.resolve(listQuery(tx, { filter, sort, after: cursor ?? undefined, limit: PAGE + 1 }).toSQL()));
      return (await planOf(statement)).map((node) => node["Function Name"]).filter((name) => name !== undefined);
    };

    expect(await calls({ ownerId: accountId })).toEqual(["sys_bookmark_title_page"]);
    expect(await calls({ ownerId: accountId }, "title_desc", await deepPosition("title_desc"))).toEqual(["sys_bookmark_title_page"]);
    expect(await calls({ ownerId: accountId }, "recent", { key: "2026-01-01 00:00:00+00", id: after.id })).toEqual([]);
    expect(await calls({ ownerId: accountId }, "title_asc", null)).toEqual([]);
    for (const filter of [{ pinned: true }, { hasSlug: true }, { forwarding: false }, { urlCanonical: "https://example.com/12345" }]) {
      expect(await calls({ ownerId: accountId, ...filter }), JSON.stringify(filter)).toEqual([]);
    }
  });

  it("registers the function as a system operation of slugbase_system with the scans that serve the page pinned", async () => {
    const [row] = await db.owner<{ config: string[] | null; owner: string; definer: boolean }[]>`
      SELECT p.proconfig AS config, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer FROM pg_proc p WHERE p.oid = 'public.sys_bookmark_title_page(boolean, text, uuid, integer)'::regprocedure`;

    expect(row?.owner).toBe("slugbase_system");
    expect(row?.definer).toBe(true);
    expect(row?.config).toEqual(expect.arrayContaining(["enable_seqscan=off", "enable_bitmapscan=off", "enable_sort=off"]));
  });

  it("reads every call of one connection within the work of its plan, whichever side of the library and whichever direction the cursor is on", async () => {
    const positions = [100, 25_000, 40_000, 44_000, 5_000, 30_000, 20_000, 44_990];
    const at = async (sort: "title_asc" | "title_desc", offset: number) => {
      const [row] = await asSystem(
        db,
        (tx) => tx<{ key: string; id: string }[]>`
          SELECT lower(title) AS key, id FROM bookmarks WHERE workspace_id = ${workspaceId} AND owner_id = ${accountId} AND plan_archived_at IS NULL
          ORDER BY lower(title) ${sort === "title_asc" ? tx`ASC` : tx`DESC`}, id ${sort === "title_asc" ? tx`ASC` : tx`DESC`} OFFSET ${offset} LIMIT 1`,
      );
      if (row === undefined) {
        throw new Error("the library is smaller than the position");
      }
      return row;
    };
    const statements: { sql: string; params: unknown[] }[] = [];
    for (const sort of ["title_asc", "title_desc"] as const) {
      for (const offset of positions) {
        const { key, id } = await at(sort, offset);
        statements.push(await inTenant((tx) => Promise.resolve(listQuery(tx, { filter: { ownerId: accountId }, sort, after: { key, id }, limit: PAGE + 1 }).toSQL())));
      }
    }

    const blocks = await db.app.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${accountId}, true), set_config('app.workspace_id', ${workspaceId}, true), set_config('statement_timeout', ${String(STATEMENT_TIMEOUT_MS)}, true)`;
      // A call right after DDL committed elsewhere on the cluster touches hundreds of blocks more (see `blocksOfStatement`): a call that is over the bound is repeated, up to three times, and the least counts. A plan that
      // has regressed is over the bound in every one of them.
      const blocksOf = async (statement: { sql: string; params: unknown[] }): Promise<number> => {
        let least = Number.POSITIVE_INFINITY;
        for (let attempt = 0; attempt < 3 && least >= MIXED_TITLE_BLOCKS; attempt += 1) {
          const rows = await tx.unsafe<{ "QUERY PLAN": { Plan: { "Shared Hit Blocks"?: number; "Shared Read Blocks"?: number } }[] }[]>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.sql}`, statement.params as never[]);
          const plan = rows[0]?.["QUERY PLAN"][0]?.Plan;
          least = Math.min(least, (plan?.["Shared Hit Blocks"] ?? Number.NaN) + (plan?.["Shared Read Blocks"] ?? Number.NaN));
        }
        return least;
      };
      // A backend loads its catalogs on its first call and plans the statement of each direction on the first call of that direction, which touches tens of blocks more than the calls after: one call of each is not counted.
      for (const statement of [statements[0], statements[positions.length]]) {
        await blocksOf(statement ?? { sql: "", params: [] });
      }
      const counted: number[] = [];
      // Three rounds over sixteen statements: each direction's statement is called twenty-four times more on this connection, so the plan of its sixth call and of every later one is the one the first five did not make.
      for (let round = 0; round < 3; round += 1) {
        for (const statement of statements) {
          counted.push(await blocksOf(statement));
        }
      }
      return counted;
    });

    process.stdout.write(`title page work in one connection (buffers of each call, in order): ${JSON.stringify(blocks)}\n`);
    expect(blocks).toHaveLength(48);
    expect(Math.max(...blocks)).toBeLessThan(MIXED_TITLE_BLOCKS);
  }, HOOK_TIMEOUT_MS);
});

// The list of the scope `all`, which is what GET /bookmarks reads with no scope, is a union of two legs (`pageStatement`): the account's own bookmarks, read from the index of the sort, and the bookmarks shared with the account,
// driven from the grants. The keyset condition on `lower(title)` of the own leg is a filter for slugbase_app for the cause above, so a deep page of it read every own entry before the cursor (40 528 blocks at depth 40 000, against
// 13 for the same page by `recent`). The own leg of a page after a cursor of a sort by title is read from the function as well; the shared leg is the statement it was, and reads the grants (30 here) and probes the
// bookmarks they name.
describe("the deep page by title of the scope all on a workspace of 50 000 bookmarks", () => {
  const dialect = new PgDialect({ casing: "snake_case" });
  // The page touched 155 blocks in 3 runs on PostgreSQL 18 (it could not be run on 17 here, where CI's integration job runs it): about 60 for the own leg through the function and about 95 for the shared leg, whose
  // 30 grants are probed by primary key. The bound is 5 % and 16 blocks over that, rounded up to ten and with the margin of the other bounds of this file; the page before the function read the own leg as a filter over every
  // entry before the cursor and touched about 40 500 blocks more.
  const DEEP_ALL_TITLE_BLOCKS = 200;

  async function statementOf(filter: Omit<BookmarkListFilter, "ownerId">, sort: BookmarkSort, after: BookmarkListRequest["after"]): Promise<{ sql: string; params: unknown[] }> {
    const statement = await inTenant((tx) => Promise.resolve(pageStatement(tx, { filter: { ownerId: accountId, ...filter }, sort, after, limit: PAGE + 1 })));
    if (statement === undefined) {
      throw new Error("the scope reads no part");
    }
    const { sql, params } = dialect.sqlToQuery(statement);
    return { sql, params };
  }

  it.each(["title_asc", "title_desc"] as const)("reads the own leg of the page sorted by %s from the function and the shared leg from the grants, with no sequential scan of bookmarks", async (sort) => {
    const statement = await statementOf({ scope: "all" }, sort, await deepPosition(sort));

    const nodes = await planOf(statement);

    expect(nodes.map((node) => node["Function Name"]).filter((name) => name !== undefined)).toEqual(["sys_bookmark_title_page"]);
    expect(nodes.filter((node) => node["Node Type"] === "Seq Scan").map((node) => node["Index Name"])).toEqual([]);
    // The own leg's walk of the index is inside the function; the plan of the statement reads the index of the title only through the function, so none of its nodes is on it.
    expect(nodes.map((node) => node["Index Name"])).not.toContain("bookmarks_owner_title_idx");
  });

  it.each(["title_asc", "title_desc"] as const)("reads the page sorted by %s within the work of its plan, as the same page by recent is read and not as a filter over every entry before the cursor", async (sort) => {
    const statement = await statementOf({ scope: "all" }, sort, await deepPosition(sort));

    const blocks = await blocksOfStatement(db, { accountId, workspaceId }, statement, DEEP_ALL_TITLE_BLOCKS);
    const rows = await inTenant((tx) => bookmarkRepository(tx).list({ filter: { ownerId: accountId, scope: "all" }, sort, after: undefined, limit: 1 }));
    measured.set(`all ${sort} a page deep in the library`, String(blocks));

    expect(rows).toHaveLength(1);
    expect(blocks, `all, ${sort}`).toBeLessThan(DEEP_ALL_TITLE_BLOCKS);
  }, HOOK_TIMEOUT_MS);

  it("pages the same bookmarks as the table itself, whatever the sort and the depth, with the bookmarks shared with the account among them", async () => {
    const readable = (tx: Parameters<Parameters<typeof asSystem>[1]>[0]) =>
      tx`workspace_id = ${workspaceId} AND plan_archived_at IS NULL AND (owner_id = ${accountId} OR id IN (SELECT bookmark_id FROM bookmark_shares WHERE target_account_id = ${accountId}))`;
    for (const sort of ["title_asc", "title_desc"] as const) {
      const [op, dir] = sort === "title_asc" ? ([">", "ASC"] as const) : (["<", "DESC"] as const);
      // The places: three offsets into the readable library, and the place right before a bookmark shared with the account, so that the first row of that page is a shared one.
      const places = await asSystem(db, async (tx) => {
        const at = await Promise.all(
          [100, 25_000, 44_000].map(async (offset) => {
            const [row] = await tx<{ key: string; id: string }[]>`SELECT lower(title) AS key, id FROM bookmarks WHERE ${readable(tx)} ORDER BY lower(title) ${tx.unsafe(dir)}, id ${tx.unsafe(dir)} OFFSET ${offset} LIMIT 1`;
            return { key: row?.key ?? "", id: row?.id ?? "", sharedFirst: undefined as string | undefined };
          }),
        );
        const [beforeShared] = await tx<{ key: string; id: string; shared: string }[]>`
          SELECT t.prev_key AS key, t.prev_id AS id, t.id AS shared FROM (
            SELECT id, lag(lower(title)) OVER w AS prev_key, lag(id) OVER w AS prev_id FROM bookmarks WHERE ${readable(tx)}
            WINDOW w AS (ORDER BY lower(title) ${tx.unsafe(dir)}, id ${tx.unsafe(dir)})
          ) t WHERE t.prev_id IS NOT NULL AND t.id IN (SELECT bookmark_id FROM bookmark_shares WHERE target_account_id = ${accountId})
          ORDER BY t.prev_key ${tx.unsafe(dir)}, t.id ${tx.unsafe(dir)} OFFSET ${SHARED_WITH_ACCOUNT / 2} LIMIT 1`;
        return [...at, { key: beforeShared?.key ?? "", id: beforeShared?.id ?? "", sharedFirst: beforeShared?.shared }];
      });
      for (const place of places) {
        const expected = await asSystem(
          db,
          (tx) => tx<{ id: string; key: string }[]>`
            SELECT id, lower(title) AS key FROM bookmarks WHERE ${readable(tx)} AND (lower(title), id) ${tx.unsafe(op)} (${place.key}::text, ${place.id}::uuid)
            ORDER BY lower(title) ${tx.unsafe(dir)}, id ${tx.unsafe(dir)} LIMIT ${PAGE + 1}`,
        );

        const page = await inTenant((tx) => bookmarkRepository(tx).list({ filter: { ownerId: accountId, scope: "all" }, sort, after: { key: place.key, id: place.id }, limit: PAGE + 1 }));

        expect(page.map((row) => row.bookmark.id), `${sort} after ${place.id}`).toEqual(expected.map((row) => row.id));
        expect(page.map((row) => row.key)).toEqual(expected.map((row) => row.key));
        expect(page).toHaveLength(PAGE + 1);
        if (place.sharedFirst !== undefined) {
          expect(page[0]?.bookmark.id).toBe(place.sharedFirst);
        }
      }
    }
  }, HOOK_TIMEOUT_MS);
});
