import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { goRepository } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { blocksOfStatement, STATEMENT_TIMEOUT_MS } from "./support/plan-work.ts";
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

// The statement of `suggest` in goRepository, as the application runs it.
const statementOf = (prefix: string) => ({
  sql: `SELECT id, slug, title, host, owner_id, owner_name, access FROM sys_go_suggest($1::text) ORDER BY access <> 'owner', slug COLLATE "C", id LIMIT $2::integer`,
  params: [prefix, 10],
});

// The most buffers the statement of `suggest` may touch for each prefix on this fixture: 5 % and 16 blocks over the most it touched in the runs measured on PostgreSQL 18 (4 runs for the prefixes other than the two below; 972 to 980 for `slug-1` and 324 to 332 for `slug-12` over freshly seeded fixtures, whose random identifiers move the two together), rounded up to ten. The function plans each call for its values
// (`plan_cache_mode = force_custom_plan`), so a prefix that matches thousands of slugs reads about 16 800 blocks (the grants of the caller, 5 000 on this fixture, are probed by primary key for the shared candidates),
// one with a few hundred matches about 980 and the rest 160 to 332, and the answer is cut to 10 by the Limit nodes the plan test above names. Before the setting the large ones read about 3 400 blocks through a plan
// made for no value, which a connection kept from its sixth call on and which, with pending lists in the GIN indexes, read 3 600 blocks for a prefix that few slugs have (the last case of this file).
const BLOCKS: Readonly<Record<string, number>> = {
  s: 17680,
  d: 17680,
  m: 17680,
  g: 17690,
  n: 17680,
  "-": 17700,
  slug: 17690,
  "slug-1": 1050,
  "slug-12": 370,
  "docs-": 17700,
  mail: 17690,
  gh: 210,
  zz: 200,
  a: 200,
  "9": 280,
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

// The statement of `sys_go_suggest` is a PL/pgSQL statement, which a connection plans with the values of the call for its first five runs and from the sixth runs with one plan that does not know them if that plan's
// estimated cost is no worse. For `LIKE` on a value it does not know the estimate is a single row, so the walk of the workspace's slugs through `bookmarks_owner_slug_key` and `bookmarks_slug_idx` with the prefix as
// a filter costs about 5 and the scan of `bookmarks_slug_trgm_idx` costs 160 or more, because the pages of the pending list of a GIN index are added to the cost of every scan of it. The opens of `/go` reach `bookmarks`
// through `sys_flush_open_counts` and change columns that have indexes, so none of those updates is HOT and the entries of the GIN indexes wait in their pending lists until a vacuum. The plan tests above plan with the
// values as constants and `blocksOfStatement` repeats one text on a vacuumed fixture, so neither sees it. The function therefore plans each call for its values (`plan_cache_mode = force_custom_plan`); what is held here
// is the work of the calls of one connection, which does not depend on what the connection ran before, after the opens of `/go` have been flushed into a tenth of the slugged bookmarks.
describe("the suggestions on a workspace whose GIN indexes hold pending lists", () => {
  // The first call of a connection is not counted (it loads the catalogs) and is the first of the five that are planned for their values; four broad prefixes follow, then every call from the sixth on is made with
  // the plan the connection keeps, in an order that puts the prefixes that few slugs have among those that thousands have.
  const WARM_UP = "zzz";
  // The passes of the sequence the least of each prefix is taken over (see the last case).
  const PASSES = 3;
  const SEQUENCE = ["s", "d", "m", "g", "gh", "zz", "docs-", "a", "9", "slug-1", "gh", "mail", "slug-12", "zz", "a", "9", "slug-12", "slug-1", "s"];

  beforeAll(async () => {
    // The opens of `/go` as `sys_flush_open_counts` writes them. No vacuum follows, so the pending lists are as a running instance has them.
    await asSystem(
      db,
      (tx) => tx`UPDATE bookmarks SET open_count = open_count + 1, last_opened_at = now() WHERE workspace_id = ${workspaceId} AND slug IS NOT NULL AND abs(hashtext(id::text)) % 10 = 1`,
    );
  }, HOOK_TIMEOUT_MS);

  interface Call {
    /** The blocks of the execution (the `Plan` of `EXPLAIN`), the statements the function runs included. */
    readonly blocks: number;
    /** The blocks the planning of the outer statement touched (the `Planning` section of `EXPLAIN`), which is catalog work and not part of `blocks`. */
    readonly planningBlocks: number;
    readonly ms: number;
  }

  /**
   * A connection of its own as slugbase_app, to the endpoint of the pool of the test database. A pool hands the earlier cases of this file the connection they used before, and the connection keeps the plan its
   * function made on their vacuumed fixture (the plan of the trigram index, which is also what the regression makes), so the calls would no longer show what a connection plans after the opens have left pending lists.
   */
  function freshConnection(): postgres.Sql {
    const { host, port, database, user } = db.app.options;
    // The typings of postgres.js give the parsed password as null, which a connection made with one does not have.
    const pass: unknown = db.app.options.pass;
    return postgres({ host: host[0], port: port[0], database, username: user, password: typeof pass === "string" ? pass : undefined, max: 1, onnotice: () => undefined, connection: { application_name: "slugbase-test-harness" } });
  }

  /**
   * The shared blocks of each call of `prefixes`, in order, on one connection (`connection`, the pool of the test database by default), so that what the connection planned for the first calls is what the later ones run.
   * `customPlans` sets the plan cache mode of the transaction, which the function's own setting overrides while it has one.
   */
  async function callsOf(prefixes: readonly string[], customPlans = false, connection: postgres.Sql = db.app): Promise<Map<string, Call[]>> {
    return connection.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${accountId}, true), set_config('app.workspace_id', ${workspaceId}, true), set_config('statement_timeout', ${String(STATEMENT_TIMEOUT_MS)}, true)`;
      if (customPlans) {
        await tx`SELECT set_config('plan_cache_mode', 'force_custom_plan', true)`;
      }
      const byPrefix = new Map<string, Call[]>();
      for (const [index, prefix] of [WARM_UP, ...prefixes].entries()) {
        const { sql, params } = statementOf(prefix);
        const rows = await tx.unsafe<{ "QUERY PLAN": { Plan: { "Shared Hit Blocks"?: number; "Shared Read Blocks"?: number }; Planning?: { "Shared Hit Blocks"?: number; "Shared Read Blocks"?: number }; "Execution Time": number }[] }[]>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params as never[]);
        const explained = rows[0]?.["QUERY PLAN"][0];
        if (explained === undefined) {
          throw new Error("EXPLAIN returned no plan");
        }
        if (index > 0) {
          const call: Call = {
            blocks: (explained.Plan["Shared Hit Blocks"] ?? 0) + (explained.Plan["Shared Read Blocks"] ?? 0),
            planningBlocks: (explained.Planning?.["Shared Hit Blocks"] ?? 0) + (explained.Planning?.["Shared Read Blocks"] ?? 0),
            ms: explained["Execution Time"],
          };
          byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), call]);
        }
      }
      return byPrefix;
    });
  }

  it("is planned for the values of each call, whatever the connection ran before", async () => {
    const [row] = await db.owner<{ proconfig: string[] | null }[]>`SELECT proconfig FROM pg_proc WHERE oid = 'public.sys_go_suggest(text)'::regprocedure`;

    expect(row?.proconfig).toEqual(expect.arrayContaining(["enable_seqscan=off", "enable_indexscan=off", "enable_indexonlyscan=off", "plan_cache_mode=force_custom_plan"]));
  });

  it("touches no more blocks for a prefix on a connection that has run other suggestions than the plan made for the values of the call", async () => {
    // The reference: every prefix planned with its own values, whatever the function says. The calls: the mix, on one connection, with the plan cache mode left to the function.
    const reference = await callsOf([...new Set(SEQUENCE), ...new Set(SEQUENCE)], true);
    const plannedOf = (prefix: string) => Math.min(...(reference.get(prefix) ?? []).map((run) => run.blocks));
    const boundOf = (prefix: string) => plannedOf(prefix) * 1.5 + 100;
    const report = (byPrefix: Map<string, Call[]>) =>
      Object.fromEntries([...byPrefix].map(([prefix, runs]) => [prefix, runs.map((run) => `${String(run.blocks)} blocks of execution, ${String(run.planningBlocks)} of planning, ${run.ms.toFixed(1)} ms`)]));
    // The calls are made in up to PASSES passes, each on a connection of its own, and the least of a prefix over every call of every pass is what is held, as `blocksOfStatement` holds the least of its runs: a pass stops
    // the repetition when every prefix is under its bound, and a prefix that is over its bound in every call of every pass fails.
    const passes: Map<string, Call[]>[] = [];
    const leastOf = (prefix: string) => Math.min(...passes.flatMap((byPrefix) => (byPrefix.get(prefix) ?? []).map((run) => run.blocks)));
    for (let pass = 0; pass < PASSES; pass += 1) {
      const connection = freshConnection();
      try {
        passes.push(await callsOf(SEQUENCE, false, connection));
      } finally {
        await connection.end({ timeout: 5 });
      }
      if (SEQUENCE.every((prefix) => leastOf(prefix) < boundOf(prefix))) {
        break;
      }
    }
    process.stdout.write(
      `go suggest work in one connection with pending lists (each call, in order, one entry per pass): ${JSON.stringify(passes.map(report))}, planned for the values: ${JSON.stringify(report(reference))}\n`,
    );

    for (const prefix of new Set(SEQUENCE)) {
      // The same plan touches nearly the same blocks run after run, apart from a call that meets a backend whose caches were reset (the first call of `a` touched 1 683 blocks and the next 230; both calls of `gh` of a
      // single pass touched 1 647 against 252 planned, on a connection with no regression); a plan that has stopped using the trigram index touches several times as many in every call for a prefix that
      // few slugs have, so the least of the calls of a prefix over the passes is what is held, and a failure names the execution and planning blocks of every call of the prefix.
      const calls = passes.flatMap((byPrefix) => byPrefix.get(prefix) ?? []);
      const detail = `${prefix}: planned ${String(plannedOf(prefix))}, calls as [execution blocks, planning blocks] ${JSON.stringify(calls.map((run) => [run.blocks, run.planningBlocks]))}`;
      expect(leastOf(prefix), detail).toBeLessThan(boundOf(prefix));
    }
  }, HOOK_TIMEOUT_MS);
});
