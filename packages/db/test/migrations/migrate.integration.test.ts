import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CE_CHAIN,
  migrate,
  MigrationError,
  migrationLevel,
  type MigrationChain,
} from "../../src/migrate.ts";

// Runs the migration engine against throwaway databases on the development
// Postgres of compose.dev.yml (doc 08 section 3.4). Every database is
// provisioned with provision/roles.sql and migrated as slugbase_migrator, the
// way the product does it; the superuser only creates and inspects databases.

const ROLES_SQL = new URL("../../provision/roles.sql", import.meta.url).pathname;
const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;

const APP_PASSWORD = "slugbase_app_dev_only";
const MIGRATOR_PASSWORD = "slugbase_migrator_dev_only";

const server = new URL(
  process.env.SLUGBASE_TEST_PG_URL ?? "postgres://slugbase:slugbase@127.0.0.1:54329/slugbase_dev",
);

// Roles are cluster-wide and the roles test changes them, so this file holds
// the cluster lock of that test for its whole run.
const CLUSTER_LOCK_KEY = 7_354_190_025;
const HOOK_TIMEOUT_MS = 300_000;

function fixture(name: string): MigrationChain {
  return { name, folder: join(FIXTURES, name), bookkeepingTable: `migrations_${name}` };
}

function connectAs(username: string, password: string, database: string): postgres.Sql {
  return postgres({
    host: server.hostname,
    port: Number(server.port),
    database,
    username,
    password,
    max: 1,
    onnotice: () => undefined,
  });
}

function migratorUrl(database: string, password = MIGRATOR_PASSWORD): string {
  return `postgres://slugbase_migrator:${encodeURIComponent(password)}@${server.hostname}:${server.port}/${database}`;
}

// The role the server reads the migration level as.
function appUrl(database: string): string {
  return `postgres://slugbase_app:${APP_PASSWORD}@${server.hostname}:${server.port}/${database}`;
}

const clients: postgres.Sql[] = [];
const databases: string[] = [];
const scratchDirectories: string[] = [];
let admin: postgres.Sql;

function track(client: postgres.Sql): postgres.Sql {
  clients.push(client);
  return client;
}

function superuser(database: string): postgres.Sql {
  return track(
    connectAs(decodeURIComponent(server.username), decodeURIComponent(server.password), database),
  );
}

async function createDatabase(): Promise<{ name: string; owner: postgres.Sql }> {
  const name = `test_migrate_${randomBytes(6).toString("hex")}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  databases.push(name);
  const result = spawnSync("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-f", ROLES_SQL], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      PGHOST: server.hostname,
      PGPORT: server.port,
      PGDATABASE: name,
      PGUSER: decodeURIComponent(server.username),
      PGPASSWORD: decodeURIComponent(server.password),
      PROVISION_APP_PASSWORD: APP_PASSWORD,
      PROVISION_MIGRATOR_PASSWORD: MIGRATOR_PASSWORD,
    },
  });
  if (result.error) {
    throw result.error;
  }
  expect(result.stderr).not.toMatch(/ERROR/);
  expect(result.status).toBe(0);
  return { name, owner: superuser(name) };
}

async function rejection(run: Promise<unknown>): Promise<MigrationError> {
  try {
    await run;
  } catch (error) {
    expect(error).toBeInstanceOf(MigrationError);
    return error as MigrationError;
  }
  throw new Error("expected the promise to reject");
}

async function recordedRows(owner: postgres.Sql, table: string): Promise<number> {
  const rows = await owner.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM drizzle.${table}`);
  return rows[0]?.n ?? -1;
}

// Taking the lock to test it would hold it, so it is given back at once.
async function migrateLockIsFree(owner: postgres.Sql): Promise<boolean> {
  const rows = await owner<{ free: boolean }[]>`SELECT pg_try_advisory_lock(hashtext('slugbase.migrate')) AS free`;
  if (rows[0]?.free === true) {
    await owner`SELECT pg_advisory_unlock(hashtext('slugbase.migrate'))`;
    return true;
  }
  return false;
}

async function tableExists(owner: postgres.Sql, table: string): Promise<boolean> {
  const rows = await owner<{ present: boolean }[]>`SELECT to_regclass(${table}) IS NOT NULL AS present`;
  return rows[0]?.present === true;
}

interface Journal {
  entries: { tag: string }[];
}

function journalLength(folder: string): number {
  return (JSON.parse(readFileSync(join(folder, "meta", "_journal.json"), "utf8")) as Journal).entries.length;
}

const CE_MIGRATIONS = journalLength(CE_CHAIN.folder);

beforeAll(async () => {
  admin = track(connectAs(decodeURIComponent(server.username), decodeURIComponent(server.password), server.pathname.slice(1)));
  await admin`SELECT pg_advisory_lock(${CLUSTER_LOCK_KEY})`;
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  try {
    await Promise.all(clients.filter((client) => client !== admin).map((client) => client.end({ timeout: 5 })));
    for (const name of databases) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }
    for (const directory of scratchDirectories) {
      rmSync(directory, { recursive: true, force: true });
    }
  } finally {
    // Ending the session releases the cluster lock.
    await admin.end({ timeout: 5 });
  }
}, HOOK_TIMEOUT_MS);

describe("several replicas starting at once (D25)", () => {
  it("apply every chain exactly once, and all of them resolve", async () => {
    const { name, owner } = await createDatabase();
    const chains = [fixture("concurrent")];

    const runs = await Promise.all([1, 2, 3].map(() => migrate({ url: migratorUrl(name), chains })));

    const tags = runs.flatMap((run) => run.applied.map(({ chain, tag }) => `${chain}:${tag}`));
    expect(tags).toHaveLength(CE_MIGRATIONS + 1);
    expect(new Set(tags).size).toBe(tags.length);
    expect(await recordedRows(owner, "migrations_core")).toBe(CE_MIGRATIONS);
    expect(await recordedRows(owner, "migrations_concurrent")).toBe(1);
    expect(await tableExists(owner, "concurrent_probe")).toBe(true);
  }, 60_000);

  it("find nothing to do on a second run", async () => {
    const { name } = await createDatabase();
    await migrate({ url: migratorUrl(name), chains: [fixture("concurrent")] });
    expect(await migrate({ url: migratorUrl(name), chains: [fixture("concurrent")] })).toEqual({ applied: [] });
  }, 60_000);
});

describe("the session of a run", () => {
  it("sets the timeouts, does its DDL as slugbase_owner and applies a second chain after the CE chain", async () => {
    const { name, owner } = await createDatabase();

    const result = await migrate({ url: migratorUrl(name), chains: [fixture("session")] });

    const chains = result.applied.map(({ chain }) => chain);
    expect(chains).toEqual([...Array<string>(CE_MIGRATIONS).fill("core"), "session", "session"]);
    const probe = await owner`SELECT lock_timeout, statement_timeout, role_in_use, login_role FROM session_probe`;
    expect(probe[0]).toEqual({
      lock_timeout: "5s",
      statement_timeout: "15min",
      role_in_use: "slugbase_owner",
      login_role: "slugbase_migrator",
    });
    const owners = await owner<{ relname: string; owner: string }[]>`
      SELECT c.relname, pg_get_userbyid(c.relowner) AS owner FROM pg_class c
      WHERE c.relname IN ('session_probe', 'migrations_core', 'migrations_session', 'session_probe_login_role_idx')
      ORDER BY c.relname`;
    expect(owners.map((row) => row.owner)).toEqual(Array<string>(4).fill("slugbase_owner"));
    const schema = await owner<{ owner: string }[]>`
      SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'drizzle'`;
    expect(schema[0]).toEqual({ owner: "slugbase_owner" });
    expect(await recordedRows(owner, "migrations_core")).toBe(CE_MIGRATIONS);
    expect(await recordedRows(owner, "migrations_session")).toBe(2);
  }, 60_000);

  it("applies a non-transactional step outside a transaction, which leaves a valid index", async () => {
    const { name, owner } = await createDatabase();
    await migrate({ url: migratorUrl(name), chains: [fixture("session")] });
    const rows = await owner<{ indisvalid: boolean }[]>`
      SELECT indisvalid FROM pg_index WHERE indexrelid = 'session_probe_login_role_idx'::regclass`;
    expect(rows[0]).toEqual({ indisvalid: true });
  }, 60_000);

  it("releases the advisory lock when it is done", async () => {
    const { name, owner } = await createDatabase();
    await migrate({ url: migratorUrl(name) });
    expect(await migrateLockIsFree(owner)).toBe(true);
  }, 60_000);
});

describe("a failing migration", () => {
  it("rolls back, leaves the earlier migrations recorded, releases the lock and names the migration", async () => {
    const { name, owner } = await createDatabase();

    const error = await rejection(migrate({ url: migratorUrl(name), chains: [fixture("failing")] }));

    expect(error.message).toContain("20300101000002_add_failing_second");
    expect(error.message).toContain('chain "failing"');
    expect(error.code).toBe("22012");
    expect(await tableExists(owner, "failing_first")).toBe(true);
    expect(await tableExists(owner, "failing_second")).toBe(false);
    expect(await recordedRows(owner, "migrations_core")).toBe(CE_MIGRATIONS);
    expect(await recordedRows(owner, "migrations_failing")).toBe(1);
    expect(await migrateLockIsFree(owner)).toBe(true);
    expect(await migrationLevel({ url: appUrl(name), chains: [fixture("failing")] })).toEqual({
      expected: CE_MIGRATIONS + 2,
      applied: CE_MIGRATIONS + 1,
      unknownApplied: 0,
    });
  }, 60_000);

  it("leaves the statements of a non-transactional step that ran, records none, and fails again on a re-run", async () => {
    const { name, owner } = await createDatabase();
    await owner.unsafe("CREATE TABLE partial_target (a integer)");
    await owner.unsafe("ALTER TABLE partial_target OWNER TO slugbase_owner");
    const chains = [fixture("partial")];

    const first = await rejection(migrate({ url: migratorUrl(name), chains }));
    expect(first.code).toBe("42703");
    const indexes = await owner<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'partial_target'`;
    expect(indexes.map((row) => row.indexname)).toEqual(["partial_a_idx"]);
    expect(await recordedRows(owner, "migrations_partial")).toBe(0);

    const second = await rejection(migrate({ url: migratorUrl(name), chains }));
    expect(second.code).toBe("42P07");
    expect(await recordedRows(owner, "migrations_partial")).toBe(0);
  }, 60_000);

  it("is refused before anything is applied when an applied migration was changed afterwards", async () => {
    const { name, owner } = await createDatabase();
    const directory = mkdtempSync(join(tmpdir(), "slugbase-migrate-"));
    scratchDirectories.push(directory);
    const folder = join(directory, "concurrent");
    cpSync(join(FIXTURES, "concurrent"), folder, { recursive: true });
    const chain: MigrationChain = { name: "concurrent", folder, bookkeepingTable: "migrations_concurrent" };
    await migrate({ url: migratorUrl(name), chains: [chain] });

    writeFileSync(join(folder, "20300101000001_add_concurrent_probe.sql"), "SELECT 1;\n");
    const error = await rejection(migrate({ url: migratorUrl(name), chains: [chain] }));

    expect(error.message).toContain("checksum mismatch");
    expect(await recordedRows(owner, "migrations_concurrent")).toBe(1);
  }, 60_000);
});

describe("lock_timeout (doc 05 section 5.2)", () => {
  it("fails a migration blocked by a table lock within the timeout instead of queueing", async () => {
    const { name, owner } = await createDatabase();
    await owner.unsafe("CREATE TABLE locked_target (id integer)");
    await owner.unsafe("ALTER TABLE locked_target OWNER TO slugbase_owner");
    const holder = superuser(name);
    let locked!: () => void;
    let release!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const mayRelease = new Promise<void>((resolve) => (release = resolve));
    const holding = holder.begin(async (tx) => {
      await tx.unsafe("LOCK TABLE locked_target IN ACCESS EXCLUSIVE MODE");
      locked();
      await mayRelease;
    });
    await isLocked;

    const chains = [fixture("blocked")];
    const started = Date.now();
    let error: MigrationError;
    try {
      error = await rejection(migrate({ url: migratorUrl(name), chains }));
    } finally {
      release();
      await holding;
    }
    const elapsed = Date.now() - started;

    expect(error.code).toBe("55P03");
    expect(elapsed).toBeGreaterThanOrEqual(4_500);
    expect(elapsed).toBeLessThan(20_000);
    expect(await recordedRows(owner, "migrations_blocked")).toBe(0);
    expect(await migrateLockIsFree(owner)).toBe(true);

    expect((await migrate({ url: migratorUrl(name), chains })).applied).toHaveLength(1);
  }, 60_000);
});

describe("migrationLevel", () => {
  it("counts nothing applied on a database no migration ran on", async () => {
    const { name } = await createDatabase();
    expect(await migrationLevel({ url: appUrl(name), chains: [fixture("session")] })).toEqual({
      expected: CE_MIGRATIONS + 2,
      applied: 0,
      unknownApplied: 0,
    });
  }, 60_000);

  it("tells behind from level from ahead", async () => {
    const { name, owner } = await createDatabase();
    const chains = [fixture("session")];
    await migrate({ url: migratorUrl(name), chains });
    const expected = CE_MIGRATIONS + 2;

    expect(await migrationLevel({ url: appUrl(name), chains })).toEqual({ expected, applied: expected, unknownApplied: 0 });

    await owner.unsafe("DELETE FROM drizzle.migrations_session WHERE created_at = (SELECT max(created_at) FROM drizzle.migrations_session)");
    expect(await migrationLevel({ url: appUrl(name), chains })).toEqual({ expected, applied: expected - 1, unknownApplied: 0 });

    await owner.unsafe("INSERT INTO drizzle.migrations_core (hash, created_at) VALUES ('later-release', 4102444800000)");
    expect(await migrationLevel({ url: appUrl(name), chains })).toEqual({ expected, applied: expected - 1, unknownApplied: 1 });
  }, 60_000);

  it("rejects, rather than counting nothing applied, when the bookkeeping table cannot be read", async () => {
    const { name, owner } = await createDatabase();
    await migrate({ url: migratorUrl(name) });
    expect(await migrationLevel({ url: appUrl(name) })).toEqual({
      expected: CE_MIGRATIONS,
      applied: CE_MIGRATIONS,
      unknownApplied: 0,
    });
    await owner.unsafe("REVOKE SELECT ON drizzle.migrations_core FROM slugbase_app");
    const error = await rejection(migrationLevel({ url: appUrl(name) }));
    expect(error.code).toBe("42501");
  }, 60_000);
});

describe("errors never carry the connection string or the password (T7)", () => {
  const password = `pw-${randomBytes(6).toString("hex")}`;

  function expectClean(error: MigrationError, url: string): void {
    for (const secret of [url, password, encodeURIComponent(password)]) {
      expect(error.message).not.toContain(secret);
      expect(String(error.code)).not.toContain(secret);
    }
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(password);
  }

  it("when authentication fails", async () => {
    const { name } = await createDatabase();
    const url = migratorUrl(name, password);
    expectClean(await rejection(migrate({ url })), url);
    expectClean(await rejection(migrationLevel({ url })), url);
  }, 60_000);

  it("when the server cannot be reached", async () => {
    const url = `postgres://slugbase_migrator:${password}@127.0.0.1:1/nowhere`;
    expectClean(await rejection(migrate({ url })), url);
  }, 60_000);

  it("when a migration fails", async () => {
    const { name } = await createDatabase();
    const url = migratorUrl(name);
    const error = await rejection(migrate({ url, chains: [fixture("failing")] }));
    expect(error.message).not.toContain(MIGRATOR_PASSWORD);
    expect(error.message).not.toContain(url);
  }, 60_000);
});
