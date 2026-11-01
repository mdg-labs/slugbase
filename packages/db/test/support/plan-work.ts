import type { TestDatabase } from "../../src/testing.ts";

// The work of a statement, for the plan tests that hold a statement to the budgets of doc 08 section 5.3 (the tests of the dashboard, of the search and of the list). A time measured in a suite moves with what
// else runs on the host while the plan does not, and no wall-clock measure is free of that load, so a plan test holds the shared buffers the statement touches instead: the same whether a block is found in the
// cache or read, for the same plan, data and visibility map, and more for a plan that has regressed (an index that is not used, a scan of the table).

/** The runs of a statement before the ones that are counted: the first calls of a statement in a backend touch more blocks than later ones (a page of docs of the list with a text: 6 658, then 5 862 five times, then 5 820). */
export const WARM_RUNS = 6;
/** The runs a statement gets to come in under its bound, one straight after the other (see `blocksOfStatement`). */
export const MAX_COUNTED_RUNS = 8;
/** A statement of these tests runs in a few tens of milliseconds; one that has lost its index plan can run for minutes, so each is cut off at 20 s, which fails the case at once instead of at the end of the hook timeout. It is not a measure of the time. */
export const STATEMENT_TIMEOUT_MS = 20_000;

interface ExplainNode {
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
}

export interface TenantSettings {
  readonly accountId: string;
  readonly workspaceId: string;
}

export interface BlocksOptions {
  /** The jit setting the statement runs with, for a statement that the repository runs with it set; the setting of the cluster otherwise. */
  readonly jit?: "off";
}

/**
 * The buffers one statement touches as slugbase_app with the tenant settings of `withTenant`: the shared blocks found in the cache and those read (`Shared Hit Blocks` plus `Shared Read Blocks` of
 * `EXPLAIN (ANALYZE, BUFFERS)`), counted over the whole statement, a function it calls included. The statement runs `WARM_RUNS` times first, so what a backend loads or plans on its first calls is not part of the number.
 *
 * The runs that follow stop at the first one under `bound`, which is the work; the least of up to `MAX_COUNTED_RUNS` is what it returns, and a caller fails when that is not under the bound. A plan that has regressed
 * touches more than the bound in every run, so it uses all of them and fails. With the same plan and data a single run can also touch more when DDL commits elsewhere on the cluster at that moment: while a transaction of
 * 1 000 `CREATE TABLE` committed in another database, a page of 2 598 blocks touched 3 141 in one run and 2 598 again in the next. The 540 to 960 extra blocks are in the function scan of `sys_bookmark_match`, and the
 * planning of the statement touches more in the same run (71 blocks became about 900), which fits a backend whose caches were reset after it missed invalidation messages; that cause is inferred, not established.
 * The runs follow one another with no pause, so a retry comes within milliseconds and is unlikely to meet another commit. DDL that commits more often than the
 * runs of a statement follow one another can still fail a case with no regression. A regression that shows in only some runs of a statement passes, since a case fails only when every run is over the bound.
 */
export async function blocksOfStatement(
  database: TestDatabase,
  tenant: TenantSettings,
  statement: { sql: string; params: unknown[] },
  bound: number,
  options: BlocksOptions = {},
): Promise<number> {
  return database.app.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${tenant.accountId}, true), set_config('app.workspace_id', ${tenant.workspaceId}, true), set_config('statement_timeout', ${String(STATEMENT_TIMEOUT_MS)}, true)`;
    if (options.jit !== undefined) {
      await tx`SELECT set_config('jit', ${options.jit}, true)`;
    }
    let least = Number.POSITIVE_INFINITY;
    for (let run = 0; run < WARM_RUNS + MAX_COUNTED_RUNS; run += 1) {
      const rows = await tx.unsafe<{ "QUERY PLAN": { Plan: ExplainNode }[] }[]>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.sql}`, statement.params as never[]);
      const plan = rows[0]?.["QUERY PLAN"][0]?.Plan;
      if (plan === undefined) {
        throw new Error("EXPLAIN returned no plan");
      }
      if (run >= WARM_RUNS) {
        least = Math.min(least, (plan["Shared Hit Blocks"] ?? 0) + (plan["Shared Read Blocks"] ?? 0));
        if (least < bound) {
          break;
        }
      }
    }
    return least;
  });
}
