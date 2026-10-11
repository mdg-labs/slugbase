import { resolve } from "node:path";
import { recordChecksums } from "../src/check/index.ts";

// `pnpm db:record-checksums`: records the checksum of each migration `pnpm
// db:check` has none for yet, in src/check/migration-checksums.json. Run it
// after `pnpm db:generate` and commit the result with the new migration. An
// existing entry is never rewritten.

try {
  const packageDir = resolve(process.argv[2] ?? resolve(import.meta.dirname, ".."));
  const added = recordChecksums(packageDir);
  process.stdout.write(
    `${[...added.map((tag) => `db:record-checksums: recorded ${tag}`), `db:record-checksums: ${String(added.length)} migration(s) recorded`].join("\n")}\n`,
  );
} catch (error) {
  process.stderr.write(`db:record-checksums: ${error instanceof Error ? error.message : "failed"}\n`);
  process.exitCode = 1;
}
