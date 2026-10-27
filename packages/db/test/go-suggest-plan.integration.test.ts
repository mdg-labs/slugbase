import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { goRepository } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The plan and the time of the slug suggestions on a workspace of 50 000 bookmarks, a fifth of which have a slug, beside many small workspaces and another member's bookmarks in the same
// workspace (doc 08 section 5.3, doc 05 sections 2.4 and 4): the prefix is an index condition of bookmarks_slug_trgm_idx beside the workspace, no sequential scan of bookmarks appears and
// bookmarks_slug_idx and bookmarks_owner_slug_key are not read for the whole workspace, and the answers come back well under the budget. The failure scenario: `LIKE` is not leakproof and the policy of
// `bookmarks` is FORCEd, so the same statement run as slugbase_app filters every slug of the workspace; the plans below are the function's own statement as slugbase_system runs it, and the
// timing is what the application sees through the repository.

const HOOK_TIMEOUT_MS = 300_000;
const BOOKMARKS = 50_000;
const SMALL_WORKSPACES = 1_000;
const P95_BUDGET_MS = 50;

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

describe.each(["s", "g", "d", "m", "n"])("the candidates of the prefix %s on a workspace of 50 000 bookmarks, which holds hundreds of its slugs", (prefix) => {
  it("are cut to 50 by a Limit node before the access rule narrows them to 10", async () => {
    const limits = (await planOfSuggest(prefix, true)).filter((node) => node["Node Type"] === "Limit").map((node) => node["Actual Rows"]);

    expect(limits).toContain(50);
    expect(limits).toContain(10);
  });
});

describe("the suggestions on a workspace of 50 000 bookmarks", () => {
  function suggest(prefix: string) {
    return db.tenant.withTenant({ accountId, workspaceId, requestId: "go-suggest-plan-test" }, (tx) => goRepository(tx).suggest({ prefix, accountId, limit: 10 }));
  }

  it("name the caller's own slugs that forward and are not archived, and no other member's", async () => {
    const readable = await asSystem(
      db,
      (tx) => tx<{ id: string }[]>`SELECT id FROM bookmarks WHERE workspace_id = ${workspaceId} AND owner_id = ${accountId} AND forwarding AND plan_archived_at IS NULL AND slug IS NOT NULL`,
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

  it("answer at a 95th percentile under the budget, for prefixes of one character that match thousands of slugs among them", { timeout: 120_000 }, async () => {
    const prefixes = ["s", "d", "m", "g", "n", "-", "slug", "slug-1", "slug-12", "docs-", "mail", "gh", "zz", "a", "9"];
    for (const prefix of prefixes) {
      await suggest(prefix);
    }
    const timings: number[] = [];
    const slowest = new Map<string, number>();
    for (let round = 0; round < 10; round += 1) {
      for (const prefix of prefixes) {
        const started = performance.now();
        await suggest(prefix);
        const elapsed = performance.now() - started;
        timings.push(elapsed);
        slowest.set(prefix, Math.max(slowest.get(prefix) ?? 0, elapsed));
      }
    }
    timings.sort((left, right) => left - right);
    const p95 = timings[Math.ceil(timings.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
    process.stdout.write(`go suggest p95 ${p95.toFixed(1)} ms, slowest ${JSON.stringify(Object.fromEntries([...slowest].map(([prefix, ms]) => [prefix, Math.round(ms)])))}\n`);

    expect(p95).toBeLessThan(P95_BUDGET_MS);
  });
});
