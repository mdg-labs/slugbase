// The performance budgets of doc 08 section 5.3, measured: a database made by the test harness is filled with the large
// instance (50 000 bookmarks in one workspace, 2 000 further workspaces), the built server runs against it on this machine,
// and k6 (scripts/perf/scenarios.js) signs in and drives /go, the bookmark list and search. Everything this run starts, the
// server, the k6 container and the database, is removed however it ends.
//
//   node scripts/perf/run.mjs [--out <dir>] [--bookmarks <n>] [--workspaces <n>] [--rate <per second>] [--duration <seconds>]
//
// Needs `pnpm turbo run build --filter=slugbase --filter=@slugbase/testing` first, `psql` and Docker (k6 runs from a pinned image
// on the host network), and the server the test harness uses: SLUGBASE_TEST_PG_URL, the development Postgres of compose.dev.yml
// when unset. Exit status: 0 when every budget holds, 10 when one is exceeded (a regression, not a failure of the run), 1 when
// the run itself failed.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { constants, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

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
const BUDGETS = [
  { name: "go", metric: "http_req_waiting{kind:go}", limitMs: 30 },
  { name: "list", metric: "http_req_waiting{kind:list}", limitMs: 100 },
  { name: "search", metric: "http_req_waiting{kind:search}", limitMs: 100 },
];

const { values: args } = parseArgs({
  options: {
    out: { type: "string" },
    bookmarks: { type: "string" },
    workspaces: { type: "string" },
    rate: { type: "string", default: "40" },
    duration: { type: "string", default: "30" },
  },
});
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

async function waitReady(port, server) {
  const deadline = Date.now() + READY_SECONDS * 1000;
  while (Date.now() < deadline) {
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

function evaluate(summary) {
  return BUDGETS.map(({ name, metric, limitMs }) => {
    const p95 = summary.metrics[metric]?.["p(95)"];
    if (typeof p95 !== "number") {
      throw new Error(`k6 reported no p(95) for ${metric}`);
    }
    return { name, metric, limitMs, p95Ms: Math.round(p95 * 100) / 100, ok: p95 < limitMs };
  });
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
  const server = spawn(process.execPath, [join(ROOT, "apps/slugbase/dist/main.js"), "server"], {
    cwd: join(ROOT, "apps/slugbase"),
    // Only what the server reads, so nothing of the caller's environment decides where it connects.
    env: {
      PATH: process.env.PATH ?? "",
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
    },
    stdio: ["ignore", logFile, logFile],
  });
  closeSync(logFile);
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
  try {
    await waitReady(port, server);
  } catch (error) {
    process.stderr.write(`perf: server log:\n${readFileSync(serverLog, "utf8").slice(-4000)}\n`);
    throw error;
  }
  log(`the server is ready at ${origin}`);

  // The owner of the large workspace holds about eight in ten of its bookmarks; the deep page is at most the 400th of 48 and is
  // kept within the first half of the rows, so that a smaller instance has one too.
  const deepPage = Math.max(2, Math.min(400, Math.floor(((Number(args.bookmarks ?? 50_000) * 0.8) / 48) * 0.5)));
  const container = `slugbase-perf-k6-${randomBytes(4).toString("hex")}`;
  cleanups.push(async () => {
    await run("docker", ["rm", "--force", container], { stdio: "ignore" });
  });
  const user = `${String(process.getuid())}:${String(process.getgid())}`;
  const k6 = await run(
    "docker",
    [
      "run", "--rm", "--name", container, "--network", "host", "--user", user,
      "-v", `${join(ROOT, "scripts/perf")}:/scripts:ro`,
      "-v", `${join(work, "data")}:/data:ro`,
      "-v", `${outDir}:/out`,
      "-e", `BASE_URL=${origin}`, "-e", `APP_ORIGIN=${origin}`,
      "-e", `SLUGBASE_PERF_EMAIL=${instance.instance.fixtures.email}`,
      "-e", "SLUGBASE_PERF_PASSWORD",
      "-e", `RATE=${args.rate}`, "-e", `DURATION_SECONDS=${args.duration}`, "-e", `DEEP_PAGE=${String(deepPage)}`,
      K6_IMAGE, "run", "--quiet", "--summary-export", "/out/k6-summary.json", "/scripts/scenarios.js",
    ],
    { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/", SLUGBASE_PERF_PASSWORD: instance.password } },
  );
  if (interrupted) {
    throw new Error("interrupted");
  }
  // k6 ends with 99 when a threshold is crossed; its summary is written either way.
  if (k6 !== 0 && k6 !== 99) {
    throw new Error(`k6 ended with status ${String(k6)}`);
  }
  const budgets = evaluate(JSON.parse(readFileSync(join(outDir, "k6-summary.json"), "utf8")));
  const failedChecks = k6 === 99 && budgets.every((budget) => budget.ok);
  const result = { database: instance.counts, rate: Number(args.rate), durationSeconds: Number(args.duration), image: K6_IMAGE, budgets, k6Status: k6 };
  writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  log(["budgets (p95 of the server time, k6 http_req_waiting):", ...budgets.map((b) => `  ${b.name}: ${String(b.p95Ms)} ms, budget ${String(b.limitMs)} ms, ${b.ok ? "ok" : "EXCEEDED"}`)].join("\n"));
  if (failedChecks) {
    throw new Error("a response was not what a scenario asked for; see the k6 output above");
  }
  return budgets.every((budget) => budget.ok) && k6 === 0 ? 0 : REGRESSION;
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
