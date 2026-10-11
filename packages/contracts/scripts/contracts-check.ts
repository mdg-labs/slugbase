import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

interface Options {
  operations: string;
  generated: string;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    operations: resolve(import.meta.dirname, "../src/operations/index.ts"),
    generated: resolve(import.meta.dirname, "../generated"),
  };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag !== "--operations" && flag !== "--generated") || value === undefined) {
      throw new Error("usage: contracts-check.ts [--operations <module exporting operations>] [--generated <directory>]");
    }
    options[flag === "--operations" ? "operations" : "generated"] = resolve(value);
  }
  return options;
}

function readCommitted(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/** Regenerates every artefact into a temporary directory and returns the committed files that differ from it. */
function driftedFiles(options: Options): string[] {
  const scratch = mkdtempSync(join(tmpdir(), "contracts-check-"));
  try {
    const generator = spawnSync(
      process.execPath,
      [join(import.meta.dirname, "api-gen.ts"), "--operations", options.operations, "--out-dir", scratch],
      { encoding: "utf8" },
    );
    if (generator.error !== undefined) {
      throw generator.error;
    }
    if (generator.status !== 0) {
      throw new Error(generator.stderr.trim() || `the generator exited with status ${String(generator.status)}`);
    }
    return readdirSync(scratch)
      .sort()
      .filter((name) => readCommitted(join(options.generated, name)) !== readFileSync(join(scratch, name), "utf8"))
      .map((name) => relative(process.cwd(), join(options.generated, name)));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

try {
  const drifted = driftedFiles(parseArgs(process.argv.slice(2)));
  if (drifted.length > 0) {
    const lines = drifted.map((file) => `  ${file}`).join("\n");
    process.stderr.write(
      `contracts:check failed: generated files differ from the contracts in src/:\n${lines}\nRun \`pnpm api:gen\` and commit the result.\n`,
    );
    process.exitCode = 1;
  }
} catch (error: unknown) {
  process.stderr.write(`contracts:check failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
