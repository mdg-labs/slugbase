/// <reference types="node" />
import "@slugbase/adapters";
import "@slugbase/contracts";
import "@slugbase/core";
import "@slugbase/db";
import "@slugbase/email";
import { ConfigError, PROCESS_TYPES, isProcessType, loadConfig } from "@slugbase/server";

// The process type is the command of the one image (doc 01 section 3): the
// configuration of that type is validated before anything else starts, and an
// invalid environment exits non-zero naming the keys, never their values.

function log(level: "info" | "warn" | "error", message: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ level, msg: message, ...fields })}\n`);
}

function start(): void {
  const command = process.argv[2] ?? "server";
  if (!isProcessType(command)) {
    log("error", `Unknown command; use one of ${PROCESS_TYPES.join(", ")}`);
    process.exitCode = 2;
    return;
  }

  try {
    const { warnings } = loadConfig(command, process.env);
    for (const warning of warnings) {
      log("warn", warning);
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      log("error", error.message, { keys: error.issues.map((issue) => issue.key) });
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  log("info", "Configuration loaded", { process: command });
}

start();
