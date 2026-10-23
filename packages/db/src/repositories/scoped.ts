import {
  and,
  eq,
  getTableColumns,
  getTableName,
  type InferInsertModel,
  type InferSelectModel,
  type Name,
  type SQL,
  sql,
} from "drizzle-orm";
import { CasingCache } from "drizzle-orm/casing";
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

export interface ScopedRepositoryDefinition<T extends WorkspaceTable, M extends ScopedMethod = ScopedMethod> {
  readonly name: string;
  readonly table: T;
  /** The repository's methods on an open tenant transaction. */
  bind(tx: TenantTx): Pick<ScopedRepository<T>, M>;
}

export interface ScopedRepositoryOptions<T extends WorkspaceTable, M extends ScopedMethod> {
  /**
   * The methods the repository has, for a table the application role may not write in every way (a table it can only
   * read and insert into has `select` and `insert`). The matrix runs these and no others, so a method that the role's
   * privileges refuse is neither defined nor exercised. All four when left out.
   */
  readonly methods?: readonly M[];
  /**
   * The columns an insert names, for a table whose privileges let the application role insert some of its columns and not
   * the others (a column grant). The query builder names every column of a table in an insert, with `default` for the ones
   * it was not given, which such a grant refuses; with this option the statement names the columns given and no other, and a
   * value for a column outside the list is refused before the database is asked. The row is read back by its primary key.
   * Every column when left out.
   */
  readonly insertColumns?: readonly (keyof InferInsertModel<T> & string)[];
  /**
   * The columns an update may set, for a table whose privileges let the application role update some of its columns and not the
   * others (a column grant, which never includes `workspace_id`). A value for a column outside the list is refused before the
   * database is asked, and `workspaceId` is never part of the statement, in the RLS-only build as well: the privilege that keeps the
   * application role from moving a row to another workspace is what the matrix then relies on, next to the policy. Every column
   * when left out.
   */
  readonly updateColumns?: readonly (keyof InferInsertModel<T> & string)[];
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

// The tenant database names the columns the way the schema does (tenant.ts): a column declared without a name takes the snake case of its key.
const casing = new CasingCache("snake_case");

function assertWorkspaceColumn(name: string, table: PgTable): void {
  const column = getTableColumns(table)["workspaceId"];
  if (column === undefined || casing.getColumnCasing(column) !== "workspace_id" || !column.notNull) {
    throw new Error(
      `the table ${getTableName(table)} of the scoped repository "${name}" has no NOT NULL workspace_id column exposed as workspaceId`,
    );
  }
}

type TenantHandle = ReturnType<typeof tenantHandle>;

/**
 * An insert that names the columns it is given and no other, inside the list `allowed` and the workspace; the row is read back by its primary
 * key, with the workspace predicate of `scope`.
 */
async function insertNamed(
  handle: TenantHandle,
  table: PgTable,
  written: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  scope: (where: SQL | undefined) => SQL | undefined,
): Promise<unknown> {
  const columns = getTableColumns(table);
  const given = Object.keys(written).filter((key) => written[key] !== undefined);
  const refused = given.find((key) => key !== "workspaceId" && !allowed.includes(key));
  if (refused !== undefined) {
    throw new Error(`the column ${refused} of ${getTableName(table)} is not one the repository inserts`);
  }
  const primary = Object.values(columns).filter((column) => column.primary);
  const key = primary[0];
  if (primary.length !== 1 || key === undefined) {
    throw new Error(`the table ${getTableName(table)} has no single-column primary key to read an inserted row back by`);
  }
  const named = (column: PgColumn): Name => sql.identifier(casing.getColumnCasing(column));
  const entries = given.map((name) => {
    const column = columns[name];
    if (column === undefined) {
      throw new Error(`the table ${getTableName(table)} has no column ${name}`);
    }
    return column;
  });
  const inserted = await handle.execute(sql`
    INSERT INTO ${table} (${sql.join(entries.map(named), sql`, `)})
    VALUES (${sql.join(entries.map((column, index) => sql`${sql.param(written[given[index] ?? ""], column)}`), sql`, `)})
    RETURNING ${named(key)} AS "primary_key"`);
  const id = inserted[0]?.["primary_key"];
  if (inserted.length !== 1 || id === undefined) {
    throw new Error("an insert returned no row");
  }
  const [row] = await handle.select().from(table).where(scope(eq(key, id)));
  if (row === undefined) {
    throw new Error("an inserted row cannot be read back");
  }
  return row;
}

/**
 * `applicationLayer: true` is the repository as the product uses it. `false` is
 * the RLS-only build: no workspace predicate on a read, update or delete, and
 * no stamp or `foreign_workspace` refusal on an insert or update, so that only
 * row-level security can refuse a statement naming another workspace.
 */
function build<T extends WorkspaceTable>(
  table: T,
  tx: TenantTx,
  applicationLayer: boolean,
  insertColumns?: readonly string[],
  updateColumns?: readonly string[],
): ScopedRepository<T> {
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
      if (insertColumns !== undefined) {
        return (await insertNamed(handle, pgTable, written, insertColumns, scope)) as Row;
      }
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
      }
      if (applicationLayer || updateColumns !== undefined) {
        columns = Object.fromEntries(Object.entries(set).filter(([column]) => column !== "workspaceId"));
      }
      if (updateColumns !== undefined) {
        const refused = Object.keys(columns).find((column) => columns[column] !== undefined && !updateColumns.includes(column));
        if (refused !== undefined) {
          throw new Error(`the column ${refused} of ${getTableName(pgTable)} is not one the repository updates`);
        }
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
  insertColumns: readonly string[] | undefined,
  updateColumns: readonly string[] | undefined,
): Promise<readonly unknown[]> {
  const repository = build(table, tx, applicationLayer, insertColumns, updateColumns);
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
 * The methods of a scoped repository over `table` (all four unless `methods`
 * names fewer) in the shape the registry holds, built by the code `defineScopedRepository` uses and not
 * entered in the registry. For `@slugbase/db/testing`, which hands a suite the
 * methods of a repository over a test table without adding them to the
 * process-wide registry.
 */
export function scopedRepositoryMethods(
  name: string,
  table: WorkspaceTable,
  options: { readonly methods?: readonly ScopedMethod[]; readonly insertColumns?: readonly string[]; readonly updateColumns?: readonly string[] } = {},
): RepositoryMethodEntry[] {
  assertWorkspaceColumn(name, table);
  const tableName = getTableName(table);
  const methods = options.methods ?? (Object.keys(ACCESS) as ScopedMethod[]);
  return methods.map((method) => ({
    repository: name,
    table: tableName,
    method,
    access: ACCESS[method],
    invoke: (tx, input = {}) => run(table, method, tx, input, true, options.insertColumns, options.updateColumns),
    invokeRlsOnly: (tx, input = {}) => run(table, method, tx, input, false, options.insertColumns, options.updateColumns),
  }));
}

/**
 * Defines a scoped repository over a table with a `workspace_id` column and
 * enters its methods (all four, unless `options.methods` names fewer) in the
 * registry the matrix runner iterates.
 */
export function defineScopedRepository<T extends WorkspaceTable, const M extends ScopedMethod = ScopedMethod>(
  name: string,
  table: T,
  options: ScopedRepositoryOptions<T, M> = {},
): ScopedRepositoryDefinition<T, M> {
  const methods: readonly ScopedMethod[] = options.methods ?? (Object.keys(ACCESS) as ScopedMethod[]);
  const insertColumns: readonly string[] | undefined = options.insertColumns;
  const updateColumns: readonly string[] | undefined = options.updateColumns;
  registerRepositoryMethods(
    name,
    scopedRepositoryMethods(name, table, {
      methods,
      ...(insertColumns === undefined ? {} : { insertColumns }),
      ...(updateColumns === undefined ? {} : { updateColumns }),
    }),
  );
  return {
    name,
    table,
    bind(tx) {
      const repository = build(table, tx, true, insertColumns, updateColumns);
      return Object.fromEntries(methods.map((method) => [method, repository[method].bind(repository)])) as Pick<ScopedRepository<T>, M>;
    },
  };
}
