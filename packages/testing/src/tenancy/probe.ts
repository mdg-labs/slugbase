import type { RepositoryMethodEntry } from "@slugbase/db";
import { testRepositoryMethods, type TestDatabase } from "@slugbase/db/testing";
import type { FixtureIdentifier, FixtureInstanceAdmin, FixturePrincipal, FixtureToken, PrincipalRole, TenantFixture, TokenScope, WorkspaceFixture } from "./fixture.js";
import type { RepositorySample } from "./mapping.js";

// The probe implementation of the fixture over one test-only table, created by
// the table owner in a test database and not part of the shipped migrations.
// Its policies show that the matrix can fail: `workspace` is the policy shape
// of doc 05 section 3.2; `permissive` is `USING (true) WITH CHECK (true)`.
//
// The probe holds no query code of its own. The methods over the table are a
// scoped repository built by `@slugbase/db/testing` (the code
// `defineScopedRepository` uses, not entered in the registry), and the suite
// runs them in the transaction of `TestDatabase.tenant`, the production
// `withTenant` bound to the test database, so the matrix tests that and not an
// imitation of it.

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
  /** The four methods of a scoped repository over the table, in the shape of the scoped-repository registry. */
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

/**
 * An instance admin that belongs to neither workspace, for a test to add to the fixture (`{ ...probe.fixture, instanceAdmin: PROBE_INSTANCE_ADMIN }`):
 * the probe fixture holds none, so that a suite not about the instance admin is run as it always was.
 */
export const PROBE_INSTANCE_ADMIN: FixtureInstanceAdmin = {
  instanceAdmin: true,
  accountId: "0192f3a0-0000-7000-8000-00000000d002",
  credentials: "session:0192f3a0-0000-7000-8000-00000000d002",
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

/** The tokens of an account of the workspace, one for each role and scope: it acts with the role of the account. */
function tokenOf(side: "a" | "b", role: PrincipalRole, scope: TokenScope): FixtureToken {
  const accountId = ACCOUNTS[side][role];
  return { role, accountId, scope, credentials: `token:${scope}:${accountId}` };
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
    tokens: (["owner", "admin", "member"] as const).flatMap((role) => (["read", "read-write"] as const).map((scope) => tokenOf(side, role, scope))),
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
  return { table, repository, fixture, methods: testRepositoryMethods(repository, table), sample: PROBE_SAMPLE };
}
