import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { goRepository } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { blocksOfStatement } from "./support/plan-work.ts";
import { vacuumUntilAllVisible, visibilityOf } from "./support/vacuum-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The plan and the work of the slug suggestions on a workspace of 50 000 bookmarks, a fifth of which have a slug, beside many small workspaces and another member's bookmarks in the same
// workspace (doc 08 section 5.3, doc 05 sections 2.4 and 4): the prefix is an index condition of bookmarks_slug_trgm_idx beside the workspace, no sequential scan of bookmarks appears and
// bookmarks_slug_idx and bookmarks_owner_slug_key are not read for the whole workspace, and the statement touches no more shared buffers than that plan needs. The failure scenario: `LIKE` is not
// leakproof and the policy of `bookmarks` is FORCEd, so the same statement run as slugbase_app filters every slug of the workspace; the plans below are the function's own statement as slugbase_system
// runs it, and the work is that of the statement the repository runs. The time through the repository is reported and not asserted (a time measured on a host that others share is not the time of the budget).

const HOOK_TIMEOUT_MS = 300_000;
const FIXTURE_TABLES = ["bookmark_shares", "bookmarks"] as const;
const BOOKMARKS = 50_000;
const SMALL_WORKSPACES = 1_000;
const P95_BUDGET_MS = 50;
const PREFIXES = ["s", "d", "m", "g", "n", "-", "slug", "slug-1", "slug-12", "docs-", "mail", "gh", "zz", "a", "9"];

// The most buffers the statement of `suggest` may touch for each prefix on this fixture: 5 % and 16 blocks over the most it touched in 4 runs on each of PostgreSQL 17 and 18 (the two differ by at most 2 blocks), rounded up to ten.
// A prefix that matches thousands of slugs reads about 3 400 blocks, one with a few hundred matches a few hundred, and the answer is cut to 10 by the Limit nodes the plan test above names.
const BLOCKS: Readonly<Record<string, number>> = {
  s: 3610,
  d: 3610,
  m: 3610,
  g: 3610,
  n: 3610,
  "-": 3680,
  slug: 3630,
  "slug-1": 1010,
  "slug-12": 330,
  "docs-": 3640,
  mail: 3630,
  gh: 170,
  zz: 160,
  a: 160,
  "9": 250,
};

let db: TestDatabase;
let accountId: string;
let otherId: string;
let workspaceId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  accountId = freshId();
  otherId = freshId();
  await seedAccount(db, { id: accountId, email: "go-suggest-plan-owner@example.test", passwordHash: "$argon2id$stub" });
  await seedAccount(db, { id: otherId, email: "go-suggest-plan-other@example.test", passwordHash: "$argon2id$stub" });
  workspaceId = await seedWorkspace(db, { name: "Go suggest plan test" });
  await seedMember(db, { workspaceId, accountId, role: "owner" });
  await seedMember(db, { workspaceId, accountId: otherId });
  // A fifth of the bookmarks have a slug, a tenth belong to the other member, a third of the slugs do not forward and one in a hundred is plan-archived.
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, slug, forwarding, plan_archived_at)
      SELECT gen_random_uuid(), ${workspaceId}, CASE WHEN n % 10 = 0 THEN ${otherId}::uuid ELSE ${accountId}::uuid END,
             'https://example.com/' || n, 'https://example.com/' || n, 'example.com', 'Title ' || (n % 997),
             CASE WHEN n % 5 = 0 THEN (array['slug','docs','mail','git','news'])[1 + (n / 5) % 5] || '-' || n END, n % 5 = 0 AND n % 3 <> 0,
             CASE WHEN n % 100 = 0 THEN now() END
      FROM generate_series(1, ${BOOKMARKS}) AS n`,
  );
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, slug, forwarding)
      VALUES (${freshId()}, ${workspaceId}, ${accountId}, 'https://github.com/', 'https://github.com/', 'github.com', 'GitHub', 'gh', true),
             (${freshId()}, ${workspaceId}, ${accountId}, 'https://mail.example.com/', 'https://mail.example.com/', 'mail.example.com', 'Mail', 'mail', true)`,
  );
  // The other member shares all their bookmarks with the caller directly, so the shared candidates of a prefix are as many as the caller's own are.
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO bookmark_shares (id, workspace_id, bookmark_id, target_account_id, granted_by)
      SELECT gen_random_uuid(), ${workspaceId}, b.id, ${accountId}, ${otherId} FROM bookmarks b WHERE b.workspace_id = ${workspaceId} AND b.owner_id = ${otherId}`,
  );
  // Many small workspaces whose bookmarks carry the same slugs, so no workspace dominates a table.
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
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, slug, forwarding)
      SELECT gen_random_uuid(), ('00000000-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid, ${accountId},
             'https://github.com/s' || n, 'https://github.com/s' || n, 'github.com', 'GitHub docs ' || n, 'mail-' || n, true
      FROM generate_series(1, ${SMALL_WORKSPACES}) AS n`,
  );
  // A running instance has its tables vacuumed and analysed, and a vacuum marks all-visible each page whose rows every transaction can see, so an Index Only Scan answers for the entries on those pages from the index alone: the fixture vacuums until the map covers every page, so the map is part of the fixture.
  await vacuumUntilAllVisible(db, FIXTURE_TABLES);
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await db.drop();
}, HOOK_TIMEOUT_MS);

describe("the fixture", () => {
  it("measures tables whose every page the visibility map marks all-visible", async () => {
    const rows = await visibilityOf(db, FIXTURE_TABLES);

    expect(rows.map((row) => row.name)).toEqual([...FIXTURE_TABLES].sort());
    expect(rows.filter((row) => row.visible < row.pages)).toEqual([]);
  });
});

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Index Cond"?: string;
  Filter?: string;
  "Actual Rows"?: number;
  Plans?: PlanNode[];
}

function nodesOf(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(nodesOf)];
}

/**
 * The plan of the statement of `sys_go_suggest`, taken from the function as it is defined and planned with the values of a call bound as constants, as slugbase_system, which the function runs
 * as, and with the settings the function applies. `prefix` is what the function derives its pattern from.
 */
async function planOfSuggest(prefix: string, analyze = false): Promise<PlanNode[]> {
  const [row] = await db.owner<{ prosrc: string; proconfig: string[] | null }[]>`SELECT prosrc, proconfig FROM pg_proc WHERE oid = 'public.sys_go_suggest(text)'::regprocedure`;
  if (row === undefined) {
    throw new Error("the system operation is not defined");
  }
  const statements = row.prosrc.split("RETURN QUERY");
  const statement = statements[1];
  const body = statement?.slice(0, statement.indexOf(";\nEND"));
  if (body === undefined || statements.length !== 2) {
    throw new Error("the statement of the system operation was not found");
  }
  const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;
  const pattern = prefix.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
  const bound = body
    .replaceAll("v_workspace", `'${workspaceId}'::uuid`)
    .replaceAll("v_account", `'${accountId}'::uuid`)
    .replaceAll("v_pattern", `${literal(pattern)}::text`);
  const plan = await asSystem(db, async (tx) => {
    // The settings the function applies to its own run, taken from its definition, except the search path, which the statement does not need.
    for (const setting of row.proconfig ?? []) {
      const [name, value] = setting.split("=");
      if (name !== undefined && value !== undefined && name.startsWith("enable_")) {
        await tx`SELECT set_config(${name}, ${value}, true)`;
      }
    }
    const rows = await tx.unsafe<{ "QUERY PLAN": { Plan: PlanNode }[] }[]>(`EXPLAIN (${analyze ? "ANALYZE, " : ""}FORMAT JSON) ${bound}`);
    return rows[0]?.["QUERY PLAN"][0]?.Plan;
  });
  if (plan === undefined) {
    throw new Error("EXPLAIN returned no plan");
  }
  return nodesOf(plan);
}

describe.each(["slug-1", "slug-12", "s", "g", "gh", "docs-", "mail", "zz", "a-b"])("the plan of the suggestions for the prefix %s on a workspace of 50 000 bookmarks", (prefix) => {
  it("reads the prefix from bookmarks_slug_trgm_idx as an index condition beside the workspace, and reads no bookmarks by any other index or sequentially", async () => {
    const nodes = await planOfSuggest(prefix);

    expect(nodes.filter((node) => node["Node Type"] === "Seq Scan").map((node) => node["Relation Name"])).not.toContain("bookmarks");
    expect(nodes.filter((node) => node["Index Name"] === "bookmarks_slug_idx" || node["Index Name"] === "bookmarks_owner_slug_key")).toEqual([]);
    const trigram = nodes.filter((node) => node["Index Name"] === "bookmarks_slug_trgm_idx");
    expect(trigram.length).toBeGreaterThan(0);
    for (const node of trigram) {
      expect(node["Index Cond"]).toContain("slug ~~ ");
      expect(node["Index Cond"]).toContain("workspace_id");
    }
  });
});

describe.each(["s", "g", "d", "m", "n"])("the candidates of the prefix %s on a workspace of 50 000 bookmarks, which holds hundreds of its slugs, of the caller's and shared with the caller", (prefix) => {
  it("are cut to 10 by a Limit node for the caller's own and another for the ones shared with the caller, before the two are joined and cut to 10 again", async () => {
    const limits = (await planOfSuggest(prefix, true)).filter((node) => node["Node Type"] === "Limit").map((node) => node["Actual Rows"]);

    expect(limits.filter((rows) => rows === 10).length).toBeGreaterThanOrEqual(3);
    expect(limits.filter((rows) => rows !== undefined && rows > 10)).toEqual([]);
  });
});

describe("the suggestions on a workspace of 50 000 bookmarks", () => {
  function suggest(prefix: string) {
    return db.tenant.withTenant({ accountId, workspaceId, requestId: "go-suggest-plan-test" }, (tx) => goRepository(tx).suggest({ prefix, accountId, limit: 10 }));
  }

  it("name the slugs of the caller's own bookmarks and of the ones shared with the caller that forward and are not archived, and no other", async () => {
    const readable = await asSystem(
      db,
      (tx) => tx<{ id: string }[]>`SELECT id FROM bookmarks WHERE workspace_id = ${workspaceId} AND (owner_id = ${accountId} OR id IN (SELECT bookmark_id FROM bookmark_shares WHERE workspace_id = ${workspaceId} AND target_account_id = ${accountId})) AND forwarding AND plan_archived_at IS NULL AND slug IS NOT NULL`,
    );
    const visible = new Set(readable.map((row) => row.id));
    for (const prefix of ["s", "slug", "slug-1", "g", "m", "docs-2", "n"]) {
      const found = await suggest(prefix);
      expect(found.length, prefix).toBeGreaterThan(0);
      expect(
        found.filter((record) => !visible.has(record.bookmarkId) || !record.slug.startsWith(prefix)),
        prefix,
      ).toEqual([]);
    }
    expect((await suggest("gh")).map((record) => record.slug)).toEqual(["gh"]);
  });

  // The statement of `suggest` in goRepository, as the application runs it.
  const statementOf = (prefix: string) => ({
    sql: `SELECT id, slug, title, host, owner_id, owner_name, access FROM sys_go_suggest($1::text) ORDER BY access <> 'owner', slug COLLATE "C", id LIMIT $2::integer`,
    params: [prefix, 10],
  });
  const measured = new Map<string, number>();

  afterAll(() => {
    process.stdout.write(`go suggest work (buffers of each statement): ${JSON.stringify(Object.fromEntries(measured))}\n`);
  });

  it.each(PREFIXES)("reads the prefix %s within the work of its plan", async (prefix) => {
    const bound = BLOCKS[prefix];
    if (bound === undefined) {
      throw new Error(`no bound of the work of the prefix ${prefix}`);
    }
    const blocks = await blocksOfStatement(db, { accountId, workspaceId }, statementOf(prefix), bound);
    measured.set(prefix, blocks);

    expect(blocks, prefix).toBeLessThan(bound);
  }, HOOK_TIMEOUT_MS);

  it("report the 95th percentile of their time, which is not asserted, for prefixes of one character that match thousands of slugs among them", { timeout: 120_000 }, async () => {
    for (const prefix of PREFIXES) {
      await suggest(prefix);
    }
    const timings: number[] = [];
    const slowest = new Map<string, number>();
    for (let round = 0; round < 10; round += 1) {
      for (const prefix of PREFIXES) {
        const started = performance.now();
        await suggest(prefix);
        const elapsed = performance.now() - started;
        timings.push(elapsed);
        slowest.set(prefix, Math.max(slowest.get(prefix) ?? 0, elapsed));
      }
    }
    timings.sort((left, right) => left - right);
    const p95 = timings[Math.ceil(timings.length * 0.95) - 1] ?? Number.NaN;
    process.stdout.write(
      `go suggest p95 ${p95.toFixed(1)} ms (reported, not asserted; the budget is ${String(P95_BUDGET_MS)} ms), slowest ${JSON.stringify(Object.fromEntries([...slowest].map(([prefix, ms]) => [prefix, Math.round(ms)])))}\n`,
    );
  });
});
