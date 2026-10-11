import { TenantContextError, type Database, type RepositoryMethodEntry, type TenantTx } from "@slugbase/db";
import type { TestDatabase, TestSql } from "@slugbase/db/testing";
import type { FixtureIdentifier, FixturePrincipal, PrincipalRole, TenantFixture, WorkspaceFixture } from "./fixture.js";
import type { RepositorySample } from "./mapping.js";

// The probe implementation of the fixture over one test-only table, created by
// the table owner in a test database and not part of the shipped migrations.
// Its two policies show that the matrix can fail: `workspace` is the policy
// shape of doc 05 section 3.2, `permissive` is `USING (true)`.
//
// The probe cannot build a scoped repository, because that needs the query
// builder, which only packages/db may import. It therefore carries its own
// registry entries and tenant database over raw SQL: the entries run in the
// transaction the probe's withTenant opened and set the same transaction-local
// settings, so row-level security sees what it sees in the product.
//
// The entries mirror the build of defineScopedRepository: reads and deletes
// leave the workspace predicate out in RLS-only mode; an insert or update that names a
// workspace other than the one of the transaction is refused with the
// `foreign_workspace` code before any statement runs, and one that does not is
// stamped with the workspace of the transaction. So a workspace written to a
// row never reaches the database from here, and what the permissive policy
// shows is what a read, an update or a delete without the predicate reaches.

// The client of a transaction the probe opened.
type ProbeSql = Pick<TestSql, "unsafe">;

export type ProbePolicy = "workspace" | "permissive";

export interface ProbeOptions {
  /** The table to create; a lower-case SQL identifier. */
  readonly table?: string;
  readonly policy?: ProbePolicy;
  /** The repository name of the registry entries. */
  readonly repository?: string;
}

export interface Probe {
  readonly table: string;
  readonly fixture: TenantFixture;
  /** `withTenant` over the probe's transaction. */
  readonly tenant: Pick<Database, "withTenant">;
  /** The four methods of a repository over the table, in the shape of the scoped-repository registry. */
  readonly methods: readonly RepositoryMethodEntry[];
  /** The sample row the matrix writes to the table. */
  readonly sample: RepositorySample;
  readonly repository: string;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export const PROBE_WORKSPACE_A = "0192f3a0-1111-7000-8000-00000000a001";
export const PROBE_WORKSPACE_B = "0192f3a0-1111-7000-8000-00000000b001";

const ACCOUNTS: Record<"a" | "b", Record<PrincipalRole, string>> = {
  a: {
    owner: "0192f3a0-0000-7000-8000-00000000a011",
    admin: "0192f3a0-0000-7000-8000-00000000a012",
    member: "0192f3a0-0000-7000-8000-00000000a013",
  },
  b: {
    owner: "0192f3a0-0000-7000-8000-00000000b011",
    admin: "0192f3a0-0000-7000-8000-00000000b012",
    member: "0192f3a0-0000-7000-8000-00000000b013",
  },
};

const ROWS: Record<"a" | "b", { shared: string; unshared: string }> = {
  a: { shared: "0192f3a0-2222-7000-8000-00000000a021", unshared: "0192f3a0-2222-7000-8000-00000000a022" },
  b: { shared: "0192f3a0-2222-7000-8000-00000000b021", unshared: "0192f3a0-2222-7000-8000-00000000b022" },
};

export const PROBE_SAMPLE: RepositorySample = {
  values: { id: "0192f3a0-2222-7000-8000-00000000c0de", label: "matrix-probe-inserted" },
  set: { label: "matrix-probe-updated" },
};

function principal(side: "a" | "b", role: PrincipalRole): FixturePrincipal {
  const accountId = ACCOUNTS[side][role];
  return { role, accountId, credentials: `session:${accountId}` };
}

function workspaceFixture(side: "a" | "b", id: string): WorkspaceFixture {
  const rows = ROWS[side];
  const identifiers: FixtureIdentifier[] = [
    { kind: "workspace", id },
    { kind: "member", id: ACCOUNTS[side].owner },
    { kind: "member", id: ACCOUNTS[side].admin },
    { kind: "member", id: ACCOUNTS[side].member },
    { kind: "bookmark", id: rows.shared, visibility: "shared" },
    { kind: "bookmark", id: rows.unshared, visibility: "unshared" },
  ];
  return {
    id,
    owner: principal(side, "owner"),
    admin: principal(side, "admin"),
    member: principal(side, "member"),
    identifiers,
    markers: [`matrix-probe-${side}-shared`, `matrix-probe-${side}-unshared`],
  };
}

async function createTable(database: TestDatabase, table: string, policy: ProbePolicy): Promise<void> {
  const predicate = policy === "workspace" ? "workspace_id = public.app_workspace_id()" : "true";
  await database.owner.unsafe(`
    CREATE TABLE ${table} (
      id uuid PRIMARY KEY,
      workspace_id uuid NOT NULL,
      label text NOT NULL
    );
    ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
    CREATE POLICY ${table}_tenant ON ${table} USING (${predicate}) WITH CHECK (${predicate});
    GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO slugbase_app;
  `);
}

/** Runs `statement` as the table owner inside workspace `workspaceId`: row-level security is forced on the owner too. */
async function ownerIn<T>(database: TestDatabase, workspaceId: string, statement: string, params: string[] = []): Promise<T[]> {
  const rows = await database.owner.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    return tx.unsafe(statement, params);
  });
  return rows as unknown as T[];
}

async function seed(database: TestDatabase, table: string, side: "a" | "b", workspaceId: string): Promise<void> {
  for (const visibility of ["shared", "unshared"] as const) {
    await ownerIn(database, workspaceId, `INSERT INTO ${table} (id, workspace_id, label) VALUES ($1, $2, $3)`, [
      ROWS[side][visibility],
      workspaceId,
      `matrix-probe-${side}-${visibility}`,
    ]);
  }
}

function tenantDatabase(database: TestDatabase, transactions: WeakMap<TenantTx, ProbeSql>): Pick<Database, "withTenant"> {
  return {
    async withTenant<T>(
      context: { accountId: string; workspaceId?: string; requestId: string },
      fn: (tx: TenantTx) => Promise<T>,
    ): Promise<T> {
      const tx: TenantTx = Object.freeze({
        accountId: context.accountId,
        workspaceId: context.workspaceId,
        requestId: context.requestId,
      });
      let result: { value: T } | undefined;
      await database.app.begin(async (sql) => {
        await sql`SELECT
          set_config('app.account_id', ${context.accountId}, true),
          set_config('app.workspace_id', ${context.workspaceId ?? ""}, true),
          set_config('app.request_id', ${context.requestId}, true)`;
        transactions.set(tx, sql);
        result = { value: await fn(tx) };
      });
      if (result === undefined) {
        throw new Error("the probe transaction produced no result");
      }
      return result.value;
    },
  };
}

const COLUMNS = `id, workspace_id AS "workspaceId", label`;

function methodsOver(table: string, repository: string, transactions: WeakMap<TenantTx, ProbeSql>): RepositoryMethodEntry[] {
  const handle = (tx: TenantTx): ProbeSql => {
    const sql = transactions.get(tx);
    if (sql === undefined) {
      throw new Error("the value is not a transaction opened by the probe's withTenant");
    }
    return sql;
  };
  const workspaceOf = (tx: TenantTx): string => {
    if (tx.workspaceId === undefined) {
      throw new Error("a scoped repository needs a tenant transaction opened with a workspace");
    }
    return tx.workspaceId;
  };
  const refuseForeignWorkspace = (supplied: unknown, workspaceId: string): void => {
    if (supplied === undefined) {
      return;
    }
    if (typeof supplied !== "string" || supplied.toLowerCase() !== workspaceId) {
      throw new TenantContextError(
        "foreign_workspace",
        "a row of a scoped repository cannot name a workspace other than the one of the transaction",
      );
    }
  };
  const text = (value: unknown, column: string): string => {
    if (typeof value !== "string") {
      throw new Error(`the probe needs a text value for ${column}`);
    }
    return value;
  };

  const entry = (
    method: RepositoryMethodEntry["method"],
    run: (tx: TenantTx, input: Parameters<RepositoryMethodEntry["invoke"]>[1], scoped: boolean) => Promise<readonly unknown[]>,
  ): RepositoryMethodEntry => ({
    repository,
    table,
    method,
    access: method === "select" ? "read" : "write",
    invoke: (tx, input) => run(tx, input, true),
    invokeRlsOnly: (tx, input) => run(tx, input, false),
  });

  return [
    entry("select", (tx, _input, scoped) =>
      scoped
        ? handle(tx).unsafe(`SELECT ${COLUMNS} FROM ${table} WHERE workspace_id = $1`, [workspaceOf(tx)])
        : handle(tx).unsafe(`SELECT ${COLUMNS} FROM ${table}`),
    ),
    entry("insert", (tx, input) => {
      const values = input?.values ?? {};
      const workspaceId = workspaceOf(tx);
      refuseForeignWorkspace(values["workspaceId"], workspaceId);
      return handle(tx).unsafe(
        `INSERT INTO ${table} (id, workspace_id, label) VALUES ($1, $2, $3) RETURNING ${COLUMNS}`,
        [text(values["id"], "id"), workspaceId, text(values["label"], "label")],
      );
    }),
    entry("update", (tx, input, scoped) => {
      const set = input?.set ?? {};
      const label = text(set["label"], "label");
      const workspaceId = workspaceOf(tx);
      refuseForeignWorkspace(set["workspaceId"], workspaceId);
      if (scoped) {
        return handle(tx).unsafe(`UPDATE ${table} SET label = $1 WHERE workspace_id = $2 RETURNING ${COLUMNS}`, [
          label,
          workspaceId,
        ]);
      }
      return handle(tx).unsafe(`UPDATE ${table} SET label = $1 RETURNING ${COLUMNS}`, [label]);
    }),
    entry("delete", (tx, _input, scoped) =>
      scoped
        ? handle(tx).unsafe(`DELETE FROM ${table} WHERE workspace_id = $1 RETURNING ${COLUMNS}`, [workspaceOf(tx)])
        : handle(tx).unsafe(`DELETE FROM ${table} RETURNING ${COLUMNS}`),
    ),
  ];
}

/**
 * Creates the probe table in `database`, seeds one shared and one unshared row
 * in each of two workspaces, and returns the fixture over it.
 */
export async function createProbe(database: TestDatabase, options: ProbeOptions = {}): Promise<Probe> {
  const table = options.table ?? "matrix_probe";
  const repository = options.repository ?? "matrix_probe";
  if (!IDENTIFIER.test(table)) {
    throw new Error("the probe table must be a lower-case SQL identifier");
  }
  await createTable(database, table, options.policy ?? "workspace");
  await seed(database, table, "a", PROBE_WORKSPACE_A);
  await seed(database, table, "b", PROBE_WORKSPACE_B);

  const fixture: TenantFixture = {
    a: workspaceFixture("a", PROBE_WORKSPACE_A),
    b: workspaceFixture("b", PROBE_WORKSPACE_B),
    async checksum(workspaceId) {
      const rows = await ownerIn<{ sum: string }>(
        database,
        workspaceId,
        `SELECT coalesce(md5(string_agg(p::text, '|' ORDER BY p.id)), 'empty') AS sum FROM ${table} p WHERE p.workspace_id = $1`,
        [workspaceId],
      );
      const sum = rows[0]?.sum;
      if (sum === undefined) {
        throw new Error("the checksum query returned no row");
      }
      return sum;
    },
  };
  const transactions = new WeakMap<TenantTx, ProbeSql>();
  return {
    table,
    repository,
    fixture,
    tenant: tenantDatabase(database, transactions),
    methods: methodsOver(table, repository, transactions),
    sample: PROBE_SAMPLE,
  };
}
