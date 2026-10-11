import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Timeout, in milliseconds, for a test that starts a child process or lints with
 * the repository config. A cold `node` start plus ESLint or vitest takes several
 * seconds on a two-core CI runner that turbo shares with other packages' suites,
 * well past vitest's 5 s default.
 */
export const SUBPROCESS_TIMEOUT_MS = 60_000;

export function run(binScript: string, args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [resolve(ROOT, "node_modules", binScript), ...args], {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
