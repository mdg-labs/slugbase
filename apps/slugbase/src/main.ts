import "@slugbase/adapters";
import "@slugbase/contracts";
import { unconfigured } from "@slugbase/core";
import "@slugbase/db";
import "@slugbase/email";
import {
  ConfigError,
  PROCESS_TYPES,
  createServer,
  isProcessType,
  loadConfig,
  type Logger,
  type ServerConfig,
} from "@slugbase/server";

// The process type is the command of the one image (doc 01 section 3): the
// configuration of that type is validated before anything else starts, and an
// invalid environment exits non-zero naming the keys, never their values.

type Level = "info" | "warn" | "error";

function log(level: Level, message: string, fields: Readonly<Record<string, unknown>> = {}): void {
  process.stderr.write(`${JSON.stringify({ level, msg: message, ...fields })}\n`);
}

const logger: Logger = {
  info: (message, fields) => {
    log("info", message, fields);
  },
  warn: (message, fields) => {
    log("warn", message, fields);
  },
  error: (message, fields) => {
    log("error", message, fields);
  },
};

const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT"] as const;

// CE composes the unconfigured defaults of every port and no extra modules or
// migration sets; a configured adapter replaces its default here.
async function runServer(config: ServerConfig): Promise<void> {
  const server = createServer({
    config,
    adapters: unconfigured(),
    modules: [],
    migrations: [],
    logger,
  });
  const running = await server.start();

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

async function start(): Promise<void> {
  const command = process.argv[2] ?? "server";
  if (!isProcessType(command)) {
    log("error", `Unknown command; use one of ${PROCESS_TYPES.join(", ")}`);
    process.exitCode = 2;
    return;
  }

  let serverConfig: ServerConfig | undefined;
  let warnings: readonly string[];
  try {
    if (command === "server") {
      const loaded = loadConfig("server", process.env);
      serverConfig = loaded.config;
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

  if (serverConfig !== undefined) {
    try {
      await runServer(serverConfig);
    } catch (error) {
      log("error", error instanceof Error ? error.message : "The server failed to start", {
        code: (error as { code?: unknown }).code,
      });
      process.exitCode = 1;
    }
  }
}

await start();
