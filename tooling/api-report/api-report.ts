import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { Extractor, ExtractorConfig, ExtractorLogLevel, type ExtractorMessage } from "@microsoft/api-extractor";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const USAGE = "usage: api-report.ts <check|extract> [--package <directory>]...";

// API Extractor's own "complete" report keeps @internal exports. The "alpha"
// variant drops them, so the committed report is the alpha variant under the
// plain `<name>.api.md` name.
const VARIANT_SUFFIX = ".alpha.api.md";

const CONTRACT_CHANGE_RULE =
  "A changed report is a contract change (doc 09 section 3.3): run `pnpm api:extract` and commit the regenerated " +
  "report, name the change in the commit body, and file the Cloud follow-up item \"Adopt CE <change>\".";

interface Manifest {
  name: string;
  exports?: Record<string, unknown>;
}

interface EntryPoint {
  /** The report's base name: `core` for the "." entry, `testing-db` for "./db" of `@slugbase/testing`. */
  report: string;
  declarations: string;
}

interface PackageResult {
  name: string;
  problems: string[];
  /** The generated reports by file name, empty when generation failed. */
  reports: Map<string, string>;
  directory: string;
}

function unscoped(packageName: string): string {
  return packageName.slice(packageName.lastIndexOf("/") + 1);
}

function entryPoints(directory: string, manifest: Manifest): EntryPoint[] {
  const base = unscoped(manifest.name);
  const entries = Object.entries(manifest.exports ?? {});
  if (entries.length === 0) {
    throw new Error("package.json has no exports map, so there is no entry point to report on");
  }
  return entries.map(([subpath, target]) => {
    const declarations =
      typeof target === "object" && target !== null && "types" in target && typeof target.types === "string"
        ? target.types
        : undefined;
    if (declarations === undefined) {
      throw new Error(`exports["${subpath}"] has no "types" declaration file`);
    }
    const suffix = subpath === "." ? "" : `-${subpath.replace(/^\.\//, "").replaceAll("/", "-")}`;
    return { report: `${base}${suffix}`, declarations: resolve(directory, declarations) };
  });
}

const CREATED_OR_COPIED = new Set(["console-api-report-created", "console-api-report-copied"]);

/** Runs API Extractor for one entry point into `scratch` and returns the report text; throws with every problem it found. */
function extract(directory: string, entry: EntryPoint, scratch: string): string {
  if (!existsSync(entry.declarations)) {
    throw new Error(`${relative(directory, entry.declarations)} does not exist; build the package first (pnpm build)`);
  }
  const configPath = join(directory, "api-extractor.json");
  if (!existsSync(configPath)) {
    throw new Error("api-extractor.json is missing");
  }
  const configObject = ExtractorConfig.loadFile(configPath);
  configObject.mainEntryPointFilePath = entry.declarations;
  configObject.apiReport = {
    ...configObject.apiReport,
    enabled: true,
    reportFileName: entry.report,
    reportVariants: ["alpha"],
    reportFolder: scratch,
    reportTempFolder: join(scratch, "temp"),
  };
  const config = ExtractorConfig.prepare({
    configObject,
    configObjectFullPath: configPath,
    packageJsonFullPath: join(directory, "package.json"),
  });

  const problems: string[] = [];
  const result = Extractor.invoke(config, {
    localBuild: true,
    messageCallback: (message: ExtractorMessage) => {
      message.handled = true;
      if (CREATED_OR_COPIED.has(message.messageId)) {
        return;
      }
      if (message.logLevel === ExtractorLogLevel.Error || message.logLevel === ExtractorLogLevel.Warning) {
        const where = message.sourceFilePath === undefined ? "" : `${relative(directory, message.sourceFilePath)}: `;
        problems.push(`${where}${message.text.trim()} (${message.messageId})`);
      }
    },
  });
  if (!result.succeeded && problems.length === 0) {
    problems.push("API Extractor reported failure without a message");
  }
  if (problems.length > 0) {
    throw new Error(problems.join("\n"));
  }
  return readFileSync(join(scratch, `${entry.report}${VARIANT_SUFFIX}`), "utf8");
}

function describeDifference(committed: string, generated: string): string {
  const before = new Set(committed.split("\n"));
  const after = new Set(generated.split("\n"));
  const lines = [
    ...generated.split("\n").filter((line) => !before.has(line) && line.trim() !== "").map((line) => `+ ${line}`),
    ...committed.split("\n").filter((line) => !after.has(line) && line.trim() !== "").map((line) => `- ${line}`),
  ];
  const shown = lines.slice(0, 20).map((line) => `    ${line}`);
  if (lines.length > shown.length) {
    shown.push(`    ... ${String(lines.length - shown.length)} more line(s)`);
  }
  return shown.join("\n");
}

function generate(directory: string, scratchRoot: string, index: number): PackageResult {
  const result: PackageResult = { name: relative(REPO_ROOT, directory) || directory, problems: [], reports: new Map(), directory };
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as Manifest;
    result.name = manifest.name;
  } catch (error: unknown) {
    result.problems.push(`cannot read package.json: ${error instanceof Error ? error.message : String(error)}`);
    return result;
  }
  try {
    for (const entry of entryPoints(directory, manifest)) {
      const scratch = join(scratchRoot, String(index), entry.report);
      mkdirSync(scratch, { recursive: true });
      result.reports.set(`${entry.report}.api.md`, extract(directory, entry, scratch));
    }
  } catch (error: unknown) {
    result.reports.clear();
    result.problems.push(error instanceof Error ? error.message : String(error));
  }
  return result;
}

function committedReports(directory: string): Map<string, string> {
  const folder = join(directory, "etc");
  const found = new Map<string, string>();
  if (existsSync(folder)) {
    for (const name of readdirSync(folder).filter((file) => file.endsWith(".api.md"))) {
      found.set(name, readFileSync(join(folder, name), "utf8"));
    }
  }
  return found;
}

/** The problems a generated package has against its committed reports; none when they match exactly. */
function differences(result: PackageResult): string[] {
  const committed = committedReports(result.directory);
  const found: string[] = [];
  for (const [file, generated] of result.reports) {
    const existing = committed.get(file);
    if (existing === undefined) {
      found.push(`etc/${file} is missing`);
    } else if (existing !== generated) {
      found.push(`etc/${file} differs from the exported API:\n${describeDifference(existing, generated)}`);
    }
  }
  for (const file of committed.keys()) {
    if (!result.reports.has(file)) {
      found.push(`etc/${file} no longer matches an entry point`);
    }
  }
  return found;
}

function defaultPackages(): string[] {
  const root = join(REPO_ROOT, "packages");
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .sort();
}

function parseArgs(argv: readonly string[]): { command: "check" | "extract"; packages: string[] } {
  const [command, ...rest] = argv;
  if (command !== "check" && command !== "extract") {
    throw new Error(USAGE);
  }
  const packages: string[] = [];
  for (let i = 0; i < rest.length; i += 2) {
    const value = rest[i + 1];
    if (rest[i] !== "--package" || value === undefined) {
      throw new Error(USAGE);
    }
    packages.push(resolve(value));
  }
  return { command, packages: packages.length > 0 ? packages : defaultPackages() };
}

function run(argv: readonly string[]): number {
  const { command, packages } = parseArgs(argv);
  const scratchRoot = mkdtempSync(join(tmpdir(), "api-report-"));
  try {
    const results = packages.map((directory, index) => generate(directory, scratchRoot, index));
    const failures = results.map((result) => ({
      result,
      problems: [...result.problems, ...(command === "check" && result.problems.length === 0 ? differences(result) : [])],
    }));
    const failed = failures.filter(({ problems }) => problems.length > 0);
    for (const { result, problems } of failed) {
      process.stderr.write(`api-report ${command} failed: ${result.name}\n${problems.map((problem) => `  ${problem.replaceAll("\n", "\n  ")}`).join("\n")}\n`);
    }
    if (failed.length > 0) {
      if (command === "check" && failed.some(({ result, problems }) => problems.length > result.problems.length)) {
        process.stderr.write(`${CONTRACT_CHANGE_RULE}\n`);
      }
      return 1;
    }
    if (command === "extract") {
      for (const result of results) {
        const folder = join(result.directory, "etc");
        mkdirSync(folder, { recursive: true });
        for (const file of committedReports(result.directory).keys()) {
          if (!result.reports.has(file)) {
            rmSync(join(folder, file));
          }
        }
        for (const [file, content] of result.reports) {
          writeFileSync(join(folder, file), content);
        }
      }
    }
    return 0;
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
}

try {
  process.exitCode = run(process.argv.slice(2));
} catch (error: unknown) {
  process.stderr.write(`api-report failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
