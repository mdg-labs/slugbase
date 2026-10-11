import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { lintOpenApi } from "./lint-openapi.ts";

interface Options {
  operations: string;
  generated: string;
  package: string;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    operations: resolve(import.meta.dirname, "../src/operations/index.ts"),
    generated: resolve(import.meta.dirname, "../generated"),
    package: resolve(import.meta.dirname, ".."),
  };
  const flags = { "--operations": "operations", "--generated": "generated", "--package": "package" } as const;
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === undefined || !(flag in flags) || value === undefined) {
      throw new Error(
        "usage: contracts-check.ts [--operations <module exporting operations>] [--generated <directory>] [--package <directory>]",
      );
    }
    options[flags[flag as keyof typeof flags]] = resolve(value);
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

/** Describes how the committed generated files drifted, or returns undefined when they match. */
function driftFailure(options: Options): string | undefined {
  const drifted = driftedFiles(options);
  if (drifted.length === 0) {
    return undefined;
  }
  const lines = drifted.map((file) => `  ${file}`).join("\n");
  return `generated files differ from the contracts in src/:\n${lines}\nRun \`pnpm api:gen\` and commit the result.`;
}

/** Describes the findings of the SlugBase Spectral ruleset on the committed document, or returns undefined when there are none. */
async function lintFailure(options: Options): Promise<string | undefined> {
  const findings = await lintOpenApi(join(options.generated, "openapi.json"));
  if (findings.length === 0) {
    return undefined;
  }
  return `the OpenAPI document breaks the SlugBase ruleset (${String(findings.length)} finding(s)):\n${findings.map((finding) => `  ${finding}`).join("\n")}`;
}

/** Describes how the package's API Extractor reports differ from its exported API, or returns undefined when they match. */
function apiReportFailure(options: Options): string | undefined {
  const runner = resolve(import.meta.dirname, "../../../tooling/api-report/api-report.ts");
  const report = spawnSync(process.execPath, [runner, "check", "--package", options.package], { encoding: "utf8" });
  if (report.error !== undefined) {
    throw report.error;
  }
  if (report.status === 0) {
    return undefined;
  }
  return report.stderr.trim() || `the API report check exited with status ${String(report.status)}`;
}

/** Every check runs even when an earlier one fails, so one run reports everything that is wrong. */
async function failures(options: Options): Promise<string[]> {
  const checks = [() => driftFailure(options), () => lintFailure(options), () => apiReportFailure(options)];
  const failed: string[] = [];
  for (const check of checks) {
    try {
      const failure = await check();
      if (failure !== undefined) {
        failed.push(failure);
      }
    } catch (error: unknown) {
      failed.push(error instanceof Error ? error.message : String(error));
    }
  }
  return failed;
}

try {
  const failed = await failures(parseArgs(process.argv.slice(2)));
  for (const failure of failed) {
    process.stderr.write(`contracts:check failed: ${failure}\n`);
  }
  if (failed.length > 0) {
    process.exitCode = 1;
  }
} catch (error: unknown) {
  process.stderr.write(`contracts:check failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
