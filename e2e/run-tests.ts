import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:os";
import { createRequire } from "node:module";

// `pnpm test:e2e -- --grep <title>` reaches the script as `-- --grep <title>`,
// and Playwright reads everything after a `--` as a file filter. The separator
// is dropped here so that its options work as they do on its own command line.
//
// Without arguments the journeys run first, then the backup and restore drill
// (restore-drill.spec.ts), which starts a stack of its own. With arguments only the
// journeys run, with Playwright's own options, unless the first one is `restore-drill`,
// which runs only the drill: `pnpm test:e2e restore-drill`. The drill needs docker on the
// machine, so a run in the Playwright image (e2e/in-image.sh) leaves it to a run on the host.
const args = process.argv.slice(2);
const forwarded = args[0] === "--" ? args.slice(1) : args;

const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");

let current: ChildProcess | undefined;
let interrupted = false;

// An interrupt or a termination of this process is the child's too; the child
// ends with its signal and the exit status below is 128 plus its number.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    interrupted = true;
    current?.kill(signal);
  });
}

/** Runs Playwright with the arguments and resolves with the exit status it ended with. */
function playwright(playwrightArgs: readonly string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, "test", ...playwrightArgs], { stdio: "inherit" });
    current = child;
    child.on("error", (error) => {
      process.stderr.write(`could not start Playwright: ${error.message}\n`);
      resolve(1);
    });
    child.on("close", (code, signal) => {
      resolve(code ?? (signal === null ? 1 : 128 + constants.signals[signal]));
    });
  });
}

const DRILL = ["--config", "restore-drill.config.ts"];

async function main(): Promise<number> {
  if (forwarded[0] === "restore-drill") {
    return playwright([...DRILL, ...forwarded.slice(1)]);
  }
  const journeys = await playwright(forwarded);
  if (forwarded.length > 0 || interrupted) {
    return journeys;
  }
  if (process.env.E2E_IN_IMAGE === "1") {
    process.stderr.write("the restore drill needs docker and is not run in the Playwright image; run `pnpm test:e2e restore-drill` on the host\n");
    return journeys;
  }
  // The drill runs even when a journey failed, so that one run reports both.
  const drill = await playwright(DRILL);
  return journeys !== 0 ? journeys : drill;
}

process.exit(await main());
