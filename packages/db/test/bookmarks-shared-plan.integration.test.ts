import { BOOKMARK_SORTS, type BookmarkListFilter, type BookmarkListRequest, type BookmarkPosition, type BookmarkScope, type BookmarkSort } from "@slugbase/core";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookmarkRepository } from "../src/index.ts";
import { countStatement, pageStatement } from "../src/repositories/bookmarks.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { vacuumUntilAllVisible } from "./support/vacuum-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The plan of the lists that read the bookmarks shared with a member (doc 05 sections 2.5 and 4, doc 02 section 5.7, doc 08 section 5.3) on a workspace of 50 000 bookmarks beside many small
// workspaces whose bookmarks and shares fill the share tables, so that no workspace dominates them: the pages and the counts of the scopes `all`, `shared_with_me` and `shared_by_me` scan no
// table sequentially, and the bookmarks shared with the member are read from the set of the grants to the member by primary key. The answers are the bookmarks the grants give, each once, in the
// order of the sort. The failure scenario: a list that tests every bookmark of the workspace against the shares (an `OR` over an `EXISTS`) reads the whole library for a member who is shared
// a few hundred, which this test sees as a sequential scan, or as a page that is not the oracle's.

const HOOK_TIMEOUT_MS = 300_000;
const BOOKMARKS = 50_000;
const NOISE_WORKSPACES = 500;
const PAGE = 100;
const SCOPES = ["all", "shared_with_me", "shared_by_me"] as const satisfies readonly BookmarkScope[];
const PLANNED_TABLES = ["bookmarks", "bookmark_shares", "folder_shares", "folder_bookmarks", "team_members"];

// The members of the large workspace: the viewer, who owns bookmarks 1 to 2 000, the owner of the rest, and one more member the viewer shares with. Bookmark n has the identifier `bid(n)`.
//   shared with the viewer directly: 2 001 to 2 400 · with a team the viewer is in: 2 301 to 2 600 · through a folder shared with the viewer: 3 001 to 3 150 · through a folder shared with the team: 3 101 to 3 250
//   shared by the viewer: 1 to 100 directly and 201 to 250 through a folder of the viewer's, with the other member.
const SHARED_WITH_VIEWER = [...range(2001, 2600), ...range(3001, 3250)];
const OWN = range(1, 2000);
const SHARED_BY_VIEWER = [...range(1, 100), ...range(201, 250)];

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

const bid = (n: number): string => `0192f3a0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

let db: TestDatabase;
let viewerId: string;
let ownerId: string;
let otherId: string;
let workspaceId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  [viewerId, ownerId, otherId] = [freshId(), freshId(), freshId()];
  for (const [id, name] of [[viewerId, "viewer"], [ownerId, "owner"], [otherId, "other"]] as const) {
    await seedAccount(db, { id, email: `shared-plan-${name}@example.test`, passwordHash: "$argon2id$stub" });
  }
  workspaceId = await seedWorkspace(db, { name: "Shared plan test" });
  await seedMember(db, { workspaceId, accountId: ownerId, role: "owner" });
  await seedMember(db, { workspaceId, accountId: viewerId });
  await seedMember(db, { workspaceId, accountId: otherId });
  const id = (n: string) => `('0192f3a0-0000-7000-8000-' || lpad(to_hex(${n}), 12, '0'))::uuid`;
  await asSystem(db, (tx) => tx.unsafe(`
    INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, slug, forwarding, pinned_at, open_count, last_opened_at, created_at)
    SELECT ${id("n")}, '${workspaceId}'::uuid, CASE WHEN n <= 2000 THEN '${viewerId}'::uuid ELSE '${ownerId}'::uuid END,
           'https://example.com/' || n, 'https://example.com/' || n, 'example.com', 'Title ' || (n % 997),
           CASE WHEN n % 5 = 0 THEN 'slug-' || n END, n % 20 = 0, CASE WHEN n % 25 = 0 THEN now() END, n % 50,
           CASE WHEN n % 2 = 0 THEN timestamptz '2026-02-01' + (n % 3000) * interval '1 minute' END,
           timestamptz '2026-01-01' + (n / 3) * interval '1 second'
    FROM generate_series(1, ${String(BOOKMARKS)}) AS n`));
  const team = freshId();
  const ownersFolder = freshId();
  const teamsFolder = freshId();
  const viewersFolder = freshId();
  await asSystem(db, async (tx) => {
    await tx`INSERT INTO teams (id, workspace_id, name) VALUES (${team}, ${workspaceId}, 'Readers')`;
    await tx`INSERT INTO team_members (workspace_id, team_id, account_id) VALUES (${workspaceId}, ${team}, ${viewerId})`;
    await tx`INSERT INTO folders (id, workspace_id, owner_id, name) VALUES (${ownersFolder}, ${workspaceId}, ${ownerId}, 'Owner folder 1'), (${teamsFolder}, ${workspaceId}, ${ownerId}, 'Owner folder 2'), (${viewersFolder}, ${workspaceId}, ${viewerId}, 'Viewer folder')`;
    await tx.unsafe(`
      INSERT INTO folder_bookmarks (workspace_id, folder_id, bookmark_id)
      SELECT '${workspaceId}'::uuid, '${ownersFolder}'::uuid, ${id("n")} FROM generate_series(3001, 3150) AS n
      UNION ALL SELECT '${workspaceId}'::uuid, '${teamsFolder}'::uuid, ${id("n")} FROM generate_series(3101, 3250) AS n
      UNION ALL SELECT '${workspaceId}'::uuid, '${viewersFolder}'::uuid, ${id("n")} FROM generate_series(201, 250) AS n`);
    await tx`INSERT INTO folder_shares (id, workspace_id, folder_id, target_account_id, granted_by) VALUES (${freshId()}, ${workspaceId}, ${ownersFolder}, ${viewerId}, ${ownerId}), (${freshId()}, ${workspaceId}, ${viewersFolder}, ${otherId}, ${viewerId})`;
    await tx`INSERT INTO folder_shares (id, workspace_id, folder_id, target_team_id, granted_by) VALUES (${freshId()}, ${workspaceId}, ${teamsFolder}, ${team}, ${ownerId})`;
    await tx.unsafe(`
      INSERT INTO bookmark_shares (id, workspace_id, bookmark_id, target_account_id, granted_by)
      SELECT gen_random_uuid(), '${workspaceId}'::uuid, ${id("n")}, '${viewerId}'::uuid, '${ownerId}'::uuid FROM generate_series(2001, 2400) AS n
      UNION ALL SELECT gen_random_uuid(), '${workspaceId}'::uuid, ${id("n")}, '${otherId}'::uuid, '${viewerId}'::uuid FROM generate_series(1, 100) AS n`);
    await tx.unsafe(`
      INSERT INTO bookmark_shares (id, workspace_id, bookmark_id, target_team_id, granted_by)
      SELECT gen_random_uuid(), '${workspaceId}'::uuid, ${id("n")}, '${team}'::uuid, '${ownerId}'::uuid FROM generate_series(2301, 2600) AS n`);
  });
  // Many small workspaces with their own members, bookmarks, a folder and shares, so no workspace dominates the share tables.
  const noiseOwner = freshId();
  const noiseTarget = freshId();
  await seedAccount(db, { id: noiseOwner, email: "shared-plan-noise-owner@example.test", passwordHash: "$argon2id$stub" });
  await seedAccount(db, { id: noiseTarget, email: "shared-plan-noise-target@example.test", passwordHash: "$argon2id$stub" });
  const small = (n: string) => `('00000000-0000-7000-8000-' || lpad(${n}::text, 12, '0'))::uuid`;
  await asSystem(db, async (tx) => {
    await tx.unsafe(`INSERT INTO workspaces (id, name) SELECT ${small("n")}, 'Small ' || n FROM generate_series(1, ${String(NOISE_WORKSPACES)}) AS n`);
    await tx.unsafe(`INSERT INTO workspace_members (workspace_id, account_id, role) SELECT ${small("n")}, '${noiseOwner}'::uuid, 'owner' FROM generate_series(1, ${String(NOISE_WORKSPACES)}) AS n`);
    await tx.unsafe(`INSERT INTO workspace_members (workspace_id, account_id, role) SELECT ${small("n")}, '${noiseTarget}'::uuid, 'member' FROM generate_series(1, ${String(NOISE_WORKSPACES)}) AS n`);
    await tx.unsafe(`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title)
      SELECT ('00000001-0000-7000-8000-' || lpad(n::text, 8, '0') || lpad(k::text, 4, '0'))::uuid, ${small("n")}, '${noiseOwner}'::uuid, 'https://example.com/s', 'https://example.com/s', 'example.com', 'Small ' || n
      FROM generate_series(1, ${String(NOISE_WORKSPACES)}) AS n, generate_series(1, 20) AS k`);
    await tx.unsafe(`
      INSERT INTO bookmark_shares (id, workspace_id, bookmark_id, target_account_id, granted_by)
      SELECT gen_random_uuid(), ${small("n")}, ('00000001-0000-7000-8000-' || lpad(n::text, 8, '0') || lpad(k::text, 4, '0'))::uuid, '${noiseTarget}'::uuid, '${noiseOwner}'::uuid
      FROM generate_series(1, ${String(NOISE_WORKSPACES)}) AS n, generate_series(1, 10) AS k`);
    await tx.unsafe(`INSERT INTO folders (id, workspace_id, owner_id, name) SELECT ('00000002-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid, ${small("n")}, '${noiseOwner}'::uuid, 'Small folder' FROM generate_series(1, ${String(NOISE_WORKSPACES)}) AS n`);
    await tx.unsafe(`
      INSERT INTO folder_bookmarks (workspace_id, folder_id, bookmark_id)
      SELECT ${small("n")}, ('00000002-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid, ('00000001-0000-7000-8000-' || lpad(n::text, 8, '0') || lpad(k::text, 4, '0'))::uuid
      FROM generate_series(1, ${String(NOISE_WORKSPACES)}) AS n, generate_series(11, 15) AS k`);
    await tx.unsafe(`INSERT INTO teams (id, workspace_id, name) SELECT ('00000003-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid, ${small("n")}, 'Small team' FROM generate_series(1, ${String(NOISE_WORKSPACES)}) AS n`);
    await tx.unsafe(`
      INSERT INTO team_members (workspace_id, team_id, account_id)
      SELECT ${small("n")}, ('00000003-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid, account FROM generate_series(1, ${String(NOISE_WORKSPACES)}) AS n, (VALUES ('${noiseOwner}'::uuid), ('${noiseTarget}'::uuid)) AS members(account)`);
    await tx.unsafe(`INSERT INTO folder_shares (id, workspace_id, folder_id, target_account_id, granted_by) SELECT gen_random_uuid(), ${small("n")}, ('00000002-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid, '${noiseTarget}'::uuid, '${noiseOwner}'::uuid FROM generate_series(1, ${String(NOISE_WORKSPACES)}) AS n`);
  });
  await vacuumUntilAllVisible(db, PLANNED_TABLES);
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

const dialect = new PgDialect({ casing: "snake_case" });

function planned(statement: Parameters<PgDialect["sqlToQuery"]>[0]): { sql: string; params: unknown[] } {
  const { sql, params } = dialect.sqlToQuery(statement);
  return { sql, params };
}

/** The nodes of the plan of a statement, as the database plans it for a transaction of `slugbase_app` with the settings of `withTenant`. */
async function planOf(statement: { sql: string; params: unknown[] }): Promise<PlanNode[]> {
  const plan = await db.app.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${viewerId}, true), set_config('app.workspace_id', ${workspaceId}, true)`;
    const rows = await tx.unsafe<{ "QUERY PLAN": { Plan: PlanNode }[] }[]>(`EXPLAIN (FORMAT JSON) ${statement.sql}`, statement.params as never[]);
    return rows[0]?.["QUERY PLAN"][0]?.Plan;
  });
  if (plan === undefined) {
    throw new Error("EXPLAIN returned no plan");
  }
  return nodesOf(plan);
}

function inTenant<T>(work: Parameters<typeof db.tenant.withTenant<T>>[1]): Promise<T> {
  return db.tenant.withTenant({ accountId: viewerId, workspaceId, requestId: "shared-plan-test" }, work);
}

const filterOf = (scope: BookmarkScope): BookmarkListFilter => ({ ownerId: viewerId, scope });

const idsOf = (numbers: readonly number[]): Set<string> => new Set(numbers.map(bid));

async function readAll(scope: BookmarkScope, sort: BookmarkSort, limit = PAGE): Promise<string[]> {
  const found: string[] = [];
  let after: BookmarkPosition | undefined;
  for (;;) {
    const rows = await inTenant((tx) => bookmarkRepository(tx).list({ filter: filterOf(scope), sort, after, limit }));
    found.push(...rows.map((row) => row.bookmark.id));
    const last = rows.at(-1);
    if (rows.length < limit || last === undefined) {
      return found;
    }
    after = { key: last.key, id: last.bookmark.id };
  }
}

describe.each(SCOPES)("the plan of the list of the scope %s on a workspace of 50 000 bookmarks", (scope) => {
  describe.each(BOOKMARK_SORTS)("sorted by %s", (sort) => {
    it("scans none of the tables it reads sequentially, for the first page and a page after a place in the order, and for the count", async () => {
      const first = await inTenant((tx) => bookmarkRepository(tx).list({ filter: filterOf(scope), sort, after: undefined, limit: 200 }));
      const last = first.at(-1);
      const after = last === undefined ? undefined : { key: last.key, id: last.bookmark.id };
      const request = (position: BookmarkPosition | undefined): BookmarkListRequest => ({ filter: filterOf(scope), sort, after: position, limit: PAGE + 1 });
      const statements = await inTenant((tx) => Promise.resolve([pageStatement(tx, request(undefined)), pageStatement(tx, request(after)), countStatement(tx, filterOf(scope), 10_001)]));

      for (const statement of statements) {
        expect(statement).toBeDefined();
        const nodes = await planOf(planned(statement ?? sql`SELECT 1`));
        const scanned = nodes.filter((node) => node["Node Type"] === "Seq Scan").map((node) => node["Relation Name"]);
        expect(scanned.filter((name) => name !== undefined && PLANNED_TABLES.includes(name))).toEqual([]);
      }
    });
  });
});

describe("the bookmarks shared with the member", () => {
  it("are read from the set of the grants, each probed by the primary key of bookmarks, and the walk of no sort index", async () => {
    const request: BookmarkListRequest = { filter: filterOf("shared_with_me"), sort: "recent", after: undefined, limit: PAGE + 1 };
    const statement = await inTenant((tx) => Promise.resolve(pageStatement(tx, request)));

    const nodes = await planOf(planned(statement ?? sql`SELECT 1`));

    const reads = nodes.filter((node) => node["Relation Name"] === "bookmarks" || node["Index Name"]?.startsWith("bookmarks_") === true);
    expect(reads.map((node) => node["Index Name"])).toEqual(["bookmarks_pkey"]);
    expect(reads[0]?.["Index Cond"]).toContain("id = shared.bookmark_id");
    expect(nodes.map((node) => node["Index Name"]).filter((name) => name !== undefined)).toEqual(expect.arrayContaining(["bookmark_shares_account_idx", "bookmark_shares_team_idx", "folder_shares_account_idx", "folder_shares_team_idx"]));
  });
});

describe("the answers of the lists", () => {
  it.each([
    ["shared_with_me", SHARED_WITH_VIEWER],
    ["shared_by_me", SHARED_BY_VIEWER],
    ["all", [...OWN, ...SHARED_WITH_VIEWER]],
  ] as const)("are, for %s, exactly the bookmarks the grants give, each once, and the count says how many", async (scope, wanted) => {
    const found = await readAll(scope, "recent");
    const total = await inTenant((tx) => bookmarkRepository(tx).count(filterOf(scope), 10_000));
    const selected = await inTenant((tx) => bookmarkRepository(tx).ids(filterOf(scope), 5_001));

    expect(found).toHaveLength(wanted.length);
    expect(new Set(found)).toEqual(idsOf(wanted));
    expect(total).toBe(wanted.length);
    expect(new Set(selected)).toEqual(idsOf(wanted));
  });

  it.each(BOOKMARK_SORTS)("are in the order of the sort %s, whichever scope and page size reads them", async (sort) => {
    const oracle = async (scope: BookmarkScope): Promise<string[]> => {
      const rows = await asSystem(db, (tx) => tx.unsafe<{ id: string }[]>(`SELECT id FROM bookmarks WHERE workspace_id = '${workspaceId}'::uuid AND id = ANY ($1::uuid[]) ORDER BY ${ORDER[sort]}`, [`{${[...idsOf(scope === "all" ? [...OWN, ...SHARED_WITH_VIEWER] : SHARED_WITH_VIEWER)].join(",")}}`] as never[]));
      return rows.map((row) => row.id);
    };

    expect(await readAll("shared_with_me", sort, 97)).toEqual(await oracle("shared_with_me"));
    expect(await readAll("all", sort, 333)).toEqual(await oracle("all"));
  });
});

/** The ordering of each sort, as the oracle states it with the identifier as the tiebreak. */
const ORDER: Readonly<Record<BookmarkSort, string>> = {
  recent: "created_at DESC NULLS LAST, id DESC NULLS LAST",
  oldest: "created_at ASC NULLS FIRST, id ASC NULLS FIRST",
  title_asc: "lower(title) ASC NULLS LAST, id ASC NULLS LAST",
  title_desc: "lower(title) DESC NULLS FIRST, id DESC NULLS FIRST",
  most_used: "open_count DESC NULLS LAST, id DESC NULLS LAST",
  recently_opened: "last_opened_at DESC NULLS LAST, id DESC NULLS LAST",
};
