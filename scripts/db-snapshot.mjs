// `pnpm db:snapshot <tag>` records the schema snapshot of one release for the upgrade test (doc 08 section 3.4): a compressed `pg_dump`
// of the seeded instance at the migration level of the release tag, with a record of the migration hash it corresponds to.
//
//   pnpm db:snapshot v1.0.0
//
// It writes `packages/db/test/migrations/released/<tag>.sql.gz` and `<tag>.json` and nothing else. The steps:
//
//   1. Reads the release's journal and migration files from git (`git show <tag>:...`), and refuses unless every one of them is
//      byte for byte the file in the working tree, which the checksum rule of `pnpm db:check` keeps true for a merged migration:
//      the working tree's chain up to the release's last migration is then the release's chain.
//   2. Creates a throwaway database `test_snapshot_<random>` on the server of the test harness (SLUGBASE_TEST_PG_URL, the development
//      Postgres of compose.dev.yml when unset), provisions the roles with provision/roles.sql and applies the chain up to and including
//      the release's last migration with `migrate`, as slugbase_migrator.
//   3. Seeds the demo instance (doc 08 section 1.4) with the factories and the seed script of the working tree, through psql as
//      `slugbase_migrator` like `pnpm db:seed`. The instance is deterministic. The accounts carry a password hash that matches no
//      password, so the snapshot holds nothing that signs in. Only the stamps the database writes itself (`now()`) differ between
//      two runs.
//   4. Takes `pg_dump` in plain format (COPY rows), strips the `\restrict` and `\unrestrict` lines of newer pg_dump releases (a random
//      key per run, and a meta-command that psql releases before the 16.10 and 17.6 minors do not know), and compresses it with gzip
//      (level 9, no file name or time in the header, so the same dump compresses to the same bytes).
//   5. Records the tag, the last migration and its checksum, a checksum over the whole chain, the row counts of every table, the
//      checksum of the compressed file and the server major, and drops the throwaway database, however the run ends.
//
// The dump is taken from a PostgreSQL 17 server, the oldest supported major (doc 01 section 9): a plain dump of an older major
// restores on 17 and on 18, which a dump of a newer one does not promise. The script refuses any other major, and refuses a
// `pg_dump` older than the server. Point SLUGBASE_TEST_PG_URL at a PostgreSQL 17 server (the CI service container or a throwaway
// container) when the development Postgres is a newer major. `PG_DUMP` names the `pg_dump` binary when it is not the one on the PATH.
//
// Needs `pnpm turbo run build --filter=@slugbase/core...` first (the root script does it), `psql` and `pg_dump` on the PATH, and a full clone
// with its tags. Exit status: 0 when both files were written, 1 otherwise, 128 + n on a SIGINT, SIGTERM or SIGHUP (signal number n).
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { constants } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = resolve(import.meta.dirname, "..");
const DB_PACKAGE = join(ROOT, "packages/db");
const OUT_DIR = join(DB_PACKAGE, "test/migrations/released");
const DEFAULT_SERVER_URL = "postgres://slugbase:slugbase@127.0.0.1:54329/slugbase_dev";
const SNAPSHOT_MAJOR = 17;
const APP_PASSWORD = "slugbase_app_dev_only";
const MIGRATOR_PASSWORD = "slugbase_migrator_dev_only";
// The hash of no password: the shape of an argon2id string, so the column holds what it holds in production, and nothing that verifies.
const NO_PASSWORD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$c25hcHNob3Qtbm8tcGFzc3dvcmQ$c25hcHNob3Qtbm8tcGFzc3dvcmQtaGFzaC1ub3QtdmVyaWZ5aW5n";
const RELEASE_TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const CHILD_TIMEOUT_MS = 300_000;

function log(message) {
  process.stdout.write(`db:snapshot: ${message}\n`);
}

function fail(message) {
  throw new Error(message);
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function git(args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  const result = spawnSync("git", ["-C", ROOT, ...args], { env, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  if (result.error !== undefined || result.status !== 0) {
    fail(`git ${args.join(" ")} failed: ${result.error?.message ?? result.stderr.toString().trim()}`);
  }
  return result.stdout;
}

const server = new URL(process.env.SLUGBASE_TEST_PG_URL ?? DEFAULT_SERVER_URL);

function connection(database) {
  return {
    host: server.hostname,
    port: Number(server.port === "" ? "5432" : server.port),
    database,
    username: decodeURIComponent(server.username),
    password: decodeURIComponent(server.password),
  };
}

// The child gets the connection and the PATH and nothing else, and the password goes by the environment, never by a command line.
function childEnvironment(target, extra = {}) {
  return {
    PATH: process.env.PATH ?? "",
    PGHOST: target.host,
    PGPORT: String(target.port),
    PGDATABASE: target.database,
    PGUSER: target.username,
    PGPASSWORD: target.password,
    PGCLIENTENCODING: "UTF8",
    PGCONNECT_TIMEOUT: "10",
    ...extra,
  };
}

function run(command, args, target, options = {}) {
  const result = spawnSync(command, args, {
    env: childEnvironment(target, options.env),
    input: options.input,
    encoding: options.binary === true ? "buffer" : "utf8",
    timeout: CHILD_TIMEOUT_MS,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail = result.error?.message ?? String(result.stderr).trim().slice(0, 2_000);
    fail(`${command} failed: ${detail.split(target.password).join("***")}`);
  }
  return result.stdout;
}

function psql(target, statement) {
  return run("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", statement], target).trim();
}

async function main(tag) {
  if (!RELEASE_TAG.test(tag)) {
    fail("usage: pnpm db:snapshot <release tag>, a tag such as v1.0.0 or v1.0.0-rc.1");
  }
  git(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]);

  // The release's chain, read from git, which must be the working tree's chain up to the release's last migration.
  const journalAt = JSON.parse(git(["show", `${tag}:packages/db/migrations/meta/_journal.json`]).toString("utf8"));
  const releaseTags = journalAt.entries.map((entry) => entry.tag);
  const currentJournal = JSON.parse(readFileSync(join(DB_PACKAGE, "migrations/meta/_journal.json"), "utf8"));
  const currentTags = currentJournal.entries.map((entry) => entry.tag);
  if (releaseTags.length === 0 || releaseTags.some((entry, index) => currentTags[index] !== entry)) {
    fail(`the journal of ${tag} is not the start of the journal in the working tree`);
  }
  const lines = [];
  for (const migration of releaseTags) {
    const released = git(["show", `${tag}:packages/db/migrations/${migration}.sql`]);
    const current = readFileSync(join(DB_PACKAGE, "migrations", `${migration}.sql`));
    if (!released.equals(current)) {
      fail(`migration ${migration} differs between ${tag} and the working tree; a merged migration is never edited`);
    }
    lines.push(`${migration} ${sha256(released)}`);
  }
  const lastMigration = releaseTags[releaseTags.length - 1];
  const lastMigrationSha256 = lines[lines.length - 1].split(" ")[1];
  const recorded = JSON.parse(readFileSync(join(DB_PACKAGE, "src/check/migration-checksums.json"), "utf8")).migrations;
  if (recorded[lastMigration] !== lastMigrationSha256) {
    fail(`${lastMigration} is not recorded in src/check/migration-checksums.json with the checksum it has in ${tag}`);
  }

  const dumpBinary = process.env.PG_DUMP ?? "pg_dump";
  const dumpMajor = Number(/(\d+)(?:\.\d+)*/.exec(run(dumpBinary, ["--version"], connection("postgres")))?.[1]);
  const serverMajor = Math.floor(Number(psql(connection("postgres"), "SHOW server_version_num")) / 10_000);
  if (serverMajor !== SNAPSHOT_MAJOR) {
    fail(`the server of SLUGBASE_TEST_PG_URL is PostgreSQL ${String(serverMajor)}; a snapshot is taken from PostgreSQL ${String(SNAPSHOT_MAJOR)}, the oldest supported major`);
  }
  if (dumpMajor < serverMajor) {
    fail(`${dumpBinary} is version ${String(dumpMajor)} and cannot dump a PostgreSQL ${String(serverMajor)} server`);
  }

  const { migrate, CE_CHAIN } = await import(pathToFileURL(join(DB_PACKAGE, "src/migrate.ts")));
  const { buildDemoInstance } = await import(pathToFileURL(join(ROOT, "packages/testing/src/seed/instance.ts")));
  const { seedScript } = await import(pathToFileURL(join(ROOT, "packages/testing/src/seed/script.ts")));
  const { runSeedScript } = await import(pathToFileURL(join(ROOT, "packages/testing/src/seed/run.ts")));
  const { countRows } = await import(pathToFileURL(join(DB_PACKAGE, "test/migrations/read-back.ts")));
  const postgres = (await import(pathToFileURL(createRequire(join(DB_PACKAGE, "package.json")).resolve("postgres")))).default;

  const name = `test_snapshot_${randomBytes(6).toString("hex")}`;
  const maintenance = connection(server.pathname.slice(1) === "" ? "postgres" : server.pathname.slice(1));
  const target = connection(name);
  let created = false;
  const drop = () => {
    if (created) {
      created = false;
      psql(maintenance, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => {
      try {
        drop();
      } finally {
        process.exit(128 + constants.signals[signal]);
      }
    });
  }

  try {
    psql(maintenance, `CREATE DATABASE ${name}`);
    created = true;
    run("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", join(DB_PACKAGE, "provision/roles.sql")], target, {
      env: { PROVISION_APP_PASSWORD: APP_PASSWORD, PROVISION_MIGRATOR_PASSWORD: MIGRATOR_PASSWORD },
    });
    const migratorUrl = `postgres://slugbase_migrator:${encodeURIComponent(MIGRATOR_PASSWORD)}@${target.host}:${String(target.port)}/${name}`;
    const applied = await migrate({ url: migratorUrl, until: { chain: CE_CHAIN.name, tag: lastMigration } });
    log(`applied ${String(applied.applied.length)} migrations up to ${lastMigration}`);

    const instance = buildDemoInstance();
    const hashes = Object.fromEntries(instance.accounts.map((account) => [account.key, NO_PASSWORD_HASH]));
    await runSeedScript(
      { ...target, username: "slugbase_migrator", password: MIGRATOR_PASSWORD },
      seedScript(instance, hashes),
      { path: process.env.PATH ?? "" },
    );

    const sql = postgres({ ...target, username: target.username, max: 1, onnotice: () => undefined });
    let rowCounts;
    let migrationCount;
    try {
      rowCounts = await countRows(sql);
      migrationCount = (await sql.unsafe("SELECT count(*)::int AS n FROM drizzle.migrations_core"))[0].n;
    } finally {
      await sql.end({ timeout: 5 });
    }
    if (migrationCount !== releaseTags.length) {
      fail(`the database recorded ${String(migrationCount)} migrations and ${tag} has ${String(releaseTags.length)}`);
    }

    const dump = run(dumpBinary, ["--format=plain", "--encoding=UTF8", "--no-sync"], target, { binary: true }).toString("utf8");
    const plain = dump
      .split("\n")
      .filter((line) => !/^\\(?:un)?restrict [A-Za-z0-9]+$/.test(line))
      .join("\n");
    const compressed = gzipSync(plain, { level: 9 });

    mkdirSync(OUT_DIR, { recursive: true });
    const file = `${tag}.sql.gz`;
    const record = {
      tag,
      file,
      fileSha256: sha256(compressed),
      serverMajor,
      lastMigration,
      lastMigrationSha256,
      migrationCount,
      chainSha256: sha256(`${lines.join("\n")}\n`),
      rowCounts,
    };
    // The record is written last: a run that fails halfway leaves no record that names a dump that is not there.
    writeFileSync(join(OUT_DIR, `${file}.partial`), compressed);
    renameSync(join(OUT_DIR, `${file}.partial`), join(OUT_DIR, file));
    writeFileSync(join(OUT_DIR, `${tag}.json.partial`), `${JSON.stringify(record, null, 2)}\n`);
    renameSync(join(OUT_DIR, `${tag}.json.partial`), join(OUT_DIR, `${tag}.json`));
    log(`wrote ${file} (${String(compressed.length)} bytes) and ${tag}.json: ${lastMigration}, ${String(migrationCount)} migrations`);
  } finally {
    drop();
  }
}

try {
  await main(process.argv.slice(2).filter((argument) => argument !== "--")[0] ?? "");
} catch (error) {
  process.stderr.write(`db:snapshot: ${error instanceof Error ? error.message : "failed"}\n`);
  process.exitCode = 1;
}
