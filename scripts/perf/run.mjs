// The performance budgets of doc 08 section 5.3, measured: a database made by the test harness is filled with the large
// instance (50 000 bookmarks in one workspace, 2 000 further workspaces), the server runs against it on this machine, and k6
// (scripts/perf/scenarios.js) signs in and drives /go, the bookmark list (with no text, narrowed by a text and under a filter)
// and search. The server is the CE image given by --image (started with `server`, as the nightly job does) or, without it, the
// built `apps/slugbase/dist/main.js server`. Before the budgets, 10 000 requests for one forwarding slug check that /go does not
// become write load (doc 01 section 8.1). Everything this run starts, the server or its container, the k6 containers and the
// database, is removed however it ends.
//
//   node scripts/perf/run.mjs [--image <ref>] [--out <dir>] [--bookmarks <n>] [--workspaces <n>] [--rate <per second>] [--duration <seconds>]
//
// Needs `pnpm turbo run build --filter=slugbase --filter=@slugbase/testing` first (`--filter=@slugbase/testing` alone with --image),
// `psql` and Docker (k6 runs from a pinned image on the host network, as does the server image), and the server the test harness
// uses: SLUGBASE_TEST_PG_URL, the development Postgres of compose.dev.yml when unset. Exit status: 0 when every budget holds and
// the write load is within its limit, 10 when one is exceeded (a regression, not a failure of the run), 1 when the run itself failed.
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { constants, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { FLUSH_INTERVAL_SECONDS, GO_HOT_METRIC, GO_HOT_REQUESTS, MAX_VUS, SCENARIOS, budgets as budgetList, loadMetrics, writeLoadLimit } from "./budgets.js";

const ROOT = resolve(import.meta.dirname, "../..");
// The k6 image is pinned by tag and by digest, so a re-run measures the same tool.
const K6_IMAGE = "grafana/k6:1.3.0@sha256:3ddc8b1a33a2c3d8edc6e99b6a762ae36cba08788463458f5e6a7703e14eb77d";
const REGRESSION = 10;
const READY_SECONDS = 60;
const STOP_SECONDS = 10;
const DEFAULT_SERVER_URL = "postgres://slugbase:slugbase@127.0.0.1:54329/slugbase_dev";
// The limits are raised so that the measurement is of the server and not of its rate limiter answering 429; a token is still taken on
// every request.
const UNLIMITED = "9999999/sec";
// Every budget the scenarios put a threshold on (budgets.js), so that k6 ending with 99 is explained by an entry that is not ok.
const BUDGETS = budgetList();

const { values: args } = parseArgs({
  options: {
    image: { type: "string" },
    out: { type: "string" },
    bookmarks: { type: "string" },
    workspaces: { type: "string" },
    rate: { type: "string", default: "40" },
    duration: { type: "string", default: "30" },
  },
});
// The image reference goes to `docker run` as an argument, so it may not read as an option of it.
if (args.image !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(args.image)) {
  process.stderr.write("perf: --image takes an image reference such as slugbase:perf\n");
  process.exit(1);
}
// Where the k6 summary and the result are written; a directory of its own under the temporary directory unless one is given.
const outDir = args.out === undefined ? mkdtempSync(join(tmpdir(), "slugbase-perf-results-")) : resolve(args.out);

function log(message) {
  process.stdout.write(`perf: ${message}\n`);
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => {
        resolvePort(port);
      });
    });
  });
}

function exited(child) {
  return new Promise((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveExit(child.exitCode ?? 1);
      return;
    }
    child.once("exit", (code) => {
      resolveExit(code ?? 1);
    });
  });
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

// Runs a command to its end and resolves with its status; a failure to start it rejects.
function run(command, argv, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, argv, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code) => {
      resolveRun(code ?? 1);
    });
  });
}

// Runs a command to its end and resolves with its status and what it wrote to stdout; a failure to start it rejects.
function capture(command, argv, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, argv, { stdio: ["ignore", "pipe", "inherit"], ...options });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      resolveRun({ status: code ?? 1, stdout });
    });
  });
}

const cleanups = [];
let cleaning;
async function cleanup() {
  cleaning ??= (async () => {
    for (const step of cleanups.reverse()) {
      try {
        await step();
      } catch (error) {
        process.stderr.write(`perf: cleanup failed: ${error instanceof Error ? error.message : "unknown"}\n`);
      }
    }
  })();
  await cleaning;
}

let interrupted = false;
let interruptStatus;
// Settles when the database is created, seeded and registered for removal, or when seeding ended without one; an interrupt waits
// for it, so that the database the seeding is making is dropped too.
let preparing = Promise.resolve();
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    interrupted = true;
    interruptStatus = 128 + constants.signals[signal];
    abort.abort();
    preparing
      .then(cleanup, cleanup)
      .finally(() => {
        process.exit(interruptStatus);
      });
  });
}

// Set when the process that starts the server (node, or the docker client) could not be started at all.
let serverStartError;

async function waitReady(port, server) {
  const deadline = Date.now() + READY_SECONDS * 1000;
  while (Date.now() < deadline) {
    if (serverStartError !== undefined) {
      throw new Error(`the server could not be started: ${serverStartError.message}`);
    }
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error("the server ended before it was ready");
    }
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/ready`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        return;
      }
    } catch {
      // not listening yet
    }
    await sleep(500);
  }
  throw new Error(`the server was not ready within ${String(READY_SECONDS)} seconds`);
}

// What a scenario's load did, from the sub-metrics budgets.js names. A scenario that dropped no arrival has no `dropped_iterations` sample and so no entry:
// that is 0. The other two always have samples when the scenario ran, so a missing one is an error and not a 0. A scenario is saturated when it dropped an
// arrival or used every VU it may: then the time of its requests includes the wait for a server that could not keep up, and a p95 is not the time of a statement.
function loadOf(summary, scenario) {
  const metrics = loadMetrics(scenario);
  const completed = summary.metrics[metrics.completed]?.count;
  const peakVus = summary.metrics[metrics.activeVus]?.max;
  if (typeof completed !== "number" || typeof peakVus !== "number") {
    throw new Error(`k6 reported no requests or VUs for the scenario ${scenario}`);
  }
  const dropped = summary.metrics[metrics.dropped]?.count ?? 0;
  return { completed, dropped, peakVus, maxVus: MAX_VUS, saturated: dropped > 0 || peakVus >= MAX_VUS };
}

function evaluate(summary) {
  const scenarios = Object.fromEntries(SCENARIOS.map((scenario) => [scenario, loadOf(summary, scenario)]));
  const rows = BUDGETS.map(({ name, scenario, metric, limitMs }) => {
    const p95 = summary.metrics[metric]?.["p(95)"];
    if (typeof p95 !== "number") {
      throw new Error(`k6 reported no p(95) for ${metric}`);
    }
    return { name, scenario, metric, limitMs, p95Ms: Math.round(p95 * 100) / 100, ok: p95 < limitMs, saturated: scenarios[scenario].saturated };
  });
  return { budgets: rows, scenarios };
}

async function main() {
  const { preparePerfInstance } = await import(join(ROOT, "packages/testing/dist/seed/index.js"));
  const serverUrl = process.env.SLUGBASE_TEST_PG_URL ?? DEFAULT_SERVER_URL;
  mkdirSync(outDir, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "slugbase-perf-"));
  cleanups.push(() => {
    rmSync(work, { recursive: true, force: true });
  });
  mkdirSync(join(work, "data"));

  log("seeding the large instance into a database of the test harness");
  const started = Date.now();
  const prepared = preparePerfInstance({
    serverUrl,
    harnessUrl: process.env.SLUGBASE_TEST_PG_URL,
    path: process.env.PATH ?? "",
    signal: abort.signal,
    ...(args.bookmarks === undefined ? {} : { bookmarks: Number(args.bookmarks) }),
    ...(args.workspaces === undefined ? {} : { workspaces: Number(args.workspaces) }),
  });
  // A seeding that fails or is interrupted has dropped its database itself; one that succeeds is dropped by a cleanup step,
  // registered in the turn in which the instance arrives.
  preparing = prepared.then(
    (ready) => {
      cleanups.push(() => ready.drop());
    },
    () => undefined,
  );
  const instance = await prepared;
  log(`seeded ${instance.databaseName}: ${JSON.stringify(instance.counts)} in ${String(Math.round((Date.now() - started) / 1000))} s`);
  writeFileSync(join(work, "data", "fixtures.json"), JSON.stringify(instance.instance.fixtures));

  const port = await freePort();
  const origin = `http://127.0.0.1:${String(port)}`;
  const serverLog = join(work, "server.log");
  const logFile = openSync(serverLog, "w");
  // Only what the server reads, so nothing of the caller's environment decides where it connects.
  const serverEnv = {
    NODE_ENV: "development",
    LOG_LEVEL: "warn",
    PORT: String(port),
    APP_ORIGIN: origin,
    DATABASE_URL: instance.appUrl,
    MIGRATE_ON_START: "false",
    SETUP_ENABLED: "false",
    SESSION_SECRET: randomBytes(32).toString("base64url"),
    ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    ENCRYPTION_KEY_ID: "perf-1",
    RATE_LIMIT_LOGIN_IP: UNLIMITED,
    RATE_LIMIT_LOGIN_EMAIL: UNLIMITED,
    RATE_LIMIT_GO_IP: UNLIMITED,
    RATE_LIMIT_GO_ACCOUNT: UNLIMITED,
    RATE_LIMIT_READ_IP: UNLIMITED,
    RATE_LIMIT_READ_ACCOUNT: UNLIMITED,
  };
  let server;
  if (args.image === undefined) {
    server = spawn(process.execPath, [join(ROOT, "apps/slugbase/dist/main.js"), "server"], {
      cwd: join(ROOT, "apps/slugbase"),
      env: { PATH: process.env.PATH ?? "", ...serverEnv },
      stdio: ["ignore", logFile, logFile],
    });
    cleanups.push(async () => {
      if (server.exitCode !== null || server.signalCode !== null) {
        return;
      }
      server.kill("SIGTERM");
      const status = await Promise.race([exited(server), sleep(STOP_SECONDS * 1000).then(() => "timeout")]);
      if (status === "timeout") {
        server.kill("SIGKILL");
      }
    });
  } else {
    // The image's entrypoint takes the command alone. Each variable goes in by name, so that the values (the database URL, the secrets) are in the
    // environment of the docker client and not in its arguments. The host network lets the container reach the database at the address the server uses.
    const serverContainer = `slugbase-perf-server-${randomBytes(4).toString("hex")}`;
    cleanups.push(async () => {
      // The container is stopped (a graceful stop flushes the usage buffer) and removed whether or not the docker client that started it is still running.
      await run("docker", ["stop", "--time", String(STOP_SECONDS), serverContainer], { stdio: "ignore" });
      await run("docker", ["rm", "--force", serverContainer], { stdio: "ignore" });
      if (server.exitCode === null && server.signalCode === null) {
        server.kill("SIGKILL");
      }
    });
    server = spawn(
      "docker",
      ["run", "--rm", "--name", serverContainer, "--network", "host", ...Object.keys(serverEnv).flatMap((name) => ["-e", name]), args.image, "server"],
      { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/", ...serverEnv }, stdio: ["ignore", logFile, logFile] },
    );
  }
  closeSync(logFile);
  server.once("error", (error) => {
    serverStartError = error;
  });
  try {
    await waitReady(port, server);
  } catch (error) {
    process.stderr.write(`perf: server log:\n${readFileSync(serverLog, "utf8").slice(-4000)}\n`);
    throw error;
  }
  log(`the server (${args.image ?? "apps/slugbase/dist/main.js"}) is ready at ${origin}`);

  const k6Run = (name, set, environment) => runK6({ name, set, environment, work, origin, instance });
  const writeLoad = await measureWriteLoad({ serverUrl, instance, k6Run });
  log(
    `write load: ${String(writeLoad.requests)} requests for one slug changed ${String(writeLoad.updates)} rows of bookmarks in ${String(writeLoad.elapsedSeconds)} s, limit ${String(writeLoad.limit)}, ${writeLoad.ok ? "ok" : "EXCEEDED"}`,
  );

  // The owner of the large workspace holds about eight in ten of its bookmarks; the deep page is at most the 400th of 48 and is
  // kept within the first half of the rows, so that a smaller instance has one too.
  const deepPage = Math.max(2, Math.min(400, Math.floor(((Number(args.bookmarks ?? 50_000) * 0.8) / 48) * 0.5)));
  const k6 = await k6Run("budgets", "budgets", { RATE: args.rate, DURATION_SECONDS: args.duration, DEEP_PAGE: String(deepPage) });
  // k6 ends with 99 when a threshold is crossed; its summary is written either way.
  if (k6 !== 0 && k6 !== 99) {
    throw new Error(`k6 ended with status ${String(k6)}`);
  }
  const { budgets, scenarios } = evaluate(JSON.parse(readFileSync(join(outDir, "k6-summary.json"), "utf8")));
  const failedChecks = k6 === 99 && budgets.every((budget) => budget.ok);
  const result = {
    database: instance.counts,
    rate: Number(args.rate),
    durationSeconds: Number(args.duration),
    k6Image: K6_IMAGE,
    server: args.image ?? "apps/slugbase/dist/main.js",
    scenarios,
    budgets,
    writeLoad,
    k6Status: k6,
  };
  writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  log(
    [
      "load of each scenario:",
      ...SCENARIOS.map((name) => {
        const load = scenarios[name];
        return `  ${name}: ${String(load.completed)} requests completed, ${String(load.dropped)} arrivals dropped, at most ${String(load.peakVus)} of ${String(load.maxVus)} VUs active${load.saturated ? ", SATURATED" : ""}`;
      }),
    ].join("\n"),
  );
  log(
    [
      "budgets (p95 of the server time, k6 http_req_waiting):",
      ...budgets.map((b) => `  ${b.name}: ${String(b.p95Ms)} ms, budget ${String(b.limitMs)} ms, ${b.ok ? "ok" : "EXCEEDED"}${b.saturated ? " (the scenario was saturated: the time includes the queue)" : ""}`),
    ].join("\n"),
  );
  if (failedChecks) {
    throw new Error("a response was not what a scenario asked for; see the k6 output above");
  }
  return budgets.every((budget) => budget.ok) && writeLoad.ok && k6 === 0 ? 0 : REGRESSION;
}

// Runs one k6 container to its end and resolves with its status. `set` is the set of scenarios of scenarios.js; the summary goes to `k6-<name>-summary.json`
// in the output directory (the budgets' is `k6-summary.json`).
async function runK6({ name, set, environment, work, origin, instance }) {
  const container = `slugbase-perf-k6-${name}-${randomBytes(4).toString("hex")}`;
  cleanups.push(async () => {
    await run("docker", ["rm", "--force", container], { stdio: "ignore" });
  });
  const user = `${String(process.getuid())}:${String(process.getgid())}`;
  const status = await run(
    "docker",
    [
      "run", "--rm", "--name", container, "--network", "host", "--user", user,
      "-v", `${join(ROOT, "scripts/perf")}:/scripts:ro`,
      "-v", `${join(work, "data")}:/data:ro`,
      "-v", `${outDir}:/out`,
      "-e", `BASE_URL=${origin}`, "-e", `APP_ORIGIN=${origin}`, "-e", `SCENARIO_SET=${set}`,
      "-e", `SLUGBASE_PERF_EMAIL=${instance.instance.fixtures.email}`,
      "-e", "SLUGBASE_PERF_PASSWORD",
      ...Object.entries(environment).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
      K6_IMAGE, "run", "--quiet", "--summary-export", `/out/${summaryFile(name)}`, "/scripts/scenarios.js",
    ],
    { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/", SLUGBASE_PERF_PASSWORD: instance.password } },
  );
  if (interrupted) {
    throw new Error("interrupted");
  }
  return status;
}

const summaryFile = (name) => (name === "budgets" ? "k6-summary.json" : `k6-${name}-summary.json`);

// The rows of `bookmarks` that were updated since the database was made, as the owner of the database (psql, with the credentials of the harness's server).
// A reading that is not a number is an error: it is never taken for zero.
async function updatedBookmarkRows(serverUrl, databaseName) {
  const url = new URL(serverUrl);
  const { status, stdout } = await capture(
    "psql",
    ["--no-psqlrc", "--no-align", "--tuples-only", "--set", "ON_ERROR_STOP=1", "--command", "SELECT n_tup_upd FROM pg_stat_user_tables WHERE schemaname = 'public' AND relname = 'bookmarks'"],
    {
      env: {
        PATH: process.env.PATH ?? "",
        PGHOST: url.hostname.replace(/^\[|\]$/gu, ""),
        PGPORT: url.port === "" ? "5432" : url.port,
        PGUSER: decodeURIComponent(url.username),
        PGPASSWORD: decodeURIComponent(url.password),
        PGDATABASE: databaseName,
      },
    },
  );
  const text = stdout.trim();
  if (status !== 0 || !/^\d+$/.test(text)) {
    throw new Error("the updates of the bookmarks table could not be read, so the write load was not measured");
  }
  return Number(text);
}

// /go counts an open in the server's memory and writes the counts once per flush interval (doc 01 section 8.1). So 10 000 requests for one slug may update
// the one row of `bookmarks` once per interval that began during them, and once more for the flush that follows them. The window runs from before k6 starts to
// when it ends; the reading after it waits for that last flush and for the statistics of the server's connection to reach the database.
async function measureWriteLoad({ serverUrl, instance, k6Run }) {
  const before = await updatedBookmarkRows(serverUrl, instance.databaseName);
  const started = performance.now();
  const status = await k6Run("go-hot", "go-hot", {});
  const elapsedSeconds = Math.round((performance.now() - started) / 100) / 10;
  if (status !== 0) {
    throw new Error(`the requests for one slug did not all answer as asked (k6 status ${String(status)}), so the write load was not measured`);
  }
  const requests = JSON.parse(readFileSync(join(outDir, summaryFile("go-hot")), "utf8")).metrics[GO_HOT_METRIC]?.count;
  if (requests !== GO_HOT_REQUESTS) {
    throw new Error(`k6 reported ${String(requests)} requests for one slug, not ${String(GO_HOT_REQUESTS)}`);
  }
  await sleep((FLUSH_INTERVAL_SECONDS + 5) * 1000);
  let updates = (await updatedBookmarkRows(serverUrl, instance.databaseName)) - before;
  // The opens of 10 000 requests were buffered, so at least one flush wrote them; no update by now means the statistics are late or the flush did not happen.
  for (let waited = 0; updates === 0 && waited < 30; waited += 2) {
    await sleep(2000);
    updates = (await updatedBookmarkRows(serverUrl, instance.databaseName)) - before;
  }
  if (updates === 0) {
    throw new Error("no update of the bookmarks table was counted after 10 000 requests, so the write load was not measured");
  }
  const limit = writeLoadLimit(elapsedSeconds);
  return { requests, updates, elapsedSeconds, flushIntervalSeconds: FLUSH_INTERVAL_SECONDS, limit, ok: updates <= limit };
}

let status = 1;
try {
  status = await main();
} catch (error) {
  process.stderr.write(`perf: ${error instanceof Error ? error.message : "failed"}\n`);
} finally {
  await cleanup();
}
process.exit(interruptStatus ?? status);
