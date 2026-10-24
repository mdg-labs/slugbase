import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
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

async function indexes(owner: postgres.Sql, names: string[]): Promise<{ name: string; valid: boolean; unique: boolean }[]> {
  return owner<{ name: string; valid: boolean; unique: boolean }[]>`
    SELECT c.relname AS name, i.indisvalid AS valid, i.indisunique AS unique
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname IN ${owner(names)} ORDER BY c.relname`;
}

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
