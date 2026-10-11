import type { SQL } from "drizzle-orm";
import type { TenantTx } from "../tenant.ts";

// Every method of every scoped repository is entered here when the repository
// is defined, so the cross-tenant matrix (doc 08 section 3.3) covers a method
// the moment it exists, without a list to keep up to date.

export type ScopedMethod = "select" | "insert" | "update" | "delete";

/** What the matrix runner passes to a repository method. */
export interface RepositoryInput {
  /** The caller's predicate of a select, update or delete; the workspace predicate is added to it. */
  where?: SQL;
  /** The row an insert writes. */
  values?: Record<string, unknown>;
  /** The columns an update sets. */
  set?: Record<string, unknown>;
}

export interface RepositoryMethodEntry {
  /** The repository's name, unique across the registry. */
  readonly repository: string;
  /** The database name of the table the repository works on. */
  readonly table: string;
  readonly method: ScopedMethod;
  readonly access: "read" | "write";
  /** Runs the method as the repository does, workspace predicate included, and returns the rows it read or wrote. */
  invoke(tx: TenantTx, input?: RepositoryInput): Promise<readonly unknown[]>;
  /**
   * Runs the same method with the application layer left out, so that only
   * row-level security stands between the transaction and another workspace's
   * rows: the RLS-only mode of the matrix (T1, doc 08 section 3.3). A read,
   * update or delete has no workspace predicate; an insert is not stamped and
   * an insert or update that names another workspace is not refused with
   * `foreign_workspace`: the statement reaches the database as passed, so the
   * policy is what refuses it (SQLSTATE 42501).
   */
  invokeRlsOnly(tx: TenantTx, input?: RepositoryInput): Promise<readonly unknown[]>;
}

const entries: RepositoryMethodEntry[] = [];
const names = new Set<string>();

/** Registers the methods of one repository; a name used twice is refused. */
export function registerRepositoryMethods(repository: string, methods: readonly RepositoryMethodEntry[]): void {
  if (names.has(repository)) {
    throw new Error(`a scoped repository named "${repository}" is already defined`);
  }
  names.add(repository);
  entries.push(...methods);
}

/** Every method of every scoped repository defined so far. */
export function listRepositoryMethods(): readonly RepositoryMethodEntry[] {
  return [...entries];
}
