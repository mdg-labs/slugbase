import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:os";
import { createRequire } from "node:module";
import { runSequence } from "./support/run-sequence.ts";

// `pnpm test:e2e -- --grep <title>` reaches the script as `-- --grep <title>`,
// and Playwright reads everything after a `--` as a file filter. The separator
// is dropped here so that its options work as they do on its own command line.
//
// Without arguments the journeys run first, then the backup and restore drill
// (restore-drill.spec.ts) and the reverse proxy drill (reverse-proxy.spec.ts), which each start a
// stack of their own. With arguments only the journeys run, with Playwright's own options, unless
// the first one is `restore-drill` or `reverse-proxy`, which runs only that drill:
// `pnpm test:e2e restore-drill`. The drills need docker on the machine, so a run in the
// Playwright image (e2e/in-image.sh) leaves them to a run on the host. The upgrade drill
// (upgrade-drill.spec.ts) runs only when named, `pnpm test:e2e upgrade-drill`: it pulls the
// published release candidate image and needs the image of the commit under test and its
// commit, SLUGBASE_IMAGE and BUILD_COMMIT, as the `upgrade-drill` job of e2e.yml sets them.
// The no-egress drill (no-egress.spec.ts) runs only when named too, `pnpm test:e2e no-egress`: it idles for
// minutes by design and needs the image of the commit under test, SLUGBASE_IMAGE, as the `no-egress` job of e2e.yml sets it.
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

process.exit(
  await runSequence({
    forwarded,
    inImage: process.env.E2E_IN_IMAGE === "1",
    run: playwright,
    interrupted: () => interrupted,
    note: (message) => process.stderr.write(message),
  }),
);
