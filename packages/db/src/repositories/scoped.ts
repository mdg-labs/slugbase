import {
  and,
  eq,
  getTableColumns,
  getTableName,
  type InferInsertModel,
  type InferSelectModel,
  type SQL,
  sql,
} from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { TenantContextError, tenantHandle, type TenantTx } from "../tenant.ts";
import {
  registerRepositoryMethods,
  type RepositoryInput,
  type RepositoryMethodEntry,
  type ScopedMethod,
} from "./registry.ts";

// The scoped-repository helper of doc 01 section 5.3: the first of the two
// layers that keep a workspace's rows apart (row-level security is the second).
// Reads, updates and deletes carry the workspace predicate, and an insert is
// stamped with the workspace of the transaction; an insert or update that names
// another workspace is refused before it reaches the database.
//
// The same module builds the methods a second way for the cross-tenant matrix
// (doc 08 section 3.3, doc 01 section 5.5): with the application layer left
// out altogether, so that row-level security is the only thing between the
// transaction and another workspace. That build has no workspace predicate, no
// stamp and no `foreign_workspace` refusal: what the caller passes reaches the
// database unchanged.

/** A table every row of which belongs to one workspace (doc 05 section 1). */
export type WorkspaceTable = PgTable & { workspaceId: PgColumn };

export type InsertValues<T extends WorkspaceTable> = Omit<InferInsertModel<T>, "workspaceId"> & {
  /** Accepted only when it equals the workspace of the transaction. */
  workspaceId?: string;
};

export type UpdateValues<T extends WorkspaceTable> = Partial<Omit<InferInsertModel<T>, "workspaceId">> & {
  /** Accepted only when it equals the workspace of the transaction. */
  workspaceId?: string;
};

export interface ScopedRepository<T extends WorkspaceTable> {
  /** The rows of the workspace that match `where`. */
  select(where?: SQL): Promise<InferSelectModel<T>[]>;
  /** Inserts one row stamped with the workspace and returns it. */
  insert(values: InsertValues<T>): Promise<InferSelectModel<T>>;
  /** Updates the rows of the workspace that match `where` and returns them. */
  update(set: UpdateValues<T>, where?: SQL): Promise<InferSelectModel<T>[]>;
  /** Deletes the rows of the workspace that match `where` and returns them. */
  delete(where?: SQL): Promise<InferSelectModel<T>[]>;
}

export interface ScopedRepositoryDefinition<T extends WorkspaceTable> {
  readonly name: string;
  readonly table: T;
  /** The repository's methods on an open tenant transaction. */
  bind(tx: TenantTx): ScopedRepository<T>;
}

function requireWorkspace(tx: TenantTx): string {
  if (tx.workspaceId === undefined) {
    throw new TenantContextError(
      "workspace_required",
      "a scoped repository needs a tenant transaction opened with a workspace",
    );
  }
  return tx.workspaceId;
}

function checkForeignWorkspace(supplied: unknown, workspaceId: string): void {
  if (supplied === undefined) {
    return;
  }
  if (typeof supplied !== "string" || supplied.toLowerCase() !== workspaceId) {
    throw new TenantContextError(
      "foreign_workspace",
      "a row of a scoped repository cannot name a workspace other than the one of the transaction",
    );
  }
}

function assertWorkspaceColumn(name: string, table: PgTable): void {
  const column = getTableColumns(table)["workspaceId"];
  if (column === undefined || column.name !== "workspace_id" || !column.notNull) {
    throw new Error(
      `the table ${getTableName(table)} of the scoped repository "${name}" has no NOT NULL workspace_id column exposed as workspaceId`,
    );
  }
}

/**
 * `applicationLayer: true` is the repository as the product uses it. `false` is
 * the RLS-only build: no workspace predicate on a read, update or delete, and
 * no stamp or `foreign_workspace` refusal on an insert or update, so that only
 * row-level security can refuse a statement naming another workspace.
 */
function build<T extends WorkspaceTable>(table: T, tx: TenantTx, applicationLayer: boolean): ScopedRepository<T> {
  type Row = InferSelectModel<T>;
  // The generic table type is erased for the query builder, whose own types do not follow it through.
  const pgTable: PgTable = table;
  const scope = (where: SQL | undefined): SQL | undefined => {
    if (!applicationLayer) {
      return where;
    }
    // The caller predicate is parenthesised: a raw top-level OR would otherwise bind looser than the workspace predicate.
    return and(eq(table.workspaceId, requireWorkspace(tx)), where === undefined ? undefined : sql`(${where})`);
  };

  return {
    async select(where) {
      const predicate = scope(where);
      const handle = tenantHandle(tx);
      return (await handle.select().from(pgTable).where(predicate)) as Row[];
    },
    async insert(values) {
      let written: Record<string, unknown> = { ...values };
      if (applicationLayer) {
        const workspaceId = requireWorkspace(tx);
        checkForeignWorkspace(values.workspaceId, workspaceId);
        written = { ...values, workspaceId };
      }
      const handle = tenantHandle(tx);
      const rows = (await handle.insert(pgTable).values(written).returning()) as Row[];
      const row = rows[0];
      if (row === undefined) {
        throw new Error("an insert returned no row");
      }
      return row;
    },
    async update(set, where) {
      let columns: Record<string, unknown> = { ...set };
      if (applicationLayer) {
        checkForeignWorkspace(set.workspaceId, requireWorkspace(tx));
        columns = Object.fromEntries(Object.entries(set).filter(([column]) => column !== "workspaceId"));
      }
      const predicate = scope(where);
      const handle = tenantHandle(tx);
      return (await handle.update(pgTable).set(columns).where(predicate).returning()) as Row[];
    },
    async delete(where) {
      const predicate = scope(where);
      const handle = tenantHandle(tx);
      return (await handle.delete(pgTable).where(predicate).returning()) as Row[];
    },
  };
}

const ACCESS: Record<ScopedMethod, "read" | "write"> = {
  select: "read",
  insert: "write",
  update: "write",
  delete: "write",
};

async function run(
  table: WorkspaceTable,
  method: ScopedMethod,
  tx: TenantTx,
  input: RepositoryInput,
  applicationLayer: boolean,
): Promise<readonly unknown[]> {
  const repository = build(table, tx, applicationLayer);
  switch (method) {
    case "select":
      return repository.select(input.where);
    case "insert":
      return [await repository.insert(input.values ?? {})];
    case "update":
      return repository.update(input.set ?? {}, input.where);
    case "delete":
      return repository.delete(input.where);
  }
}

/**
 * The four methods of a scoped repository over `table` in the shape the
 * registry holds, built by the code `defineScopedRepository` uses and not
 * entered in the registry. For `@slugbase/db/testing`, which hands a suite the
 * methods of a repository over a test table without adding them to the
 * process-wide registry.
 */
export function scopedRepositoryMethods(name: string, table: WorkspaceTable): RepositoryMethodEntry[] {
  assertWorkspaceColumn(name, table);
  const tableName = getTableName(table);
  return (Object.keys(ACCESS) as ScopedMethod[]).map((method) => ({
    repository: name,
    table: tableName,
    method,
    access: ACCESS[method],
    invoke: (tx, input = {}) => run(table, method, tx, input, true),
    invokeRlsOnly: (tx, input = {}) => run(table, method, tx, input, false),
  }));
}

/**
 * Defines a scoped repository over a table with a `workspace_id` column and
 * enters its four methods in the registry the matrix runner iterates.
 */
export function defineScopedRepository<T extends WorkspaceTable>(
  name: string,
  table: T,
): ScopedRepositoryDefinition<T> {
  registerRepositoryMethods(name, scopedRepositoryMethods(name, table));
  return { name, table, bind: (tx) => build(table, tx, true) };
}
