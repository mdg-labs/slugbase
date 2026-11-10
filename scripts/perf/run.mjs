// The performance budgets of doc 08 section 5.3, measured: a database made by the test harness is filled with the large
// instance (50 000 bookmarks in one workspace, 2 000 further workspaces), the server runs against it on this machine, and k6
// (scripts/perf/scenarios.js) signs in and drives /go, the bookmark list (with no text, narrowed by a text and under a filter)
// and search. The server is the CE image given by --image (started with `server`, as the nightly job does) or, without it, the
// built `apps/slugbase/dist/main.js server`. Before the budgets, 10 000 requests for one forwarding slug check that /go does not
// become write load (doc 01 section 8.1). After them, in a k6 run of its own so that what it adds changes none of their measurements, one member imports the largest
// Netscape file and the largest SlugBase JSON file into the large workspace, as many times back to back as budgets.js IMPORT_PHASE says (a file of its own for each), while /go and the list are requested and another member
// creates bookmarks: the p95 of /go and of the list while an import is in flight are budgets (ratios to the same run's steady /go and list, judged here, budgets.js), and each import's duration and counts and the p95 of the creates with and without an import are reported (doc 02 section 13.1).
// Everything this run starts, the server or its container, the k6 containers, the state of the import and the database, is removed however it ends.
//
//   node scripts/perf/run.mjs [--image <ref>] [--commit <sha>] [--out <dir>] [--bookmarks <n>] [--workspaces <n>] [--rate <per second>] [--duration <seconds>] [--import-window <seconds>] [--import-repeats <most pairs>] [--import-rate <per second>]
//
// Needs `pnpm turbo run build --filter=slugbase --filter=@slugbase/testing` first (`--filter=@slugbase/testing` alone with --image),
// `psql` and Docker (k6 runs from a pinned image on the host network, as does the server image), and the server the test harness
// uses: SLUGBASE_TEST_PG_URL, the development Postgres of compose.dev.yml when unset. Exit status: 0 when every budget holds and
// the write load is within its limit, 10 when one is exceeded (a regression, not a failure of the run),
// 128 + n when a SIGINT, SIGTERM or SIGHUP (signal number n) interrupts the run, after it drops the database, stops the server and removes the k6 containers, 1 when the run failed in any other way.
// `result.json` names the commit that was measured: --commit, or the HEAD of this checkout, or null when neither is known. scripts/perf/report.mjs files
// what a result exceeds.
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { constants, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  CREATE_PHASES,
  CREATE_RATE,
  CREATES_DROPPED_METRIC,
  FLUSH_INTERVAL_SECONDS,
  GO_HOT_METRIC,
  GO_HOT_REQUESTS,
  IMPORT_PHASE,
  IMPORT_SCENARIOS,
  IMPORT_STATES,
  MAX_VUS,
  STEADY_SCENARIOS,
  budgets as budgetList,
  createMetrics,
  importSampleShortfalls,
  judgeRatios,
  loadMetrics,
  writeLoadLimit,
} from "./budgets.js";

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
// The seconds the load of the import run lasts from the start of the first import, which the last import must end within.
const DEFAULT_IMPORT_WINDOW_SECONDS = String(IMPORT_PHASE.windowSeconds);

// Run as a script, not when a test imports `evaluate`: nothing below that reads the command line, makes a directory or takes a signal happens then.
const isMain = process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

const { values: args } = isMain
  ? parseArgs({
      options: {
        image: { type: "string" },
        commit: { type: "string" },
        out: { type: "string" },
        bookmarks: { type: "string" },
        workspaces: { type: "string" },
        rate: { type: "string", default: "40" },
        duration: { type: "string", default: "30" },
        "import-window": { type: "string", default: DEFAULT_IMPORT_WINDOW_SECONDS },
        "import-repeats": { type: "string" },
        "import-rate": { type: "string" },
      },
    })
  : { values: {} };
// The image reference goes to `docker run` as an argument, so it may not read as an option of it.
if (isMain && args.image !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(args.image)) {
  process.stderr.write("perf: --image takes an image reference such as slugbase:perf\n");
  process.exit(1);
}
if (isMain && !/^[1-9][0-9]{0,3}$/.test(args["import-window"])) {
  process.stderr.write("perf: --import-window takes a number of seconds, 1 to 9999\n");
  process.exit(1);
}
if (isMain && args["import-repeats"] !== undefined && !/^[1-9][0-9]{0,2}$/.test(args["import-repeats"])) {
  process.stderr.write("perf: --import-repeats takes a number of pairs of imports, 1 to 999\n");
  process.exit(1);
}
if (isMain && args["import-rate"] !== undefined && !/^[1-9][0-9]{0,3}$/.test(args["import-rate"])) {
  process.stderr.write("perf: --import-rate takes a number of requests a second, 1 to 9999\n");
  process.exit(1);
}
// A run with another number of repeats or another rate for the import phase is a trial of the scripts: the sample the phase must have (budgets.js IMPORT_PHASE) is the one of the phase as committed, at the rate it was sized for, and is not held to a run that changed either.
const importMaxRepeats = Number(args["import-repeats"] ?? IMPORT_PHASE.maxRepeats);
const importRate = Number(args["import-rate"] ?? IMPORT_PHASE.rate);
const importTrial = importMaxRepeats !== IMPORT_PHASE.maxRepeats || importRate !== IMPORT_PHASE.rate;
// The commit is written into the result and from there into an issue, so it is a full hash and nothing else.
if (isMain && args.commit !== undefined && !/^[0-9a-f]{40}$/.test(args.commit)) {
  process.stderr.write("perf: --commit takes a full commit hash of 40 hex digits\n");
  process.exit(1);
}
// Where the k6 summary and the result are written; a directory of its own under the temporary directory unless one is given.
const outDir = !isMain ? undefined : args.out === undefined ? mkdtempSync(join(tmpdir(), "slugbase-perf-results-")) : resolve(args.out);

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
for (const signal of isMain ? ["SIGINT", "SIGTERM", "SIGHUP"] : []) {
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

// What a scenario's load did, from the sub-metrics budgets.js names. k6 1.3.0 writes a sub-metric that a threshold names and that has no sample as zeros and does not leave it out:
// `dropped_iterations` of a scenario that dropped no arrival is `"count": 0`, and the p(95) of a shape that was never requested is `"p(95)": 0`. So a count of 0 is a real 0 only
// for the dropped arrivals; a missing entry of any of the three is an error, and so is a scenario that made no request, whose p(95) would read as 0 ms and be ok. A scenario is
// saturated when it dropped an arrival or used every VU it may: then the time of its requests includes the wait for a server that could not keep up, and a p95 is not the time of a statement.
// `active_vus` is the VUs active in the whole k6 run, which is the scenario's own only when it runs alone (the budgets run); `vus` says how many VUs the run may use, and so what the peak is of.
function loadOf(summary, scenario, vus) {
  const metrics = loadMetrics(scenario);
  const completed = summary.metrics[metrics.completed]?.count;
  const peakVus = summary.metrics[metrics.activeVus]?.max;
  const dropped = summary.metrics[metrics.dropped]?.count;
  if (!isNumber(completed) || !isNumber(peakVus) || !isNumber(dropped)) {
    throw new Error(`k6 reported no requests, dropped arrivals or VUs for the scenario ${scenario}`);
  }
  if (completed < 1) {
    throw new Error(`the scenario ${scenario} made no request, so it measured nothing`);
  }
  return { completed, dropped, peakVus, maxVus: vus.capacity, vusOf: vus.of, saturated: dropped > 0 || peakVus >= vus.capacity };
}

// The count of the requests behind a budget's p(95): the `http_reqs` sub-metric of the same tags as its `http_req_waiting` one. k6 writes a p(95) of 0 for a shape with no request.
const requestsMetric = (metric) => metric.replace(/^http_req_waiting/u, "http_reqs");

// The scenarios of one k6 run and the budgets on them, from its summary. A budget whose shape had no request has no p(95) to report and fails the run, naming each such shape.
function evaluate(summary, ids, vus = { capacity: MAX_VUS, of: "scenario" }) {
  const scenarios = Object.fromEntries(ids.map((scenario) => [scenario, loadOf(summary, scenario, vus)]));
  const unrequested = [];
  const rows = budgetList(ids).map(({ name, scenario, metric, limitMs, limitRatio, of }) => {
    const requests = summary.metrics[requestsMetric(metric)]?.count;
    const p95 = summary.metrics[metric]?.["p(95)"];
    if (!isNumber(requests) || !isNumber(p95)) {
      throw new Error(`k6 reported no request count or p(95) for ${metric}`);
    }
    if (requests < 1) {
      unrequested.push(name);
    }
    const p95Ms = Math.round(p95 * 100) / 100;
    // A ratio budget (budgets.js RATIO_BUDGETS) is judged against the p95 of another k6 run, so `judgeRatios` does it once both are known; until then its row holds only what this run measured.
    if (limitRatio !== undefined) {
      return { name, scenario, metric, of, limitRatio, p95Ms, ok: true, saturated: scenarios[scenario].saturated };
    }
    return { name, scenario, metric, limitMs, p95Ms, ok: p95 < limitMs, saturated: scenarios[scenario].saturated };
  });
  if (unrequested.length > 0) {
    throw new Error(`no request was made for ${unrequested.map((name) => `"${name}"`).join(", ")}, so its p(95) is not a measurement (k6 writes 0 for it); the scenario needs at least as many arrivals (rate x duration) as it has shapes`);
  }
  return { budgets: rows, scenarios };
}

// The commit measured: the one given, or the HEAD of the checkout the run is in, or null (a copy of the sources that is not a checkout).
async function measuredCommit() {
  if (args.commit !== undefined) {
    return args.commit;
  }
  try {
    const { status, stdout } = await capture("git", ["rev-parse", "HEAD"], { cwd: ROOT });
    const hash = stdout.trim();
    return status === 0 && /^[0-9a-f]{40}$/.test(hash) ? hash : null;
  } catch {
    // no git on the machine
    return null;
  }
}

async function main() {
  const { preparePerfInstance, buildImportFiles } = await import(join(ROOT, "packages/testing/dist/seed/index.js"));
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

  await installQueues({ serverUrl, instance });

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
    // The import phase: two imports (the bulk bucket allows 20 an hour) and the creates beside them (the write bucket).
    RATE_LIMIT_BULK_IP: UNLIMITED,
    RATE_LIMIT_BULK_ACCOUNT: UNLIMITED,
    RATE_LIMIT_WRITE_IP: UNLIMITED,
    RATE_LIMIT_WRITE_ACCOUNT: UNLIMITED,
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
  const steady = evaluate(JSON.parse(readFileSync(join(outDir, "k6-summary.json"), "utf8")), STEADY_SCENARIOS);
  // Last, so that the bookmarks the imports add change none of the measurements above.
  const importRun = await measureImports({ k6Run, work, instance, deepPage, buildImportFiles, serverLog });
  const scenarios = { ...steady.scenarios, ...importRun.scenarios };
  // The import phase's budgets are ratios to the steady scenarios of this same run: judged here, where both runs' p95 are known, and not by k6 (budgets.js budgetThresholds).
  const budgets = judgeRatios([...steady.budgets, ...importRun.budgets], scenarios);
  // A status of 99 that no budget explains is a check that failed: a response that was not what a scenario asked for.
  const failedChecks = (k6 === 99 && steady.budgets.every((budget) => budget.ok)) || (importRun.status === 99 && importRun.budgets.every((budget) => budget.ok));
  const result = {
    commit: await measuredCommit(),
    database: instance.counts,
    rate: Number(args.rate),
    durationSeconds: Number(args.duration),
    k6Image: K6_IMAGE,
    server: args.image ?? "apps/slugbase/dist/main.js",
    scenarios,
    budgets,
    writeLoad,
    importPhase: importRun.phase,
    k6Status: k6,
  };
  writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  log(`commit measured: ${result.commit ?? "unknown"}`);
  log(
    [
      "load of each scenario:",
      ...Object.keys(scenarios).map((name) => {
        const load = scenarios[name];
        return `  ${name}: ${String(load.completed)} requests completed, ${String(load.dropped)} arrivals dropped, at most ${String(load.peakVus)} of ${String(load.maxVus)} VUs active${load.vusOf === "run" ? " in the run" : ""}${load.saturated ? ", SATURATED" : ""}`;
      }),
    ].join("\n"),
  );
  log(
    [
      "budgets (p95 of the server time, k6 http_req_waiting):",
      ...budgets.map((b) =>
        b.limitRatio === undefined
          ? `  ${b.name}: ${String(b.p95Ms)} ms, budget ${String(b.limitMs)} ms, ${b.ok ? "ok" : "EXCEEDED"}${b.saturated ? " (the scenario was saturated: the time includes the queue)" : ""}`
          : `  ${b.name}: ${String(b.p95Ms)} ms against ${String(b.baselineP95Ms)} ms of ${b.of} in this run, ${b.saturatedMiss !== undefined ? `EXCEEDED, SATURATED (${b.ratio === null ? "no ratio" : `ratio ${String(b.ratio)}`}, limit ${String(b.limitRatio)}): ${b.saturatedMiss}` : b.judged ? `ratio ${String(b.ratio)}, limit ${String(b.limitRatio)}, ${b.ok ? "ok" : "EXCEEDED"}` : `NOT JUDGED (limit ${String(b.limitRatio)}): ${b.notJudged ?? ""}`}`,
      ),
    ].join("\n"),
  );
  log(
    [
      `import phase (no budget of its own; ${String(importRun.phase.repeats)} pairs of imports, ${String(importRun.phase.importCount)} in all, and the creates beside them): ${String(importRun.phase.inFlightSeconds)} s with an import in flight (at least ${String(importRun.sample.minSeconds)} s), /go and list at ${String(importRun.phase.rate)} a second for ${String(importRun.phase.windowSeconds)} s,` +
        ` ${Object.entries(importRun.phase.requests).map(([scenario, count]) => `${scenario} ${String(count)} requests`).join(", ")} (at least ${String(importRun.sample.minRequests)} each)${importRun.sample.enforced ? "" : "; a trial run, so that sample is not enforced"}`,
      ...importRun.phase.imports.map(
        (i) =>
          `  ${i.import} ${String(i.repeat)}: ${String(i.bytes)} bytes in ${String(i.durationMs)} ms, created ${String(i.created)}, skipped ${String(i.skipped)}, failed ${String(i.failed)}, slugs dropped ${String(i.slugsDropped)} (${String(i.slugsDroppedConflict)} taken, ${String(i.slugsDroppedInvalid)} invalid), folders created ${String(i.foldersCreated)}, tags created ${String(i.tagsCreated)}`,
      ),
      ...CREATE_PHASES.map((phase) => `  creates ${phase} an import: p95 ${String(importRun.phase.creates[phase].p95Ms)} ms over ${String(importRun.phase.creates[phase].completed)} requests`),
      `  creates dropped (every VU busy): ${String(importRun.phase.creates.dropped)}`,
    ].join("\n"),
  );
  if (failedChecks) {
    throw new Error("a response was not what a scenario asked for; see the k6 output above");
  }
  // The result is written, so the run can be read, but the ratios of a phase with too few requests are not a measurement of what an import costs /go and the list: it is a failed run, not a budget, and it names the way out.
  if (importRun.sample.enforced && importRun.sample.shortfalls.length > 0) {
    throw new Error(`the import phase is too short to judge its ratios (${importRun.sample.shortfalls.join("; ")}); raise IMPORT_PHASE.maxRepeats (or its targetSeconds) in scripts/perf/budgets.js`);
  }
  return budgets.every((budget) => budget.ok) && writeLoad.ok && k6 === 0 && importRun.status === 0 ? 0 : REGRESSION;
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

// The database of the harness has the schema and not the pg-boss queues that `migrate` installs, and a create or an import enqueues its events (a request to a queue that does not exist is
// answered 500). The CE image does this on every start (docker-entrypoint.sh runs `migrate` before the server), so it is done here, once and before the server starts, with the same command: as
// the harness's own role for the database, which the harness uses for the same purpose. The connection string goes to the command by name, not in its arguments.
async function installQueues({ serverUrl, instance }) {
  const url = new URL(serverUrl);
  url.pathname = `/${instance.databaseName}`;
  const environment = { NODE_ENV: "development", LOG_LEVEL: "warn", DATABASE_MIGRATE_URL: url.toString() };
  let status;
  if (args.image === undefined) {
    status = await run(process.execPath, [join(ROOT, "apps/slugbase/dist/main.js"), "migrate"], { cwd: join(ROOT, "apps/slugbase"), env: { PATH: process.env.PATH ?? "", ...environment } });
  } else {
    const container = `slugbase-perf-migrate-${randomBytes(4).toString("hex")}`;
    cleanups.push(async () => {
      await run("docker", ["rm", "--force", container], { stdio: "ignore" });
    });
    status = await run("docker", ["run", "--rm", "--name", container, "--network", "host", ...Object.keys(environment).flatMap((name) => ["-e", name]), args.image, "migrate"], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/", ...environment },
    });
  }
  if (status !== 0) {
    throw new Error(`migrate ended with status ${String(status)}, so the queues of pg-boss are not installed`);
  }
}

// The state of the import for the k6 VUs, which cannot share a variable (budgets.js IMPORT_STATES): a server on the loopback address that holds it and the answers of the imports. `GET /`
// answers the state; `POST /` sets it, and an import's answer with it. It lives as long as the run.
async function startImportState() {
  const held = { state: "before", imports: [] };
  const server = createHttpServer((request, response) => {
    const reply = (status, body) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method === "GET") {
      reply(200, { state: held.state });
      return;
    }
    if (request.method !== "POST") {
      reply(405, {});
      return;
    }
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 65_536) {
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!IMPORT_STATES.includes(body.state)) {
          throw new Error("not a state");
        }
        held.state = body.state;
        if (body.result !== undefined) {
          held.imports.push(body.result);
        }
        reply(200, {});
      } catch {
        reply(400, {});
      }
    });
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise((resolveClose) => {
      server.close(resolveClose);
    });
  });
  return { port: server.address().port, held };
}

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

// The answers of the imports (a Netscape file and a JSON file for each repeat), judged: each must be what the file asked for. An import answered with anything but the success of the whole file (an error status, a replay of an
// earlier answer, bookmarks skipped or refused, fewer created than the file holds) is not the import this phase means to measure, and a time taken for it is not reported.
function judgeImports(imports, files) {
  // Each repeat imports its Netscape file and then its JSON file, in that order.
  const wanted = files.flatMap((pair, repeat) => [
    ["netscape", pair.netscape, repeat],
    ["json", pair.json, repeat],
  ]);
  if (imports.length !== wanted.length) {
    throw new Error(`${String(imports.length)} imports answered, not ${String(wanted.length)}`);
  }
  return wanted.map(([name, file, repeat], index) => {
    const answered = imports[index];
    const fail = (why) => new Error(`the ${name} import of repeat ${String(repeat)} ${why}: ${JSON.stringify(answered)}`);
    if (answered?.import !== name || answered.repeat !== repeat || answered.status !== 200 || answered.replayed !== false) {
      throw fail("was not answered with its own success");
    }
    for (const key of ["bytes", "durationMs", "inFlightMs", "created", "skipped", "failed", "slugsDropped", "slugsDroppedInvalid", "slugsDroppedConflict", "foldersCreated", "tagsCreated"]) {
      if (!isNumber(answered[key]) || answered[key] < 0) {
        throw fail(`has no number ${key}`);
      }
    }
    if (answered.durationMs <= 0 || answered.detected?.bookmarks !== file.bookmarks || answered.created !== file.bookmarks || answered.skipped !== 0 || answered.failed !== 0) {
      throw fail(`did not create the ${String(file.bookmarks)} bookmarks of its file`);
    }
    if (answered.slugsDropped !== answered.slugsDroppedInvalid + answered.slugsDroppedConflict || (name === "json") !== (answered.slugsDropped > 0)) {
      throw fail(name === "json" ? "dropped no slug, so the slugs it asks for do not collide" : "dropped a slug of a file that has none");
    }
    return { import: name, repeat, bytes: file.bytes, bookmarks: file.bookmarks, status: 200, durationMs: answered.durationMs, inFlightMs: answered.inFlightMs, created: answered.created, skipped: answered.skipped, failed: answered.failed, slugsDropped: answered.slugsDropped, slugsDroppedInvalid: answered.slugsDroppedInvalid, slugsDroppedConflict: answered.slugsDroppedConflict, foldersCreated: answered.foldersCreated, tagsCreated: answered.tagsCreated };
  });
}

// The p95 of the creates in each phase, their number and the arrivals dropped. A phase with no create has no p95, which is an error and not a 0. The dropped arrivals have an entry
// of their own (`"count": 0` when none was dropped, budgets.js), so a missing entry is an error too, as in `loadOf`, and never a 0.
function createsOf(summary) {
  const creates = {};
  for (const phase of CREATE_PHASES) {
    const { p95, completed } = createMetrics(phase);
    const value = summary.metrics[p95]?.["p(95)"];
    const count = summary.metrics[completed]?.count;
    if (!isNumber(value) || !isNumber(count) || count < 1) {
      throw new Error(`k6 reported no creates in the phase ${phase}`);
    }
    creates[phase] = { p95Ms: Math.round(value * 100) / 100, completed: count };
  }
  const dropped = summary.metrics[CREATES_DROPPED_METRIC]?.count;
  if (!isNumber(dropped)) {
    throw new Error("k6 reported no dropped arrivals for the creates");
  }
  return { ...creates, rate: CREATE_RATE, dropped };
}

// The import phase: perf-member-1 imports the largest Netscape file and the largest JSON file, one after the other, while the admin's /go and list traffic goes on at the run's rate and
// perf-member-2 creates bookmarks (scripts/perf/scenarios.js). The files are made here and handed to k6 as files. The /go and list requests made while an import is in flight are budgets (ratios to the steady ones of the run); the
// imports' own numbers and the creates' are reported.
async function measureImports({ k6Run, work, instance, deepPage, buildImportFiles, serverLog }) {
  const { collidingSlugs, slugs } = instance.instance.fixtures;
  // One pair of files for each repeat (import-files.ts): the files of a repeat name addresses, slugs, folders and tags of their own, so every repeat creates all of its bookmarks and does the work of the first.
  // They are made one at a time and only written, so that the run holds one pair in memory.
  const files = [];
  for (let repeat = 0; repeat < importMaxRepeats; repeat += 1) {
    const pair = buildImportFiles({ collidingSlugs: [...collidingSlugs, ...slugs], repeat });
    writeFileSync(join(work, "data", `import-netscape-${String(repeat)}.html`), pair.netscape.body);
    writeFileSync(join(work, "data", `import-${String(repeat)}.json`), pair.json.body);
    files.push({ netscape: { bytes: pair.netscape.bytes, bookmarks: pair.netscape.bookmarks }, json: { bytes: pair.json.bytes, bookmarks: pair.json.bookmarks } });
  }
  const { port, held } = await startImportState();
  const status = await k6Run("import", "import", {
    RATE: args.rate,
    DURATION_SECONDS: args.duration,
    DEEP_PAGE: String(deepPage),
    IMPORT_WINDOW_SECONDS: args["import-window"],
    IMPORT_REPEATS: String(importMaxRepeats),
    IMPORT_TARGET_SECONDS: String(IMPORT_PHASE.targetSeconds),
    IMPORT_RATE: String(importRate),
    SIGNAL_URL: `http://127.0.0.1:${String(port)}/`,
  });
  if (status !== 0 && status !== 99) {
    process.stderr.write(`perf: server log:\n${readFileSync(serverLog, "utf8").slice(-4000)}\n`);
    throw new Error(`the import run ended with k6 status ${String(status)} (the state of the import is ${held.state}${held.state === "failed" ? `: ${JSON.stringify(held.imports.at(-1))}` : ""})`);
  }
  if (held.state !== "after") {
    throw new Error(`the import run ended with the import in the state ${held.state}, not after`);
  }
  // The importer stops after the pair that took the time in flight to the target, or at the last pair there is a file for: so the imports are whole pairs, from the first, and no more than the files.
  if (held.imports.length % 2 !== 0 || held.imports.length < 2 || held.imports.length > files.length * 2) {
    throw new Error(`${String(held.imports.length)} imports answered, not whole pairs of at most ${String(files.length)}`);
  }
  const imports = judgeImports(held.imports, files.slice(0, held.imports.length / 2));
  const summary = JSON.parse(readFileSync(join(outDir, summaryFile("import")), "utf8"));
  // The creates, /go, the list and the importer run at the same time, and `active_vus` counts them all: the peak is of the run and not of one scenario, against the VUs the run may use.
  const { budgets, scenarios } = evaluate(summary, IMPORT_SCENARIOS, { capacity: MAX_VUS * (IMPORT_SCENARIOS.length + 1) + 1, of: "run" });
  // The sample the ratios are judged on: the time an import was in flight (summed over the imports, which do not overlap) and the requests made in it, held to the phase's minimum unless this run is a trial.
  const inFlightSeconds = Math.round(imports.reduce((sum, i) => sum + i.inFlightMs, 0) / 100) / 10;
  const requests = Object.fromEntries(IMPORT_SCENARIOS.map((scenario) => [scenario, scenarios[scenario].completed]));
  const shortfalls = importSampleShortfalls({ inFlightSeconds, completed: requests });
  const sample = { minSeconds: IMPORT_PHASE.minSeconds, minRequests: IMPORT_PHASE.minRequests, enforced: !importTrial, shortfalls };
  return {
    status,
    budgets,
    scenarios,
    sample,
    phase: { windowSeconds: Number(args["import-window"]), maxRepeats: importMaxRepeats, repeats: imports.length / 2, importCount: imports.length, targetSeconds: IMPORT_PHASE.targetSeconds, rate: importRate, inFlightSeconds, requests, sample, k6Status: status, imports, creates: createsOf(summary) },
  };
}

export { createsOf, evaluate, loadOf };

if (isMain) {
  let status = 1;
  try {
    status = await main();
  } catch (error) {
    process.stderr.write(`perf: ${error instanceof Error ? error.message : "failed"}\n`);
  } finally {
    await cleanup();
  }
  process.exit(interruptStatus ?? status);
}
