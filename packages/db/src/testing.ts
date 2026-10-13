import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { pgTable, text, uuid } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { CE_CHAIN, migrate, type MigrationChain } from "./migrate.ts";
import { scopedRepositoryMethods } from "./repositories/scoped.ts";
import type { RepositoryMethodEntry } from "./repositories/registry.ts";
import { bindTenantDatabase, type Database } from "./tenant.ts";

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
// The types `TestDatabase.tenant` and `testRepositoryMethods` are declared with.
export type { Database, TenantContext, TenantTx } from "./tenant.ts";
export type { RepositoryInput, RepositoryMethodEntry, ScopedMethod } from "./repositories/registry.ts";

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

// Per template, two session advisory locks: the build lock, held exclusively
// while the template is built or dropped, and the use lock, held shared by every
// process from before it looks for the template until its test database is
// gone. Postgres records no link from a clone to its template, so the use lock
// is what makes "a database is cloned from this template" observable to the prune.
const buildLockLabel = (template: string): string => `slugbase.test-template.${template}`;
const useLockLabel = (template: string): string => `slugbase.test-template-use.${template}`;

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
  /**
   * `withTenant` on the `app` pool: the one `createDatabase` builds on a pool of
   * its own, so a suite runs the production tenant transaction against this
   * database. The pool is closed by `drop()`.
   */
  readonly tenant: Pick<Database, "withTenant">;
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

// The statements of roles.sql that set the privileges on the current database:
// each is a `SELECT format(..., current_database())` the script runs with
// \gexec. CREATE DATABASE ... TEMPLATE copies no database-level ACL, so a clone
// is given them again, from the script itself, so a real install and a test
// database are provisioned by the same text.
const DATABASE_PRIVILEGES = /^SELECT (format\('(?:REVOKE|GRANT) [^\n]* ON DATABASE %I [^\n]*, current_database\(\)\))$/gm;

function databasePrivilegeStatements(): string[] {
  const statements = [...readFileSync(ROLES_SQL, "utf8").matchAll(DATABASE_PRIVILEGES)].map((match) => match[1] ?? "");
  if (statements.length === 0) {
    throw new Error("found no database-level GRANT or REVOKE in roles.sql to give a test database");
  }
  return statements;
}

// Gives the clone `name` the database-level privileges roles.sql gives a database.
async function grantDatabasePrivileges(admin: TestSql, name: string): Promise<void> {
  assertTestName(name);
  for (const statement of databasePrivilegeStatements()) {
    const rows = await admin.unsafe<{ format: string }[]>(`SELECT ${statement.replace("current_database()", `'${name}'::name`)}`);
    const command = rows[0]?.format;
    if (command === undefined) {
      throw new Error("a database-level statement of roles.sql produced no command");
    }
    await admin.unsafe(command);
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

// One build in flight per template name in this process; the advisory lock does
// the same across processes and checkouts. An entry lives only while its build
// runs: a later prune may have dropped the template, so each use looks again.
const builds = new Map<string, Promise<boolean>>();

async function buildTemplate(server: Server, name: string, chains: readonly MigrationChain[]): Promise<boolean> {
  return withAdvisoryLock(server, buildLockLabel(name), async (admin) => {
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
  } finally {
    builds.delete(key);
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

async function endTemplateUse(server: Server, session: Session, template: string): Promise<void> {
  try {
    await session.admin`SELECT pg_advisory_unlock_shared(hashtext(${useLockLabel(template)}))`;
  } finally {
    await releaseSession(server, session);
  }
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
  let usingTemplate = false;
  try {
    await session.admin`SELECT pg_advisory_lock_shared(hashtext(${useLockLabel(templateName)}))`;
    usingTemplate = true;
    const built = await ensureTemplate(server, templateName, chains);
    await session.admin.unsafe(`CREATE DATABASE ${quote(name)} TEMPLATE ${quote(templateName)}`);
    created = true;
    await grantDatabasePrivileges(session.admin, name);
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
          await endTemplateUse(server, session, templateName);
        }
      })();
      return dropped;
    };
    return { name, template: { name: templateName, built }, app, owner, tenant: bindTenantDatabase(app), drop };
  } catch (error) {
    try {
      await Promise.all(pools.map((pool) => pool.end({ timeout: 5 })));
      if (created) {
        await session.admin.unsafe(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`);
      }
    } finally {
      if (usingTemplate) {
        await endTemplateUse(server, session, templateName);
      } else {
        await releaseSession(server, session);
      }
    }
    throw error;
  }
}

const PROBE_TABLE_NAME = /^[a-z_][a-z0-9_]*$/;

/**
 * The four methods of a scoped repository named `repository` over a test table
 * `table` with the columns `id uuid`, `workspace_id uuid NOT NULL` and
 * `label text NOT NULL`, which the suite creates (as the owner, with row-level
 * security as it wants to test it). They come from the code
 * `defineScopedRepository` builds its methods with, run in the transaction of
 * `TestDatabase.tenant`, and are not entered in the registry of
 * `listRepositoryMethods`, so a suite passes exactly the methods it means to to
 * the cross-tenant matrix.
 */
export function testRepositoryMethods(repository: string, table: string): RepositoryMethodEntry[] {
  if (!PROBE_TABLE_NAME.test(table)) {
    throw new Error("a test repository table must be a lower-case SQL identifier");
  }
  const columns = {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    label: text("label").notNull(),
  };
  return scopedRepositoryMethods(repository, pgTable(table, columns));
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
  await withAdvisoryLock(server, buildLockLabel(name), (admin) => dropDatabase(admin, name));
}

/**
 * Why a template was kept: it is the current one or one named in `keep`
 * (`"current"`); a process is building or dropping it (`"building"`); a test
 * database cloned from it exists or a process is about to clone it (`"in use"`);
 * a session is connected to it (`"connected"`).
 */
export type PruneSkipReason = "current" | "building" | "in use" | "connected";

export interface PruneTestTemplatesOptions {
  /** Superuser URL of the server, as for `createTestDatabase`. */
  serverUrl?: string;
  /** Templates to leave alone. Defaults to the template of the current migration hash. */
  keep?: readonly string[];
  /** Consider only these databases. Names that are not `slugbase_tpl_` followed by 32 hex digits are ignored. Defaults to every template. */
  names?: readonly string[];
}

export interface PruneTestTemplatesResult {
  dropped: string[];
  skipped: { name: string; reason: PruneSkipReason }[];
}

/**
 * Drops the `slugbase_tpl_*` templates that nothing is using: not the current
 * one, not one whose build or use lock another process holds, not one with a
 * connection. A template that fails any of these is reported, never dropped.
 * Databases outside the `slugbase_tpl_` names are never listed or touched.
 */
export async function pruneTestTemplates(options: PruneTestTemplatesOptions = {}): Promise<PruneTestTemplatesResult> {
  const server = resolveServer(options.serverUrl);
  const keep = new Set(options.keep ?? [testTemplateName()]);
  const only = options.names === undefined ? undefined : new Set(options.names);
  const result: PruneTestTemplatesResult = { dropped: [], skipped: [] };
  const admin = openAdmin(server);
  try {
    const rows = await admin<{ name: string }[]>`SELECT datname AS name FROM pg_database WHERE datname LIKE 'slugbase\_tpl\_%' ORDER BY datname`;
    for (const { name } of rows) {
      if (!TEMPLATE_NAME.test(name) || (only !== undefined && !only.has(name))) {
        continue;
      }
      if (keep.has(name)) {
        result.skipped.push({ name, reason: "current" });
        continue;
      }
      const reason = await pruneTemplate(admin, name);
      if (reason === undefined) {
        result.dropped.push(name);
      } else {
        result.skipped.push({ name, reason });
      }
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
  return result;
}

// Both locks are taken without waiting. A process that asks for the use lock
// while this holds it waits, then finds the template gone and builds it again.
async function pruneTemplate(admin: TestSql, name: string): Promise<PruneSkipReason | undefined> {
  const useLocked = await tryLock(admin, useLockLabel(name));
  if (!useLocked) {
    return "in use";
  }
  try {
    if (!(await tryLock(admin, buildLockLabel(name)))) {
      return "building";
    }
    try {
      return await dropUnusedTemplate(admin, name);
    } finally {
      await admin`SELECT pg_advisory_unlock(hashtext(${buildLockLabel(name)}))`;
    }
  } finally {
    await admin`SELECT pg_advisory_unlock(hashtext(${useLockLabel(name)}))`;
  }
}

async function tryLock(admin: TestSql, label: string): Promise<boolean> {
  const rows = await admin<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(hashtext(${label})) AS locked`;
  return rows[0]?.locked === true;
}

const OBJECT_IN_USE = "55006";

// The drop has no FORCE: a connection that opens after the check makes it
// fail, and the template is marked again as it was.
async function dropUnusedTemplate(admin: TestSql, name: string): Promise<PruneSkipReason | undefined> {
  const state = await admin<{ template: boolean; connections: number }[]>`
    SELECT d.datistemplate AS template,
           (SELECT count(*)::int FROM pg_stat_activity a WHERE a.datname = d.datname) AS connections
    FROM pg_database d WHERE d.datname = ${name}`;
  const row = state[0];
  if (row === undefined) {
    return undefined;
  }
  if (row.connections > 0) {
    return "connected";
  }
  if (row.template) {
    await admin.unsafe(`ALTER DATABASE ${quote(name)} WITH IS_TEMPLATE false`);
  }
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${quote(name)}`);
  } catch (error) {
    if (row.template) {
      await admin.unsafe(`ALTER DATABASE ${quote(name)} WITH IS_TEMPLATE true`);
    }
    if (typeof error === "object" && error !== null && "code" in error && error.code === OBJECT_IN_USE) {
      return "connected";
    }
    throw error;
  }
  return undefined;
}
