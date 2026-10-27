import { BOOKMARK_SORTS, type BookmarkListRequest, type BookmarkPosition, type BookmarkSort } from "@slugbase/core";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookmarkRepository } from "../src/index.ts";
import { matchedCountStatement, matchedPageStatement } from "../src/repositories/bookmarks.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The plan and the time of the list with a text on a workspace of 50 000 bookmarks, beside many small workspaces and another member's bookmarks in the same workspace (doc 08 section 5.3, doc 05
// section 2.4): the matches are read by one call of `sys_bookmark_match`, each of whose branches reads its own index with the search condition as the index condition, and the page is read by the plan that
// is cheap for the number of matches it finds, the probes of the primary key when they are few and the walk of the sort index when they are many, with no sequential scan of bookmarks. The failure
// scenario: the policy of `bookmarks` is FORCEd and none of `@@`, `<%` or `LIKE` is leakproof, so the same conditions in a statement of slugbase_app would use the indexes for the workspace alone and filter
// every bookmark of it, and a page that is read the same way whatever the number of matches walks the whole workspace for a text few bookmarks hold or probes every bookmark of it for a text most of them
// hold. The answers are compared with the table's own order, and the median of five runs of a page and its count is held under the 100 ms of doc 08 section 5.3, through the repository as slugbase_app.

const HOOK_TIMEOUT_MS = 300_000;
const BOOKMARKS = 50_000;
const SMALL_WORKSPACES = 1_000;
const BUDGET_MS = 100;
const RUNS = 5;
const PAGE = 49;

let db: TestDatabase;
let accountId: string;
let otherId: string;
let workspaceId: string;

// A title of three to five words from a vocabulary of eighty or so, hosts from about 400 sites and one site (github.com) that a tenth of the bookmarks share, a slug on a fifth of them and a description
// on half: the shape of a real library, in which a common word matches thousands of bookmarks. A tenth belong to the other member and one in a hundred is plan-archived.
async function seedLibrary(): Promise<void> {
  await asSystem(
    db,
    (tx) => tx`
      WITH words AS (
        SELECT array[
          'docs','guide','api','reference','tutorial','cheatsheet','release','notes','dashboard','settings','pricing','blog','news','review','design','system','kubernetes','postgres','typescript','react',
          'rust','golang','python','linux','network','security','database','cloud','server','client','mobile','desktop','browser','editor','terminal','shell','deploy','build','test','debug',
          'monitor','metrics','logs','alert','backup','restore','migrate','schema','index','query','cache','queue','worker','stream','event','search','vector','model','prompt','agent',
          'recipe','travel','budget','invoice','report','meeting','calendar','mail','photo','music','video','podcast','book','paper','course','talk','forum','shop','map','weather'
        ] AS w
      )
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, description, slug, forwarding, pinned_at, open_count, last_opened_at, created_at, plan_archived_at)
      SELECT gen_random_uuid(), ${workspaceId}, CASE WHEN n % 10 = 0 THEN ${otherId}::uuid ELSE ${accountId}::uuid END,
             'https://' || h.host || '/p/' || n, 'https://' || h.host || '/p/' || n, h.host,
             initcap(words.w[1 + n % cardinality(words.w)]) || ' ' || words.w[1 + (n / 7) % cardinality(words.w)] || ' ' || words.w[1 + (n / 11) % cardinality(words.w)] || CASE WHEN n % 3 = 0 THEN ' ' || words.w[1 + (n / 13) % cardinality(words.w)] ELSE '' END || CASE WHEN n % 4 = 0 THEN ' ' || words.w[1 + (n / 17) % cardinality(words.w)] ELSE '' END,
             CASE WHEN n % 2 = 0 THEN 'Notes on ' || words.w[1 + (n / 3) % cardinality(words.w)] || ' and ' || words.w[1 + (n / 19) % cardinality(words.w)] || ' for the team' END,
             CASE WHEN n % 5 = 0 THEN words.w[1 + (n / 5) % cardinality(words.w)] || '-' || n END, false,
             CASE WHEN n % 25 = 0 THEN now() END, n % 50,
             CASE WHEN n % 2 = 0 THEN timestamptz '2026-02-01' + (n % 3000) * interval '1 minute' + (n % 7) * interval '1 microsecond' END,
             timestamptz '2026-01-01' + (n / 3) * interval '1 second' + interval '123456 microseconds',
             CASE WHEN n % 100 = 0 THEN now() END
      FROM generate_series(1, ${BOOKMARKS}) AS n
      CROSS JOIN words
      CROSS JOIN LATERAL (SELECT CASE WHEN n % 10 = 3 THEN 'github.com' ELSE 'www.' || words.w[1 + n % cardinality(words.w)] || words.w[1 + (n / 80) % 5] || '.' || (array['com','org','io','dev','net'])[1 + n % 5] END AS host) AS h`,
  );
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, slug, forwarding)
      VALUES (${freshId()}, ${workspaceId}, ${accountId}, 'https://github.com/', 'https://github.com/', 'github.com', 'GitHub', 'gh', true),
             (${freshId()}, ${workspaceId}, ${accountId}, 'https://mail.example.com/', 'https://mail.example.com/', 'mail.example.com', 'Mail', 'mail', true)`,
  );
}

beforeAll(async () => {
  db = await createTestDatabase();
  accountId = freshId();
  otherId = freshId();
  await seedAccount(db, { id: accountId, email: "list-search-plan-owner@example.test", passwordHash: "$argon2id$stub" });
  await seedAccount(db, { id: otherId, email: "list-search-plan-other@example.test", passwordHash: "$argon2id$stub" });
  workspaceId = await seedWorkspace(db, { name: "List search plan test" });
  await seedMember(db, { workspaceId, accountId, role: "owner" });
  await seedMember(db, { workspaceId, accountId: otherId });
  await seedLibrary();
  // Many small workspaces whose bookmarks carry the same words, so no workspace dominates a table.
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO workspaces (id, name)
      SELECT ('00000000-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid, 'Small ' || n FROM generate_series(1, ${SMALL_WORKSPACES}) AS n`,
  );
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO workspace_members (workspace_id, account_id, role)
      SELECT ('00000000-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid, ${accountId}, 'owner' FROM generate_series(1, ${SMALL_WORKSPACES}) AS n`,
  );
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, slug)
      SELECT gen_random_uuid(), ('00000000-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid, ${accountId},
             'https://github.com/s' || n, 'https://github.com/s' || n, 'github.com', 'GitHub docs ' || n, 'mail-' || n
      FROM generate_series(1, ${SMALL_WORKSPACES}) AS n`,
  );
  // A running instance has had its tables vacuumed and analysed.
  await db.owner.unsafe("VACUUM (ANALYZE) bookmarks");
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await db.drop();
}, HOOK_TIMEOUT_MS);

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Index Cond"?: string;
  "Function Name"?: string;
  "Actual Loops"?: number;
  "Rows Removed by Filter"?: number;
  Filter?: string;
  Plans?: PlanNode[];
}

function nodesOf(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(nodesOf)];
}

function indexCondOf(nodes: readonly PlanNode[], indexName: string): string {
  return nodes
    .filter((node) => node["Index Name"] === indexName)
    .map((node) => node["Index Cond"] ?? "")
    .join(" ");
}

function inTenant<T>(work: Parameters<typeof db.tenant.withTenant<T>>[1]): Promise<T> {
  return db.tenant.withTenant({ accountId, workspaceId, requestId: "list-search-plan-test" }, work);
}

// ---- the plan of the matches, each branch of the function as slugbase_system runs it ----

/** The plan of the statement of one form of `sys_bookmark_match`, taken from the function as it is defined and planned with the values of a call bound as constants and the settings the function applies. */
async function planOfMatches(text: string, form: "short" | "long"): Promise<PlanNode[]> {
  const [row] = await db.owner<{ prosrc: string; proconfig: string[] | null }[]>`SELECT prosrc, proconfig FROM pg_proc WHERE oid = 'public.sys_bookmark_match(text)'::regprocedure`;
  if (row === undefined) {
    throw new Error("the system operation is not defined");
  }
  expect(row.proconfig).toEqual(expect.arrayContaining(["enable_seqscan=off", "enable_indexscan=off", "enable_indexonlyscan=off"]));
  const statements = row.prosrc.split("RETURN QUERY");
  const statement = statements[form === "short" ? 1 : 2];
  const body = statement?.slice(0, statement.indexOf(";\n"));
  if (body === undefined || statements.length !== 3) {
    throw new Error("the forms of the system operation were not found");
  }
  const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;
  const pattern = text.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
  const tsquery = text
    .split(" ")
    .map((word) => `'${word}':*`)
    .join(" & ");
  const bound = body
    .replaceAll("v_workspace", `'${workspaceId}'::uuid`)
    .replaceAll("v_account", `'${accountId}'::uuid`)
    .replaceAll("v_pattern", `${literal(pattern)}::text`)
    .replaceAll("v_tsquery", `${literal(tsquery)}::tsquery`)
    .replaceAll("v_text", `${literal(text)}::text`);
  const plan = await asSystem(db, async (tx) => {
    await tx`SET LOCAL pg_trgm.word_similarity_threshold = '0.4'`;
    await tx`SET LOCAL enable_seqscan = off`;
    await tx`SET LOCAL enable_indexscan = off`;
    await tx`SET LOCAL enable_indexonlyscan = off`;
    const rows = await tx.unsafe<{ "QUERY PLAN": { Plan: PlanNode }[] }[]>(`EXPLAIN (FORMAT JSON) ${bound}`);
    return rows[0]?.["QUERY PLAN"][0]?.Plan;
  });
  if (plan === undefined) {
    throw new Error("EXPLAIN returned no plan");
  }
  return nodesOf(plan);
}

// The texts of the plans: a word that few bookmarks hold, words that thousands do (`docs` and `notes` in titles, `www` and `the team` only in hosts and descriptions) and two words.
const LONG_TEXTS = ["github", "kubernetes guide", "git", "docs", "notes", "www", "the team"];

describe.each(LONG_TEXTS)("the plan of the matches of %s on a workspace of 50 000 bookmarks", (text) => {
  it("reads each branch from its own index with the search condition as its index condition and scans no bookmarks sequentially", async () => {
    const nodes = await planOfMatches(text, "long");

    expect(nodes.filter((node) => node["Node Type"] === "Seq Scan").map((node) => node["Relation Name"])).not.toContain("bookmarks");
    expect(indexCondOf(nodes, "bookmarks_slug_trgm_idx")).toContain("slug ~~ ");
    expect(indexCondOf(nodes, "bookmarks_search_idx")).toContain("search @@ ");
    expect(indexCondOf(nodes, "bookmarks_title_trgm_idx")).toContain("title %> ");
    expect(indexCondOf(nodes, "bookmarks_host_trgm_idx")).toContain("host %> ");
    for (const indexName of ["bookmarks_slug_trgm_idx", "bookmarks_search_idx", "bookmarks_title_trgm_idx", "bookmarks_host_trgm_idx"]) {
      expect(indexCondOf(nodes, indexName), indexName).toContain("workspace_id");
    }
    expect(nodes.map((node) => node["Index Name"])).not.toContain("bookmarks_owner_title_idx");
  });
});

describe.each(["g", "gh", "re", "ma", "zq"])("the plan of the matches of the short text %s on a workspace of 50 000 bookmarks", (text) => {
  it("reads the slug prefix and the title prefix from their own indexes with the search condition as the index condition", async () => {
    const nodes = await planOfMatches(text, "short");

    expect(nodes.filter((node) => node["Node Type"] === "Seq Scan").map((node) => node["Relation Name"])).not.toContain("bookmarks");
    expect(indexCondOf(nodes, "bookmarks_slug_trgm_idx")).toContain("slug ~~ ");
    expect(indexCondOf(nodes, "bookmarks_title_trgm_idx")).toContain("title ~~* ");
    for (const indexName of ["bookmarks_slug_trgm_idx", "bookmarks_title_trgm_idx"]) {
      expect(indexCondOf(nodes, indexName), indexName).toContain("workspace_id");
    }
  });
});

// ---- the plan of the page and of the count, as slugbase_app runs them ----

const INDEX_OF: Readonly<Record<BookmarkSort, string>> = {
  recent: "bookmarks_owner_recent_idx",
  oldest: "bookmarks_owner_recent_idx",
  title_asc: "bookmarks_owner_title_idx",
  title_desc: "bookmarks_owner_title_idx",
  most_used: "bookmarks_owner_popular_idx",
  recently_opened: "bookmarks_owner_opened_idx",
};

// The texts of the pages, by how many bookmarks of the caller they match (`FEW_MATCHES` is 10 000): the ones the page probes, and the ones it walks the index of its sort for. `kubenetes` is a typo, which
// matches by trigrams alone.
const FEW = ["docs", "docs guide", "gh", "g", "github", "kubernetes", "kubenetes", "mail"];
const MANY = ["www", "the team"];

/** Runs a statement as slugbase_app with the tenant settings of `withTenant` and answers its plan with the rows and loops each node ran. */
async function analyse(statement: { sql: string; params: unknown[] }): Promise<PlanNode[]> {
  const plan = await db.app.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${accountId}, true), set_config('app.workspace_id', ${workspaceId}, true)`;
    const rows = await tx.unsafe<{ "QUERY PLAN": { Plan: PlanNode }[] }[]>(`EXPLAIN (ANALYZE, FORMAT JSON) ${statement.sql}`, statement.params as never[]);
    return rows[0]?.["QUERY PLAN"][0]?.Plan;
  });
  if (plan === undefined) {
    throw new Error("EXPLAIN returned no plan");
  }
  return nodesOf(plan);
}

const dialect = new PgDialect({ casing: "snake_case" });

function planned(statement: Parameters<PgDialect["sqlToQuery"]>[0]): { sql: string; params: unknown[] } {
  const { sql, params } = dialect.sqlToQuery(statement);
  return { sql, params };
}

/** The nodes of the plan that ran, and those that the statement held and never ran. */
function ran(nodes: readonly PlanNode[], predicate: (node: PlanNode) => boolean): PlanNode[] {
  return nodes.filter((node) => predicate(node) && (node["Actual Loops"] ?? 0) > 0);
}

function held(nodes: readonly PlanNode[], predicate: (node: PlanNode) => boolean): PlanNode[] {
  return nodes.filter(predicate);
}

const isProbe = (node: PlanNode): boolean => node["Index Name"] === "bookmarks_pkey";
const walksIndex = (sort: BookmarkSort) => (node: PlanNode): boolean => node["Index Name"] === INDEX_OF[sort];

async function positionAfter(text: string, sort: BookmarkSort, rows: number): Promise<BookmarkPosition> {
  const page = await inTenant((tx) => bookmarkRepository(tx).list({ filter: { ownerId: accountId, q: text }, sort, after: undefined, limit: rows }));
  const last = page.at(-1);
  if (last === undefined || page.length < rows) {
    throw new Error(`the matches of ${text} are fewer than ${String(rows)}`);
  }
  return { key: last.key, id: last.bookmark.id };
}

describe.each(BOOKMARK_SORTS)("the page of the list sorted by %s on a workspace of 50 000 bookmarks", (sort) => {
  const deepOf = new Map<string, BookmarkPosition>();

  beforeAll(async () => {
    deepOf.set("docs", await positionAfter("docs", sort, 1000));
    deepOf.set("the team", await positionAfter("the team", sort, 8000));
  }, HOOK_TIMEOUT_MS);

  it.each([
    { text: "docs", where: undefined },
    { text: "docs", where: "deep" },
    { text: "gh", where: undefined },
  ] as const)("probes the primary key once for each match of $text ($where) and runs no walk of the sort index, when the matches are few", async ({ text, where }) => {
    const after = where === "deep" ? deepOf.get(text) : undefined;
    const request: BookmarkListRequest = { filter: { ownerId: accountId, q: text }, sort, after, limit: PAGE };
    const statement = await inTenant((tx) => Promise.resolve(planned(matchedPageStatement(tx, request))));

    const nodes = await analyse(statement);

    expect(nodes.filter((node) => node["Node Type"] === "Seq Scan").map((node) => node["Relation Name"])).not.toContain("bookmarks");
    expect(held(nodes, (node) => node["Function Name"] === "sys_bookmark_match")).toHaveLength(1);
    expect(ran(nodes, (node) => node["Function Name"] === "sys_bookmark_match")).toHaveLength(1);
    expect(ran(nodes, isProbe).length).toBe(1);
    expect(held(nodes, isProbe)[0]?.["Index Cond"]).toContain("id = m.id");
    expect(ran(nodes, walksIndex(sort))).toEqual([]);
  });

  it.each([
    { text: "the team", where: undefined },
    { text: "the team", where: "deep" },
    { text: "www", where: undefined },
  ] as const)("walks the index of the sort for the matches of $text ($where), tests each row against the matches and probes no bookmark, when they are many", async ({ text, where }) => {
    const after = where === "deep" ? deepOf.get(text) : undefined;
    const request: BookmarkListRequest = { filter: { ownerId: accountId, q: text }, sort, after, limit: PAGE };
    const statement = await inTenant((tx) => Promise.resolve(planned(matchedPageStatement(tx, request))));

    const nodes = await analyse(statement);

    expect(nodes.filter((node) => node["Node Type"] === "Seq Scan").map((node) => node["Relation Name"])).not.toContain("bookmarks");
    expect(held(nodes, (node) => node["Function Name"] === "sys_bookmark_match")).toHaveLength(1);
    expect(ran(nodes, isProbe)).toEqual([]);
    const walked = ran(nodes, walksIndex(sort));
    expect(walked).toHaveLength(1);
    // The walk stops when the page is full: from the start of the order it rejects the rows that are not matches, which are a few for each that is, and not the library, and from a deep place it reads
    // no more than what is left of the library.
    expect(walked[0]?.["Rows Removed by Filter"] ?? 0).toBeLessThan(where === "deep" ? BOOKMARKS : BOOKMARKS / 10);
    expect(held(nodes, (node) => (node.Filter ?? "").includes("hashed SubPlan")).length).toBeGreaterThan(0);
  });
});

describe("the count of the list with a text on a workspace of 50 000 bookmarks", () => {
  it.each([...FEW, ...MANY])("calls the function once, probes the primary key for the matches it counts and stops at the cap (%s)", async (text) => {
    const statement = await inTenant((tx) => Promise.resolve(planned(matchedCountStatement(tx, { ownerId: accountId, q: text }, 10_001))));

    const nodes = await analyse(statement);

    expect(nodes.filter((node) => node["Node Type"] === "Seq Scan").map((node) => node["Relation Name"])).not.toContain("bookmarks");
    expect(held(nodes, (node) => node["Function Name"] === "sys_bookmark_match")).toHaveLength(1);
    expect(held(nodes, isProbe)).toHaveLength(1);
    expect(nodes.map((node) => node["Node Type"])).toContain("Limit");
  });
});

// ---- the answers at this size, and the time ----

async function matchesOf(text: string): Promise<string[]> {
  const rows = await db.app.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${accountId}, true), set_config('app.workspace_id', ${workspaceId}, true)`;
    return tx<{ id: string }[]>`SELECT id FROM sys_bookmark_match(${text}::text)`;
  });
  return rows.map((row) => row.id);
}

const ORDER_BY: Readonly<Record<BookmarkSort, string>> = {
  recent: "created_at DESC, id DESC",
  oldest: "created_at ASC, id ASC",
  title_asc: "lower(title) ASC, id ASC",
  title_desc: "lower(title) DESC, id DESC",
  most_used: "open_count DESC, id DESC",
  recently_opened: "last_opened_at DESC NULLS LAST, id DESC",
};

async function reference(ids: readonly string[], sort: BookmarkSort): Promise<string[]> {
  const rows = await asSystem(
    db,
    (tx) => tx.unsafe<{ id: string }[]>(`SELECT id FROM bookmarks WHERE id = ANY ($1::uuid[]) AND workspace_id = $2 AND owner_id = $3 AND plan_archived_at IS NULL ORDER BY ${ORDER_BY[sort]}`, [`{${ids.join(",")}}`, workspaceId, accountId]),
  );
  return rows.map((row) => row.id);
}

describe("the answers of the list with a text on a workspace of 50 000 bookmarks", () => {
  it.each([...FEW, ...MANY].flatMap((text) => BOOKMARK_SORTS.map((sort) => ({ text, sort }))))("are the first page and the page after a deep position of the matches of $text in the order of $sort", async ({ text, sort }) => {
    const wanted = await reference(await matchesOf(text), sort);
    expect(wanted.length, text).toBeGreaterThan(0);

    const first = await inTenant((tx) => bookmarkRepository(tx).list({ filter: { ownerId: accountId, q: text }, sort, after: undefined, limit: PAGE }));
    expect(first.map((row) => row.bookmark.id)).toEqual(wanted.slice(0, PAGE));

    if (wanted.length > 300) {
      const anchor = await inTenant((tx) => bookmarkRepository(tx).list({ filter: { ownerId: accountId, q: text }, sort, after: undefined, limit: 300 }));
      const last = anchor.at(-1);
      const second = await inTenant((tx) => bookmarkRepository(tx).list({ filter: { ownerId: accountId, q: text }, sort, after: last === undefined ? undefined : { key: last.key, id: last.bookmark.id }, limit: PAGE }));
      expect(second.map((row) => row.bookmark.id)).toEqual(wanted.slice(300, 300 + PAGE));
    }
    expect(await inTenant((tx) => bookmarkRepository(tx).count({ ownerId: accountId, q: text }, 10_001))).toBe(Math.min(wanted.length, 10_001));
  });
});

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

describe("the time of the list with a text on a workspace of 50 000 bookmarks", () => {
  it.each([...FEW, ...MANY, "zzzq"])(`reads a page of the matches of %s and counts them in under ${String(BUDGET_MS)} ms`, async (text) => {
    const elapsed = await inTenant(async (tx) => {
      const repository = bookmarkRepository(tx);
      return median(async () => {
        await repository.list({ filter: { ownerId: accountId, q: text }, sort: "recent", after: undefined, limit: PAGE });
        await repository.count({ ownerId: accountId, q: text }, 10_001);
      });
    });

    expect(elapsed).toBeLessThan(BUDGET_MS);
  }, HOOK_TIMEOUT_MS);

  it.each(BOOKMARK_SORTS)(`reads a page of the matches of a text most of the workspace holds, sorted by %s, and counts them in under ${String(BUDGET_MS)} ms`, async (sort) => {
    const elapsed = await inTenant(async (tx) => {
      const repository = bookmarkRepository(tx);
      return median(async () => {
        await repository.list({ filter: { ownerId: accountId, q: "www" }, sort, after: undefined, limit: PAGE });
        await repository.count({ ownerId: accountId, q: "www" }, 10_001);
      });
    });

    expect(elapsed).toBeLessThan(BUDGET_MS);
  }, HOOK_TIMEOUT_MS);
});
