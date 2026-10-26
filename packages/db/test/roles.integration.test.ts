import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useCluster, type ClusterUse } from "../src/testing.ts";

// Applies packages/db/provision/roles.sql to a throwaway database on the
// development Postgres of compose.dev.yml (doc 05 section 3.1, doc 10 T1).

const ROLES_SQL = new URL("../provision/roles.sql", import.meta.url).pathname;
const COMPOSE_DEV = new URL("../../../compose.dev.yml", import.meta.url).pathname;

// The development passwords of compose.dev.yml. Roles are cluster-wide, so
// they may already exist with these passwords, which roles.sql never changes.
const APP_PASSWORD = "slugbase_app_dev_only";
const MIGRATOR_PASSWORD = "slugbase_migrator_dev_only";

const server = new URL(
  process.env.SLUGBASE_TEST_PG_URL ?? "postgres://slugbase:slugbase@127.0.0.1:54329/slugbase_dev",
);

const dbName = `test_roles_${randomBytes(6).toString("hex")}`;
const noSuperRole = `test_nosuper_${randomBytes(6).toString("hex")}`;
const noSuperPassword = randomBytes(12).toString("hex");

interface Login {
  username: string;
  password: string;
}

const superuser: Login = {
  username: decodeURIComponent(server.username),
  password: decodeURIComponent(server.password),
};
const appLogin: Login = { username: "slugbase_app", password: APP_PASSWORD };
const migratorLogin: Login = { username: "slugbase_migrator", password: MIGRATOR_PASSWORD };

// Roles are cluster-wide. This file reads them like every test database does,
// so it holds the cluster shared for its whole run, and the drift test, which
// changes them, holds it exclusively for that test alone (`@slugbase/db/testing`).
const ROLE_NAMES = ["slugbase_app", "slugbase_migrator", "slugbase_owner", "slugbase_system"];

// Waiting for another run to release the cluster lock counts against this.
const HOOK_TIMEOUT_MS = 300_000;

const clients: postgres.Sql[] = [];

function connect(login: Login, database: string): postgres.Sql {
  const client = postgres({
    host: server.hostname,
    port: Number(server.port),
    database,
    username: login.username,
    password: login.password,
    max: 1,
    onnotice: () => undefined,
  });
  clients.push(client);
  return client;
}

interface PsqlResult {
  status: number | null;
  stderr: string;
}

function runRolesSql(options: {
  login: Login;
  args?: string[];
  env?: Record<string, string>;
}): PsqlResult {
  const result = spawnSync(
    "psql",
    ["-X", "-v", "ON_ERROR_STOP=1", ...(options.args ?? []), "-f", ROLES_SQL],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        PGHOST: server.hostname,
        PGPORT: server.port,
        PGDATABASE: dbName,
        PGUSER: options.login.username,
        PGPASSWORD: options.login.password,
        ...options.env,
      },
    },
  );
  if (result.error) {
    throw result.error;
  }
  return { status: result.status, stderr: result.stderr };
}

async function sqlState(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    if (error instanceof postgres.PostgresError) {
      return error.code;
    }
    throw error;
  }
  return undefined;
}

async function snapshot(sql: postgres.Sql): Promise<Record<string, unknown>> {
  const roles = await sql`
    SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin,
           rolreplication, rolbypassrls, rolconnlimit, rolpassword, rolvaliduntil
    FROM pg_authid WHERE rolname = ANY(${ROLE_NAMES}) ORDER BY rolname`;
  const memberships = await sql`
    SELECT pg_get_userbyid(roleid) AS role, pg_get_userbyid(member) AS member,
           pg_get_userbyid(grantor) AS grantor, admin_option, inherit_option, set_option
    FROM pg_auth_members
    WHERE pg_get_userbyid(roleid) = ANY(${ROLE_NAMES}) OR pg_get_userbyid(member) = ANY(${ROLE_NAMES})
    ORDER BY 1, 2, 3`;
  const database = await sql`
    SELECT datacl::text AS acl FROM pg_database WHERE datname = current_database()`;
  const schemas = await sql`
    SELECT nspname, pg_get_userbyid(nspowner) AS owner, nspacl::text AS acl
    FROM pg_namespace ORDER BY nspname`;
  return { roles, memberships, database, schemas };
}

let cluster: ClusterUse | undefined;
let admin: postgres.Sql;
let owner: postgres.Sql;
let app: postgres.Sql;
let migrator: postgres.Sql;
let afterFirstRun: Record<string, unknown>;
let afterSecondRun: Record<string, unknown>;
let firstRun: PsqlResult;
let secondRun: PsqlResult;
let schemaCreatePublicBefore: number;

beforeAll(async () => {
  cluster = await useCluster();
  admin = connect(superuser, server.pathname.slice(1));
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  owner = connect(superuser, dbName);

  // Schemas that grant CREATE to everyone, as in a database that predates the
  // restricted public schema.
  await owner.unsafe("CREATE SCHEMA extra_schema");
  await owner.unsafe("GRANT CREATE ON SCHEMA extra_schema, public TO PUBLIC");
  const open = await owner<{ count: string }[]>`
    SELECT count(*) FROM pg_namespace n, aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
    WHERE n.nspname IN ('extra_schema', 'public') AND a.grantee = 0 AND a.privilege_type = 'CREATE'`;
  schemaCreatePublicBefore = Number(open[0]?.count);

  firstRun = runRolesSql({
    login: superuser,
    args: ["-v", `app_password=${APP_PASSWORD}`, "-v", `migrator_password=${MIGRATOR_PASSWORD}`],
  });
  afterFirstRun = await snapshot(owner);

  // The second run takes the passwords from the environment, the way the
  // Postgres image's init directory runs the file.
  secondRun = runRolesSql({
    login: superuser,
    env: { PROVISION_APP_PASSWORD: APP_PASSWORD, PROVISION_MIGRATOR_PASSWORD: MIGRATOR_PASSWORD },
  });
  afterSecondRun = await snapshot(owner);

  migrator = connect(migratorLogin, dbName);
  app = connect(appLogin, dbName);

  // Schema objects are created the way `migrate` does: as the migrator, after
  // SET ROLE slugbase_owner. The policy compares against the tenant setting
  // that withTenant() sets transaction-locally.
  await migrator.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE slugbase_owner");
    for (const table of ["notes", "notes_unforced"]) {
      await tx.unsafe(`CREATE TABLE ${table} (workspace_id text NOT NULL, body text NOT NULL)`);
      await tx.unsafe(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await tx.unsafe(
        `CREATE POLICY tenant ON ${table}
           USING (workspace_id = current_setting('app.workspace_id', true))
           WITH CHECK (workspace_id = current_setting('app.workspace_id', true))`,
      );
      await tx.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO slugbase_app`);
    }
    await tx.unsafe("ALTER TABLE notes FORCE ROW LEVEL SECURITY");
    await tx`SELECT set_config('app.workspace_id', 'ws-1', true)`;
    await tx.unsafe("INSERT INTO notes VALUES ('ws-1', 'a'), ('ws-1', 'b')");
    await tx.unsafe("INSERT INTO notes_unforced VALUES ('ws-1', 'a'), ('ws-1', 'b')");
    await tx`SELECT set_config('app.workspace_id', 'ws-2', true)`;
    await tx.unsafe("INSERT INTO notes VALUES ('ws-2', 'c')");
    await tx.unsafe("INSERT INTO notes_unforced VALUES ('ws-2', 'c')");
  });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  try {
    await Promise.all(
      clients.filter((client) => client !== admin).map((client) => client.end({ timeout: 5 })),
    );
    const cleanup = postgres({
      host: server.hostname,
      port: Number(server.port),
      database: server.pathname.slice(1),
      username: superuser.username,
      password: superuser.password,
      max: 1,
    });
    try {
      await cleanup.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await cleanup.unsafe(`DROP ROLE IF EXISTS ${noSuperRole}`);
    } finally {
      await cleanup.end({ timeout: 5 });
    }
  } finally {
    try {
      await admin.end({ timeout: 5 });
    } finally {
      await cluster?.release();
    }
  }
}, HOOK_TIMEOUT_MS);

describe("provisioning script", () => {
  it("applies with the passwords as psql variables and again with them in the environment", () => {
    expect(firstRun.stderr).not.toMatch(/ERROR/);
    expect(firstRun.status).toBe(0);
    expect(secondRun.stderr).not.toMatch(/ERROR/);
    expect(secondRun.status).toBe(0);
  });

  it("is idempotent: a second run changes no role, password, membership or privilege", () => {
    expect(afterSecondRun).toEqual(afterFirstRun);
  });

  it("revokes CREATE from PUBLIC on a schema that granted it", () => {
    expect(schemaCreatePublicBefore).toBe(2);
  });

  it("refuses to run as a non-superuser, with a clear message, and changes nothing", async () => {
    await admin.unsafe(`CREATE ROLE ${noSuperRole} LOGIN PASSWORD '${noSuperPassword}'`);
    const before = await snapshot(owner);
    const result = runRolesSql({
      login: { username: noSuperRole, password: noSuperPassword },
      args: ["-v", `app_password=${APP_PASSWORD}`, "-v", `migrator_password=${MIGRATOR_PASSWORD}`],
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("roles.sql must be run by a superuser");
    expect(await snapshot(owner)).toEqual(before);
  });

  it("refuses to run without the passwords, with a clear message", () => {
    const result = runRolesSql({ login: superuser });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("app_password");
  });

  it("refuses an empty password", () => {
    const result = runRolesSql({
      login: superuser,
      args: ["-v", "app_password=", "-v", `migrator_password=${MIGRATOR_PASSWORD}`],
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must not be empty");
  });
});

describe("roles in pg_roles", () => {
  type RoleRow = {
    rolname: string;
    rolsuper: boolean;
    rolcanlogin: boolean;
    rolbypassrls: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
    rolreplication: boolean;
  };

  it("has the four roles with the attributes of doc 05 section 3.1", async () => {
    const rows = await owner<RoleRow[]>`
      SELECT rolname, rolsuper, rolcanlogin, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication
      FROM pg_roles WHERE rolname = ANY(${ROLE_NAMES}) ORDER BY rolname`;
    const expected = (name: string, canLogin: boolean, bypassRls: boolean): RoleRow => ({
      rolname: name,
      rolsuper: false,
      rolcanlogin: canLogin,
      rolbypassrls: bypassRls,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
    });
    expect([...rows]).toEqual([
      expected("slugbase_app", true, false),
      expected("slugbase_migrator", true, false),
      expected("slugbase_owner", false, false),
      expected("slugbase_system", false, true),
    ]);
  });

  it("makes the migrator a member of slugbase_owner and slugbase_owner a member of slugbase_system, and nothing else", async () => {
    const rows = await owner<{ role: string; member: string }[]>`
      SELECT pg_get_userbyid(roleid) AS role, pg_get_userbyid(member) AS member
      FROM pg_auth_members
      WHERE pg_get_userbyid(roleid) = ANY(${ROLE_NAMES}) OR pg_get_userbyid(member) = ANY(${ROLE_NAMES})`;
    expect([...rows].sort((a, b) => a.role.localeCompare(b.role))).toEqual([
      { role: "slugbase_owner", member: "slugbase_migrator" },
      { role: "slugbase_system", member: "slugbase_owner" },
    ]);
    const options = await owner<{ role: string; member: string; inherit: boolean; set: boolean; admin: boolean }[]>`
      SELECT pg_get_userbyid(roleid) AS role, pg_get_userbyid(member) AS member,
             inherit_option AS inherit, set_option AS set, admin_option AS admin
      FROM pg_auth_members
      WHERE pg_get_userbyid(roleid) = ANY(${ROLE_NAMES}) ORDER BY 1`;
    expect([...options]).toEqual([
      { role: "slugbase_owner", member: "slugbase_migrator", inherit: false, set: true, admin: false },
      { role: "slugbase_system", member: "slugbase_owner", inherit: true, set: true, admin: false },
    ]);
  });

  it("lets nobody own an object but slugbase_owner", async () => {
    const rows = await owner<{ role: string; owned: string }[]>`
      SELECT r.rolname AS role, count(*)::text AS owned
      FROM pg_shdepend d JOIN pg_roles r ON r.oid = d.refobjid
      WHERE d.refclassid = 'pg_authid'::regclass AND d.deptype = 'o'
        AND d.dbid IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
        AND r.rolname = ANY(${ROLE_NAMES})
      GROUP BY r.rolname`;
    expect(rows.map((row) => row.role)).toEqual(["slugbase_owner"]);
    const tables = await owner<{ tableowner: string }[]>`
      SELECT tableowner FROM pg_tables WHERE tablename IN ('notes', 'notes_unforced')`;
    expect(tables.map((row) => row.tableowner)).toEqual(["slugbase_owner", "slugbase_owner"]);
  });

  it("grants CREATE on no schema to PUBLIC, slugbase_app or slugbase_migrator", async () => {
    const rows = await owner<{ nspname: string }[]>`
      SELECT n.nspname FROM pg_namespace n
      WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
        AND (has_schema_privilege('slugbase_app', n.oid, 'CREATE')
          OR has_schema_privilege('slugbase_migrator', n.oid, 'CREATE')
          OR EXISTS (
            SELECT 1 FROM aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
            WHERE a.grantee = 0 AND a.privilege_type = 'CREATE'))`;
    expect(rows.map((row) => row.nspname)).toEqual([]);
  });
});

describe("behaviour of the roles", () => {
  it("slugbase_app cannot create a table or a schema", async () => {
    expect(await sqlState(() => app.unsafe("CREATE TABLE public.nope (id int)"))).toBe("42501");
    expect(await sqlState(() => app.unsafe("CREATE SCHEMA nope"))).toBe("42501");
  });

  it("slugbase_app cannot SET ROLE slugbase_owner or slugbase_system", async () => {
    expect(await sqlState(() => app.unsafe("SET ROLE slugbase_owner"))).toBe("42501");
    expect(await sqlState(() => app.unsafe("SET ROLE slugbase_system"))).toBe("42501");
  });

  it("slugbase_app holds neither TRUNCATE nor REFERENCES on a table it can read and write", async () => {
    const rows = await owner<{ truncate: boolean; references: boolean; select: boolean }[]>`
      SELECT has_table_privilege('slugbase_app', 'notes', 'TRUNCATE') AS truncate,
             has_table_privilege('slugbase_app', 'notes', 'REFERENCES') AS references,
             has_table_privilege('slugbase_app', 'notes', 'SELECT') AS select`;
    expect([...rows]).toEqual([{ truncate: false, references: false, select: true }]);
    expect(await sqlState(() => app.unsafe("TRUNCATE notes"))).toBe("42501");
  });

  it("the migrator cannot create a table until it sets role to slugbase_owner", async () => {
    expect(await sqlState(() => migrator.unsafe("CREATE TABLE public.direct (id int)"))).toBe(
      "42501",
    );
    await migrator.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE slugbase_owner");
      await tx.unsafe("CREATE TABLE public.via_owner (id int)");
    });
    const rows = await owner<{ tableowner: string }[]>`
      SELECT tableowner FROM pg_tables WHERE tablename = 'via_owner'`;
    expect(rows.map((row) => row.tableowner)).toEqual(["slugbase_owner"]);
  });
});

describe("slugbase_system", () => {
  it("is reached through slugbase_owner only, and can create nothing", async () => {
    await migrator.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE slugbase_owner");
      await tx.unsafe("SET LOCAL ROLE slugbase_system");
      const role = await tx<{ current_user: string }[]>`SELECT current_user`;
      expect(role[0]?.current_user).toBe("slugbase_system");
    });
    await expect(
      migrator.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE slugbase_system");
        await tx.unsafe("CREATE TABLE public.via_system (id int)");
      }),
    ).rejects.toMatchObject({ code: "42501" });
    expect(await sqlState(() => app.unsafe("SET ROLE slugbase_system"))).toBe("42501");
  });

  it("is not passed on to slugbase_app, and keeps BYPASSRLS to itself", async () => {
    const rows = await owner<{ app_bypass: boolean; owner_bypass: boolean; owner_inherits_system: boolean }[]>`
      SELECT (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'slugbase_app') AS app_bypass,
             (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'slugbase_owner') AS owner_bypass,
             pg_has_role('slugbase_owner', 'slugbase_system', 'USAGE') AS owner_inherits_system`;
    expect([...rows]).toEqual([{ app_bypass: false, owner_bypass: false, owner_inherits_system: true }]);
  });
});

describe("row-level security is the boundary (T1, Q56)", () => {
  async function count(sql: postgres.Sql, table: string): Promise<number> {
    const rows = await sql.unsafe<{ count: string }[]>(`SELECT count(*)::text AS count FROM ${table}`);
    return Number(rows[0]?.count);
  }

  it("slugbase_app sees no row outside a tenant, forced RLS or not", async () => {
    expect(await count(app, "notes")).toBe(0);
    expect(await count(app, "notes_unforced")).toBe(0);
  });

  it("slugbase_app sees exactly the rows of the tenant its transaction sets", async () => {
    const seen = await app.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', 'ws-1', true)`;
      return tx.unsafe<{ body: string }[]>("SELECT body FROM notes ORDER BY body");
    });
    expect(seen.map((row) => row.body)).toEqual(["a", "b"]);
  });

  it("a superuser sees every row, so the application must never connect as one", async () => {
    expect(await count(owner, "notes")).toBe(3);
    expect(await count(owner, "notes_unforced")).toBe(3);
  });

  it("the table owner sees every row unless RLS is forced, so the application must never connect as it", async () => {
    const asOwner = (table: string) =>
      migrator.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE slugbase_owner");
        return count(tx as unknown as postgres.Sql, table);
      });
    expect(await asOwner("notes_unforced")).toBe(3);
    expect(await asOwner("notes")).toBe(0);
  });
});

describe("compose.dev.yml", () => {
  it("passes the development passwords and mounts the script into the init directory", () => {
    const compose = readFileSync(COMPOSE_DEV, "utf8");
    expect(compose).toContain(`PROVISION_APP_PASSWORD: ${APP_PASSWORD}`);
    expect(compose).toContain(`PROVISION_MIGRATOR_PASSWORD: ${MIGRATOR_PASSWORD}`);
    expect(compose).toContain(
      "./packages/db/provision/roles.sql:/docker-entrypoint-initdb.d/10-roles.sql",
    );
  });
});

// The one test that changes the roles of the cluster: every test database of
// every run waits for this step, and it waits for each of them to be dropped, so
// it takes the cluster exclusively from just before the test until just after it.
// The roles are converged once more before the cluster is given back, so a test
// that failed half way leaves no drift behind for the others.
describe("a run converges drifted roles", () => {
  let endStep: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    endStep = await cluster?.lockExclusive();
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    try {
      const result = runRolesSql({
        login: superuser,
        args: ["-v", `app_password=${APP_PASSWORD}`, "-v", `migrator_password=${MIGRATOR_PASSWORD}`],
      });
      expect(result.status).toBe(0);
    } finally {
      await endStep?.();
    }
  }, HOOK_TIMEOUT_MS);

  it("restores attributes and memberships changed by hand", async () => {
    await owner.unsafe("ALTER ROLE slugbase_app BYPASSRLS");
    await owner.unsafe("GRANT slugbase_owner TO slugbase_app");
    await owner.unsafe("REVOKE slugbase_owner FROM slugbase_migrator");
    await owner.unsafe("GRANT slugbase_owner TO slugbase_migrator WITH INHERIT TRUE");
    const result = runRolesSql({
      login: superuser,
      args: ["-v", `app_password=${APP_PASSWORD}`, "-v", `migrator_password=${MIGRATOR_PASSWORD}`],
    });
    expect(result.status).toBe(0);
    expect(await snapshot(owner)).toEqual(afterFirstRun);
  });
});
