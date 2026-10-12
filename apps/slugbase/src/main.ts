import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import "@slugbase/adapters";
import "@slugbase/contracts";
import { unconfigured } from "@slugbase/core";
import "@slugbase/db";
import "@slugbase/email";
import {
  ConfigError,
  PROCESS_TYPES,
  createLogger,
  createServer,
  createWorker,
  isProcessType,
  loadBuildInfo,
  loadConfig,
  type Logger,
  type ServerConfig,
  type WorkerConfig,
} from "@slugbase/server";

// The process type is the command of the one image (doc 01 section 3): the
// configuration of that type is validated before anything else starts, and an
// invalid environment exits non-zero naming the keys, never their values. Until
// the configuration is valid there is no log level, so those lines are written
// by hand; the running server logs through pino at `LOG_LEVEL`.

type Level = "info" | "warn" | "error";

function log(level: Level, message: string, fields: Readonly<Record<string, unknown>> = {}): void {
  process.stderr.write(`${JSON.stringify({ level, msg: message, ...fields })}\n`);
}

const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT"] as const;

// Stops the process once on the first signal: `shutdown` lets in-flight work
// finish within its deadline and closes the pools.
function exitOnSignal(running: { shutdown(): Promise<void> }, logger: Logger): void {
  let stopping = false;
  for (const signal of SHUTDOWN_SIGNALS) {
    process.once(signal, () => {
      if (stopping) {
        return;
      }
      stopping = true;
      logger.info("Shutting down", { signal });
      running.shutdown().then(
        () => {
          logger.info("Shutdown complete");
          process.exit(0);
        },
        (error: unknown) => {
          logger.error("Shutdown failed", { error: error instanceof Error ? error.name : typeof error });
          process.exit(1);
        },
      );
    });
  }
}

// The image build writes the file next to src/ and dist/; a checkout without it is a development run.
const BUILD_INFO_FILE = new URL("../build-info.json", import.meta.url);

// The image build puts the built web app next to src/ and dist/ too. A checkout
// without a web build serves the API only; a directory that is there but broken
// refuses the start.
const WEB_ROOT = fileURLToPath(new URL("../web", import.meta.url));

// CE composes the unconfigured defaults of every port and no extra modules or
// migration sets; a configured adapter replaces its default here.
async function runServer(config: ServerConfig): Promise<void> {
  const logger = createLogger({ level: config.LOG_LEVEL });
  const serveWeb = existsSync(WEB_ROOT);
  if (!serveWeb) {
    logger.warn("There is no web build; only the API is served", { webRoot: WEB_ROOT });
  }
  const server = createServer({
    config,
    adapters: unconfigured(),
    modules: [],
    migrations: [],
    logger,
    buildInfo: loadBuildInfo(BUILD_INFO_FILE),
    ...(serveWeb ? { webRoot: WEB_ROOT } : {}),
  });
  exitOnSignal(await server.start(), logger);
}

// The worker registers the jobs and schedules of the same modules (doc 01
// section 3); CE has none yet. It never migrates: `migrate` installs the
// pg-boss schema before it starts.
async function runWorker(config: WorkerConfig): Promise<void> {
  const logger = createLogger({ level: config.LOG_LEVEL });
  const worker = createWorker({
    config,
    adapters: unconfigured(),
    modules: [],
    logger,
  });
  exitOnSignal(await worker.start(), logger);
}

async function start(): Promise<void> {
  const command = process.argv[2] ?? "server";
  if (!isProcessType(command)) {
    log("error", `Unknown command; use one of ${PROCESS_TYPES.join(", ")}`);
    process.exitCode = 2;
    return;
  }

  let serverConfig: ServerConfig | undefined;
  let workerConfig: WorkerConfig | undefined;
  let warnings: readonly string[];
  try {
    if (command === "server") {
      const loaded = loadConfig("server", process.env);
      serverConfig = loaded.config;
      warnings = loaded.warnings;
    } else if (command === "worker") {
      const loaded = loadConfig("worker", process.env);
      workerConfig = loaded.config;
      warnings = loaded.warnings;
    } else {
      warnings = loadConfig(command, process.env).warnings;
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      log("error", error.message, { keys: error.issues.map((issue) => issue.key) });
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  for (const warning of warnings) {
    log("warn", warning);
  }
  log("info", "Configuration loaded", { process: command });

  try {
    if (serverConfig !== undefined) {
      await runServer(serverConfig);
    } else if (workerConfig !== undefined) {
      await runWorker(workerConfig);
    }
  } catch (error) {
    log("error", error instanceof Error ? error.message : `The ${command} failed to start`, {
      code: (error as { code?: unknown }).code,
    });
    process.exitCode = 1;
  }
}

await start();
