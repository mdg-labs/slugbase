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
// runs it, and the timing is what the application sees.

const HOOK_TIMEOUT_MS = 300_000;
const BOOKMARKS = 50_000;
const SMALL_WORKSPACES = 1_000;
const P95_BUDGET_MS = 100;

let db: TestDatabase;
let accountId: string;
let otherId: string;
let workspaceId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  accountId = freshId();
  otherId = freshId();
  await seedAccount(db, { id: accountId, email: "search-plan-owner@example.test", passwordHash: "$argon2id$stub" });
  await seedAccount(db, { id: otherId, email: "search-plan-other@example.test", passwordHash: "$argon2id$stub" });
  workspaceId = await seedWorkspace(db, { name: "Search plan test" });
  await seedMember(db, { workspaceId, accountId, role: "owner" });
  await seedMember(db, { workspaceId, accountId: otherId });
  // Titles of three to five words from a vocabulary of eighty or so, hosts from about 400 sites and one site (github.com) that a tenth of the bookmarks share, a slug on a fifth of them and a
  // description on half: the shape of a real library, in which a common word matches thousands of bookmarks. A tenth belong to the other member and one in a hundred is plan-archived.
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
  const [row] = await db.owner<{ prosrc: string }[]>`SELECT prosrc FROM pg_proc WHERE oid = 'public.sys_search(text, integer)'::regprocedure`;
  if (row === undefined) {
    throw new Error("the system operation is not defined");
  }
  const statements = row.prosrc.split("RETURN QUERY");
  const statement = statements[form === "short" ? 1 : 2];
  const body = statement?.slice(0, statement.indexOf(";"));
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
    .replaceAll("v_limit", String(limit))
    .replaceAll("v_text", `${literal(text)}::text`);
  const plan = await asSystem(db, async (tx) => {
    await tx`SET LOCAL pg_trgm.word_similarity_threshold = '0.4'`;
    await tx`SET LOCAL enable_seqscan = off`;
    const rows = await tx.unsafe<{ "QUERY PLAN": { Plan: PlanNode }[] }[]>(`EXPLAIN (FORMAT JSON) ${bound}`);
    return rows[0]?.["QUERY PLAN"][0]?.Plan;
  });
  if (plan === undefined) {
    throw new Error("EXPLAIN returned no plan");
  }
  return nodesOf(plan);
}

function indexCondOf(nodes: readonly PlanNode[], indexName: string): string {
  return nodes
    .filter((node) => node["Index Name"] === indexName)
    .map((node) => node["Index Cond"] ?? "")
    .join(" ");
}

describe.each(["github", "kubernetes guide", "git"])("the plan of the search for %s on a workspace of 50 000 bookmarks", (text) => {
  it("reads each branch from its own index with the search condition as its index condition, and scans no bookmarks sequentially", async () => {
    const nodes = await planOfSearch(text, "long");

    expect(nodes.filter((node) => node["Node Type"] === "Seq Scan").map((node) => node["Relation Name"])).not.toContain("bookmarks");
    expect(indexCondOf(nodes, "bookmarks_owner_slug_key")).toContain("slug = ");
    expect(indexCondOf(nodes, "bookmarks_slug_trgm_idx")).toContain("slug ~~ ");
    expect(indexCondOf(nodes, "bookmarks_search_idx")).toContain("search @@ ");
    expect(indexCondOf(nodes, "bookmarks_title_trgm_idx")).toContain("title %> ");
    expect(indexCondOf(nodes, "bookmarks_host_trgm_idx")).toContain("host %> ");
    for (const indexName of ["bookmarks_owner_slug_key", "bookmarks_slug_trgm_idx", "bookmarks_search_idx", "bookmarks_title_trgm_idx", "bookmarks_host_trgm_idx"]) {
      expect(indexCondOf(nodes, indexName), indexName).toContain("workspace_id");
    }
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
