import { resolve } from "node:path";
import { checkDocs, formatViolation } from "./check.ts";

// `pnpm docs:check` checks this repository; the optional argument names another
// repository root, which the tests use for their fixtures.
const repoRoot = process.argv[2] === undefined ? resolve(import.meta.dirname, "../..") : resolve(process.argv[2]);

try {
  const { violations, pages } = checkDocs(repoRoot);
  if (violations.length > 0) {
    process.stderr.write(`${violations.map(formatViolation).join("\n")}\n`);
    process.stderr.write(`docs:check failed: ${String(violations.length)} problem${violations.length === 1 ? "" : "s"}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`docs:check passed: ${String(pages)} page${pages === 1 ? "" : "s"} checked\n`);
  }
} catch (error) {
  process.stderr.write(`docs:check could not run: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
