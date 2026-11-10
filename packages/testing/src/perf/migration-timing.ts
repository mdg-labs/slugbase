import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { hash } from "@node-rs/argon2";
import { CE_CHAIN, migrate, type MigrationChain, type MigrationStop } from "@slugbase/db";
import { useCluster } from "@slugbase/db/testing";
import { buildLargeInstance, type LargeInstance, type LargeInstanceOptions } from "../seed/large.ts";
import { largeSeedScript } from "../seed/large-script.ts";
import { APP_PASSWORD, MIGRATOR_PASSWORD, PerfSeedError, assertHarnessDatabase, perfServer, type SeededCounts } from "../seed/perf.ts";
import { runSeedScript } from "../seed/run.ts";
import type { SeedConnection } from "../seed/target.ts";
import { CAN_OBSERVE_LOCKS, SAMPLE_INTERVAL_MS, startLockSampler, type LockHold } from "./lock-sampler.ts";

// Migration timing on the large instance (doc 08 section 5.4). A database is built at the migration level of the latest release and
// raised to the first level at which the large instance can be written, the large instance is seeded into it, and every later
// migration is applied with `migrate`, one at a time, while a sampler watches the `ACCESS EXCLUSIVE` locks of the session that
// applies it. The database is one the harness names (`test_` and 16 hex digits) on a loopback server or the harness's own, and the run
// never uses `drizzle-kit push`.

/** A migration that holds `ACCESS EXCLUSIVE` for longer than this fails the run (doc 08 section 5.4). */
export const LOCK_LIMIT_MS = 1_000;
const SEED_TIMEOUT_MS = 600_000;
const CE_CHAIN_NAME = CE_CHAIN.name;
// The first line that makes `migrate` apply a file outside a transaction (NON_TRANSACTIONAL_MARKER of packages/db/src/migrate.ts); the
// integration test holds it to a CE migration that `migrate` applies that way.
const NON_TRANSACTIONAL_MARKER = "-- slugbase:non-transactional";

/** Whether `sql` is a migration file that `migrate` applies outside a transaction. */
export function isNonTransactional(sql: string): boolean {
  return sql.split("\n", 1)[0]?.trimEnd() === NON_TRANSACTIONAL_MARKER;
}

export { SAMPLE_INTERVAL_MS };

export class MigrationTimingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationTimingError";
  }
}

/** A migration whose `ACCESS EXCLUSIVE` lock was held for longer than the limit. */
export class MigrationLockError extends MigrationTimingError {
  readonly violations: readonly MigrationTiming[];

  constructor(violations: readonly MigrationTiming[], limitMs: number) {
    super(
      `${violations.length === 1 ? "a migration holds" : "migrations hold"} ACCESS EXCLUSIVE for more than ${String(limitMs)} ms: ${violations
        .map((timing) => `${timing.file} (chain ${timing.chain}) on ${timing.lock?.relation ?? "?"} for ${String(timing.lock?.heldMs ?? 0)} ms`)
        .join("; ")}`,
    );
    this.name = "MigrationLockError";
    this.violations = violations;
  }
}

export interface MigrationTiming {
  readonly chain: string;
  readonly tag: string;
  /** The migration file, `<tag>.sql`. */
  readonly file: string;
  /** The time the `migrate` call that applied only this migration took, connecting and taking the advisory lock included. */
  readonly wallMs: number;
  /** A file applied outside a transaction, one concurrent index build at a time: it takes no `ACCESS EXCLUSIVE` lock on the table it indexes, so only its duration is reported. */
  readonly nonTransactional: boolean;
  /** The relation on which the longest `ACCESS EXCLUSIVE` lock was seen, and for how long; undefined when none was seen or the file is non-transactional. */
  readonly lock: LockHold | undefined;
}

/** The migrations of `timings` that held `ACCESS EXCLUSIVE` for longer than `limitMs`. */
export function lockViolations(timings: readonly MigrationTiming[], limitMs = LOCK_LIMIT_MS): MigrationTiming[] {
  return timings.filter((timing) => !timing.nonTransactional && timing.lock !== undefined && timing.lock.heldMs > limitMs);
}

/** Throws a `MigrationLockError` naming each migration file and relation that held `ACCESS EXCLUSIVE` for longer than `limitMs`. */
export function assertLocksWithinLimit(timings: readonly MigrationTiming[], limitMs = LOCK_LIMIT_MS): void {
  const violations = lockViolations(timings, limitMs);
  if (violations.length > 0) {
    throw new MigrationLockError(violations, limitMs);
  }
}

/** The connection of `serverUrl` (a superuser of the server), to `database` when it is given. */
export function serverConnection(serverUrl: string, database?: string): SeedConnection {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    throw new MigrationTimingError("the server URL is not a valid PostgreSQL connection URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new MigrationTimingError("the server URL is not a PostgreSQL connection URL");
  }
  const name = database ?? decodeURIComponent(url.pathname.slice(1));
  return {
    host: url.hostname.replace(/^\[|\]$/gu, ""),
    port: url.port === "" ? 5432 : Number(url.port),
    database: name === "" ? "postgres" : name,
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

/** The URL `migrate` connects with, as `slugbase_migrator`, to `database` of the server `connection` names. */
export function migratorUrl(connection: SeedConnection, database: string): string {
  const url = new URL("postgres://localhost");
  url.hostname = connection.host.includes(":") ? `[${connection.host}]` : connection.host;
  url.port = String(connection.port);
  url.username = "slugbase_migrator";
  url.password = MIGRATOR_PASSWORD;
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.href;
}

interface Journal {
  entries: { tag: string }[];
}

/** The tags of a chain's migrations, in order. */
export function chainTags(chain: MigrationChain): string[] {
  let journal: unknown;
  try {
    journal = JSON.parse(readFileSync(join(chain.folder, "meta", "_journal.json"), "utf8"));
  } catch {
    throw new MigrationTimingError(`the journal of chain "${chain.name}" cannot be read`);
  }
  const entries = typeof journal === "object" && journal !== null && "entries" in journal ? (journal as Journal).entries : undefined;
  if (!Array.isArray(entries) || !entries.every((entry) => typeof entry.tag === "string")) {
    throw new MigrationTimingError(`the journal of chain "${chain.name}" has no list of migrations`);
  }
  return entries.map((entry) => entry.tag);
}

export interface TimeMigrationsOptions {
  /** `slugbase_migrator` on the database whose migrations are timed (`migratorUrl`). */
  readonly migratorUrl: string;
  /** A superuser connection to the same database, for the lock sampler. */
  readonly connection: SeedConnection;
  /** Chains applied after the CE chain, as `migrate` takes them. */
  readonly chains?: readonly MigrationChain[];
  /** The last migration that is already applied; every migration after it, in the order of the chains, is timed. Omitted: all of them. */
  readonly after?: MigrationStop;
  /** The PATH to find `psql` on. */
  readonly path: string;
}

/**
 * Applies the migrations after `after` one at a time with `migrate` (`until` stops it after each), and returns the time of each and
 * the longest `ACCESS EXCLUSIVE` lock the session that applied it held. A call that applies anything but the one migration it was
 * asked for, a sampler that fails and a sampler that cannot see other sessions are errors: a result is never a partial one.
 */
export async function timeMigrations(options: TimeMigrationsOptions): Promise<MigrationTiming[]> {
  const chains = [CE_CHAIN, ...(options.chains ?? [])];
  const plan = chains.flatMap((chain) => chainTags(chain).map((tag) => ({ chain, tag })));
  let first = 0;
  if (options.after !== undefined) {
    const { chain, tag } = options.after;
    const index = plan.findIndex((step) => step.chain.name === chain && step.tag === tag);
    if (index === -1) {
      throw new MigrationTimingError(`the migration ${tag} of chain "${chain}" is not in the chains of this run`);
    }
    first = index + 1;
  }
  const observable = await runSeedScript(options.connection, CAN_OBSERVE_LOCKS, { path: options.path, capture: true });
  if (observable.trim() !== "t") {
    throw new MigrationTimingError("the lock sampler's role can neither be a superuser nor a member of pg_read_all_stats, so it would not see the migrating session");
  }
  const timings: MigrationTiming[] = [];
  for (const { chain, tag } of plan.slice(first)) {
    const file = `${tag}.sql`;
    const nonTransactional = isNonTransactional(readFileSync(join(chain.folder, file), "utf8"));
    const sampler = await startLockSampler({ connection: options.connection, path: options.path });
    let applied: Awaited<ReturnType<typeof migrate>>["applied"];
    let wallMs: number;
    try {
      const started = performance.now();
      applied = (await migrate({ url: options.migratorUrl, chains: options.chains ?? [], until: { chain: chain.name, tag } })).applied;
      wallMs = performance.now() - started;
    } catch (error) {
      await sampler.stop().catch(() => undefined);
      throw error;
    }
    const holds = await sampler.stop();
    if (applied.length !== 1 || applied[0]?.chain !== chain.name || applied[0].tag !== tag) {
      throw new MigrationTimingError(
        `the run of ${file} applied ${applied.length === 0 ? "nothing" : applied.map((step) => step.tag).join(", ")}: the database was not at the level before it`,
      );
    }
    timings.push({ chain: chain.name, tag, file, wallMs: Math.round(wallMs), nonTransactional, lock: nonTransactional ? undefined : holds[0] });
  }
  return timings;
}

// What the large instance's seed script writes, read from the script itself so that the baseline can never need less than the seed does.

export interface SeedRequirements {
  /** The columns the script inserts into or updates, per table of `public`. */
  readonly columns: ReadonlyMap<string, readonly string[]>;
  /** The system operations the script calls, with the number of arguments of each call. */
  readonly functions: readonly { name: string; args: number }[];
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** The arguments of the call whose opening parenthesis is at `open`: the top-level commas outside quoted strings, plus one. */
function argumentCount(script: string, open: number): number {
  let depth = 0;
  let args = 1;
  let quoted = false;
  for (let index = open; index < script.length; index += 1) {
    const char = script[index];
    if (quoted) {
      quoted = char !== "'";
    } else if (char === "'") {
      quoted = true;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return args;
      }
    } else if (char === "," && depth === 1) {
      args += 1;
    }
  }
  throw new MigrationTimingError("a call of the seed script is not closed");
}

/** The tables, columns and system operations `script` (of `largeSeedScript`) writes through. */
export function seedRequirements(script: string): SeedRequirements {
  const columns = new Map<string, Set<string>>();
  const add = (table: string, names: readonly string[]): void => {
    const known = columns.get(table) ?? new Set<string>();
    for (const name of names) {
      known.add(name);
    }
    columns.set(table, known);
  };
  for (const match of script.matchAll(/INSERT INTO public\.([a-z_]+) \(([^)]*)\)/gu)) {
    add(match[1] ?? "", (match[2] ?? "").split(",").map((name) => name.trim()));
  }
  for (const match of script.matchAll(/UPDATE public\.([a-z_]+) SET ([a-z_]+) =/gu)) {
    add(match[1] ?? "", [match[2] ?? ""]);
  }
  const calls = new Map<string, number>();
  for (const match of script.matchAll(/public\.(sys_[a-z_]+)\(/gu)) {
    const name = match[1] ?? "";
    if (!calls.has(name)) {
      calls.set(name, argumentCount(script, match.index + match[0].length - 1));
    }
  }
  const result = new Map([...columns].map(([table, names]) => [table, [...names]] as const));
  for (const [table, names] of result) {
    if (!IDENTIFIER.test(table) || !names.every((name) => IDENTIFIER.test(name))) {
      throw new MigrationTimingError(`the seed script writes to a name that is not a plain identifier (${table})`);
    }
  }
  if (result.size === 0 || calls.size === 0) {
    throw new MigrationTimingError("the seed script writes no table or calls no system operation, so its requirements cannot be read");
  }
  return { columns: result, functions: [...calls].map(([name, args]) => ({ name, args })) };
}

/** What `requirements` names and the database lacks, as `table`, `table.column` and `function/arguments`. Empty: the seed can be written. */
export async function missingForSeed(connection: SeedConnection, path: string, requirements: SeedRequirements): Promise<string[]> {
  const tables = [...requirements.columns.keys()];
  const present = await runSeedScript(
    connection,
    `SELECT 'c ' || table_name || '.' || column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN (${tables.map((table) => `'${table}'`).join(", ")})
     UNION ALL SELECT 'f ' || p.proname || '/' || p.pronargs FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname IN (${requirements.functions.map((fn) => `'${fn.name}'`).join(", ")});`,
    { path, capture: true },
  );
  const have = new Set(present.split("\n").map((line) => line.trim()).filter((line) => line !== ""));
  const missing: string[] = [];
  for (const [table, names] of requirements.columns) {
    for (const name of names) {
      if (!have.has(`c ${table}.${name}`)) {
        missing.push(`${table}.${name}`);
      }
    }
  }
  for (const fn of requirements.functions) {
    if (!have.has(`f ${fn.name}/${String(fn.args)}`)) {
      missing.push(`${fn.name}/${String(fn.args)}`);
    }
  }
  return missing;
}

export interface Baseline {
  /** The latest release's last CE migration, or null when no release holds one. */
  readonly releaseLevel: string | null;
  /** The last migration applied before the seed: the release's, or the first one at which the large instance can be written. */
  readonly level: string;
  /** Whether the level is later than the release's. */
  readonly raised: boolean;
  /** What the release's level lacked for the seed (tables, columns and system operations), when it was raised. */
  readonly missingAtRelease: readonly string[];
}

export interface MigrationInstanceOptions extends LargeInstanceOptions {
  /** Superuser URL of the server the harness builds databases on. */
  readonly serverUrl: string;
  /** The PATH to find `psql` on. */
  readonly path: string;
  /** `SLUGBASE_TEST_PG_URL`, when it is set: a host other than loopback is accepted only when it is this URL's host. */
  readonly harnessUrl: string | undefined;
  /** The CE migrations of the latest release, in order; empty when there is no release. */
  readonly released: readonly string[];
  /** Aborting it ends the seeding and drops the database; the call then rejects. */
  readonly signal?: AbortSignal;
  /** Called with the name of the database once it exists, before anything is written into it. */
  readonly onDatabase?: (name: string) => void;
}

export interface MigrationInstance {
  readonly databaseName: string;
  /** A superuser connection to the database. */
  readonly connection: SeedConnection;
  /** The URL `migrate` connects with. */
  readonly migratorUrl: string;
  readonly baseline: Baseline;
  readonly instance: LargeInstance;
  readonly counts: SeededCounts;
  /** Drops the database and lets go of the cluster. */
  drop(): Promise<void>;
}

const QUOTED_PATH = /^[^'\n\\]+$/u;

async function countRows(connection: SeedConnection, path: string, name: string): Promise<SeededCounts> {
  const output = await runSeedScript(
    connection,
    `SELECT json_build_object('accounts', (SELECT count(*) FROM accounts), 'workspaces', (SELECT count(*) FROM workspaces), 'bookmarks', (SELECT count(*) FROM bookmarks), 'largestWorkspace', (SELECT coalesce(max(bookmark_count), 0) FROM workspaces));`,
    { path, capture: true },
  );
  const row = JSON.parse(output) as Omit<SeededCounts, "database">;
  return { database: name, accounts: row.accounts, workspaces: row.workspaces, bookmarks: row.bookmarks, largestWorkspace: row.largestWorkspace };
}

/**
 * Creates a harness database, builds its schema at the level of the latest release (`released`), raises it, one CE migration at a
 * time, to the first level at which everything the large instance's seed writes exists, and seeds the large instance into it. The
 * release level is kept when it already has all of that; the result names which. Every failure drops the database.
 */
export async function prepareMigrationInstance(options: MigrationInstanceOptions): Promise<MigrationInstance> {
  perfServer(options.serverUrl, options.path, options.harnessUrl);
  const tags = chainTags(CE_CHAIN);
  const releaseLevel = options.released.at(-1) ?? null;
  if (!options.released.every((tag, index) => tag === tags[index])) {
    throw new MigrationTimingError("the migrations of the latest release are not the first migrations of the CE chain");
  }
  const roles = resolve(CE_CHAIN.folder, "..", "provision", "roles.sql");
  if (!QUOTED_PATH.test(roles) || !existsSync(roles)) {
    throw new MigrationTimingError("provision/roles.sql of @slugbase/db is not where the CE chain is");
  }
  const instance = buildLargeInstance(options);
  const password = randomBytes(18).toString("base64url");
  const passwordHash = await hash(password);
  const script = largeSeedScript(instance, passwordHash);
  const requirements = seedRequirements(script);

  const admin = serverConnection(options.serverUrl);
  const name = `test_${randomBytes(8).toString("hex")}`;
  assertHarnessDatabase(name);
  const connection = serverConnection(options.serverUrl, name);
  const cluster = await useCluster({ serverUrl: options.serverUrl });
  let created = false;
  const drop = async (): Promise<void> => {
    try {
      if (created) {
        created = false;
        await runSeedScript(admin, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE);`, { path: options.path });
      }
    } finally {
      await cluster.release();
    }
  };
  try {
    await runSeedScript(admin, `CREATE DATABASE "${name}";`, { path: options.path });
    created = true;
    options.onDatabase?.(name);
    options.signal?.throwIfAborted();
    await runSeedScript(
      connection,
      `\\set app_password '${APP_PASSWORD}'\n\\set migrator_password '${MIGRATOR_PASSWORD}'\n\\i '${roles}'\n`,
      { path: options.path },
    );
    const url = migratorUrl(connection, name);
    const upTo = async (tag: string): Promise<void> => {
      options.signal?.throwIfAborted();
      await migrate({ url, until: { chain: CE_CHAIN_NAME, tag } });
    };

    let index = releaseLevel === null ? -1 : tags.indexOf(releaseLevel);
    if (releaseLevel !== null) {
      await upTo(releaseLevel);
    }
    let missing = await missingForSeed(connection, options.path, requirements);
    const missingAtRelease = missing;
    while (missing.length > 0) {
      index += 1;
      const tag = tags[index];
      if (tag === undefined) {
        throw new PerfSeedError(`the large instance cannot be written at any level of the CE chain; the head lacks ${missing.join(", ")}`);
      }
      await upTo(tag);
      missing = await missingForSeed(connection, options.path, requirements);
    }
    const level = tags[index];
    if (level === undefined) {
      throw new PerfSeedError("the CE chain has no migration to build the large instance on");
    }

    await runSeedScript(connection, script, {
      path: options.path,
      secrets: [passwordHash],
      timeoutMs: SEED_TIMEOUT_MS,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    options.signal?.throwIfAborted();
    await runSeedScript(connection, "VACUUM (ANALYZE);", { path: options.path, timeoutMs: SEED_TIMEOUT_MS });
    const counts = await countRows(connection, options.path, name);
    return {
      databaseName: name,
      connection,
      migratorUrl: url,
      baseline: { releaseLevel, level, raised: level !== releaseLevel, missingAtRelease },
      instance,
      counts,
      drop,
    };
  } catch (error) {
    try {
      await drop();
    } catch (dropError) {
      throw new AggregateError([error, dropError], `the migration instance was not built, and the database ${name} was not dropped`);
    }
    throw error;
  }
}
