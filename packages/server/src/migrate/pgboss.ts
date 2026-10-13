import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import { MigrationError } from "@slugbase/db";
import { PgBoss, getConstructionPlans, getMigrationPlans } from "pg-boss";
import { connectionSecrets, redact } from "./secrets.ts";

// The pg-boss chain of doc 05 section 5.5: second after the CE chain, recorded
// in pg-boss's own version table. `migrate` installs and upgrades it as
// `slugbase_owner`, so that the default privileges of the declarative SQL give
// `slugbase_app`, the role the worker connects as, its rights on what pg-boss
// creates; the worker itself never installs or upgrades it.

/** Where pg-boss keeps its tables; the worker's pg-boss uses the same schema. */
export const PGBOSS_SCHEMA = "pgboss";

const OWNER_ROLE = "slugbase_owner";
const STATEMENT_TIMEOUT = "15min";
const STATEMENT_TIMEOUT_MS = 15 * 60 * 1000;
const LOCK_POLL_INTERVAL_MS = 500;

// The session settings of the engine in `@slugbase/db` (doc 05 section 5.2): a
// build whose client is gone is cancelled by the server instead of holding the
// session, and with it the migrate lock, until the connection ends on its own.
const CLIENT_CONNECTION_CHECK_INTERVAL = "1s";
const TCP_KEEPALIVES_IDLE_SECONDS = 60;
const TCP_KEEPALIVES_INTERVAL_SECONDS = 10;
const TCP_KEEPALIVES_COUNT = 6;

/**
 * Where the index builds of an upgrade that are still to run are recorded. It
 * lives beside the bookkeeping tables of the engine, owned by the owner role;
 * `slugbase_app` has no right on it, as what it holds runs as the owner.
 */
const PENDING_TABLE = "drizzle.pgboss_pending_builds";

/** pg-boss's own message for a statement that finds its object already installed, as it handles an install another process finished first. */
const ALREADY_INSTALLED = "already exists";

/** The comment pg-boss puts in front of each index build it appends after the transaction of an upgrade. */
const INLINED_BUILD_MARKER = "-- inlined from ";
const INLINED_BUILD = /\n(?=-- inlined from )/;
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const INDEX_STATEMENT = /^(?:CREATE\s+(?:UNIQUE\s+)?INDEX|DROP\s+INDEX)\s+CONCURRENTLY\s/i;

type Db = ReturnType<PgBoss["getDb"]>;

interface Pool {
  open(): Promise<void>;
  close(): Promise<void>;
}

function isPool(value: unknown): value is Pool {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { open?: unknown }).open === "function" &&
    typeof (value as { close?: unknown }).close === "function"
  );
}

/** The schema version this build of pg-boss installs. */
function expectedVersion(): number {
  const manifest = createRequire(import.meta.url)("pg-boss/package.json") as { pgboss?: { schema?: unknown } };
  const version = manifest.pgboss?.schema;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new MigrationError("the installed pg-boss does not declare the version of its schema");
  }
  return version;
}

// The session starts as the owner role, which the migrator may act as, and is
// bounded by statement_timeout. lock_timeout is not set here: the transaction
// of an upgrade sets its own, and the index builds after it turn it off. The
// connection-check and keepalive settings are part of the startup, so every
// connection of the pool has them.
export function ownerSessionUrl(url: string): string {
  const parsed = new URL(url);
  const existing = parsed.searchParams.get("options");
  const ours = [
    `-c role=${OWNER_ROLE}`,
    `-c statement_timeout=${STATEMENT_TIMEOUT}`,
    `-c client_connection_check_interval=${CLIENT_CONNECTION_CHECK_INTERVAL}`,
    `-c tcp_keepalives_idle=${String(TCP_KEEPALIVES_IDLE_SECONDS)}`,
    `-c tcp_keepalives_interval=${String(TCP_KEEPALIVES_INTERVAL_SECONDS)}`,
    `-c tcp_keepalives_count=${String(TCP_KEEPALIVES_COUNT)}`,
  ].join(" ");
  parsed.searchParams.set("options", existing === null || existing === "" ? ours : `${existing} ${ours}`);
  return parsed.href;
}

async function select<Row>(db: Db, text: string): Promise<Row[]> {
  const result = await db.executeSql(text);
  return result.rows as Row[];
}

async function backendPid(db: Db): Promise<number> {
  const pid = (await select<{ pid: unknown }>(db, "SELECT pg_backend_pid() AS pid"))[0]?.pid;
  if (typeof pid !== "number") {
    throw new MigrationError("the database did not report its backend process");
  }
  return pid;
}

const SESSION_REPLACED =
  "the database connection was replaced during the run, so the advisory lock and the session settings are gone";

async function assertSession(db: Db, pid: number): Promise<void> {
  if ((await backendPid(db)) !== pid) {
    throw new MigrationError(SESSION_REPLACED);
  }
}

// The lock of `migrate` itself (doc 05 section 5.3), the same key the engine of
// `@slugbase/db` takes for the chains. It is polled rather than waited for in a
// statement, so that a waiting run holds no snapshot which the index build of
// the running one would wait for. The pool holds one connection, and the lock
// lives in its session, which `assertSession` keeps checking.
async function takeMigrateLock(db: Db): Promise<number> {
  const deadline = Date.now() + STATEMENT_TIMEOUT_MS;
  const pid = await backendPid(db);
  for (;;) {
    const [lock] = await select<{ locked: boolean; pid: number }>(
      db,
      "SELECT pg_try_advisory_lock(hashtext('slugbase.migrate')) AS locked, pg_backend_pid() AS pid",
    );
    if (lock?.pid !== pid) {
      throw new MigrationError(SESSION_REPLACED);
    }
    if (lock.locked) {
      return pid;
    }
    if (Date.now() >= deadline) {
      throw new MigrationError("the migration lock was not obtained in time: another migrate is still running");
    }
    await sleep(LOCK_POLL_INTERVAL_MS);
  }
}

interface UpgradePlan {
  /** The part pg-boss runs in one transaction, from BEGIN to COMMIT, and which records the new version. */
  readonly transaction: string;
  /** The index builds pg-boss appends after it, which cannot run inside a transaction. */
  readonly builds: readonly string[];
}

// pg-boss's plan is one script: its transaction, then each concurrent index
// build. Anything else in it is refused, as the engine refuses it in a
// non-transactional migration.
function upgradePlan(plan: string): UpgradePlan {
  const [first = "", ...rest] = plan.split(INLINED_BUILD);
  const transaction = first.trim();
  if (!/^BEGIN;/.test(transaction) || !/COMMIT;$/.test(transaction)) {
    throw new MigrationError("the pg-boss upgrade plan is not a single transaction followed by index builds");
  }
  const builds = rest.map((chunk) => {
    const lines = chunk.trim().split("\n");
    const statement = lines.filter((line) => !line.startsWith("--")).join("\n").trim();
    if (!chunk.startsWith(INLINED_BUILD_MARKER) || !INDEX_STATEMENT.test(statement) || statement.replace(/;$/, "").includes(";")) {
      throw new MigrationError("the pg-boss upgrade plan holds a step that is not a concurrent index build");
    }
    return statement;
  });
  return { transaction, builds };
}

// The partitions of the job table are read from the catalog, which only the
// owner role changes, and not from `pgboss.queue`, which the application role
// writes: a table name goes into DDL that runs as the owner. The queue table
// supplies only the policy, which is compared and never pasted into a statement.
async function partitionTables(db: Db): Promise<{ tableName: string; policy: string }[]> {
  const tables = await select<{ table_name: string }>(
    db,
    `SELECT c.relname AS table_name
       FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = '${PGBOSS_SCHEMA}.job'::regclass AND c.relname <> 'job_common'
      ORDER BY c.relname`,
  );
  const queues = await select<{ table_name: string; policy: string }>(
    db,
    `SELECT table_name, policy FROM ${PGBOSS_SCHEMA}.queue WHERE partition = true`,
  );
  const policies = new Map(queues.map((row) => [row.table_name, row.policy]));
  return tables.map((row) => {
    if (!IDENTIFIER.test(row.table_name)) {
      throw new MigrationError("a partition of the pg-boss job table has a name that migrate does not build indexes on");
    }
    return { tableName: row.table_name, policy: policies.get(row.table_name) ?? "" };
  });
}

interface PendingBuilds {
  readonly target: number;
  readonly statements: readonly string[];
  readonly done: number;
}

async function readPending(db: Db): Promise<PendingBuilds | undefined> {
  const [present] = await select<{ present: boolean }>(db, `SELECT to_regclass('${PENDING_TABLE}') IS NOT NULL AS present`);
  if (present?.present !== true) {
    return undefined;
  }
  const [row] = await select<{ target_version: unknown; statements: unknown; done: unknown }>(
    db,
    `SELECT target_version, statements, done FROM ${PENDING_TABLE}`,
  );
  if (row === undefined) {
    return undefined;
  }
  const { target_version: target, statements, done } = row;
  if (
    typeof target !== "number" ||
    typeof done !== "number" ||
    !Array.isArray(statements) ||
    !statements.every((statement): statement is string => typeof statement === "string") ||
    done < 0 ||
    done > statements.length
  ) {
    throw new MigrationError("the record of the pg-boss index builds still to run is not readable");
  }
  return { target, statements, done };
}

// Written before the transaction of the upgrade, which records the new version
// and so is the point after which a run that stops leaves builds undone.
async function writePending(db: Db, target: number, statements: readonly string[]): Promise<void> {
  await db.executeSql(`CREATE SCHEMA IF NOT EXISTS drizzle`);
  await db.executeSql(
    `CREATE TABLE IF NOT EXISTS ${PENDING_TABLE} (
       id boolean PRIMARY KEY DEFAULT true CHECK (id),
       target_version integer NOT NULL,
       statements text[] NOT NULL,
       done integer NOT NULL DEFAULT 0
     )`,
  );
  await db.executeSql(
    `INSERT INTO ${PENDING_TABLE} (id, target_version, statements, done) VALUES (true, $1, $2, 0)
     ON CONFLICT (id) DO UPDATE SET target_version = excluded.target_version, statements = excluded.statements, done = 0`,
    [target, statements],
  );
}

async function clearPending(db: Db): Promise<void> {
  await db.executeSql(`DELETE FROM ${PENDING_TABLE}`);
}

const BUILD_TARGET = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+ON\s+(\w+)\.(\w+)[\s(]/i;

// One recorded build. A build of an earlier, interrupted run leaves an INVALID
// index of its name, which `IF NOT EXISTS` would skip: it is dropped first. A
// valid index is never touched, and a build on a table that no longer exists
// (its queue was deleted since) has nothing to build.
async function runBuild(db: Db, statement: string): Promise<void> {
  if (!INDEX_STATEMENT.test(statement) || statement.replace(/;$/, "").includes(";")) {
    throw new MigrationError("the record of the pg-boss index builds holds a step that is not a concurrent index build");
  }
  const target = BUILD_TARGET.exec(statement);
  if (target !== null) {
    const [, index = "", schema = "", table = ""] = target;
    if (schema !== PGBOSS_SCHEMA || !IDENTIFIER.test(index) || !IDENTIFIER.test(table)) {
      throw new MigrationError("the record of the pg-boss index builds names an object outside the pg-boss schema");
    }
    const [present] = await select<{ present: boolean }>(
      db,
      `SELECT to_regclass('${PGBOSS_SCHEMA}.${table}') IS NOT NULL AS present`,
    );
    if (present?.present !== true) {
      return;
    }
    const invalid = await db.executeSql(
      `SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = $1 AND c.relnamespace = '${PGBOSS_SCHEMA}'::regnamespace AND NOT i.indisvalid`,
      [index],
    );
    if (invalid.rows.length > 0) {
      await db.executeSql(`DROP INDEX CONCURRENTLY ${PGBOSS_SCHEMA}.${index}`);
    }
  }
  await db.executeSql(statement);
}

// A concurrent build waits for transactions that could write to its table
// and, after its second scan, for every transaction in the database whose
// snapshot predates that scan, whatever table it reads; that wait counts
// against lock_timeout. It queues no application traffic, so only
// statement_timeout bounds it (doc 05 section 5.2). Progress is recorded after
// each build, so a run that stops resumes at the build it did not finish.
async function finishBuilds(db: Db, pid: number, pending: PendingBuilds): Promise<void> {
  await assertSession(db, pid);
  await db.executeSql("SET lock_timeout = 0");
  for (let index = pending.done; index < pending.statements.length; index += 1) {
    await assertSession(db, pid);
    await runBuild(db, pending.statements[index] ?? "");
    await db.executeSql(`UPDATE ${PENDING_TABLE} SET done = $1`, [index + 1]);
  }
  await clearPending(db);
}

async function upgrade(db: Db, pid: number, from: number, target: number): Promise<void> {
  const partitions = await partitionTables(db);
  const { transaction, builds } = upgradePlan(getMigrationPlans(PGBOSS_SCHEMA, from, { partitionTables: partitions }));
  await assertSession(db, pid);
  if (builds.length > 0) {
    await writePending(db, target, builds);
  }
  try {
    await db.executeSql(transaction);
  } catch (error) {
    // The transaction failed part-way through and is still open in this session.
    await db.executeSql("ROLLBACK");
    throw error;
  }
  const pending = builds.length > 0 ? await readPending(db) : undefined;
  if (pending !== undefined) {
    await finishBuilds(db, pid, pending);
  }
}

/**
 * Installs the pg-boss schema when the database has none, and upgrades an older
 * one to the version this build runs, as `slugbase_owner` over `url`
 * (`DATABASE_MIGRATE_URL`), with pg-boss's own plans. The work runs under the
 * lock of `migrate`; the index builds of an upgrade run outside a transaction
 * with `lock_timeout` off and `statement_timeout` as their bound, and are
 * recorded before the upgrade so that a run that stops part-way is finished by
 * the next one, which drops the INVALID index of an interrupted build. Returns the
 * version this call installed or upgraded to, and undefined when the schema was
 * already at it, also when another `migrate` got there first. A schema newer
 * than this build rejects.
 */
export async function installPgBoss(url: string): Promise<number | undefined> {
  const secrets = connectionSecrets(url);
  try {
    const expected = expectedVersion();
    const boss = new PgBoss({
      connectionString: ownerSessionUrl(url),
      schema: PGBOSS_SCHEMA,
      max: 1,
      application_name: "slugbase-migrate-pgboss",
      migrate: false,
      createSchema: false,
      supervise: false,
      schedule: false,
    });
    // A failed statement rejects its own call; this only keeps the pool's errors on an idle connection from ending the process.
    boss.on("error", () => undefined);
    const pool: unknown = boss.getDb();
    if (!isPool(pool)) {
      throw new MigrationError("the installed pg-boss does not expose its connection pool");
    }
    await pool.open();
    try {
      const db = boss.getDb();
      const pid = await takeMigrateLock(db);
      let changed = false;
      if (!(await boss.isInstalled())) {
        try {
          await db.executeSql(getConstructionPlans(PGBOSS_SCHEMA, { createSchema: false }));
          changed = true;
        } catch (error) {
          // The plan runs in one transaction and failed part-way through it.
          await db.executeSql("ROLLBACK");
          if (!(error instanceof Error) || !error.message.includes(ALREADY_INSTALLED)) {
            throw error;
          }
        }
      }
      const found = await boss.schemaVersion();
      if (found !== null && found > expected) {
        throw new MigrationError(
          `the pg-boss schema is at version ${String(found)}, which is newer than version ${String(expected)}, the one this build installs and runs`,
        );
      }
      // Builds an earlier run recorded and did not finish: the version is
      // stamped by the transaction that precedes them, so a version at or past
      // the record's target means the builds are owed. A record of a version
      // not reached belongs to a transaction that did not commit.
      const pending = await readPending(db);
      if (pending !== undefined) {
        if (found !== null && found >= pending.target) {
          await finishBuilds(db, pid, pending);
          changed = true;
        } else {
          await clearPending(db);
        }
      }
      if (found !== null && found < expected) {
        await upgrade(db, pid, found, expected);
        changed = true;
      }
      const version = await boss.schemaVersion();
      if (version !== expected) {
        throw new MigrationError(
          `the pg-boss schema is at version ${version === null ? "none" : String(version)}, and this build installs and runs version ${String(expected)}`,
        );
      }
      return changed ? expected : undefined;
    } finally {
      await pool.close();
    }
  } catch (error) {
    if (error instanceof MigrationError) {
      throw new MigrationError(redact(error.message, secrets), error.code);
    }
    const code = (error as { code?: unknown } | null)?.code;
    const message = error instanceof Error && error.message !== "" ? error.message : "unknown error";
    throw new MigrationError(
      redact(`the pg-boss schema could not be installed or upgraded: ${message}`, secrets),
      typeof code === "string" ? redact(code, secrets) : undefined,
    );
  }
}
