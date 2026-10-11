import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

// The migration engine (doc 05 section 5.3, D25). It is the only code path that
// applies migrations: the `migrate` command, the CE image entrypoint and the
// in-process variant all call `migrate()`.
//
// Migration file format, for the generator (scripts/generate-migration.ts) and
// for this engine:
//
//   - A file is a list of statements separated by STATEMENT_BREAKPOINT lines.
//     A statement ends in `;`, and a custom-SQL statement may hold several.
//   - A file whose first line is NON_TRANSACTIONAL_MARKER is applied outside a
//     transaction, one statement at a time. The generator writes only
//     `CREATE INDEX CONCURRENTLY` statements into such a file.
//   - Every other file is applied in one transaction, together with its
//     bookkeeping row.

export const STATEMENT_BREAKPOINT = "--> statement-breakpoint";
export const NON_TRANSACTIONAL_MARKER = "-- slugbase:non-transactional";

export function splitStatements(sql: string): string[] {
  return sql
    .split(STATEMENT_BREAKPOINT)
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");
}

/** Whether a migration file must be applied outside a transaction. */
export function isNonTransactional(sql: string): boolean {
  return sql.split("\n", 1)[0]?.trimEnd() === NON_TRANSACTIONAL_MARKER;
}

/** One migration chain: a folder of migrations and the table that records them. */
export interface MigrationChain {
  /** Names the chain in errors and results. */
  name: string;
  /** The folder holding `meta/_journal.json` and the `<tag>.sql` files. */
  folder: string;
  /** The table in the `drizzle` schema that records the applied migrations. */
  bookkeepingTable: string;
}

/** The Community Edition chain, always applied first. */
export const CE_CHAIN: MigrationChain = {
  name: "core",
  folder: fileURLToPath(new URL("../migrations/", import.meta.url)),
  bookkeepingTable: "migrations_core",
};

export interface MigrateOptions {
  /** Connection URL of the migrator role (`DATABASE_MIGRATE_URL`). */
  url: string;
  /** Chains applied after the CE chain, in order, each with its own bookkeeping table. */
  chains?: readonly MigrationChain[];
}

export interface MigrateResult {
  /** The migrations this run applied, in order. */
  applied: { chain: string; tag: string }[];
}

export interface MigrationLevelOptions {
  /** Connection URL of a role that can read the bookkeeping tables, which `migrate` lets slugbase_app do. */
  url: string;
  /** Chains the build expects after the CE chain. */
  chains?: readonly MigrationChain[];
}

export interface MigrationLevel {
  /** Migrations the build ships, over all chains. */
  expected: number;
  /** Shipped migrations the database has recorded. */
  applied: number;
  /** Recorded migrations this build does not ship: the database is ahead of it. */
  unknownApplied: number;
}

/**
 * Every failure of this module. The message and `code` (a SQLSTATE or a Node
 * error code, when there is one) never contain the connection string or the
 * password, and the driver's own error is not kept as `cause`.
 */
export class MigrationError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "MigrationError";
    this.code = code;
  }
}

const LOCK_TIMEOUT = "5s";
const STATEMENT_TIMEOUT = "15min";

const BOOKKEEPING_SCHEMA = "drizzle";
const OWNER_ROLE = "slugbase_owner";
const APP_ROLE = "slugbase_app";
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const TAG = /^[A-Za-z0-9_]+$/;

interface Migration {
  tag: string;
  when: number;
  hash: string;
  nonTransactional: boolean;
  statements: string[];
}

interface LoadedChain {
  chain: MigrationChain;
  migrations: Migration[];
}

interface ConnectionSecrets {
  url: string;
  secrets: string[];
}

function parseConnection(url: string): ConnectionSecrets {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MigrationError("the database URL is not a valid PostgreSQL connection URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new MigrationError("the database URL is not a valid PostgreSQL connection URL");
  }
  const secrets = new Set<string>([url, parsed.href]);
  if (parsed.password !== "") {
    secrets.add(parsed.password);
    try {
      secrets.add(decodeURIComponent(parsed.password));
    } catch {
      // An undecodable password has no other form to redact.
    }
  }
  return { url, secrets: [...secrets].sort((a, b) => b.length - a.length) };
}

function redact(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) {
    result = result.split(secret).join("***");
  }
  return result;
}

function sanitize(error: unknown, connection: ConnectionSecrets, context?: string): MigrationError {
  let message = "unknown error";
  let code: string | undefined;
  if (error instanceof Error) {
    message = error.message;
    const errorCode = (error as { code?: unknown }).code;
    code = typeof errorCode === "string" ? errorCode : undefined;
    if (message === "") {
      message = code ?? error.name;
    }
  }
  const text = redact(context === undefined ? message : `${context}: ${message}`, connection.secrets);
  return new MigrationError(text, code === undefined ? undefined : redact(code, connection.secrets));
}

function quoteIdentifier(name: string): string {
  return `"${name}"`;
}

function bookkeepingName(chain: MigrationChain): string {
  return `${quoteIdentifier(BOOKKEEPING_SCHEMA)}.${quoteIdentifier(chain.bookkeepingTable)}`;
}

function loadChain(chain: MigrationChain): LoadedChain {
  const fail = (reason: string): never => {
    throw new MigrationError(`chain "${chain.name}": ${reason}`);
  };
  let journal: unknown;
  try {
    journal = JSON.parse(readFileSync(join(chain.folder, "meta", "_journal.json"), "utf8"));
  } catch (error) {
    return fail(`cannot read meta/_journal.json (${error instanceof Error ? error.message : "unknown error"})`);
  }
  const entries =
    typeof journal === "object" && journal !== null && "entries" in journal ? journal.entries : undefined;
  if (!Array.isArray(entries)) {
    return fail("meta/_journal.json has no entries list");
  }
  const migrations: Migration[] = [];
  for (const entry of entries as unknown[]) {
    const tag = typeof entry === "object" && entry !== null && "tag" in entry ? entry.tag : undefined;
    const when = typeof entry === "object" && entry !== null && "when" in entry ? entry.when : undefined;
    if (typeof tag !== "string" || !TAG.test(tag) || typeof when !== "number" || !Number.isSafeInteger(when)) {
      return fail("meta/_journal.json holds an entry without a valid tag and when");
    }
    const previous = migrations.at(-1);
    if (previous !== undefined && when <= previous.when) {
      return fail(`migration ${tag} is not newer than ${previous.tag}`);
    }
    let content: string;
    try {
      content = readFileSync(join(chain.folder, `${tag}.sql`), "utf8");
    } catch {
      return fail(`migration file ${tag}.sql cannot be read`);
    }
    const statements = splitStatements(content);
    if (statements.length === 0) {
      return fail(`migration ${tag} holds no statement`);
    }
    migrations.push({
      tag,
      when,
      hash: createHash("sha256").update(content).digest("hex"),
      nonTransactional: isNonTransactional(content),
      statements,
    });
  }
  return { chain, migrations };
}

function loadChains(extra: readonly MigrationChain[] | undefined): LoadedChain[] {
  const chains = [CE_CHAIN, ...(extra ?? [])];
  const names = new Set<string>();
  const tables = new Set<string>();
  for (const chain of chains) {
    if (!IDENTIFIER.test(chain.bookkeepingTable)) {
      throw new MigrationError(`chain "${chain.name}": bookkeepingTable is not a plain lower-case identifier`);
    }
    if (names.has(chain.name) || tables.has(chain.bookkeepingTable)) {
      throw new MigrationError(`chain "${chain.name}": name or bookkeeping table is used by another chain`);
    }
    names.add(chain.name);
    tables.add(chain.bookkeepingTable);
  }
  return chains.map(loadChain);
}

function connect(connection: ConnectionSecrets, name: string): postgres.Sql {
  return postgres(connection.url, {
    max: 1,
    max_lifetime: 0,
    idle_timeout: 0,
    onnotice: () => undefined,
    connection: { application_name: name },
  });
}

interface Recorded {
  hash: string;
  createdAt: string;
}

async function readRecorded(sql: postgres.Sql, chain: MigrationChain): Promise<Recorded[] | undefined> {
  const exists = await sql<{ present: boolean }[]>`
    SELECT to_regclass(${bookkeepingName(chain)}) IS NOT NULL AS present`;
  if (exists[0]?.present !== true) {
    return undefined;
  }
  const rows = await sql.unsafe<{ hash: string; created_at: string }[]>(
    `SELECT hash, created_at::text AS created_at FROM ${bookkeepingName(chain)} ORDER BY created_at`,
  );
  return rows.map((row) => ({ hash: row.hash, createdAt: row.created_at }));
}

function recordedFor(recorded: readonly Recorded[], migration: Migration): Recorded | undefined {
  return recorded.find((row) => row.createdAt === String(migration.when));
}

/**
 * Where the database stands against the migrations this build ships, for
 * readiness (doc 05 section 5.3): `applied < expected` is behind,
 * `unknownApplied > 0` is ahead. A failure to read the bookkeeping tables
 * rejects: it never means ready. A database no migration ran on has no
 * bookkeeping table, which counts as nothing applied.
 */
export async function migrationLevel(options: MigrationLevelOptions): Promise<MigrationLevel> {
  const connection = parseConnection(options.url);
  let loaded: LoadedChain[];
  try {
    loaded = loadChains(options.chains);
  } catch (error) {
    throw sanitize(error, connection);
  }
  const sql = connect(connection, "slugbase-migration-level");
  try {
    const level: MigrationLevel = { expected: 0, applied: 0, unknownApplied: 0 };
    for (const { chain, migrations } of loaded) {
      const recorded = (await readRecorded(sql, chain)) ?? [];
      const matched = new Set<Recorded>();
      for (const migration of migrations) {
        const row = recordedFor(recorded, migration);
        if (row?.hash === migration.hash) {
          matched.add(row);
        }
      }
      level.expected += migrations.length;
      level.applied += matched.size;
      level.unknownApplied += recorded.length - matched.size;
    }
    return level;
  } catch (error) {
    throw sanitize(error, connection);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

class StepFailure extends Error {
  readonly step: string;
  readonly original: unknown;

  constructor(step: string, original: unknown) {
    super(step);
    this.step = step;
    this.original = original;
  }
}

async function assertSession(sql: Pick<postgres.Sql, "unsafe">, pid: number): Promise<void> {
  const rows = await sql.unsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid");
  if (rows[0]?.pid !== pid) {
    throw new MigrationError(
      "the database connection was replaced during the run, so the advisory lock and the session settings are gone",
    );
  }
}

async function applyMigration(sql: postgres.Sql, pid: number, chain: MigrationChain, migration: Migration) {
  const record = `INSERT INTO ${bookkeepingName(chain)} (hash, created_at) VALUES ($1, $2::bigint)`;
  const values = [migration.hash, String(migration.when)];
  if (migration.nonTransactional) {
    // Not atomic with its bookkeeping row: when a statement fails part-way, the
    // statements before it stay and nothing is recorded, so a re-run fails on
    // the first of them ("already exists") instead of recording the step.
    for (const statement of migration.statements) {
      await assertSession(sql, pid);
      await sql.unsafe(statement);
    }
    await assertSession(sql, pid);
    await sql.unsafe(record, values);
    return;
  }
  await sql.begin(async (tx) => {
    await assertSession(tx, pid);
    for (const statement of migration.statements) {
      await tx.unsafe(statement);
    }
    await tx.unsafe(record, values);
  });
}

async function applyChain(sql: postgres.Sql, pid: number, loaded: LoadedChain): Promise<string[]> {
  const { chain, migrations } = loaded;
  await sql.begin(async (tx) => {
    await tx.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(BOOKKEEPING_SCHEMA)}`);
    await tx.unsafe(
      `CREATE TABLE IF NOT EXISTS ${bookkeepingName(chain)} (
         id serial PRIMARY KEY,
         hash text NOT NULL,
         created_at bigint NOT NULL UNIQUE
       )`,
    );
    // The server reads the level for readiness as slugbase_app (doc 05 section 5.3).
    await tx.unsafe(`GRANT USAGE ON SCHEMA ${quoteIdentifier(BOOKKEEPING_SCHEMA)} TO ${APP_ROLE}`);
    await tx.unsafe(`GRANT SELECT ON ${bookkeepingName(chain)} TO ${APP_ROLE}`);
  });
  const recorded = (await readRecorded(sql, chain)) ?? [];
  const applied: string[] = [];
  for (const migration of migrations) {
    const row = recordedFor(recorded, migration);
    if (row === undefined) {
      try {
        await applyMigration(sql, pid, chain, migration);
      } catch (error) {
        throw new StepFailure(`migration ${migration.tag} of chain "${chain.name}" failed`, error);
      }
      applied.push(migration.tag);
    } else if (row.hash !== migration.hash) {
      throw new MigrationError(
        `migration ${migration.tag} of chain "${chain.name}" was changed after it was applied (checksum mismatch)`,
      );
    }
  }
  return applied;
}

/**
 * Applies the CE chain and then the additional chains, one migration at a time,
 * under `pg_advisory_lock(hashtext('slugbase.migrate'))` held for the whole run,
 * with `lock_timeout` and `statement_timeout` set for the session and DDL done
 * as `slugbase_owner`. A second concurrent call waits for the lock and finds
 * nothing left to do. The lock lives in the session: it is released when the
 * run ends, on success or failure, because the connection is closed.
 */
export async function migrate(options: MigrateOptions): Promise<MigrateResult> {
  const connection = parseConnection(options.url);
  let loaded: LoadedChain[];
  try {
    loaded = loadChains(options.chains);
  } catch (error) {
    throw sanitize(error, connection);
  }
  const sql = connect(connection, "slugbase-migrate");
  try {
    // Waiting for the lock is bounded by statement_timeout, not by lock_timeout,
    // which applies to a migration waiting for a table lock.
    await sql.unsafe(`SET statement_timeout = '${STATEMENT_TIMEOUT}'`);
    await sql.unsafe("SET lock_timeout = 0");
    await sql`SELECT pg_advisory_lock(hashtext('slugbase.migrate'))`;
    const pidRows = await sql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    const pid = pidRows[0]?.pid;
    if (pid === undefined) {
      throw new MigrationError("the database did not report its backend process");
    }
    await sql.unsafe(`SET lock_timeout = '${LOCK_TIMEOUT}'`);
    await sql.unsafe(`SET ROLE ${OWNER_ROLE}`);

    const applied: MigrateResult["applied"] = [];
    for (const chain of loaded) {
      for (const tag of await applyChain(sql, pid, chain)) {
        applied.push({ chain: chain.chain.name, tag });
      }
    }
    await sql`SELECT pg_advisory_unlock(hashtext('slugbase.migrate'))`;
    return { applied };
  } catch (error) {
    if (error instanceof StepFailure) {
      throw sanitize(error.original, connection, error.step);
    }
    throw sanitize(error, connection);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
