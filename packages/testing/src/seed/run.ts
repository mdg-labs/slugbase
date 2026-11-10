import { spawn } from "node:child_process";
import type { SeedConnection } from "./target.ts";

const PSQL_TIMEOUT_MS = 120_000;
const STDERR_LIMIT = 2_000;

export interface RunSeedScriptOptions {
  /** The PATH to find `psql` on. */
  readonly path: string;
  /** Values that must not appear in an error message, besides the password of the connection. */
  readonly secrets?: readonly string[];
  /** How long psql may run; the default is two minutes. */
  readonly timeoutMs?: number;
  /** Ends psql, and so the script's transaction, when it aborts; the promise then rejects once psql has gone. */
  readonly signal?: AbortSignal;
  /** Resolves with what the script printed, as unaligned rows without headers or footers, instead of with an empty string. */
  readonly capture?: boolean;
}

function psqlEnvironment(connection: SeedConnection, path: string, application: string): Record<string, string> {
  return {
    PATH: path,
    PGHOST: connection.host,
    PGPORT: String(connection.port),
    PGDATABASE: connection.database,
    PGUSER: connection.username,
    PGPASSWORD: connection.password,
    PGCLIENTENCODING: "UTF8",
    PGCONNECT_TIMEOUT: "10",
    PGAPPNAME: application,
  };
}

/**
 * A `psql` session that stays open and reads its script from its stdin, as unaligned rows without headers or footers, with the
 * environment of `runSeedScript`. The caller writes the script, reads the rows and ends the process.
 */
export function spawnPsql(connection: SeedConnection, options: { readonly path: string; readonly application: string }) {
  return spawn("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
    env: psqlEnvironment(connection, options.path, options.application),
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/**
 * Runs `script` with `psql` as `connection`. The child gets the connection and the PATH in its own environment and
 * nothing else of this process's, so no setting of the caller can send it to another server, and the password is on no
 * command line. A failure rejects with psql's own message, without the password or any of the `secrets`.
 */
export function runSeedScript(connection: SeedConnection, script: string, options: RunSeedScriptOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const capture = options.capture === true;
    const child = spawn("psql", ["-X", "-q", ...(capture ? ["-A", "-t"] : []), "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      env: psqlEnvironment(connection, options.path, "slugbase-seed"),
      stdio: ["pipe", "pipe", "pipe"],
      timeout: options.timeoutMs ?? PSQL_TIMEOUT_MS,
    });
    let stderr = "";
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (capture) {
        stdout += chunk;
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(0, STDERR_LIMIT);
    });
    child.on("error", (error) => {
      reject(new Error(`could not run psql (it must be on the PATH): ${error.message}`));
    });
    child.on("close", (code) => {
      if (options.signal?.aborted === true) {
        reject(new Error("the seed was interrupted"));
        return;
      }
      if (code === 0) {
        resolve(stdout);
        return;
      }
      let message = stderr.trim();
      for (const secret of [connection.password, ...(options.secrets ?? [])]) {
        if (secret !== "") {
          message = message.split(secret).join("***");
        }
      }
      reject(new Error(`psql exited with ${code === null ? "a signal" : `status ${String(code)}`}: ${message}`));
    });
    const abort = (): void => {
      child.kill("SIGTERM");
    };
    if (options.signal?.aborted === true) {
      abort();
    } else {
      options.signal?.addEventListener("abort", abort, { once: true });
      child.once("close", () => {
        options.signal?.removeEventListener("abort", abort);
      });
    }
    child.stdin.on("error", () => undefined);
    child.stdin.end(script);
  });
}
