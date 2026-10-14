import { spawn } from "node:child_process";
import { constants } from "node:os";
import { createRequire } from "node:module";

// `pnpm test:e2e -- --grep <title>` reaches the script as `-- --grep <title>`,
// and Playwright reads everything after a `--` as a file filter. The separator
// is dropped here so that its options work as they do on its own command line.
const args = process.argv.slice(2);
const forwarded = args[0] === "--" ? args.slice(1) : args;

const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");
const child = spawn(process.execPath, [cli, "test", ...forwarded], { stdio: "inherit" });

// An interrupt or a termination of this process is the child's too; the child
// ends with its signal and the exit status below is 128 plus its number.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on("error", (error) => {
  process.stderr.write(`could not start Playwright: ${error.message}\n`);
  process.exit(1);
});

child.on("close", (code, signal) => {
  process.exit(code ?? (signal === null ? 1 : 128 + constants.signals[signal]));
});
