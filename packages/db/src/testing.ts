import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import postgres from "postgres";
import { CE_CHAIN, migrate, type MigrationChain } from "./migrate.ts";

// The database lifecycle of the integration tests (doc 08 section 3.2). It is
// the one place outside the product code that holds a raw database handle, so
// the boundary rule stays as it is (doc 09 section 2.1); `@slugbase/testing/db`
// wraps this module. Product code never imports it, and the package's main
// entry does not export it.
//
// A template database `slugbase_tpl_<hash>` is built once per migration hash:
// the roles are installed with provision/roles.sql and the chain is applied
// through `migrate()`. Every test file then clones it into `test_<random>`.
// The harness creates, uses and drops only databases with those two name
// patterns; the server's own database is touched for the catalog and for
// CREATE and DROP DATABASE, never for data.

export type { MigrationChain } from "./migrate.ts";

const execFileAsync = promisify(execFile);

const DEFAULT_SERVER_URL = "postgres://slugbase:slugbase@127.0.0.1:54329/slugbase_dev";

// The development passwords of compose.dev.yml. Roles are cluster-wide and
// roles.sql never changes a password, so a cluster that already has the roles
// keeps whatever it was provisioned with.
const APP_PASSWORD = "slugbase_app_dev_only";
const MIGRATOR_PASSWORD = "slugbase_migrator_dev_only";

// Roles are cluster-wide, and the tests of roles.sql and of `migrate` change or
// depend on them, so each holds this advisory lock exclusively for its run. A
// test database holds it shared for its lifetime.
const CLUSTER_LOCK_KEY = 7_354_190_025;

const TEMPLATE_NAME = /^slugbase_tpl_[0-9a-f]{32}$/;
const TEST_NAME = /^test_[0-9a-f]{16}$/;

// Bump when the way a template is built changes without any hashed file changing.
const TEMPLATE_FORMAT = "1";

const ROLES_SQL = fileURLToPath(new URL("../provision/roles.sql", import.meta.url));
const SQL_SOURCES = fileURLToPath(new URL("../src/sql/", import.meta.url));

const APP_POOL_SIZE = 4;
const OWNER_POOL_SIZE = 2;
const PSQL_TIMEOUT_MS = 120_000;

/** The client of every pool the harness hands out. */
export type TestSql = postgres.Sql;

export interface TestDatabaseOptions {
  /**
   * Superuser URL of the server. Defaults to `SLUGBASE_TEST_PG_URL`, and to the
   * Postgres of compose.dev.yml when that is unset.
   */
  serverUrl?: string;
  /** Chains applied after the CE chain, in order (the composed chain of doc 05 section 5.5). */
  chains?: readonly MigrationChain[];
}

export interface TestDatabase {
  /** The `test_<random>` database of this test file. */
  readonly name: string;
  readonly template: {
    /** The `slugbase_tpl_<hash>` database this one was cloned from. */
    readonly name: string;
    /** Whether this call built the template; false when it already existed. */
    readonly built: boolean;
  };
  /** A pool as `slugbase_app`, what the server connects as: row-level security applies. */
  readonly app: TestSql;
  /** A pool as `slugbase_owner`, for fixtures that create objects or insert what the app role may not. */
  readonly owner: TestSql;
  /** Ends both pools and drops the database. Safe to call more than once. */
  drop(): Promise<void>;
}

interface Server {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  key: string;
}

function resolveServer(serverUrl: string | undefined): Server {
  const fromEnv = process.env["SLUGBASE_TEST_PG_URL"];
  const raw = serverUrl ?? (fromEnv === undefined || fromEnv === "" ? DEFAULT_SERVER_URL : fromEnv);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("SLUGBASE_TEST_PG_URL is not a valid PostgreSQL connection URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("SLUGBASE_TEST_PG_URL is not a valid PostgreSQL connection URL");
  }
  const database = decodeURIComponent(url.pathname.slice(1));
  const username = decodeURIComponent(url.username);
  const port = url.port === "" ? 5432 : Number(url.port);
  return {
    host: url.hostname,
    port,
    database: database === "" ? "postgres" : database,
    username,
    password: decodeURIComponent(url.password),
    key: `${url.hostname}:${String(port)}:${username}`,
  };
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function assertTemplateName(name: string): void {
  if (!TEMPLATE_NAME.test(name)) {
    throw new Error(`the harness only handles templates named slugbase_tpl_ followed by 32 hex digits, not "${name}"`);
  }
}

function assertTestName(name: string): void {
  if (!TEST_NAME.test(name)) {
    throw new Error(`the harness only handles databases named test_ followed by 16 hex digits, not "${name}"`);
  }
}

interface OpenOptions {
  max: number;
  role?: string;
}

function open(
  server: Server,
  login: { username: string; password: string },
  database: string,
  options: OpenOptions,
): TestSql {
  return postgres({
    host: server.host,
    port: server.port,
    database,
    username: login.username,
    password: login.password,
    max: options.max,
    // A session lock lives as long as its connection, so no connection is
    // recycled behind the caller's back.
    max_lifetime: 0,
    idle_timeout: 0,
    onnotice: () => undefined,
    connection: {
      application_name: "slugbase-test-harness",
      ...(options.role === undefined ? {} : { role: options.role }),
    },
  });
}

function openAdmin(server: Server): TestSql {
  return open(server, server, server.database, { max: 1 });
}

function frame(hash: ReturnType<typeof createHash>, label: string, content: Buffer): void {
  hash.update(`${label}\0${String(content.length)}\0`);
  hash.update(content);
  hash.update("\0");
}

function sqlFiles(folder: string): string[] {
  return readdirSync(folder)
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

/**
 * The hash a template is named after: the migration files and journal of every
 * chain, the chain list itself, the SQL sources the migrations are generated
 * from and roles.sql. Where a chain's folder lives is not part of it.
 */
function templateHash(chains: readonly MigrationChain[]): string {
  const hash = createHash("sha256");
  frame(hash, "format", Buffer.from(TEMPLATE_FORMAT));
  for (const chain of [CE_CHAIN, ...chains]) {
    frame(hash, "chain", Buffer.from(`${chain.name}\0${chain.bookkeepingTable}`));
    frame(hash, `${chain.name}/meta/_journal.json`, readFileSync(join(chain.folder, "meta", "_journal.json")));
    for (const file of sqlFiles(chain.folder)) {
      frame(hash, `${chain.name}/${file}`, readFileSync(join(chain.folder, file)));
    }
  }
  for (const file of sqlFiles(SQL_SOURCES)) {
    frame(hash, `sql/${file}`, readFileSync(join(SQL_SOURCES, file)));
  }
  frame(hash, "roles.sql", readFileSync(ROLES_SQL));
  return hash.digest("hex");
}

/** The name of the template database for the CE chain and the extra chains: a changed migration is a new name. */
export function testTemplateName(chains: readonly MigrationChain[] = []): string {
  return `slugbase_tpl_${templateHash(chains).slice(0, 32)}`;
}

function migratorUrl(server: Server, database: string): string {
  const url = new URL("postgres://localhost");
  url.hostname = server.host;
  url.port = String(server.port);
  url.username = "slugbase_migrator";
  url.password = MIGRATOR_PASSWORD;
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.href;
}

async function installRoles(server: Server, database: string): Promise<void> {
  try {
    await execFileAsync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", ROLES_SQL], {
      timeout: PSQL_TIMEOUT_MS,
      env: {
        PATH: process.env["PATH"] ?? "",
        PGHOST: server.host,
        PGPORT: String(server.port),
        PGDATABASE: database,
        PGUSER: server.username,
        PGPASSWORD: server.password,
        PROVISION_APP_PASSWORD: APP_PASSWORD,
        PROVISION_MIGRATOR_PASSWORD: MIGRATOR_PASSWORD,
      },
    });
  } catch (error) {
    const stderr = typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr).trim() : "";
    const reason = stderr === "" ? (error instanceof Error ? error.message : "unknown error") : stderr;
    throw new Error(`installing the roles with psql failed (psql must be on the PATH): ${reason}`);
  }
}

// Runs `work` while holding a session advisory lock of its own connection.
async function withAdvisoryLock<T>(server: Server, label: string, work: (admin: TestSql) => Promise<T>): Promise<T> {
  const admin = openAdmin(server);
  try {
    await admin`SELECT pg_advisory_lock(hashtext(${label}))`;
    return await work(admin);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

async function dropDatabase(admin: TestSql, name: string): Promise<void> {
  const rows = await admin<{ template: boolean }[]>`SELECT datistemplate AS template FROM pg_database WHERE datname = ${name}`;
  if (rows[0]?.template === true) {
    await admin.unsafe(`ALTER DATABASE ${quote(name)} WITH IS_TEMPLATE false`);
  }
  await admin.unsafe(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`);
}

// One build per template name in this process; the advisory lock does the same
// across processes and checkouts.
const builds = new Map<string, Promise<boolean>>();

async function buildTemplate(server: Server, name: string, chains: readonly MigrationChain[]): Promise<boolean> {
  return withAdvisoryLock(server, `slugbase.test-template.${name}`, async (admin) => {
    const state = await admin<{ template: boolean }[]>`SELECT datistemplate AS template FROM pg_database WHERE datname = ${name}`;
    if (state[0]?.template === true) {
      return false;
    }
    // A database of this name that was never marked is the rest of a build that died.
    await dropDatabase(admin, name);
    await admin.unsafe(`CREATE DATABASE ${quote(name)}`);
    try {
      await installRoles(server, name);
      await migrate({ url: migratorUrl(server, name), chains });
      await admin.unsafe(`ALTER DATABASE ${quote(name)} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`);
    } catch (error) {
      await dropDatabase(admin, name).catch(() => undefined);
      throw error;
    }
    return true;
  });
}

async function ensureTemplate(server: Server, name: string, chains: readonly MigrationChain[]): Promise<boolean> {
  const key = `${server.key}/${name}`;
  const running = builds.get(key);
  if (running !== undefined) {
    await running;
    return false;
  }
  const build = buildTemplate(server, name, chains);
  builds.set(key, build);
  try {
    return await build;
  } catch (error) {
    builds.delete(key);
    throw error;
  }
}

interface Session {
  admin: TestSql;
  holders: number;
  ready: Promise<void>;
}

// One superuser connection per server and process, which holds the cluster
// lock shared for as long as a test database of the process exists. It is
// shared because a second shared request queues behind a waiting exclusive
// one, and a process must never wait for itself.
const sessions = new Map<string, Session>();

async function acquireSession(server: Server): Promise<Session> {
  let session = sessions.get(server.key);
  if (session === undefined) {
    const admin = openAdmin(server);
    session = {
      admin,
      holders: 0,
      ready: admin`SELECT pg_advisory_lock_shared(${CLUSTER_LOCK_KEY})`.then(() => undefined),
    };
    sessions.set(server.key, session);
  }
  session.holders += 1;
  try {
    await session.ready;
  } catch (error) {
    await releaseSession(server, session);
    throw error;
  }
  return session;
}

async function releaseSession(server: Server, session: Session): Promise<void> {
  session.holders -= 1;
  if (session.holders > 0) {
    return;
  }
  if (sessions.get(server.key) === session) {
    sessions.delete(server.key);
  }
  await session.admin.end({ timeout: 5 });
}

/**
 * Creates the database of one test file: `test_<random>`, cloned from the
 * template of the migration hash, which is built first if no run has built it.
 * Pass the result to `drop()` when the file is done, also when it failed.
 */
export async function createTestDatabase(options: TestDatabaseOptions = {}): Promise<TestDatabase> {
  const server = resolveServer(options.serverUrl);
  const chains = options.chains ?? [];
  const templateName = testTemplateName(chains);
  assertTemplateName(templateName);
  const session = await acquireSession(server);
  const name = `test_${randomBytes(8).toString("hex")}`;
  assertTestName(name);
  const pools: TestSql[] = [];
  let created = false;
  try {
    const built = await ensureTemplate(server, templateName, chains);
    await session.admin.unsafe(`CREATE DATABASE ${quote(name)} TEMPLATE ${quote(templateName)}`);
    created = true;
    const app = open(server, { username: "slugbase_app", password: APP_PASSWORD }, name, { max: APP_POOL_SIZE });
    pools.push(app);
    // The owner role cannot log in; the migrator can act as it, so its
    // sessions start with that role set.
    const owner = open(server, { username: "slugbase_migrator", password: MIGRATOR_PASSWORD }, name, {
      max: OWNER_POOL_SIZE,
      role: "slugbase_owner",
    });
    pools.push(owner);
    await Promise.all([app`SELECT 1`, owner`SELECT 1`]);

    let dropped: Promise<void> | undefined;
    const drop = (): Promise<void> => {
      dropped ??= (async () => {
        try {
          await Promise.all(pools.map((pool) => pool.end({ timeout: 5 })));
          await session.admin.unsafe(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`);
        } finally {
          await releaseSession(server, session);
        }
      })();
      return dropped;
    };
    return { name, template: { name: templateName, built }, app, owner, drop };
  } catch (error) {
    try {
      await Promise.all(pools.map((pool) => pool.end({ timeout: 5 })));
      if (created) {
        await session.admin.unsafe(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`);
      }
    } finally {
      await releaseSession(server, session);
    }
    throw error;
  }
}

/** Runs `work` with a fresh test database and drops it afterwards, also when `work` throws. */
export async function withTestDatabase<T>(
  work: (database: TestDatabase) => Promise<T>,
  options: TestDatabaseOptions = {},
): Promise<T> {
  const database = await createTestDatabase(options);
  let result: T;
  try {
    result = await work(database);
  } catch (error) {
    await database.drop().catch(() => undefined);
    throw error;
  }
  await database.drop();
  return result;
}

/** Drops a template, for one a test built for a chain list of its own. Only `slugbase_tpl_*` names are accepted. */
export async function dropTestTemplate(name: string, options: Pick<TestDatabaseOptions, "serverUrl"> = {}): Promise<void> {
  assertTemplateName(name);
  const server = resolveServer(options.serverUrl);
  builds.delete(`${server.key}/${name}`);
  await withAdvisoryLock(server, `slugbase.test-template.${name}`, (admin) => dropDatabase(admin, name));
}
