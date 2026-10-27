import { randomBytes } from "node:crypto";
import { hash } from "@node-rs/argon2";
import { createTestDatabase, type TestDatabase } from "@slugbase/db/testing";
import { buildLargeInstance, type LargeInstance, type LargeInstanceOptions } from "./large.ts";
import { largeSeedScript } from "./large-script.ts";
import { runSeedScript } from "./run.ts";

// The large instance of the performance suite (doc 08 section 5.3) in a database of its own. The database is created here, by
// the test harness (doc 08 section 3.2), and the seed takes the harness's handle and nothing else: there is no address to give it,
// so it cannot be pointed at a development, staging or production database. It checks the handle's name against the harness's
// own pattern and that the connection it holds is to that database, and it writes only into an empty one. The server is on this
// machine or is the one the harness is configured with (`SLUGBASE_TEST_PG_URL`), which CI reaches by its service name.

/** The name pattern of a database the harness clones for a test (`TEST_NAME` in `@slugbase/db/testing`). */
const HARNESS_DATABASE = /^test_[0-9a-f]{16}$/;
const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "[::1]", "::1"];
// The development passwords the harness gives the login roles when it provisions them.
const APP_PASSWORD = "slugbase_app_dev_only";
const MIGRATOR_PASSWORD = "slugbase_migrator_dev_only";
const SEED_TIMEOUT_MS = 600_000;

export class PerfSeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PerfSeedError";
  }
}

/** Throws unless `name` is the name of a database the test harness creates. */
export function assertHarnessDatabase(name: string): void {
  if (!HARNESS_DATABASE.test(name)) {
    throw new PerfSeedError(`the large instance is seeded only into a database the test harness created (test_ and 16 hex digits), not "${name}"`);
  }
}

export interface PerfServer {
  readonly host: string;
  readonly port: number;
  /** The PATH to find `psql` on. */
  readonly path: string;
}

/** The host of the server the test harness is configured with, or undefined when none is configured or it does not parse. */
function harnessHost(harnessUrl: string | undefined): string | undefined {
  if (harnessUrl === undefined || harnessUrl === "") {
    return undefined;
  }
  try {
    const url = new URL(harnessUrl);
    return url.protocol === "postgres:" || url.protocol === "postgresql:" ? url.hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The server the harness builds databases on. Its host must be a loopback address or the host of the server the harness itself is
 * configured with (`harnessUrl`, the value of `SLUGBASE_TEST_PG_URL` when it is set): CI reaches its Postgres service by the service
 * name. A host that is neither is refused, whatever else is configured.
 */
export function perfServer(serverUrl: string, path: string, harnessUrl: string | undefined): PerfServer {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    throw new PerfSeedError("the server URL is not a valid PostgreSQL connection URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new PerfSeedError("the server URL is not a PostgreSQL connection URL");
  }
  if (!LOOPBACK_HOSTS.includes(url.hostname) && url.hostname.toLowerCase() !== harnessHost(harnessUrl)) {
    throw new PerfSeedError(`the performance suite runs against a server on this machine or the one the test harness is configured with, not ${url.hostname}`);
  }
  return { host: url.hostname.replace(/^\[|\]$/gu, ""), port: url.port === "" ? 5432 : Number(url.port), path };
}

export interface SeededCounts {
  readonly database: string;
  readonly accounts: number;
  readonly workspaces: number;
  readonly bookmarks: number;
  readonly largestWorkspace: number;
}

// Counted as slugbase_system, which row-level security does not hold back, so that a database that merely hides its rows from the
// owner is not taken for an empty one.
async function count(database: Pick<TestDatabase, "owner">): Promise<SeededCounts> {
  const rows = await database.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<SeededCounts[]>`
      SELECT current_database() AS database, (SELECT count(*)::int FROM accounts) AS accounts, (SELECT count(*)::int FROM workspaces) AS workspaces,
             (SELECT count(*)::int FROM bookmarks) AS bookmarks, (SELECT coalesce(max(bookmark_count), 0)::int FROM workspaces) AS "largestWorkspace"`;
  });
  const [row] = rows;
  if (row === undefined) {
    throw new PerfSeedError("the database could not be counted");
  }
  return row;
}

/**
 * Writes `instance` into `database`, which must be a harness database with no account in it, as every account's password
 * `passwordHash` stands for, then analyzes the tables so that the planner knows the data it will be asked about. Returns what
 * the database holds afterwards. An abort of `signal` ends the seed, which rejects.
 */
export async function seedLargeInstance(
  database: Pick<TestDatabase, "name" | "owner">,
  server: PerfServer,
  instance: LargeInstance,
  passwordHash: string,
  signal?: AbortSignal,
): Promise<SeededCounts> {
  assertHarnessDatabase(database.name);
  const before = await count(database);
  if (before.database !== database.name) {
    throw new PerfSeedError("the handle is not connected to the database it names");
  }
  if (before.accounts !== 0) {
    throw new PerfSeedError(`the database ${database.name} already has accounts; the large instance is seeded into an empty one`);
  }
  await runSeedScript(
    { host: server.host, port: server.port, database: database.name, username: "slugbase_migrator", password: MIGRATOR_PASSWORD },
    largeSeedScript(instance, passwordHash),
    { path: server.path, secrets: [passwordHash], timeoutMs: SEED_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) },
  );
  signal?.throwIfAborted();
  await database.owner.unsafe("VACUUM (ANALYZE)");
  return count(database);
}

export interface PerfInstance {
  readonly databaseName: string;
  /** The URL the server connects with, as `slugbase_app`. */
  readonly appUrl: string;
  /** The password of every account; made for this instance and valid in its database only. */
  readonly password: string;
  readonly instance: LargeInstance;
  readonly counts: SeededCounts;
  /** Drops the database. */
  drop(): Promise<void>;
}

export interface PrepareOptions extends LargeInstanceOptions {
  /** Superuser URL of the server the harness builds databases on. */
  readonly serverUrl: string;
  /** The PATH to find `psql` on. */
  readonly path: string;
  /** `SLUGBASE_TEST_PG_URL`, when it is set: a host other than loopback is accepted only when it is this URL's host. */
  readonly harnessUrl: string | undefined;
  /** Aborting it ends the seeding and drops the database; the call then rejects. */
  readonly signal?: AbortSignal;
  /** Called with the name of the database once it exists, before anything is seeded into it. */
  readonly onDatabase?: (name: string) => void;
}

/** Creates a harness database, seeds the large instance into it and returns what the server and the scenarios need. */
export async function preparePerfInstance(options: PrepareOptions): Promise<PerfInstance> {
  const server = perfServer(options.serverUrl, options.path, options.harnessUrl);
  const instance = buildLargeInstance(options);
  const password = randomBytes(18).toString("base64url");
  const database = await createTestDatabase({ serverUrl: options.serverUrl });
  try {
    options.onDatabase?.(database.name);
    options.signal?.throwIfAborted();
    const counts = await seedLargeInstance(database, server, instance, await hash(password), options.signal);
    return {
      databaseName: database.name,
      appUrl: `postgres://slugbase_app:${APP_PASSWORD}@${server.host}:${String(server.port)}/${database.name}`,
      password,
      instance,
      counts,
      drop: () => database.drop(),
    };
  } catch (error) {
    try {
      await database.drop();
    } catch (dropError) {
      throw new AggregateError([error, dropError], `the large instance was not seeded, and the database ${database.name} was not dropped`);
    }
    throw error;
  }
}
