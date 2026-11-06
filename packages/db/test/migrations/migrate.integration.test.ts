import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CE_CHAIN,
  isNonTransactional,
  migrate,
  MigrationError,
  migrationLevel,
  type MigrationChain,
} from "../../src/migrate.ts";
import { useCluster, type ClusterUse } from "../../src/testing.ts";

// Runs the migration engine against throwaway databases on the development
// Postgres of compose.dev.yml (doc 08 section 3.4). Every database is
// provisioned with provision/roles.sql and migrated as slugbase_migrator, the
// way the product does it; the superuser only creates and inspects databases.

const ROLES_SQL = fileURLToPath(new URL("../../provision/roles.sql", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

const APP_PASSWORD = "slugbase_app_dev_only";
const MIGRATOR_PASSWORD = "slugbase_migrator_dev_only";

const server = new URL(
  process.env.SLUGBASE_TEST_PG_URL ?? "postgres://slugbase:slugbase@127.0.0.1:54329/slugbase_dev",
);

// Roles are cluster-wide and the roles test changes them for a step, so this
// file holds the cluster shared, like a test database, for its whole run.
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
let cluster: ClusterUse | undefined;
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

// The server's answer to a terminated backend, as the wire protocol carries it.
function terminationResponse(): Buffer {
  const fields = ["SFATAL", "VFATAL", "C57P01", "Mterminating connection due to administrator command"];
  const body = Buffer.concat([...fields.map((field) => Buffer.from(`${field}\0`)), Buffer.from("\0")]);
  const header = Buffer.alloc(5);
  header.write("E");
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}

// A relay between a client and the development Postgres that, instead of
// forwarding a client write, ends the connection: the first write containing
// the given statement text, or the one `writesAfter` writes later (the driver
// sends a prepared statement's text once). The client then loses its connection
// at a known point, with that write in flight. By default both sockets are
// closed at once; with `terminated` the client first gets the server's
// termination error and the sockets close 100 ms later, the way a terminated
// backend shows to a client.
interface Relay {
  url: (database: string) => string;
  close: () => Promise<void>;
}

async function relayDroppingAt(statement: string, writesAfter = 0, terminated = false): Promise<Relay> {
  const sockets = new Set<Socket>();
  let matched = false;
  let wait = writesAfter;
  const listener: Server = createServer((client) => {
    const upstream = connect({ host: server.hostname, port: Number(server.port) });
    sockets.add(client);
    sockets.add(upstream);
    let dropping = false;
    const dropBoth = (): void => {
      client.destroy();
      upstream.destroy();
    };
    client.on("data", (chunk: Buffer) => {
      if (dropping) {
        return;
      }
      matched ||= chunk.includes(statement);
      if (matched && wait-- === 0) {
        dropping = true;
        if (terminated) {
          client.write(terminationResponse());
          setTimeout(dropBoth, 100);
        } else {
          dropBoth();
        }
        return;
      }
      upstream.write(chunk);
    });
    upstream.on("data", (chunk: Buffer) => client.write(chunk));
    client.on("error", dropBoth);
    upstream.on("error", dropBoth);
    client.on("close", dropBoth);
    upstream.on("close", dropBoth);
  });
  await new Promise<void>((resolve) => {
    listener.listen(0, "127.0.0.1", resolve);
  });
  const { port } = listener.address() as { port: number };
  return {
    url: (database) =>
      `postgres://slugbase_migrator:${encodeURIComponent(MIGRATOR_PASSWORD)}@127.0.0.1:${String(port)}/${database}`,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        listener.close(() => {
          resolve();
        });
      });
    },
  };
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

// The CE chain builds indexes concurrently too, so a test that holds a snapshot to make the build of a fixture wait applies the CE chain first:
// the build it waits for is then the fixture's, the first one after the snapshot is taken.
async function applyCoreChain(database: string): Promise<void> {
  expect((await migrate({ url: migratorUrl(database), chains: [] })).applied).toHaveLength(CE_MIGRATIONS);
}

// A transaction that has run a query holds a snapshot, and a concurrent index
// build waits for it. Returns the call that ends the transaction.
async function holdSnapshot(database: string): Promise<() => Promise<void>> {
  const holder = superuser(database);
  let held!: () => void;
  let release!: () => void;
  const isHeld = new Promise<void>((resolve) => (held = resolve));
  const mayRelease = new Promise<void>((resolve) => (release = resolve));
  const holding = holder.begin("isolation level repeatable read", async (tx) => {
    await tx.unsafe("SELECT count(*) FROM pg_class");
    held();
    await mayRelease;
  });
  await Promise.race([isHeld, holding]);
  return async () => {
    release();
    await holding;
  };
}

async function waitForBlockedIndexBuild(database: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const rows = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = ${database} AND wait_event_type = 'Lock' AND query ILIKE '%INDEX CONCURRENTLY%'
        AND pid <> pg_backend_pid()`;
    if ((rows[0]?.n ?? 0) > 0) {
      return;
    }
    await sleep(100);
  }
  throw new Error("no concurrent index build is waiting");
}

// Resolves once a slugbase-migrate backend of the database is waiting for a lock
// on a statement containing the given text, i.e. once lock_timeout is running.
async function waitForBlockedStatement(database: string, statement: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const rows = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = ${database} AND application_name = 'slugbase-migrate'
        AND wait_event_type = 'Lock' AND query LIKE ${`%${statement}%`}`;
    if ((rows[0]?.n ?? 0) > 0) {
      return;
    }
    await sleep(50);
  }
  throw new Error("no migration is waiting for the lock");
}

async function indexes(owner: postgres.Sql, names: string[]): Promise<{ name: string; valid: boolean; unique: boolean }[]> {
  return owner<{ name: string; valid: boolean; unique: boolean }[]>`
    SELECT c.relname AS name, i.indisvalid AS valid, i.indisunique AS unique
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname IN ${owner(names)} ORDER BY c.relname`;
}

// A chain of one non-transactional migration holding the given statements, in a scratch folder.
function indexChain(name: string, statements: string[]): MigrationChain {
  const directory = mkdtempSync(join(tmpdir(), "slugbase-migrate-"));
  scratchDirectories.push(directory);
  const folder = join(directory, name);
  const tag = `20300101000001_index_${name}`;
  mkdirSync(join(folder, "meta"), { recursive: true });
  writeFileSync(
    join(folder, `${tag}.sql`),
    `-- slugbase:non-transactional\n${statements.join("\n--> statement-breakpoint\n")}\n`,
  );
  writeFileSync(
    join(folder, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: [{ idx: 0, version: "7", when: 1893456000000, tag, breakpoints: true }],
    }),
  );
  return { name, folder, bookkeepingTable: `migrations_${name}` };
}

async function indexIdentities(owner: postgres.Sql, names: string[]): Promise<{ name: string; oid: string; definition: string }[]> {
  return owner<{ name: string; oid: string; definition: string }[]>`
    SELECT c.relname AS name, c.oid::text AS oid, pg_get_indexdef(c.oid) AS definition
    FROM pg_class c WHERE c.relkind = 'i' AND c.relname IN ${owner(names)} ORDER BY c.relname`;
}

beforeAll(async () => {
  cluster = await useCluster();
  admin = track(connectAs(decodeURIComponent(server.username), decodeURIComponent(server.password), server.pathname.slice(1)));
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
    try {
      await admin.end({ timeout: 5 });
    } finally {
      await cluster?.release();
    }
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
  it("sets the timeouts and keepalives, does its DDL as slugbase_owner and applies a second chain after the CE chain", async () => {
    const { name, owner } = await createDatabase();

    const result = await migrate({ url: migratorUrl(name), chains: [fixture("session")] });

    const chains = result.applied.map(({ chain }) => chain);
    expect(chains).toEqual([...Array<string>(CE_MIGRATIONS).fill("core"), "session", "session"]);
    const probe = await owner`
      SELECT lock_timeout, statement_timeout, client_connection_check_interval,
        tcp_keepalives_idle, tcp_keepalives_interval, tcp_keepalives_count, role_in_use, login_role
      FROM session_probe`;
    expect(probe[0]).toEqual({
      lock_timeout: "5s",
      statement_timeout: "15min",
      client_connection_check_interval: "1s",
      tcp_keepalives_idle: "60",
      tcp_keepalives_interval: "10",
      tcp_keepalives_count: "6",
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

  it("fails when its connection is replaced while it waits for the lock", async () => {
    const { name } = await createDatabase();
    const holder = superuser(name);
    await holder`SELECT pg_advisory_lock(hashtext('slugbase.migrate'))`;
    const run = rejection(migrate({ url: migratorUrl(name) }));
    run.catch(() => undefined);
    try {
      let terminated = 0;
      for (let attempt = 0; attempt < 100 && terminated === 0; attempt++) {
        const rows = await admin<{ n: number }[]>`
          SELECT count(pg_terminate_backend(pid))::int AS n FROM pg_stat_activity
          WHERE datname = ${name} AND application_name = 'slugbase-migrate' AND state = 'idle'
            AND query LIKE '%pg_try_advisory_lock%'`;
        terminated = rows[0]?.n ?? 0;
        if (terminated === 0) {
          await sleep(100);
        }
      }
      expect(terminated).toBe(1);
    } finally {
      await holder`SELECT pg_advisory_unlock(hashtext('slugbase.migrate'))`;
    }

    const error = await run;

    expect(error.message).toContain("connection was replaced");
  }, 60_000);

  it("fails when a lock poll is written to a connection that has just closed", async () => {
    const { name } = await createDatabase();
    const holder = superuser(name);
    await holder`SELECT pg_advisory_lock(hashtext('slugbase.migrate'))`;
    const relay = await relayDroppingAt("pg_try_advisory_lock", 1);
    try {
      const error = await rejection(migrate({ url: relay.url(name) }));

      expect(error.message).toContain("connection was replaced");
      expect(error.code).toBe("CONNECTION_CLOSED");
    } finally {
      await holder`SELECT pg_advisory_unlock(hashtext('slugbase.migrate'))`;
      await relay.close();
    }
  }, 60_000);

  it.each([
    {
      kind: "transactional",
      statement: "CREATE TABLE session_probe",
      terminated: true,
      tag: "20300101000001_record_session",
      codes: ["57P01", "CONNECTION_CLOSED"],
      recorded: 0,
    },
    {
      kind: "non-transactional",
      statement: "INDEX CONCURRENTLY session_probe_login_role_idx",
      terminated: false,
      tag: "20300101000002_index_session_probe",
      codes: ["CONNECTION_CLOSED"],
      recorded: 1,
    },
  ])("names the step when the connection is lost during a $kind step", async ({ statement, terminated, tag, codes, recorded }) => {
    const { name, owner } = await createDatabase();
    const relay = await relayDroppingAt(statement, 0, terminated);
    try {
      const error = await rejection(migrate({ url: relay.url(name), chains: [fixture("session")] }));

      expect(error.message).toContain(`migration ${tag} of chain "session" failed`);
      expect(error.message).toContain("connection was replaced");
      expect(codes).toContain(error.code);
    } finally {
      await relay.close();
    }
    expect(await recordedRows(owner, "migrations_session")).toBe(recorded);
  }, 60_000);

  it("names the step when the server terminates the backend while a build waits", async () => {
    const { name } = await createDatabase();
    await applyCoreChain(name);
    const release = await holdSnapshot(name);
    const run = rejection(migrate({ url: migratorUrl(name), chains: [fixture("snapshot")] }));
    run.catch(() => undefined);
    try {
      await waitForBlockedIndexBuild(name);
      const rows = await admin<{ n: number }[]>`
        SELECT count(pg_terminate_backend(pid))::int AS n FROM pg_stat_activity
        WHERE datname = ${name} AND application_name = 'slugbase-migrate'`;
      expect(rows[0]?.n).toBe(1);
    } finally {
      await release();
    }

    const error = await run;

    expect(error.message).toContain('migration 20300101000002_index_snapshot_target of chain "snapshot" failed');
    expect(error.message).toContain("connection was replaced");
    expect(["57P01", "CONNECTION_CLOSED"]).toContain(error.code);
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

  it("leaves the statements of a non-transactional step that ran, records none, and fails the same way on a re-run without building them again", async () => {
    const { name, owner } = await createDatabase();
    await owner.unsafe("CREATE TABLE partial_target (a integer)");
    await owner.unsafe("ALTER TABLE partial_target OWNER TO slugbase_owner");
    const chains = [fixture("partial")];

    const first = await rejection(migrate({ url: migratorUrl(name), chains }));
    expect(first.code).toBe("42703");
    const built = await indexIdentities(owner, ["partial_a_idx"]);
    expect(built).toHaveLength(1);
    expect(await recordedRows(owner, "migrations_partial")).toBe(0);

    const second = await rejection(migrate({ url: migratorUrl(name), chains }));
    expect(second.code).toBe("42703");
    expect(await indexIdentities(owner, ["partial_a_idx"])).toEqual(built);
    expect(await recordedRows(owner, "migrations_partial")).toBe(0);
    expect(await migrateLockIsFree(owner)).toBe(true);
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
  // Several times the 5 s lock_timeout, from when the statement starts waiting.
  const BLOCKED_BOUND_MS = 20_000;
  const QUEUE_GUARD_MS = BLOCKED_BOUND_MS + 2_000;

  it("fails a migration blocked by a table lock within the timeout instead of queueing", async () => {
    const { name, owner } = await createDatabase();
    // migrate always applies the CE chain first, which takes seconds and as long
    // as the host lets it: it is done before the table is locked, and the upper
    // bound runs from when the server reports the blocked statement waiting.
    await applyCoreChain(name);
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
    const run = migrate({ url: migratorUrl(name), chains });
    run.catch(() => undefined);
    let waitingSince = started;
    let queueGuard: NodeJS.Timeout | undefined;
    let error: MigrationError;
    try {
      await waitForBlockedStatement(name, "locked_target");
      waitingSince = Date.now();
      // A migration that queues behind the lock instead of timing out is let
      // through here, after the bound, so the test fails on it instead of hanging.
      queueGuard = setTimeout(release, QUEUE_GUARD_MS);
      error = await rejection(run);
    } finally {
      clearTimeout(queueGuard);
      release();
      await holding;
    }
    const elapsed = Date.now() - started;
    const waited = Date.now() - waitingSince;

    expect(error.code).toBe("55P03");
    expect(elapsed).toBeGreaterThanOrEqual(4_500);
    expect(waited).toBeLessThan(BLOCKED_BOUND_MS);
    expect(await recordedRows(owner, "migrations_blocked")).toBe(0);
    expect(await migrateLockIsFree(owner)).toBe(true);

    expect((await migrate({ url: migratorUrl(name), chains })).applied).toHaveLength(1);
  }, 60_000);
});

describe("a non-transactional step (doc 05 section 5.2)", () => {
  // The older snapshot is held for longer than the 5 s lock_timeout of every
  // other migration, once the build is waiting for it.
  const SNAPSHOT_HOLD_MS = 6_500;

  it("builds its index while another connection holds an older snapshot for longer than lock_timeout", async () => {
    const { name, owner } = await createDatabase();
    await applyCoreChain(name);
    const release = await holdSnapshot(name);
    const run = migrate({ url: migratorUrl(name), chains: [fixture("snapshot")] });
    run.catch(() => undefined);
    try {
      await waitForBlockedIndexBuild(name);
      await sleep(SNAPSHOT_HOLD_MS);
    } finally {
      await release();
    }

    expect((await run).applied).toHaveLength(2);

    expect(await indexes(owner, ["snapshot_target_a_idx"])).toEqual([
      { name: "snapshot_target_a_idx", valid: true, unique: false },
    ]);
    expect(await recordedRows(owner, "migrations_snapshot")).toBe(2);
    expect(await migrateLockIsFree(owner)).toBe(true);
  }, 60_000);

  it("cancels a build whose migrate client was killed, so the next run rebuilds the index instead of finding it", async () => {
    const { name, owner } = await createDatabase();
    await applyCoreChain(name);
    const release = await holdSnapshot(name);
    const folder = join(FIXTURES, "snapshot");
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { migrate } from ${JSON.stringify(new URL("../../src/migrate.ts", import.meta.url).href)};
await migrate({
  url: process.env.MIGRATE_URL,
  chains: [{ name: "snapshot", folder: process.env.MIGRATE_FOLDER, bookkeepingTable: "migrations_snapshot" }],
});`,
      ],
      {
        env: { PATH: process.env.PATH ?? "", MIGRATE_URL: migratorUrl(name), MIGRATE_FOLDER: folder },
        stdio: "ignore",
      },
    );
    let released = false;
    try {
      await waitForBlockedIndexBuild(name);
      const builds = await admin<{ pid: number }[]>`
        SELECT pid FROM pg_stat_activity
        WHERE datname = ${name} AND query ILIKE '%INDEX CONCURRENTLY%' AND pid <> pg_backend_pid()`;
      const backend = builds[0]?.pid;
      expect(backend).toBeDefined();

      expect(child.kill("SIGKILL")).toBe(true);
      // Still waiting for the older snapshot: only the client check can end the build now.
      let alive = true;
      for (let attempt = 0; attempt < 100 && alive; attempt++) {
        const rows = await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = ${backend ?? 0}`;
        alive = (rows[0]?.n ?? 0) > 0;
        if (alive) {
          await sleep(100);
        }
      }
      await release();
      released = true;
      expect(alive).toBe(false);
    } finally {
      child.kill("SIGKILL");
      if (!released) {
        await release();
      }
    }

    expect((await indexes(owner, ["snapshot_target_a_idx"])).filter((index) => index.valid)).toEqual([]);
    expect(await recordedRows(owner, "migrations_snapshot")).toBe(1);

    const result = await migrate({ url: migratorUrl(name), chains: [fixture("snapshot")] });

    expect(result.applied).toHaveLength(1);
    expect(await indexes(owner, ["snapshot_target_a_idx"])).toEqual([
      { name: "snapshot_target_a_idx", valid: true, unique: false },
    ]);
    expect(await recordedRows(owner, "migrations_snapshot")).toBe(2);
  }, 60_000);

  it("gives lock_timeout back to the migrations after it", async () => {
    const { name, owner } = await createDatabase();
    await migrate({ url: migratorUrl(name), chains: [fixture("restored")] });
    const probe = await owner`SELECT lock_timeout FROM restored_probe`;
    expect(probe[0]).toEqual({ lock_timeout: "5s" });
    expect(await recordedRows(owner, "migrations_restored")).toBe(3);
  }, 60_000);

  it("drops the INVALID index a failed build left and builds it again", async () => {
    const { name, owner } = await createDatabase();
    await owner.unsafe("CREATE TABLE invalid_target (a integer)");
    await owner.unsafe("ALTER TABLE invalid_target OWNER TO slugbase_owner");
    await owner.unsafe("INSERT INTO invalid_target VALUES (1), (1)");
    for (const statement of [
      "CREATE UNIQUE INDEX CONCURRENTLY invalid_a_idx ON invalid_target (a)",
      'CREATE UNIQUE INDEX CONCURRENTLY "invalid_Mixed_idx" ON invalid_target (a)',
    ]) {
      await expect(owner.unsafe(statement)).rejects.toMatchObject({ code: "23505" });
    }
    const names = ["invalid_Mixed_idx", "invalid_a_idx"];
    expect(await indexes(owner, names)).toEqual([
      { name: "invalid_Mixed_idx", valid: false, unique: true },
      { name: "invalid_a_idx", valid: false, unique: true },
    ]);
    await owner.unsafe("DELETE FROM invalid_target");

    const result = await migrate({ url: migratorUrl(name), chains: [fixture("invalid")] });

    expect(result.applied).toHaveLength(CE_MIGRATIONS + 1);
    expect(await indexes(owner, names)).toEqual([
      { name: "invalid_Mixed_idx", valid: true, unique: false },
      { name: "invalid_a_idx", valid: true, unique: true },
    ]);
    expect(await recordedRows(owner, "migrations_invalid")).toBe(1);
  }, 60_000);

  it("records a step whose indexes were built and valid when its bookkeeping row is missing, and keeps those indexes", async () => {
    const { name, owner } = await createDatabase();
    await owner.unsafe("CREATE TABLE invalid_target (a integer)");
    await owner.unsafe("ALTER TABLE invalid_target OWNER TO slugbase_owner");
    const chains = [fixture("invalid")];
    await migrate({ url: migratorUrl(name), chains });
    const built = await indexIdentities(owner, ["invalid_Mixed_idx", "invalid_a_idx"]);
    expect(built).toHaveLength(2);
    await owner.unsafe("DELETE FROM drizzle.migrations_invalid");

    const result = await migrate({ url: migratorUrl(name), chains });

    expect(result.applied).toEqual([{ chain: "invalid", tag: "20300101000001_index_invalid_target" }]);
    expect(await indexIdentities(owner, ["invalid_Mixed_idx", "invalid_a_idx"])).toEqual(built);
    expect(await recordedRows(owner, "migrations_invalid")).toBe(1);
    expect(await migrateLockIsFree(owner)).toBe(true);
  }, 60_000);

  it("records every index step of the CE chain whose bookkeeping row is missing, without building any of them again", async () => {
    const { name, owner } = await createDatabase();
    await migrate({ url: migratorUrl(name), chains: [] });
    const rows = await owner<{ hash: string; created_at: string }[]>`
      SELECT hash, created_at::text AS created_at FROM drizzle.migrations_core ORDER BY created_at`;
    const journal = JSON.parse(readFileSync(join(CE_CHAIN.folder, "meta", "_journal.json"), "utf8")) as {
      entries: { tag: string; when: number }[];
    };
    const steps = journal.entries.filter((entry) =>
      isNonTransactional(readFileSync(join(CE_CHAIN.folder, `${entry.tag}.sql`), "utf8")),
    );
    expect(steps.length).toBeGreaterThan(5);
    const before = await owner<{ oid: string }[]>`
      SELECT c.oid::text AS oid FROM pg_class c WHERE c.relkind = 'i' ORDER BY c.relname`;
    await owner.unsafe(
      `DELETE FROM drizzle.migrations_core WHERE created_at IN (${steps.map((step) => String(step.when)).join(", ")})`,
    );
    expect(await recordedRows(owner, "migrations_core")).toBe(rows.length - steps.length);

    const result = await migrate({ url: migratorUrl(name), chains: [] });

    expect(result.applied.map((step) => step.tag)).toEqual(steps.map((step) => step.tag));
    expect(await recordedRows(owner, "migrations_core")).toBe(rows.length);
    expect(
      await owner<{ oid: string }[]>`
        SELECT c.oid::text AS oid FROM pg_class c WHERE c.relkind = 'i' ORDER BY c.relname`,
    ).toEqual(before);
    expect(await owner`SELECT 1 FROM pg_index WHERE NOT indisvalid`).toHaveLength(0);
  }, 120_000);

  it("takes an index of the step's name that PostgreSQL spells differently for the step's own", async () => {
    const { name, owner } = await createDatabase();
    await owner.unsafe("CREATE TABLE spelled_target (a integer, b text)");
    await owner.unsafe("ALTER TABLE spelled_target OWNER TO slugbase_owner");
    await owner.unsafe(
      "CREATE UNIQUE INDEX spelled_idx ON spelled_target (a, lower(b) DESC NULLS LAST) WHERE a IS NOT NULL",
    );
    const chain = indexChain("spelled", [
      'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "spelled_idx" ON ONLY public."spelled_target" USING btree ("a",lower("b") DESC NULLS LAST) WHERE "spelled_target"."a" IS NOT NULL;',
    ]);
    const before = await indexIdentities(owner, ["spelled_idx"]);

    const result = await migrate({ url: migratorUrl(name), chains: [chain] });

    expect(result.applied.map((step) => step.chain)).toContain("spelled");
    expect(await indexIdentities(owner, ["spelled_idx"])).toEqual(before);
    expect(await recordedRows(owner, "migrations_spelled")).toBe(1);
  }, 60_000);

  it("takes a valid unique index of the step's name that a foreign key references for the step's own", async () => {
    const { name, owner } = await createDatabase();
    await owner.unsafe("CREATE TABLE referenced_target (a integer)");
    await owner.unsafe("ALTER TABLE referenced_target OWNER TO slugbase_owner");
    await owner.unsafe("CREATE UNIQUE INDEX referenced_idx ON referenced_target (a)");
    await owner.unsafe("CREATE TABLE referencing_table (a integer)");
    await owner.unsafe(
      "ALTER TABLE referencing_table ADD CONSTRAINT referencing_fk FOREIGN KEY (a) REFERENCES referenced_target (a)",
    );
    const chain = indexChain("referenced", [
      "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS referenced_idx ON referenced_target (a);",
    ]);
    const before = await indexIdentities(owner, ["referenced_idx"]);

    const result = await migrate({ url: migratorUrl(name), chains: [chain] });

    expect(result.applied.map((step) => step.chain)).toContain("referenced");
    expect(await indexIdentities(owner, ["referenced_idx"])).toEqual(before);
    expect(await recordedRows(owner, "migrations_referenced")).toBe(1);
    await expect(
      owner<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'referencing_fk'`,
    ).resolves.toEqual([{ n: 1 }]);
    expect(await migrateLockIsFree(owner)).toBe(true);
  }, 60_000);

  it.each([
    ["another column", "CREATE INDEX different_idx ON different_target (b)", "(a)"],
    ["another column order", "CREATE INDEX different_idx ON different_target (a DESC)", "(a)"],
    ["another expression", "CREATE INDEX different_idx ON different_target (lower(c))", "(c)"],
    ["uniqueness", "CREATE UNIQUE INDEX different_idx ON different_target (a)", "(a)"],
    ["a predicate", "CREATE INDEX different_idx ON different_target (a) WHERE a > 1", "(a) WHERE a > 0"],
    ["a missing predicate", "CREATE INDEX different_idx ON different_target (a)", "(a) WHERE a > 0"],
    ["an extra predicate", "CREATE INDEX different_idx ON different_target (a) WHERE a > 0", "(a)"],
    ["an access method", "CREATE INDEX different_idx ON different_target USING hash (a)", "(a)"],
    ["another table", "CREATE INDEX different_idx ON different_other (a)", "(a)"],
  ])("fails the run, names the index and records nothing when the index of that name differs in %s", async (_case, existing, wanted) => {
    const { name, owner } = await createDatabase();
    for (const table of ["different_target", "different_other"]) {
      await owner.unsafe(`CREATE TABLE ${table} (a integer, b integer, c text)`);
      await owner.unsafe(`ALTER TABLE ${table} OWNER TO slugbase_owner`);
    }
    await owner.unsafe(existing);
    const chain = indexChain("different", [
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS different_idx ON different_target ${wanted};`,
    ]);
    const before = await indexIdentities(owner, ["different_idx"]);

    const error = await rejection(migrate({ url: migratorUrl(name), chains: [chain] }));

    expect(error.message).toContain("different_idx");
    expect(error.message).toContain("20300101000001_index_different");
    expect(await indexIdentities(owner, ["different_idx"])).toEqual(before);
    expect(await recordedRows(owner, "migrations_different")).toBe(0);
    expect(await migrateLockIsFree(owner)).toBe(true);
    await expect(
      owner<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_class WHERE relpersistence = 't'`,
    ).resolves.toEqual([{ n: 0 }]);
  }, 60_000);

  it.each([
    [
      "a primary key",
      "ALTER TABLE owned_target ADD CONSTRAINT owned_idx PRIMARY KEY (a)",
      "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS owned_idx ON owned_target (a);",
    ],
    [
      "a deferrable unique constraint",
      "ALTER TABLE owned_target ADD CONSTRAINT owned_idx UNIQUE (a) DEFERRABLE INITIALLY DEFERRED",
      "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS owned_idx ON owned_target (a);",
    ],
    [
      "a unique constraint that a foreign key also references",
      "ALTER TABLE owned_target ADD CONSTRAINT owned_idx UNIQUE (a); CREATE TABLE owned_referrer (a integer REFERENCES owned_target (a))",
      "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS owned_idx ON owned_target (a);",
    ],
    [
      "an exclusion constraint",
      "ALTER TABLE owned_target ADD CONSTRAINT owned_idx EXCLUDE USING gist (r WITH =)",
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS owned_idx ON owned_target USING gist (r);",
    ],
  ])("fails the run, names the index and records nothing when %s owns the index of that name", async (_case, constraint, statement) => {
    const { name, owner } = await createDatabase();
    await owner.unsafe("CREATE TABLE owned_target (a integer, r int4range)");
    await owner.unsafe("ALTER TABLE owned_target OWNER TO slugbase_owner");
    await owner.unsafe(constraint);
    const chain = indexChain("owned", [statement]);
    const before = await indexIdentities(owner, ["owned_idx"]);

    const error = await rejection(migrate({ url: migratorUrl(name), chains: [chain] }));

    expect(error.message).toContain("owned_idx");
    expect(error.message).toContain("20300101000001_index_owned");
    expect(await indexIdentities(owner, ["owned_idx"])).toEqual(before);
    expect(await recordedRows(owner, "migrations_owned")).toBe(0);
    expect(await migrateLockIsFree(owner)).toBe(true);
  }, 60_000);

  it("fails a step whose second index differs before it records the step, after keeping the first one", async () => {
    const { name, owner } = await createDatabase();
    await owner.unsafe("CREATE TABLE pair_target (a integer, b integer)");
    await owner.unsafe("ALTER TABLE pair_target OWNER TO slugbase_owner");
    await owner.unsafe("CREATE INDEX pair_a_idx ON pair_target (a)");
    await owner.unsafe("CREATE INDEX pair_b_idx ON pair_target (a)");
    const chain = indexChain("pair", [
      "CREATE INDEX CONCURRENTLY pair_a_idx ON pair_target (a);",
      "CREATE INDEX CONCURRENTLY pair_b_idx ON pair_target (b);",
    ]);

    const error = await rejection(migrate({ url: migratorUrl(name), chains: [chain] }));

    expect(error.message).toContain("pair_b_idx");
    expect(await recordedRows(owner, "migrations_pair")).toBe(0);
  }, 60_000);

  it("refuses a statement that is not a named concurrent index build before running any of the step", async () => {
    const { name, owner } = await createDatabase();
    await owner.unsafe("CREATE TABLE unparsable_target (a integer)");
    await owner.unsafe("ALTER TABLE unparsable_target OWNER TO slugbase_owner");

    const error = await rejection(migrate({ url: migratorUrl(name), chains: [fixture("unparsable")] }));

    expect(error.message).toContain("20300101000001_index_unparsable_target");
    expect(error.message).toContain("only named CREATE INDEX CONCURRENTLY statements");
    expect(await indexes(owner, ["unparsable_a_idx"])).toEqual([]);
    expect(await recordedRows(owner, "migrations_unparsable")).toBe(0);
    expect(await migrateLockIsFree(owner)).toBe(true);
  }, 60_000);

  it("lets several replicas wait for the lock while it builds, without a deadlock", async () => {
    const { name, owner } = await createDatabase();
    const chains = [fixture("snapshot")];
    await applyCoreChain(name);
    const release = await holdSnapshot(name);
    const runs = Promise.all([1, 2, 3].map(() => migrate({ url: migratorUrl(name), chains })));
    runs.catch(() => undefined);
    try {
      await waitForBlockedIndexBuild(name);
      // Longer than deadlock_timeout, so a waiter that held a snapshot would be found out.
      await sleep(3_000);
    } finally {
      await release();
    }

    const tags = (await runs).flatMap((run) => run.applied.map(({ chain, tag }) => `${chain}:${tag}`));

    expect(tags).toHaveLength(2);
    expect(new Set(tags).size).toBe(tags.length);
    expect(await recordedRows(owner, "migrations_snapshot")).toBe(2);
    expect(await indexes(owner, ["snapshot_target_a_idx"])).toEqual([
      { name: "snapshot_target_a_idx", valid: true, unique: false },
    ]);
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

describe("an upgrade from the level before the search migrations", () => {
  const SEARCH_INDEXES = ["bookmarks_search_idx", "bookmarks_slug_trgm_idx", "bookmarks_title_trgm_idx", "bookmarks_host_trgm_idx"];
  const WORKSPACE = "0190a000-0000-7000-8000-000000000001";
  const ACCOUNT = "0190a000-0000-7000-8000-000000000002";

  it("applies them in a session that has not loaded pg_trgm, which the database already has, and the function leaves the threshold as it found it", async () => {
    const { name, owner } = await createDatabase();
    await migrate({ url: migratorUrl(name), chains: [] });
    // Put the database back at the level before the search migrations: no function, no search indexes, and their bookkeeping rows gone. pg_trgm stays installed, as it is on an instance that upgrades.
    const journal = JSON.parse(readFileSync(join(CE_CHAIN.folder, "meta", "_journal.json"), "utf8")) as { entries: { tag: string; when: number }[] };
    const search = journal.entries.filter((entry) => entry.tag.includes("index_bookmark_search"));
    expect(search.length).toBeGreaterThan(0);
    await owner.unsafe("DROP FUNCTION public.sys_search(text, integer)");
    for (const index of SEARCH_INDEXES) {
      await owner.unsafe(`DROP INDEX public.${index}`);
    }
    await owner.unsafe(`DELETE FROM drizzle.migrations_core WHERE created_at IN (${search.map((entry) => String(entry.when)).join(", ")})`);
    expect((await owner<{ present: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS present`)[0]?.present).toBe(true);

    const result = await migrate({ url: migratorUrl(name), chains: [] });

    expect(result.applied.map((step) => step.tag)).toEqual(search.map((entry) => entry.tag));
    expect((await indexes(owner, SEARCH_INDEXES)).map((index) => index.valid)).toEqual([true, true, true, true]);
    const [setting] = await owner.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${WORKSPACE}, true), set_config('app.account_id', ${ACCOUNT}, true)`;
      await tx`SELECT count(*) FROM sys_search('abcd', 8)`;
      return tx<{ value: string }[]>`SELECT current_setting('pg_trgm.word_similarity_threshold') AS value`;
    });
    expect(setting?.value).toBe("0.6");
  }, 120_000);
});

describe("an upgrade from the level before the go suggestion migration", () => {
  const WORKSPACE = "0190a000-0000-7000-8000-000000000011";
  const ACCOUNT = "0190a000-0000-7000-8000-000000000012";

  it("creates the system operation in a fresh session, and the function answers in a transaction of the application role", async () => {
    const { name, owner } = await createDatabase();
    await migrate({ url: migratorUrl(name), chains: [] });
    const journal = JSON.parse(readFileSync(join(CE_CHAIN.folder, "meta", "_journal.json"), "utf8")) as { entries: { tag: string; when: number }[] };
    const suggest = journal.entries.filter((entry) => entry.tag.includes("add_go_suggest"));
    expect(suggest).toHaveLength(1);
    await owner.unsafe("DROP FUNCTION public.sys_go_suggest(text)");
    await owner.unsafe(`DELETE FROM drizzle.migrations_core WHERE created_at IN (${suggest.map((entry) => String(entry.when)).join(", ")})`);

    const result = await migrate({ url: migratorUrl(name), chains: [] });

    expect(result.applied.map((step) => step.tag)).toEqual(suggest.map((entry) => entry.tag));
    const rows = await owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_app`;
      await tx`SELECT set_config('app.workspace_id', ${WORKSPACE}, true), set_config('app.account_id', ${ACCOUNT}, true)`;
      return tx`SELECT * FROM sys_go_suggest('abcd')`;
    });
    expect(rows).toHaveLength(0);
  }, 120_000);
});

describe("an upgrade from the level before the title and slug search index", () => {
  const WORKSPACE = "0190a000-0000-7000-8000-000000000021";
  const ACCOUNT = "0190a000-0000-7000-8000-000000000022";

  it("builds the index concurrently and replaces the function in a fresh session, and the function answers in a transaction of the application role", async () => {
    const { name, owner } = await createDatabase();
    await migrate({ url: migratorUrl(name), chains: [] });
    const journal = JSON.parse(readFileSync(join(CE_CHAIN.folder, "meta", "_journal.json"), "utf8")) as { entries: { tag: string; when: number }[] };
    const titleSlug = journal.entries.filter((entry) => entry.tag.includes("index_bookmark_title_slug"));
    expect(titleSlug).toHaveLength(2);
    // Put the database back at the level before them: no index, no function, and their bookkeeping rows gone. The search indexes and pg_trgm stay, as they are on an instance that upgrades.
    await owner.unsafe("DROP FUNCTION public.sys_search(text, integer)");
    await owner.unsafe("DROP INDEX public.bookmarks_title_slug_search_idx");
    await owner.unsafe(`DELETE FROM drizzle.migrations_core WHERE created_at IN (${titleSlug.map((entry) => String(entry.when)).join(", ")})`);

    const result = await migrate({ url: migratorUrl(name), chains: [] });

    expect(result.applied.map((step) => step.tag)).toEqual(titleSlug.map((entry) => entry.tag));
    expect((await indexes(owner, ["bookmarks_title_slug_search_idx"])).map((index) => index.valid)).toEqual([true]);
    const [definition] = await owner<{ definition: string }[]>`SELECT pg_get_indexdef('public.bookmarks_title_slug_search_idx'::regclass) AS definition`;
    expect(definition?.definition).toContain("to_tsvector('simple'::regconfig, COALESCE(slug, ''::text)) || to_tsvector('simple'::regconfig, title)");
    const [setting] = await owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_app`;
      await tx`SELECT set_config('app.workspace_id', ${WORKSPACE}, true), set_config('app.account_id', ${ACCOUNT}, true)`;
      await tx`SELECT count(*) FROM sys_search('abcd', 8)`;
      return tx<{ value: string }[]>`SELECT current_setting('pg_trgm.word_similarity_threshold') AS value`;
    });
    expect(setting?.value).toBe("0.6");
  }, 120_000);
});

describe("an upgrade from the level before the audit event account indexes", () => {
  const INDEXES = ["audit_events_actor_account_id_idx", "audit_events_entity_id_idx", "audit_events_transfer_to_idx", "audit_events_target_id_idx"];

  it("builds each index concurrently on a table that holds events, each in a step of its own, and every one is valid", async () => {
    const { name, owner } = await createDatabase();
    await migrate({ url: migratorUrl(name), chains: [] });
    const journal = JSON.parse(readFileSync(join(CE_CHAIN.folder, "meta", "_journal.json"), "utf8")) as { entries: { tag: string; when: number }[] };
    const accountIndexes = journal.entries.filter((entry) => entry.tag.includes("index_audit_events_account"));
    expect(accountIndexes).toHaveLength(INDEXES.length);
    for (const entry of accountIndexes) {
      expect(readFileSync(join(CE_CHAIN.folder, `${entry.tag}.sql`), "utf8").startsWith("-- slugbase:non-transactional\n")).toBe(true);
    }
    for (const index of INDEXES) {
      await owner.unsafe(`DROP INDEX public.${index}`);
    }
    await owner.unsafe(`DELETE FROM drizzle.migrations_core WHERE created_at IN (${accountIndexes.map((entry) => String(entry.when)).join(", ")})`);
    await owner.unsafe(`
      INSERT INTO audit_events (id, workspace_id, actor_type, actor_label, action, metadata)
      SELECT gen_random_uuid(), NULL, 'system', 'SlugBase', 'share.granted', jsonb_build_object('targetId', gen_random_uuid()::text) FROM generate_series(1, 100)`);

    const result = await migrate({ url: migratorUrl(name), chains: [] });

    expect(result.applied.map((step) => step.tag)).toEqual(accountIndexes.map((entry) => entry.tag));
    expect((await indexes(owner, INDEXES)).map((index) => [index.name, index.valid])).toEqual([...INDEXES].sort().map((index) => [index, true]));
    const definitions = await owner<{ name: string; definition: string }[]>`
      SELECT indexname AS name, indexdef AS definition FROM pg_indexes WHERE tablename = 'audit_events' AND indexname IN ${owner(INDEXES)} ORDER BY indexname`;
    expect(definitions.map((row) => row.definition)).toEqual([
      expect.stringContaining("(actor_account_id) WHERE (actor_account_id IS NOT NULL)"),
      expect.stringContaining("(entity_id) WHERE (entity_id IS NOT NULL)"),
      expect.stringContaining("(lower((metadata ->> 'targetId'::text))) WHERE ((metadata ->> 'targetId'::text) IS NOT NULL)"),
      expect.stringContaining("(lower((metadata ->> 'transferTo'::text))) WHERE ((metadata ->> 'transferTo'::text) IS NOT NULL)"),
    ]);
  }, 120_000);
});

describe("an upgrade from the level before the bookmark URL index", () => {
  const WORKSPACE = "0190a000-0000-7000-8000-000000000041";
  const ACCOUNT = "0190a000-0000-7000-8000-000000000042";

  it("builds the index concurrently on a table that holds bookmarks, in a step of its own, and it is valid and partial", async () => {
    const { name, owner } = await createDatabase();
    await migrate({ url: migratorUrl(name), chains: [] });
    const journal = JSON.parse(readFileSync(join(CE_CHAIN.folder, "meta", "_journal.json"), "utf8")) as { entries: { tag: string; when: number }[] };
    const urlIndex = journal.entries.filter((entry) => entry.tag.includes("index_bookmark_url"));
    expect(urlIndex).toHaveLength(1);
    for (const entry of urlIndex) {
      expect(readFileSync(join(CE_CHAIN.folder, `${entry.tag}.sql`), "utf8").startsWith("-- slugbase:non-transactional\n")).toBe(true);
    }
    await owner.unsafe("DROP INDEX public.bookmarks_owner_url_idx");
    await owner.unsafe(`DELETE FROM drizzle.migrations_core WHERE created_at IN (${urlIndex.map((entry) => String(entry.when)).join(", ")})`);
    await owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`SELECT set_config('app.account_id', ${ACCOUNT}, true)`;
      await tx`INSERT INTO accounts (id, email, display_name) VALUES (${ACCOUNT}, 'url-index@example.test', 'Url index')`;
      await tx`INSERT INTO workspaces (id, name) VALUES (${WORKSPACE}, 'Url index')`;
      await tx`INSERT INTO workspace_members (workspace_id, account_id, role) VALUES (${WORKSPACE}, ${ACCOUNT}, 'owner')`;
      await tx`
        INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title)
        SELECT gen_random_uuid(), ${WORKSPACE}, ${ACCOUNT}, 'https://example.com/' || n, 'https://example.com/' || n, 'example.com', 'Title ' || n
        FROM generate_series(1, 500) AS n`;
    });

    const result = await migrate({ url: migratorUrl(name), chains: [] });

    expect(result.applied.map((step) => step.tag)).toEqual(urlIndex.map((entry) => entry.tag));
    expect((await indexes(owner, ["bookmarks_owner_url_idx"])).map((index) => [index.name, index.valid])).toEqual([["bookmarks_owner_url_idx", true]]);
    const [definition] = await owner<{ definition: string }[]>`SELECT pg_get_indexdef('public.bookmarks_owner_url_idx'::regclass) AS definition`;
    expect(definition?.definition).toContain("(workspace_id, owner_id, url_canonical) WHERE (plan_archived_at IS NULL)");
  }, 120_000);
});

describe("an upgrade from the level before the workspace creator index", () => {
  const WORKSPACE = "0190a000-0000-7000-8000-000000000051";
  const ACCOUNT = "0190a000-0000-7000-8000-000000000052";

  it("builds the index concurrently on a table that holds workspaces, in a step of its own, and it is valid and partial", async () => {
    const { name, owner } = await createDatabase();
    await migrate({ url: migratorUrl(name), chains: [] });
    const journal = JSON.parse(readFileSync(join(CE_CHAIN.folder, "meta", "_journal.json"), "utf8")) as { entries: { tag: string; when: number }[] };
    const creatorIndex = journal.entries.filter((entry) => entry.tag.includes("index_workspace_created_by"));
    expect(creatorIndex).toHaveLength(1);
    for (const entry of creatorIndex) {
      expect(readFileSync(join(CE_CHAIN.folder, `${entry.tag}.sql`), "utf8").startsWith("-- slugbase:non-transactional\n")).toBe(true);
    }
    await owner.unsafe("DROP INDEX public.workspaces_created_by_idx");
    await owner.unsafe(`DELETE FROM drizzle.migrations_core WHERE created_at IN (${creatorIndex.map((entry) => String(entry.when)).join(", ")})`);
    await owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`SELECT set_config('app.account_id', ${ACCOUNT}, true)`;
      await tx`INSERT INTO accounts (id, email, display_name) VALUES (${ACCOUNT}, 'creator-index@example.test', 'Creator index')`;
      await tx`INSERT INTO workspaces (id, name, created_by) VALUES (${WORKSPACE}, 'Creator index', ${ACCOUNT})`;
      await tx`INSERT INTO workspace_members (workspace_id, account_id, role) VALUES (${WORKSPACE}, ${ACCOUNT}, 'owner')`;
    });

    const result = await migrate({ url: migratorUrl(name), chains: [] });

    expect(result.applied.map((step) => step.tag)).toEqual(creatorIndex.map((entry) => entry.tag));
    expect((await indexes(owner, ["workspaces_created_by_idx"])).map((index) => [index.name, index.valid])).toEqual([["workspaces_created_by_idx", true]]);
    const [definition] = await owner<{ definition: string }[]>`SELECT pg_get_indexdef('public.workspaces_created_by_idx'::regclass) AS definition`;
    expect(definition?.definition).toContain("(created_by) WHERE (created_by IS NOT NULL)");
  }, 120_000);
});

describe("an upgrade from the level before the bookmark match migration", () => {
  const WORKSPACE = "0190a000-0000-7000-8000-000000000031";
  const ACCOUNT = "0190a000-0000-7000-8000-000000000032";

  it("creates the system operation in a session that has not loaded pg_trgm, and the function answers in a transaction of the application role and leaves the threshold as it found it", async () => {
    const { name, owner } = await createDatabase();
    await migrate({ url: migratorUrl(name), chains: [] });
    const journal = JSON.parse(readFileSync(join(CE_CHAIN.folder, "meta", "_journal.json"), "utf8")) as { entries: { tag: string; when: number }[] };
    const match = journal.entries.filter((entry) => entry.tag.includes("add_bookmark_match"));
    expect(match).toHaveLength(1);
    await owner.unsafe("DROP FUNCTION public.sys_bookmark_match(text)");
    await owner.unsafe(`DELETE FROM drizzle.migrations_core WHERE created_at IN (${match.map((entry) => String(entry.when)).join(", ")})`);
    expect((await owner<{ present: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS present`)[0]?.present).toBe(true);

    const result = await migrate({ url: migratorUrl(name), chains: [] });

    expect(result.applied.map((step) => step.tag)).toEqual(match.map((entry) => entry.tag));
    const [setting] = await owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_app`;
      await tx`SELECT set_config('app.workspace_id', ${WORKSPACE}, true), set_config('app.account_id', ${ACCOUNT}, true)`;
      await tx`SELECT count(*) FROM sys_bookmark_match('abcd')`;
      return tx<{ value: string }[]>`SELECT current_setting('pg_trgm.word_similarity_threshold') AS value`;
    });
    expect(setting?.value).toBe("0.6");
  }, 120_000);
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
