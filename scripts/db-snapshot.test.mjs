// Tests the refusals of scripts/db-snapshot.mjs (doc 08 section 3.4). Each case copies the script into a temporary git repository
// that holds a two-migration chain tagged v1.0.0, changes one thing, runs the script there and expects exit status 1, the message
// of the refusal and no file under packages/db/test/migrations/released/. The server checks run against stub `psql` and `pg_dump`
// executables that report a version, so no PostgreSQL server is needed. A final case passes both server checks and shows the
// run gets past them. Nothing here reads a real database: the connection URL is a placeholder the stubs never use.
//
//   node scripts/db-snapshot.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";

const script = join(import.meta.dirname, "db-snapshot.mjs");
const scratch = mkdtempSync(join(tmpdir(), "db-snapshot-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const migrations = {
  "0000_first": "CREATE TABLE first (id uuid PRIMARY KEY);\n",
  "0001_second": "CREATE TABLE second (id uuid PRIMARY KEY);\n",
};

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function journalOf(tags) {
  return `${JSON.stringify({ version: "7", dialect: "postgresql", entries: tags.map((tag, idx) => ({ idx, tag })) }, null, 2)}\n`;
}

function checksumsOf(files) {
  return `${JSON.stringify({ migrations: Object.fromEntries(Object.entries(files).map(([name, sql]) => [name, sha256(sql)])) }, null, 2)}\n`;
}

function write(repo, path, content) {
  const full = join(repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function git(repo, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  const result = spawnSync(
    "git",
    ["-C", repo, "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args],
    { env: { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
}

let counter = 0;

/** A repository with the script and a chain of two migrations, committed and tagged v1.0.0. */
function repository() {
  counter += 1;
  const repo = join(scratch, `repo-${String(counter)}`);
  mkdirSync(repo);
  git(repo, "init", "--quiet");
  mkdirSync(join(repo, "scripts"));
  cpSync(script, join(repo, "scripts", "db-snapshot.mjs"));
  write(repo, "packages/db/migrations/meta/_journal.json", journalOf(Object.keys(migrations)));
  for (const [name, sql] of Object.entries(migrations)) {
    write(repo, `packages/db/migrations/${name}.sql`, sql);
  }
  write(repo, "packages/db/src/check/migration-checksums.json", checksumsOf(migrations));
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", "release");
  git(repo, "tag", "v1.0.0");
  return repo;
}

/** Stub `psql` and `pg_dump` that print the given versions; psql records each call in `psql.log`. */
function stubs(repo, { serverVersionNum, dumpVersion }) {
  const bin = join(repo, "stub-bin");
  mkdirSync(bin);
  const log = join(repo, "psql.log");
  write(bin, "psql", `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\necho ${serverVersionNum}\n`);
  write(bin, "pg_dump", `#!/bin/sh\necho 'pg_dump (PostgreSQL) ${dumpVersion}'\n`);
  chmodSync(join(bin, "psql"), 0o755);
  chmodSync(join(bin, "pg_dump"), 0o755);
  return { bin, log, dump: join(bin, "pg_dump") };
}

function snapshot(repo, args, { bin, dump } = {}) {
  const result = spawnSync(process.execPath, [join(repo, "scripts", "db-snapshot.mjs"), ...args], {
    cwd: repo,
    env: {
      PATH: `${bin === undefined ? "" : `${bin}:`}${process.env.PATH ?? ""}`,
      SLUGBASE_TEST_PG_URL: "postgres://placeholder:placeholder@127.0.0.1:1/placeholder",
      ...(dump === undefined ? {} : { PG_DUMP: dump }),
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

function assertRefused(repo, result, message) {
  assert.equal(result.status, 1, `expected exit status 1, got ${String(result.status)}:\n${result.stderr}`);
  assert.ok(result.stderr.includes(message), `expected "${message}" in:\n${result.stderr}`);
  assert.equal(existsSync(join(repo, "packages/db/test/migrations/released")), false, "a refused run wrote under released/");
}

test("a tag that is not a release tag is refused", () => {
  for (const tag of ["main", "1.0.0", "v1.0", "v1.0.0+build", ""]) {
    const repo = repository();
    assertRefused(repo, snapshot(repo, tag === "" ? [] : [tag]), "usage: pnpm db:snapshot <release tag>");
  }
});

test("a release tag that names no commit is refused", () => {
  const repo = repository();
  const result = snapshot(repo, ["v9.9.9"]);
  assertRefused(repo, result, "git rev-parse --verify --quiet refs/tags/v9.9.9^{commit} failed");
});

test("a tag whose journal is not the start of the working tree's journal is refused", () => {
  const renamed = repository();
  write(renamed, "packages/db/migrations/meta/_journal.json", journalOf(["0000_first", "0001_other"]));
  assertRefused(renamed, snapshot(renamed, ["v1.0.0"]), "the journal of v1.0.0 is not the start of the journal in the working tree");

  const shorter = repository();
  write(shorter, "packages/db/migrations/meta/_journal.json", journalOf(["0000_first"]));
  assertRefused(shorter, snapshot(shorter, ["v1.0.0"]), "the journal of v1.0.0 is not the start of the journal in the working tree");
});

test("a tag with an empty journal is refused", () => {
  const repo = repository();
  write(repo, "packages/db/migrations/meta/_journal.json", journalOf([]));
  git(repo, "add", "packages/db/migrations/meta/_journal.json");
  git(repo, "commit", "--quiet", "-m", "empty");
  git(repo, "tag", "v1.1.0");
  assertRefused(repo, snapshot(repo, ["v1.1.0"]), "the journal of v1.1.0 is not the start of the journal in the working tree");
});

test("a migration that differs between the tag and the working tree is refused", () => {
  const repo = repository();
  write(repo, "packages/db/migrations/0000_first.sql", `${migrations["0000_first"]}-- edited\n`);
  assertRefused(
    repo,
    snapshot(repo, ["v1.0.0"]),
    "migration 0000_first differs between v1.0.0 and the working tree; a merged migration is never edited",
  );
});

test("a last migration whose checksum is not recorded is refused", () => {
  const missing = repository();
  write(missing, "packages/db/src/check/migration-checksums.json", checksumsOf({ "0000_first": migrations["0000_first"] }));
  assertRefused(
    missing,
    snapshot(missing, ["v1.0.0"]),
    "0001_second is not recorded in src/check/migration-checksums.json with the checksum it has in v1.0.0",
  );

  const other = repository();
  write(other, "packages/db/src/check/migration-checksums.json", checksumsOf({ ...migrations, "0001_second": "something else\n" }));
  assertRefused(
    other,
    snapshot(other, ["v1.0.0"]),
    "0001_second is not recorded in src/check/migration-checksums.json with the checksum it has in v1.0.0",
  );
});

test("a server of a major other than 17 is refused", () => {
  for (const [serverVersionNum, major] of [
    ["160004", "16"],
    ["180001", "18"],
  ]) {
    const repo = repository();
    const stub = stubs(repo, { serverVersionNum, dumpVersion: "18.1" });
    const result = snapshot(repo, ["v1.0.0"], stub);
    assertRefused(
      repo,
      result,
      `the server of SLUGBASE_TEST_PG_URL is PostgreSQL ${major}; a snapshot is taken from PostgreSQL 17, the oldest supported major`,
    );
    assert.equal(readFileSync(stub.log, "utf8").trim().split("\n").length, 1, "the run went on to create a database");
  }
});

test("a pg_dump older than the server is refused", () => {
  const repo = repository();
  const stub = stubs(repo, { serverVersionNum: "170002", dumpVersion: "16.9" });
  const result = snapshot(repo, ["v1.0.0"], stub);
  assertRefused(repo, result, `${stub.dump} is version 16 and cannot dump a PostgreSQL 17 server`);
  assert.equal(readFileSync(stub.log, "utf8").trim().split("\n").length, 1, "the run went on to create a database");
});

test("a PostgreSQL 17 server and a pg_dump of 17 or newer pass both server checks", () => {
  for (const dumpVersion of ["17.2", "18.1"]) {
    const repo = repository();
    const stub = stubs(repo, { serverVersionNum: "170002", dumpVersion });
    const result = snapshot(repo, ["v1.0.0"], stub);
    assert.equal(result.status, 1, "the temporary repository has no packages to import, so the run ends there");
    assert.doesNotMatch(result.stderr, /snapshot is taken from PostgreSQL|cannot dump/);
    assert.match(result.stderr, /db:snapshot: /);
  }
});
