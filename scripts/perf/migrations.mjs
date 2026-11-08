// The migration timing of doc 08 section 5.4: the large instance is built in a database of the test harness at the migration level of the
// latest release tag (raised to the first level at which the large instance can be written, when the release has not got its tables), and
// every later migration of the CE chain is applied with `migrate`, one at a time. The report gives, per migration file, the wall time and
// the longest ACCESS EXCLUSIVE lock held and the relation it was on. A migration that holds that lock for more than 1 s fails the run.
// The database is dropped however the run ends.
//
//   node scripts/perf/migrations.mjs [--commit <sha>] [--out <dir>] [--bookmarks <n>] [--workspaces <n>]
//
// Needs `pnpm turbo run build --filter=@slugbase/testing` first, `psql`, a full clone with its tags (the release is read from git, as
// `pnpm db:check` reads it), and the server the test harness uses: SLUGBASE_TEST_PG_URL, the development Postgres of compose.dev.yml when
// unset. Exit status: 0 when no migration holds the lock for more than 1 s, 10 when one does,
// 128 + n when a SIGINT, SIGTERM or SIGHUP (signal number n) interrupts the run, which drops its database first, 1 when the run failed in any other way.
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(import.meta.dirname, "../..");
const DEFAULT_SERVER_URL = "postgres://slugbase:slugbase@127.0.0.1:54329/slugbase_dev";
const REGRESSION = 10;
const MISSING_LISTED = 20;

const NOTES = [
  "Backfills are worker jobs and not migrations, and are not part of this measurement.",
  "A non-transactional step (`CREATE INDEX CONCURRENTLY`, applied outside a transaction with lock_timeout off) takes no ACCESS EXCLUSIVE lock on the table it indexes: it is reported with its duration only and is not judged against the limit.",
  "The wall time of a migration is that of the `migrate` call that applied it alone: it includes the connection, the advisory lock and the bookkeeping, and runs with the lock_timeout and statement_timeout of `migrate`.",
  "The longest lock is the longest run of 50 ms polls of pg_locks that saw an ACCESS EXCLUSIVE lock of the migrating session on one relation of a user schema; it is short of the real time by less than two polls.",
];

const isMain = process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

const { values: args } = isMain
  ? parseArgs({
      options: {
        commit: { type: "string" },
        out: { type: "string" },
        bookmarks: { type: "string" },
        workspaces: { type: "string" },
      },
    })
  : { values: {} };
if (isMain && args.commit !== undefined && !/^[0-9a-f]{40}$/.test(args.commit)) {
  process.stderr.write("perf: --commit takes a full commit hash of 40 hex digits\n");
  process.exit(1);
}
for (const name of ["bookmarks", "workspaces"]) {
  if (isMain && args[name] !== undefined && !/^[1-9][0-9]{0,5}$/.test(args[name])) {
    process.stderr.write(`perf: --${name} takes a positive number\n`);
    process.exit(1);
  }
}

function log(message) {
  process.stdout.write(`perf: ${message}\n`);
}

function measuredCommit() {
  if (args.commit !== undefined) {
    return args.commit;
  }
  try {
    const hash = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8", timeout: 30_000 }).trim();
    return /^[0-9a-f]{40}$/.test(hash) ? hash : null;
  } catch {
    return null;
  }
}

// The latest release tag and the migrations it held, read the way `pnpm db:check` reads them. A shallow clone, or one without tags, is an error and not a
// run without a release: the baseline would silently be the first level at which the seed works.
async function latestRelease() {
  const { latestRelease: read } = await import(join(ROOT, "packages/db/src/check/release-history.ts"));
  const release = read(join(ROOT, "packages/db"));
  return release === undefined ? { tag: null, migrations: [] } : { tag: release.tag, migrations: release.migrations };
}

const abort = new AbortController();
let interruptStatus;
let cleanup = async () => undefined;
// Settles when the database is built and registered for removal, or when building it ended without one (it has dropped its own database then); an
// interrupt waits for it, so that the database being built is dropped too.
let preparing = Promise.resolve();
for (const signal of isMain ? ["SIGINT", "SIGTERM", "SIGHUP"] : []) {
  process.once(signal, () => {
    interruptStatus = 128 + constants.signals[signal];
    abort.abort();
    preparing
      .then(() => cleanup())
      .catch(() => undefined)
      .finally(() => {
        process.exit(interruptStatus);
      });
  });
}

function summary(report) {
  const rows = report.migrations.map((m) => {
    const lock = m.nonTransactional ? "non-transactional" : m.lockHeldMs === null ? "none seen" : `${String(m.lockHeldMs)} ms on ${m.lockRelation}`;
    return `  ${m.file}: ${String(m.wallMs)} ms, ${lock}`;
  });
  return [`baseline: ${report.baseline.level}${report.baseline.raised ? ` (raised from the release ${report.baseline.release ?? "(none)"})` : ` (the release ${report.baseline.release ?? "(none)"})`}`, ...rows].join("\n");
}

async function main() {
  const timing = await import(join(ROOT, "packages/testing/dist/perf/index.js"));
  const serverUrl = process.env.SLUGBASE_TEST_PG_URL ?? DEFAULT_SERVER_URL;
  const outDir = resolve(args.out ?? "perf-results/migrations");
  mkdirSync(outDir, { recursive: true });
  const release = await latestRelease();
  log(`latest release: ${release.tag ?? "none"}, ${String(release.migrations.length)} migrations`);

  const started = Date.now();
  log("building the large instance in a database of the test harness");
  const building = timing.prepareMigrationInstance({
    serverUrl,
    harnessUrl: process.env.SLUGBASE_TEST_PG_URL,
    path: process.env.PATH ?? "",
    released: release.migrations,
    signal: abort.signal,
    ...(args.bookmarks === undefined ? {} : { bookmarks: Number(args.bookmarks) }),
    ...(args.workspaces === undefined ? {} : { workspaces: Number(args.workspaces) }),
  });
  preparing = building.then(
    (ready) => {
      cleanup = () => ready.drop();
    },
    () => undefined,
  );
  const prepared = await building;
  try {
    const { baseline } = prepared;
    log(`seeded ${prepared.databaseName} at ${baseline.level}: ${JSON.stringify(prepared.counts)} in ${String(Math.round((Date.now() - started) / 1000))} s`);
    if (baseline.raised) {
      log(`the release level ${baseline.releaseLevel ?? "(none)"} lacks ${baseline.missingAtRelease.slice(0, MISSING_LISTED).join(", ")}${baseline.missingAtRelease.length > MISSING_LISTED ? ", ..." : ""}, so the baseline is ${baseline.level}`);
    }
    const timings = await timing.timeMigrations({
      migratorUrl: prepared.migratorUrl,
      connection: prepared.connection,
      after: { chain: "core", tag: baseline.level },
      path: process.env.PATH ?? "",
    });
    const violations = timing.lockViolations(timings);
    const report = {
      commit: measuredCommit(),
      database: prepared.counts,
      baseline: {
        release: release.tag,
        releaseLevel: baseline.releaseLevel,
        level: baseline.level,
        raised: baseline.raised,
        missingAtRelease: baseline.missingAtRelease.slice(0, MISSING_LISTED),
      },
      lockLimitMs: timing.LOCK_LIMIT_MS,
      sampleIntervalMs: timing.SAMPLE_INTERVAL_MS,
      migrations: timings.map((t) => ({
        chain: t.chain,
        file: t.file,
        wallMs: t.wallMs,
        nonTransactional: t.nonTransactional,
        lockRelation: t.lock?.relation ?? null,
        lockHeldMs: t.lock?.heldMs ?? null,
      })),
      violations: violations.map((t) => ({ file: t.file, relation: t.lock?.relation ?? null, heldMs: t.lock?.heldMs ?? null })),
      notes: NOTES,
    };
    writeFileSync(join(outDir, "result.json"), `${JSON.stringify(report, null, 2)}\n`);
    log(`commit measured: ${report.commit ?? "unknown"}`);
    log(`\n${summary(report)}`);
    for (const note of NOTES) {
      log(note);
    }
    if (violations.length > 0) {
      for (const violation of violations) {
        process.stderr.write(`perf: ${violation.file} held ACCESS EXCLUSIVE on ${violation.lock?.relation ?? "?"} for ${String(violation.lock?.heldMs)} ms, more than ${String(timing.LOCK_LIMIT_MS)} ms\n`);
      }
      return REGRESSION;
    }
    return 0;
  } finally {
    await prepared.drop();
    cleanup = async () => undefined;
  }
}

if (isMain) {
  let status = 1;
  try {
    status = await main();
  } catch (error) {
    process.stderr.write(`perf: ${error instanceof Error ? error.message : "failed"}\n`);
  }
  process.exit(interruptStatus ?? status);
}
