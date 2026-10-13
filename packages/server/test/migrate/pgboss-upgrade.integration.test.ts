import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import { MigrationError } from "@slugbase/db";
import { withTestDatabase } from "@slugbase/testing/db";
import { PgBoss, getRollbackPlans, getUninstallPlans } from "pg-boss";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../../src/migrate/index.ts";
import { PGBOSS_SCHEMA, ownerSessionUrl } from "../../src/migrate/pgboss.ts";
import { urlOf, useMigratableDatabase } from "./support.ts";

// An older pg-boss schema is upgraded by `migrate` to the version this build
// runs (doc 05 sections 5.2, 5.3 and 5.5), with pg-boss's own plans, under the
// lock of `migrate`, and a newer one is refused.

const database = useMigratableDatabase();
const migratorUrl = (): string => urlOf(database().owner);

const expected = (createRequire(import.meta.url)("pg-boss/package.json") as { pgboss: { schema: number } }).pgboss.schema;

async function rows<T extends Record<string, unknown>>(sql: string): Promise<T[]> {
  return database().owner.unsafe<T[]>(sql);
}

// A script of several statements with its own BEGIN and COMMIT, run on one connection.
async function script(text: string): Promise<void> {
  const connection = await database().owner.reserve();
  try {
    await connection.unsafe(text).simple();
  } finally {
    connection.release();
  }
}

async function schemaVersion(): Promise<number> {
  const found = await rows<{ version: number }>(`SELECT version::int AS version FROM ${PGBOSS_SCHEMA}.version`);
  return found[0]?.version ?? 0;
}

// A database whose pg-boss schema is `steps` versions behind this build's, made by installing the current one and applying pg-boss's rollback plans.
async function behind(steps: number): Promise<void> {
  if ((await rows(`SELECT to_regclass('${PGBOSS_SCHEMA}.version') AS present`))[0]?.["present"] !== null) {
    await script(getUninstallPlans(PGBOSS_SCHEMA));
  }
  await runMigrations({ url: migratorUrl() });
  for (let version = expected; version > expected - steps; version -= 1) {
    await script(getRollbackPlans(PGBOSS_SCHEMA, version));
  }
  expect(await schemaVersion()).toBe(expected - steps);
}

async function invalidIndexes(): Promise<string[]> {
  const found = await rows<{ name: string }>(`
    SELECT c.relname AS name FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relnamespace = '${PGBOSS_SCHEMA}'::regnamespace AND NOT i.indisvalid`);
  return found.map((row) => row.name);
}

async function failureOf(run: () => Promise<unknown>): Promise<MigrationError> {
  const failure = await run().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(MigrationError);
  return failure as MigrationError;
}

describe("a pg-boss schema older than this build's", () => {
  it("is upgraded as slugbase_owner, builds its concurrent indexes, and a second run does nothing", async () => {
    await behind(1);
    expect(await rows(`SELECT 1 FROM information_schema.columns WHERE table_schema = '${PGBOSS_SCHEMA}' AND table_name = 'job' AND column_name = 'upsert_by_key'`)).toHaveLength(0);

    const first = await runMigrations({ url: migratorUrl() });
    expect(first.applied).toEqual([{ chain: PGBOSS_SCHEMA, tag: `schema_${String(expected)}` }]);
    expect(await schemaVersion()).toBe(expected);
    expect(await rows(`SELECT 1 FROM information_schema.columns WHERE table_schema = '${PGBOSS_SCHEMA}' AND table_name = 'job' AND column_name = 'upsert_by_key'`)).toHaveLength(1);
    expect(await rows(`SELECT 1 FROM pg_indexes WHERE schemaname = '${PGBOSS_SCHEMA}' AND indexname = 'job_common_i13'`)).toHaveLength(1);
    expect(await invalidIndexes()).toEqual([]);
    const owners = await rows(`
      SELECT DISTINCT pg_get_userbyid(relowner) AS owner FROM pg_class
       WHERE relnamespace = '${PGBOSS_SCHEMA}'::regnamespace AND relkind IN ('r', 'p')`);
    expect(owners).toEqual([{ owner: "slugbase_owner" }]);
    await database().app.unsafe(`SELECT ${PGBOSS_SCHEMA}.job_now()`);

    expect((await runMigrations({ url: migratorUrl() })).applied).toEqual([]);
  });

  it("builds its concurrent indexes on the partition of a queue that has one", async () => {
    await behind(1);
    await rows(`SELECT ${PGBOSS_SCHEMA}.create_queue('partitioned', '{"partition": true, "policy": "standard"}'::jsonb)`);
    const [queue] = await rows<{ table_name: string }>(`SELECT table_name FROM ${PGBOSS_SCHEMA}.queue WHERE name = 'partitioned'`);
    const table = queue?.table_name ?? "";
    expect(table).toMatch(/^j[0-9a-f]+$/);
    expect(await rows(`SELECT 1 FROM pg_indexes WHERE schemaname = '${PGBOSS_SCHEMA}' AND tablename = '${table}' AND indexname LIKE '%\\_i13'`)).toHaveLength(0);

    await runMigrations({ url: migratorUrl() });
    expect(await rows(`SELECT 1 FROM pg_indexes WHERE schemaname = '${PGBOSS_SCHEMA}' AND tablename = '${table}' AND indexname LIKE '%\\_i13'`)).toHaveLength(1);
    expect(await invalidIndexes()).toEqual([]);
  });

  it("is upgraded across several versions at once", async () => {
    await behind(2);
    const result = await runMigrations({ url: migratorUrl() });
    expect(result.applied).toEqual([{ chain: PGBOSS_SCHEMA, tag: `schema_${String(expected)}` }]);
    expect(await schemaVersion()).toBe(expected);
    expect(await invalidIndexes()).toEqual([]);
  });

  it("builds its indexes outside a transaction with lock_timeout off, waiting as long as statement_timeout allows", async () => {
    await behind(1);
    const holdMs = 1500;
    // The session starts with a lock_timeout that a wait of this length exceeds, unless the build turns it off.
    const url = new URL(migratorUrl());
    url.searchParams.set("options", "-c lock_timeout=300ms");
    let released = 0;
    let holding!: () => void;
    const holder = new Promise<void>((resolve) => {
      holding = resolve;
    });
    // An open snapshot, which the build waits for after its second scan, whatever table it reads.
    const reader = database().owner.begin("ISOLATION LEVEL REPEATABLE READ", async (tx) => {
      await tx`SELECT count(*) FROM pg_class`;
      holding();
      await sleep(holdMs);
      released = Date.now();
    });
    try {
      await holder;
      const result = await runMigrations({ url: url.href });
      const finished = Date.now();
      expect(result.applied).toEqual([{ chain: PGBOSS_SCHEMA, tag: `schema_${String(expected)}` }]);
      expect(released).toBeGreaterThan(0);
      expect(finished).toBeGreaterThanOrEqual(released);
    } finally {
      await reader;
    }
    expect(await schemaVersion()).toBe(expected);
    expect(await invalidIndexes()).toEqual([]);
  });

  it("makes a second run wait for the index builds of the first, which holds the lock", async () => {
    await behind(1);
    let released = 0;
    let holding!: () => void;
    const holder = new Promise<void>((resolve) => {
      holding = resolve;
    });
    const reader = database().owner.begin("ISOLATION LEVEL REPEATABLE READ", async (tx) => {
      await tx`SELECT count(*) FROM pg_class`;
      holding();
      await sleep(2000);
      released = Date.now();
    });
    try {
      await holder;
      const first = runMigrations({ url: migratorUrl() });
      // The transaction of the upgrade has recorded the new version while the first run still waits for its index build.
      await expect.poll(schemaVersion, { interval: 20, timeout: 10_000 }).toBe(expected);
      expect(released).toBe(0);
      const second = await runMigrations({ url: migratorUrl() });
      expect(released).toBeGreaterThan(0);
      expect(second.applied).toEqual([]);
      expect((await first).applied).toEqual([{ chain: PGBOSS_SCHEMA, tag: `schema_${String(expected)}` }]);
    } finally {
      await reader;
    }
    expect(await invalidIndexes()).toEqual([]);
  });

  it("is upgraded once by runs started together", async () => {
    await behind(1);
    const runs = await Promise.all([1, 2, 3].map(() => runMigrations({ url: migratorUrl() })));
    const steps = runs.flatMap((run) => run.applied);
    expect(steps).toEqual([{ chain: PGBOSS_SCHEMA, tag: `schema_${String(expected)}` }]);
    expect(await schemaVersion()).toBe(expected);
    expect(await invalidIndexes()).toEqual([]);
  });

  it("is served by pg-boss as slugbase_app once upgraded", async () => {
    await behind(1);
    await runMigrations({ url: migratorUrl() });
    const boss = new PgBoss({
      connectionString: urlOf(database().app),
      schema: PGBOSS_SCHEMA,
      max: 1,
      migrate: false,
      createSchema: false,
      supervise: false,
      schedule: false,
    });
    boss.on("error", () => undefined);
    await boss.start();
    try {
      expect(await boss.schemaVersion()).toBe(expected);
    } finally {
      await boss.stop({ graceful: false });
    }
  });
});

const PENDING_TABLE = "drizzle.pgboss_pending_builds";

// A transaction that holds a snapshot until `release` is called: a concurrent index build waits for it after its second scan. `virtualxid` is the
// virtual transaction id that build waits on, as `pg_locks` shows it.
function holdSnapshot(): { held: Promise<void>; release: () => void; done: Promise<unknown>; virtualxid: () => string } {
  let holding!: () => void;
  let release!: () => void;
  let virtualxid = "";
  const held = new Promise<void>((resolve) => {
    holding = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = database().owner.begin("ISOLATION LEVEL REPEATABLE READ", async (tx) => {
    await tx`SELECT count(*) FROM pg_class`;
    const [own] = await tx<{ virtualxid: string }[]>`SELECT virtualxid FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'virtualxid'`;
    virtualxid = own?.virtualxid ?? "";
    holding();
    await released;
  });
  return { held, release, done, virtualxid: () => virtualxid };
}

// The pool acts as the owner role, which may not see the activity of a session
// of the migrator; the migrator may, and its session is put back as it was.
async function asMigrator<T>(run: (connection: { unsafe: (text: string, params?: string[]) => Promise<Record<string, unknown>[]> }) => Promise<T>): Promise<T> {
  const connection = await database().owner.reserve();
  try {
    await connection.unsafe("SET ROLE slugbase_migrator");
    return await run(connection);
  } finally {
    await connection.unsafe("SET ROLE slugbase_owner");
    connection.release();
  }
}

// What a concurrent index build is blocked on, as `pg_locks` shows it: another transaction's virtual transaction id, which is how it waits for the
// snapshots older than its second scan, or a lock on a relation, which is how it queues for a table.
type Blocked = { virtualxid: string } | { relation: string };

// The backend of the pg-boss step of migrate while it runs a concurrent index build in this test's own database: the cluster is shared, and the same step of another database is not ours to cancel.
// Without `blocked` any build is found, as soon as it is active; with it, only one that waits for exactly that, which is the one thing a test can cancel
// knowing how far the build got.
async function buildBackend(blocked?: Blocked): Promise<number | undefined> {
  const params = [database().name];
  let waiting = "true";
  if (blocked !== undefined) {
    // The migrator may not read the schema of a table it is not named for, so the relation is resolved as the owner.
    const relation = "relation" in blocked ? (await rows<{ oid: string | null }>(`SELECT to_regclass('${blocked.relation}')::oid::text AS oid`))[0]?.oid : undefined;
    const on = "virtualxid" in blocked ? "l.locktype = 'virtualxid' AND l.virtualxid = $2" : "l.locktype = 'relation' AND l.relation = $2::oid";
    params.push("virtualxid" in blocked ? blocked.virtualxid : (relation ?? "0"));
    waiting = `a.wait_event_type = 'Lock' AND EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid = a.pid AND NOT l.granted AND ${on})`;
  }
  const found = await asMigrator((connection) =>
    connection.unsafe(
      `SELECT a.pid FROM pg_stat_activity a
        WHERE a.datname = $1 AND a.application_name = 'slugbase-migrate-pgboss' AND a.state = 'active'
          AND a.query ILIKE '%INDEX CONCURRENTLY%' AND ${waiting}`,
      params,
    ),
  );
  const pid = found[0]?.["pid"];
  return typeof pid === "number" ? pid : undefined;
}

async function cancelBackend(pid: number): Promise<void> {
  await asMigrator((connection) => connection.unsafe(`SELECT pg_cancel_backend(${String(pid)})`));
}

async function indexState(name: string): Promise<{ oid: number; valid: boolean } | undefined> {
  const found = await rows<{ oid: number; valid: boolean }>(`
    SELECT c.oid::int AS oid, i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = '${name}' AND c.relnamespace = '${PGBOSS_SCHEMA}'::regnamespace`);
  return found[0];
}

describe("the lookup of the index build of an upgrade", () => {
  it("ignores the same step running in another database", async () => {
    await withTestDatabase(async (other) => {
      const decoy = await other.owner.reserve();
      let sleeping: Promise<unknown> | undefined;
      let pid = 0;
      try {
        await decoy.unsafe("SET application_name = 'slugbase-migrate-pgboss'");
        const [self] = await decoy.unsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid");
        pid = self?.pid ?? 0;
        expect(pid).toBeGreaterThan(0);
        sleeping = decoy.unsafe("SELECT pg_sleep(30) /* INDEX CONCURRENTLY */").then(
          () => undefined,
          () => undefined,
        );
        // Without the filter on the database the lookup would return this backend, so it has to be visible to the migrator first.
        const visible = (): Promise<boolean> =>
          asMigrator(async (connection) => {
            const found = await connection.unsafe(
              `SELECT 1 FROM pg_stat_activity
                WHERE pid = $1 AND datname = $2 AND application_name = 'slugbase-migrate-pgboss'
                  AND state = 'active' AND query ILIKE '%INDEX CONCURRENTLY%'`,
              [String(pid), other.name],
            );
            return found.length === 1;
          });
        await expect.poll(visible, { interval: 20, timeout: 10_000 }).toBe(true);
        expect(other.name).not.toBe(database().name);

        expect(await buildBackend()).toBeUndefined();
        expect(await buildBackend({ relation: "pg_catalog.pg_class" })).toBeUndefined();
      } finally {
        if (pid > 0) {
          await cancelBackend(pid);
        }
        await sleeping;
        decoy.release();
      }
    });
  });
});

describe("the index builds of an upgrade that stopped", () => {
  it("are finished by the next run, which drops the INVALID index the stopped build left", async () => {
    await behind(1);
    const reader = holdSnapshot();
    await reader.held;
    const first = failureOf(() => runMigrations({ url: migratorUrl() }));
    // The transaction of the upgrade has stamped the version. A build that is merely running has not necessarily put its index in the catalog yet, and
    // cancelled there it leaves none; one that waits for the held snapshot has done so, and leaves the index INVALID.
    await expect.poll(schemaVersion, { interval: 20, timeout: 10_000 }).toBe(expected);
    const waitingOnSnapshot = (): Promise<number | undefined> => buildBackend({ virtualxid: reader.virtualxid() });
    await expect.poll(waitingOnSnapshot, { interval: 20, timeout: 10_000 }).toBeDefined();
    const pid = await waitingOnSnapshot();
    expect((await indexState("job_common_i13"))?.valid).toBe(false);
    await cancelBackend(pid ?? 0);
    await first;
    reader.release();
    await reader.done;
    // Version stamped, index left behind INVALID, and the record of what is still owed kept.
    expect(await schemaVersion()).toBe(expected);
    expect((await indexState("job_common_i13"))?.valid).toBe(false);
    expect(await rows(`SELECT 1 FROM ${PENDING_TABLE}`)).toHaveLength(1);
    expect(await rows<{ read: boolean; write: boolean }>(`
      SELECT has_table_privilege('slugbase_app', '${PENDING_TABLE}', 'SELECT') AS read,
             has_table_privilege('slugbase_app', '${PENDING_TABLE}', 'INSERT, UPDATE, DELETE') AS write`)).toEqual([{ read: false, write: false }]);

    const resumed = await runMigrations({ url: migratorUrl() });
    expect(resumed.applied).toEqual([{ chain: PGBOSS_SCHEMA, tag: `schema_${String(expected)}` }]);
    expect((await indexState("job_common_i13"))?.valid).toBe(true);
    expect(await invalidIndexes()).toEqual([]);
    expect(await rows(`SELECT 1 FROM ${PENDING_TABLE}`)).toHaveLength(0);
    expect((await runMigrations({ url: migratorUrl() })).applied).toEqual([]);
  });

  it("resume at the build that did not finish and leave the valid indexes of the ones before it alone", async () => {
    await behind(1);
    await rows(`SELECT ${PGBOSS_SCHEMA}.create_queue('partitioned', '{"partition": true, "policy": "standard"}'::jsonb)`);
    const [queue] = await rows<{ table_name: string }>(`SELECT table_name FROM ${PGBOSS_SCHEMA}.queue WHERE name = 'partitioned'`);
    const partition = queue?.table_name ?? "";
    const reader = holdSnapshot();
    await reader.held;
    const first = failureOf(() => runMigrations({ url: migratorUrl() }));
    await expect.poll(schemaVersion, { interval: 20, timeout: 10_000 }).toBe(expected);
    // Once the version is stamped nothing else takes this table's lock: the second build of the upgrade queues on it.
    // The build of the first table may still wait for the snapshot after the reader is released, so the one to cancel is the one that queues on the partition.
    const blocker = database().owner.begin(async (tx) => {
      await tx.unsafe(`LOCK TABLE ${PGBOSS_SCHEMA}.${partition} IN SHARE ROW EXCLUSIVE MODE`);
      reader.release();
      const queuedOnPartition = (): Promise<number | undefined> => buildBackend({ relation: `${PGBOSS_SCHEMA}.${partition}` });
      await expect.poll(queuedOnPartition, { interval: 20, timeout: 10_000 }).toBeDefined();
      await cancelBackend((await queuedOnPartition()) ?? 0);
      await first;
    });
    await blocker;
    await reader.done;
    const common = await indexState("job_common_i13");
    expect(common?.valid).toBe(true);
    expect(await indexState(`${partition}_i13`)).toBeUndefined();
    expect(await schemaVersion()).toBe(expected);

    const resumed = await runMigrations({ url: migratorUrl() });
    expect(resumed.applied).toEqual([{ chain: PGBOSS_SCHEMA, tag: `schema_${String(expected)}` }]);
    expect((await indexState(`${partition}_i13`))?.valid).toBe(true);
    expect(await indexState("job_common_i13")).toEqual(common);
    expect(await invalidIndexes()).toEqual([]);
    expect(await rows(`SELECT 1 FROM ${PENDING_TABLE}`)).toHaveLength(0);
  });
});

async function recordPending(target: number, statements: string[]): Promise<void> {
  await rows(`
    CREATE TABLE IF NOT EXISTS ${PENDING_TABLE} (
      id boolean PRIMARY KEY DEFAULT true CHECK (id),
      target_version integer NOT NULL,
      statements text[] NOT NULL,
      done integer NOT NULL DEFAULT 0
    )`);
  await rows(`DELETE FROM ${PENDING_TABLE}`);
  await database().owner.unsafe(`INSERT INTO ${PENDING_TABLE} (id, target_version, statements) VALUES (true, $1, $2)`, [target, statements]);
}

describe("the record of the index builds still owed", () => {
  it("does not hold a run on a build whose table has since been dropped", async () => {
    await behind(0);
    await recordPending(expected, [`CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS jgone_i13 ON ${PGBOSS_SCHEMA}.jgone (name, singleton_key)`]);
    const result = await runMigrations({ url: migratorUrl() });
    expect(result.applied).toEqual([{ chain: PGBOSS_SCHEMA, tag: `schema_${String(expected)}` }]);
    expect(await rows(`SELECT 1 FROM ${PENDING_TABLE}`)).toHaveLength(0);
    expect((await runMigrations({ url: migratorUrl() })).applied).toEqual([]);
  });

  it("is discarded when the transaction it was written for did not commit", async () => {
    await behind(1);
    await recordPending(expected, [`CREATE INDEX CONCURRENTLY IF NOT EXISTS stale_i1 ON ${PGBOSS_SCHEMA}.version (version)`]);
    await runMigrations({ url: migratorUrl() });
    expect(await rows(`SELECT 1 FROM pg_indexes WHERE schemaname = '${PGBOSS_SCHEMA}' AND indexname = 'stale_i1'`)).toHaveLength(0);
    expect((await indexState("job_common_i13"))?.valid).toBe(true);
    expect(await rows(`SELECT 1 FROM ${PENDING_TABLE}`)).toHaveLength(0);
  });
});

describe("the DDL of an upgrade", () => {
  it("ignores a queue table name pg-boss did not generate", async () => {
    await behind(1);
    await rows(`SELECT ${PGBOSS_SCHEMA}.create_queue('partitioned', '{"partition": true, "policy": "standard"}'::jsonb)`);
    const [queue] = await rows<{ table_name: string }>(`SELECT table_name FROM ${PGBOSS_SCHEMA}.queue WHERE name = 'partitioned'`);
    const partition = queue?.table_name ?? "";
    await rows(`UPDATE ${PGBOSS_SCHEMA}.queue SET table_name = 'stray ON ${PGBOSS_SCHEMA}.version (version) --' WHERE name = 'partitioned'`);

    const result = await runMigrations({ url: migratorUrl() });
    expect(result.applied).toEqual([{ chain: PGBOSS_SCHEMA, tag: `schema_${String(expected)}` }]);
    expect(await rows(`SELECT 1 FROM pg_indexes WHERE schemaname = '${PGBOSS_SCHEMA}' AND tablename = 'version' AND indexname <> 'version_pkey'`)).toHaveLength(0);
    expect(await rows(`SELECT 1 FROM pg_indexes WHERE schemaname = '${PGBOSS_SCHEMA}' AND indexname LIKE 'stray%'`)).toHaveLength(0);
    // The partition is found in the catalog, whatever the queue table says.
    expect((await indexState(`${partition}_i13`))?.valid).toBe(true);
    expect(await invalidIndexes()).toEqual([]);
  });
});

describe("the session of the pg-boss step", () => {
  it("is the owner role with the connection check, keepalives and statement timeout of the engine", async () => {
    await behind(0);
    const boss = new PgBoss({
      connectionString: ownerSessionUrl(migratorUrl()),
      schema: PGBOSS_SCHEMA,
      max: 1,
      migrate: false,
      createSchema: false,
      supervise: false,
      schedule: false,
    });
    boss.on("error", () => undefined);
    await boss.start();
    try {
      const result = await boss.getDb().executeSql(`
        SELECT current_user AS role,
               current_setting('client_connection_check_interval') AS check_interval,
               current_setting('tcp_keepalives_idle') AS idle,
               current_setting('tcp_keepalives_interval') AS keepalive_interval,
               current_setting('tcp_keepalives_count') AS count,
               current_setting('statement_timeout') AS statement_timeout`);
      expect(result.rows).toEqual([
        { role: "slugbase_owner", check_interval: "1s", idle: "60", keepalive_interval: "10", count: "6", statement_timeout: "15min" },
      ]);
    } finally {
      await boss.stop({ graceful: false });
    }
  });
});

describe("a pg-boss schema that migrate cannot upgrade", () => {
  it("is refused when it is newer than this build's, naming both versions and no connection string", async () => {
    await behind(0);
    await rows(`UPDATE ${PGBOSS_SCHEMA}.version SET version = ${String(expected + 1)}`);
    const url = migratorUrl();
    const failure = await failureOf(() => runMigrations({ url }));
    expect(failure.message).toContain(String(expected + 1));
    expect(failure.message).toContain(String(expected));
    expect(failure.message).not.toContain(url);
    expect(failure.message).not.toContain(String(database().owner.options.pass));
    expect(await schemaVersion()).toBe(expected + 1);
    await rows(`UPDATE ${PGBOSS_SCHEMA}.version SET version = ${String(expected)}`);
  });

  it("is refused, and left as it was, when it is older than pg-boss can upgrade from", async () => {
    await behind(0);
    await rows(`UPDATE ${PGBOSS_SCHEMA}.version SET version = 1`);
    const url = migratorUrl();
    const failure = await failureOf(() => runMigrations({ url }));
    expect(failure.message).toMatch(/oldest supported starting version/);
    expect(failure.message).not.toContain(url);
    expect(failure.message).not.toContain(String(database().owner.options.pass));
    expect(await schemaVersion()).toBe(1);
  });
});
