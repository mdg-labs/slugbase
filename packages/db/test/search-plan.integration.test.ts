import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { searchRepository } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The plan and the time of the search on a workspace of 50 000 bookmarks, beside many small workspaces and another member's bookmarks in the same workspace (doc 08 section 5.3, doc 05
// section 2.4): each branch of `sys_search` reads its own index with the search condition as the index condition, no sequential scan of bookmarks appears, and the answers of
// realistic queries, the ones that match thousands of bookmarks among them, come back in well under 100 ms at the 95th percentile (the budget of doc 08 section 5.3, measured here
// through the repository as slugbase_app, the round trip included). The failure scenario: the policy of `bookmarks` is FORCEd and none of `@@`, `<%` or `LIKE` is leakproof, so the same
// statements run as slugbase_app would use the indexes for the workspace alone and filter every bookmark of it; the plans below are the function's own statement as slugbase_system
// runs it, and the timing is what the application sees. The full-text branch ranks every title and slug match exactly through its own index and fills the rest of the answer from a bounded
// window of host and description matches, so a query that matches tens of thousands of bookmarks (`www`, `the team`) does not rank them all; the answers are compared with the unbounded
// statement below. The file runs in a vitest project of its own, one file at a time, so that no other database-heavy file shares the machine with its timings (vitest.config.ts).

const HOOK_TIMEOUT_MS = 300_000;
const BOOKMARKS = 50_000;
const SMALL_WORKSPACES = 1_000;
const P95_BUDGET_MS = 100;

let db: TestDatabase;
let accountId: string;
let otherId: string;
let workspaceId: string;

/**
 * Titles of three to five words from a vocabulary of eighty or so, hosts from about 400 sites and one site (github.com) that a tenth of the bookmarks share, a slug on a fifth of them and a
 * description on half: the shape of a real library, in which a common word matches thousands of bookmarks. A tenth belong to the other member and one in a hundred is plan-archived.
 */
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
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, description, slug, forwarding, plan_archived_at)
      SELECT gen_random_uuid(), ${workspaceId}, CASE WHEN n % 10 = 0 THEN ${otherId}::uuid ELSE ${accountId}::uuid END,
             'https://' || h.host || '/p/' || n, 'https://' || h.host || '/p/' || n, h.host,
             initcap(words.w[1 + n % cardinality(words.w)]) || ' ' || words.w[1 + (n / 7) % cardinality(words.w)] || ' ' || words.w[1 + (n / 11) % cardinality(words.w)] || CASE WHEN n % 3 = 0 THEN ' ' || words.w[1 + (n / 13) % cardinality(words.w)] ELSE '' END || CASE WHEN n % 4 = 0 THEN ' ' || words.w[1 + (n / 17) % cardinality(words.w)] ELSE '' END,
             CASE WHEN n % 2 = 0 THEN 'Notes on ' || words.w[1 + (n / 3) % cardinality(words.w)] || ' and ' || words.w[1 + (n / 19) % cardinality(words.w)] || ' for the team' END,
             CASE WHEN n % 5 = 0 THEN words.w[1 + (n / 5) % cardinality(words.w)] || '-' || n END, false,
             CASE WHEN n % 100 = 0 THEN now() END
      FROM generate_series(1, ${BOOKMARKS}) AS n
      CROSS JOIN words
      CROSS JOIN LATERAL (SELECT CASE WHEN n % 10 = 3 THEN 'github.com' ELSE 'www.' || words.w[1 + n % cardinality(words.w)] || words.w[1 + (n / 80) % 5] || '.' || (array['com','org','io','dev','net'])[1 + n % 5] END AS host) AS h`,
  );
  // The bookmarks a person looks for by their slug.
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
  await seedAccount(db, { id: accountId, email: "search-plan-owner@example.test", passwordHash: "$argon2id$stub" });
  await seedAccount(db, { id: otherId, email: "search-plan-other@example.test", passwordHash: "$argon2id$stub" });
  workspaceId = await seedWorkspace(db, { name: "Search plan test" });
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
  Filter?: string;
  Plans?: PlanNode[];
}

function nodesOf(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(nodesOf)];
}

/**
 * The plan of the statement of one form of `sys_search`, taken from the function as it is defined and planned with the values of a call bound as constants, as slugbase_system, which the
 * function runs as, and with the settings the function applies. `text` is what the function derives its patterns and its tsquery from; the long form is the one for three characters or more.
 */
async function planOfSearch(text: string, form: "short" | "long", limit = 8): Promise<PlanNode[]> {
  const [row] = await db.owner<{ prosrc: string; proconfig: string[] | null }[]>`SELECT prosrc, proconfig FROM pg_proc WHERE oid = 'public.sys_search(text, integer)'::regprocedure`;
  if (row === undefined) {
    throw new Error("the system operation is not defined");
  }
  // The settings applied below are the ones the function runs with.
  expect(row.proconfig).toEqual(expect.arrayContaining(["enable_seqscan=off", "enable_indexscan=off", "enable_indexonlyscan=off"]));
  const statements = row.prosrc.split("RETURN QUERY");
  const statement = statements[form === "short" ? 1 : 2];
  const body = statement?.slice(0, statement.indexOf(";"));
  if (body === undefined || statements.length !== 3) {
    throw new Error("the forms of the system operation were not found");
  }
  const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;
  const pattern = likeEscaped(text);
  const tsquery = text
    .split(" ")
    .map((word) => `'${word}':*`)
    .join(" & ");
  const bound = body
    .replaceAll("v_workspace", `'${workspaceId}'::uuid`)
    .replaceAll("v_account", `'${accountId}'::uuid`)
    .replaceAll("v_pattern", `${literal(pattern)}::text`)
    .replaceAll("v_tsquery", `${literal(tsquery)}::tsquery`)
    .replaceAll("v_limit", String(limit))
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

function likeEscaped(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function indexCondOf(nodes: readonly PlanNode[], indexName: string): string {
  return nodes
    .filter((node) => node["Index Name"] === indexName)
    .map((node) => node["Index Cond"] ?? "")
    .join(" ");
}

const LONG_FORM_INDEXES = ["bookmarks_slug_trgm_idx", "bookmarks_search_idx", "bookmarks_title_slug_search_idx", "bookmarks_title_trgm_idx", "bookmarks_host_trgm_idx"];

// The texts of the plans: a word that few bookmarks hold, words that thousands do (`docs` and `notes` in titles, `www` and `the team` only in hosts and descriptions) and two words. `docs` is the
// text for which the slug-prefix branch, sorted by the title of the bookmark, was planned as a walk of `bookmarks_owner_title_idx` that filters every bookmark before the first match.
const LONG_TEXTS = ["github", "kubernetes guide", "git", "docs", "notes", "www", "the team"];

async function expectLongFormPlan(text: string): Promise<void> {
  const nodes = await planOfSearch(text, "long");

  expect(nodes.filter((node) => node["Node Type"] === "Seq Scan").map((node) => node["Relation Name"])).not.toContain("bookmarks");
  // The exact slug is read from the unique key of the owner or, on some samples of the analysis, from the slug index of the workspace, with the slug as the index condition either way.
  const exactSlug = `${indexCondOf(nodes, "bookmarks_owner_slug_key")} ${indexCondOf(nodes, "bookmarks_slug_idx")}`;
  expect(exactSlug).toContain("slug = ");
  expect(exactSlug).toContain("workspace_id");
  expect(indexCondOf(nodes, "bookmarks_slug_trgm_idx")).toContain("slug ~~ ");
  expect(indexCondOf(nodes, "bookmarks_search_idx")).toContain("search @@ ");
  expect(indexCondOf(nodes, "bookmarks_title_slug_search_idx")).toContain("@@ ");
  expect(indexCondOf(nodes, "bookmarks_title_trgm_idx")).toContain("title %> ");
  expect(indexCondOf(nodes, "bookmarks_host_trgm_idx")).toContain("host %> ");
  for (const indexName of LONG_FORM_INDEXES) {
    expect(indexCondOf(nodes, indexName), indexName).toContain("workspace_id");
  }
  // The slug-prefix branch is served by the trigram index of the slug; a walk of the titles in order, filtering every bookmark of the workspace for the prefix, is the plan its sort invites.
  expect(
    nodes.map((node) => node["Index Name"]),
    text,
  ).not.toContain("bookmarks_owner_title_idx");
}

describe.each(LONG_TEXTS)("the plan of the search for %s on a workspace of 50 000 bookmarks", (text) => {
  it("reads each branch from its own index with the search condition as its index condition, scans no bookmarks sequentially and never walks the titles in order", async () => {
    await expectLongFormPlan(text);
  });
});

describe.each(["g", "gh", "re", "ma", "zq"])("the plan of the search for the short text %s on a workspace of 50 000 bookmarks", (text) => {
  it("reads the exact slug, the slug prefix and the title prefix from their own indexes with the search condition as the index condition", async () => {
    const nodes = await planOfSearch(text, "short");

    expect(nodes.filter((node) => node["Node Type"] === "Seq Scan").map((node) => node["Relation Name"])).not.toContain("bookmarks");
    expect(indexCondOf(nodes, "bookmarks_owner_slug_key")).toContain("slug = ");
    expect(indexCondOf(nodes, "bookmarks_slug_trgm_idx")).toContain("slug ~~ ");
    expect(indexCondOf(nodes, "bookmarks_title_trgm_idx")).toContain("title ~~* ");
    for (const indexName of ["bookmarks_owner_slug_key", "bookmarks_slug_trgm_idx", "bookmarks_title_trgm_idx"]) {
      expect(indexCondOf(nodes, indexName), indexName).toContain("workspace_id");
    }
  });
});

describe("the search on a workspace of 50 000 bookmarks", () => {
  function search(text: string, limit = 8) {
    return db.tenant.withTenant({ accountId, workspaceId, requestId: "search-plan-test" }, (tx) => searchRepository(tx).bookmarks({ text, limit }));
  }

  it("finds the caller's bookmark by its slug first, whoever else has bookmarks that match", async () => {
    const hits = await search("gh");

    expect(hits[0]).toMatchObject({ title: "GitHub", slug: "gh" });
    expect((await search("mail"))[0]).toMatchObject({ title: "Mail", slug: "mail" });
  });

  it("names no plan-archived bookmark and none of the other member's", async () => {
    const owned = await asSystem(db, (tx) => tx<{ id: string }[]>`SELECT id FROM bookmarks WHERE workspace_id = ${workspaceId} AND owner_id = ${accountId} AND plan_archived_at IS NULL`);
    const visible = new Set(owned.map((row) => row.id));
    for (const text of ["github", "docs", "kubernetes guide", "api", "re", "typescript"]) {
      const hits = await search(text, 20);
      expect(hits.length, text).toBeGreaterThan(0);
      expect(
        hits.filter((hit) => !visible.has(hit.id)),
        text,
      ).toEqual([]);
    }
  });

  // The statement of the search without any bound: every bookmark the account may read that is the slug, starts with it or holds every word of it as a prefix, ranked as doc 02 section 9.1
  // ranks them (the slug is exactly the text, the slug starts with it, then the full-text rank; a short text has the title prefix in place of the full-text tier and no rank).
  interface Ranked {
    id: string;
    tier: number;
    score: number;
  }

  function tsqueryOf(text: string): string {
    return text
      .split(" ")
      .map((word) => `'${word}':*`)
      .join(" & ");
  }

  function unbounded(text: string, limit: number): Promise<Ranked[]> {
    const pattern = likeEscaped(text);
    if (text.length < 3) {
      return asSystem(
        db,
        (tx) => tx<Ranked[]>`
          SELECT b.id, tier, 0::real AS score
          FROM bookmarks b CROSS JOIN LATERAL (SELECT CASE WHEN b.slug = ${text} THEN 1 WHEN b.slug LIKE ${pattern + "%"} THEN 2 ELSE 3 END AS tier) t
          WHERE b.workspace_id = ${workspaceId} AND b.owner_id = ${accountId} AND b.plan_archived_at IS NULL
            AND (b.slug = ${text} OR b.slug LIKE ${pattern + "%"} OR b.title ILIKE ${pattern + "%"})
          ORDER BY tier, lower(b.title), b.id LIMIT ${limit}`,
      );
    }
    return asSystem(
      db,
      (tx) => tx<Ranked[]>`
        SELECT id, tier, score FROM (
          SELECT b.id, tier, CASE WHEN tier < 3 THEN 0::real ELSE ts_rank_cd(b.search, ${tsqueryOf(text)}::tsquery)::real END AS score, lower(b.title) AS sort_title
          FROM bookmarks b CROSS JOIN LATERAL (SELECT CASE WHEN b.slug = ${text} THEN 1 WHEN b.slug LIKE ${pattern + "%"} THEN 2 ELSE 3 END AS tier) t
          WHERE b.workspace_id = ${workspaceId} AND b.owner_id = ${accountId} AND b.plan_archived_at IS NULL
            AND (b.slug = ${text} OR b.slug LIKE ${pattern + "%"} OR b.search @@ ${tsqueryOf(text)}::tsquery)
        ) ranked
        ORDER BY tier, score DESC, sort_title, id LIMIT ${limit}`,
    );
  }

  async function rankOf(text: string, ids: readonly string[]): Promise<[number, number][]> {
    const pattern = likeEscaped(text);
    const rows = await asSystem(
      db,
      (tx) => tx<Ranked[]>`
        SELECT b.id, tier,
               CASE WHEN tier < 3 OR ${text.length < 3}::boolean THEN 0::real ELSE ts_rank_cd(b.search, ${tsqueryOf(text)}::tsquery)::real END AS score
        FROM bookmarks b CROSS JOIN LATERAL (SELECT CASE WHEN b.slug = ${text} THEN 1 WHEN b.slug LIKE ${pattern + "%"} THEN 2 ELSE 3 END AS tier) t
        WHERE b.id IN ${tx(ids)}`,
    );
    const byId = new Map(rows.map((row) => [row.id, row] as const));
    return ids.map((id) => {
      const row = byId.get(id);
      return [row?.tier ?? Number.NaN, row?.score ?? Number.NaN];
    });
  }

  it.each(["notes", "docs", "kubernetes", "github", "re", "www", "the team"])(
    "puts the same ranks first for %s as the statement that ranks every match, the ids differing only among equal ranks",
    async (text) => {
      const expected = await unbounded(text, 8);
      const hits = await search(text, 8);

      expect(expected).toHaveLength(8);
      expect(hits.map((hit) => hit.id)).toHaveLength(8);
      expect(await rankOf(text, hits.map((hit) => hit.id))).toEqual(expected.map((row): [number, number] => [row.tier, row.score]));
    },
  );

  it("answers realistic queries, those that match thousands of bookmarks among them, at a 95th percentile under the budget", { timeout: 120_000 }, async () => {
    const queries = ["github", "docs", "kubernetes", "kubernetes guide", "api reference", "typescript tutorial", "gh", "ma", "a", "re", "git", "mail", "postgrs", "kuberentes", "www.docs", "www", "com", "github.com", "rele", "dashbaord", "notes", "the team", "www.zzzzzz", "xyzzyx"];
    // Warm the connections and the caches, then measure each query ten times.
    for (const text of queries) {
      await search(text);
    }
    const timings: number[] = [];
    const slowest = new Map<string, number>();
    for (let round = 0; round < 10; round += 1) {
      for (const text of queries) {
        const started = performance.now();
        await search(text);
        const elapsed = performance.now() - started;
        timings.push(elapsed);
        slowest.set(text, Math.max(slowest.get(text) ?? 0, elapsed));
      }
    }
    timings.sort((left, right) => left - right);
    const p95 = timings[Math.ceil(timings.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
    process.stdout.write(`search p95 ${p95.toFixed(1)} ms, slowest ${JSON.stringify(Object.fromEntries([...slowest].map(([text, ms]) => [text, Math.round(ms)])))}\n`);

    expect(p95).toBeLessThan(P95_BUDGET_MS);
  });
});

// The library seeded again: the rows are new and in another order on disk, and the analysis of a table of this size reads a random sample of it, so the statistics, and the plan the
// planner chooses from them, are not the ones of the first seeding.
describe("the plan of the search on a workspace of 50 000 bookmarks seeded again", () => {
  beforeAll(async () => {
    await asSystem(db, (tx) => tx`DELETE FROM bookmarks WHERE workspace_id = ${workspaceId}`);
    await seedLibrary();
    await db.owner.unsafe("VACUUM (ANALYZE) bookmarks");
  }, HOOK_TIMEOUT_MS);

  describe.each(LONG_TEXTS)("for %s", (text) => {
    it.each([1, 2, 3])("reads the slug prefix from the trigram index and never walks the titles in order (analysis %i)", async () => {
      await db.owner.unsafe("ANALYZE bookmarks");
      await expectLongFormPlan(text);
    });
  });
});
