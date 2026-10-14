import {
  listRepositoryMethods,
  type Database,
  type RepositoryInput,
  type RepositoryMethodEntry,
  type TenantContext,
  type TenantTx,
} from "@slugbase/db";
import type { TenantFixture } from "./fixture.js";
import { REPOSITORY_SAMPLES, type RepositorySamples } from "./mapping.js";
import type { MatrixFailure } from "./report.js";

// RLS-only mode of the cross-tenant matrix (doc 08 section 3.3, doc 01 section
// 5.5, T1): every method of the scoped-repository registry runs through its
// RLS-only build, inside withTenant(A), so that only row-level security stands
// between the transaction and workspace B. That build has no workspace
// predicate and neither stamps a write nor refuses one that names another
// workspace, so the runner names the workspace in every write itself: A in the
// attempt that stays in A, B in the attempt that must not get through. A read
// must return no row of B; a write must touch no row of B, and one that names B
// may instead be refused by row-level security. Every attempt rolls back, so the
// checksum of B, read on another connection, sees only what a method commits
// outside its transaction; what a write touched inside it is known only from the
// rows it returns, and a write that returns none is reported as not exercised.
//
// What counts as a refusal is narrow. The attempt that stays in workspace A must
// complete, so a method that never ran proves nothing. Of the attempts that name
// B, only SQLSTATE 42501 (row-level security) is evidence for the database
// layer, and the registry's own `foreign_workspace` code is a refusal by the
// application layer, which is reported apart and is not evidence for RLS. Any
// other error is a failure: an error is never taken for a pass.

export interface RlsOnlyOptions {
  /** The tenant database the methods run on, as the application role. */
  readonly tenant: Pick<Database, "withTenant">;
  readonly fixture: TenantFixture;
  /** Defaults to every method in the registry of `@slugbase/db`. */
  readonly methods?: readonly RepositoryMethodEntry[];
  readonly samples?: RepositorySamples;
}

export interface RlsOnlyReport {
  /** Methods exercised. */
  readonly methods: number;
  /** Runs of a method, counting the ones that name workspace B. */
  readonly attempts: number;
  /** Attempts naming B that row-level security refused (SQLSTATE 42501). */
  readonly rlsRefusals: number;
  /**
   * Attempts naming B that the repository refused before reaching the database;
   * not evidence for RLS. The RLS-only build of the registry makes no such
   * refusal, so an entry here means a method that kept an application guard.
   */
  readonly applicationRefusals: readonly string[];
  readonly failures: readonly MatrixFailure[];
}

function failure(subject: string, kind: string, detail: string): MatrixFailure {
  return { mode: "rls-only", subject, kind, detail };
}

class RolledBack extends Error {
  readonly rows: readonly unknown[];

  constructor(rows: readonly unknown[]) {
    super("the attempt was rolled back");
    this.name = "RolledBack";
    this.rows = rows;
  }
}

type Refusal = "rls" | "application";

type Outcome = { readonly rows: readonly unknown[] } | { readonly refusal: Refusal; readonly message: string };

const ROW_LEVEL_SECURITY = "42501";
const FOREIGN_WORKSPACE = "foreign_workspace";

/** The refusal an error stands for, looking through the causes a driver or query builder wraps it in. */
function refusalOf(error: unknown, depth = 0): { refusal: Refusal; message: string } | undefined {
  if (typeof error !== "object" || error === null || depth > 4) {
    return undefined;
  }
  const { name, code, message, cause } = error as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
  const text = typeof message === "string" ? message : String(code);
  if (code === ROW_LEVEL_SECURITY) {
    return { refusal: "rls", message: text };
  }
  if (name === "TenantContextError" && code === FOREIGN_WORKSPACE) {
    return { refusal: "application", message: text };
  }
  return refusalOf(cause, depth + 1);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs `work` in a tenant transaction of workspace A and always rolls it back. */
async function attempt(
  tenant: Pick<Database, "withTenant">,
  context: TenantContext,
  work: (tx: TenantTx) => Promise<readonly unknown[]>,
  mayBeRefused: boolean,
): Promise<Outcome> {
  try {
    await tenant.withTenant(context, async (tx) => {
      throw new RolledBack(await work(tx));
    });
  } catch (error) {
    if (error instanceof RolledBack) {
      return { rows: error.rows };
    }
    const refusal = mayBeRefused ? refusalOf(error) : undefined;
    if (refusal === undefined) {
      throw error;
    }
    return refusal;
  }
  throw new Error("the attempt neither returned rows nor failed");
}

function workspaceOf(row: unknown): string | undefined {
  const workspaceId = typeof row === "object" && row !== null ? (row as { workspaceId?: unknown }).workspaceId : undefined;
  return typeof workspaceId === "string" ? workspaceId.toLowerCase() : undefined;
}

export async function runRlsOnlyMatrix(options: RlsOnlyOptions): Promise<RlsOnlyReport> {
  const { tenant, fixture } = options;
  const methods = options.methods ?? listRepositoryMethods();
  const samples = options.samples ?? REPOSITORY_SAMPLES;
  const workspaceA = fixture.a.id.toLowerCase();
  const context: TenantContext = { accountId: fixture.a.owner.accountId, workspaceId: fixture.a.id, requestId: "matrix-rls-only" };
  const failures: MatrixFailure[] = [];
  let attempts = 0;
  let rlsRefusals = 0;
  const applicationRefusals: string[] = [];
  let baseline = await fixture.checksum(fixture.b.id);

  for (const entry of methods) {
    const subject = `${entry.repository}.${entry.method} (${entry.table})`;
    // Only an attempt naming B may be refused; every other attempt has to complete.
    const inputs: { label: string; input: RepositoryInput; mayBeRefused: boolean }[] = [];
    if (entry.method === "select" || entry.method === "delete") {
      inputs.push({ label: "without a predicate", input: {}, mayBeRefused: false });
    } else {
      const sample = samples[entry.repository];
      if (sample === undefined) {
        failures.push(
          failure(subject, "unmapped_repository", `the repository "${entry.repository}" has no sample row in the mapping for its writes`),
        );
        continue;
      }
      const columns = entry.method === "insert" ? sample.values : sample.set;
      const key = entry.method === "insert" ? "values" : "set";
      inputs.push({ label: "in workspace A", input: { [key]: { ...columns, workspaceId: fixture.a.id } }, mayBeRefused: false });
      inputs.push({
        label: "naming workspace B",
        input: { [key]: { ...columns, workspaceId: fixture.b.id } },
        mayBeRefused: true,
      });
    }

    for (const { label, input, mayBeRefused } of inputs) {
      attempts += 1;
      let outcome: Outcome;
      try {
        outcome = await attempt(tenant, context, (tx) => entry.invokeRlsOnly(tx, input), mayBeRefused);
      } catch (error) {
        failures.push(failure(subject, "unexpected_error", `${label}: ${messageOf(error)}`));
        continue;
      }
      if ("refusal" in outcome) {
        if (outcome.refusal === "rls") {
          rlsRefusals += 1;
        } else {
          applicationRefusals.push(subject);
        }
        continue;
      }
      if (entry.access === "write" && outcome.rows.length === 0) {
        // Every attempt rolls back, so the checksum of B cannot see a write made inside it: the returned rows are the
        // only evidence of what the statement touched. A write that returns none proves nothing about workspace B.
        failures.push(
          failure(subject, "write_not_exercised", `${label}: the ${entry.method} returned no row, so no row it touched was checked against workspace B`),
        );
      }
      for (const row of outcome.rows) {
        const workspaceId = workspaceOf(row);
        if (workspaceId === undefined) {
          failures.push(failure(subject, "unverifiable_row", `${label}: a returned row does not say which workspace it belongs to`));
        } else if (workspaceId !== workspaceA) {
          failures.push(
            failure(
              subject,
              entry.access === "read" ? "read_foreign_row" : "wrote_foreign_row",
              `${label}: ${entry.access === "read" ? "returned" : "wrote"} a row of workspace ${workspaceId}`,
            ),
          );
        }
      }
    }

    const after = await fixture.checksum(fixture.b.id);
    if (after !== baseline) {
      failures.push(failure(subject, "workspace_changed", "the row-level checksum of workspace B changed"));
      baseline = after;
    }
  }

  return { methods: methods.length, attempts, rlsRefusals, applicationRefusals, failures };
}
