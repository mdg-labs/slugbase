import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT, SUBPROCESS_TIMEOUT_MS } from "./run.ts";

// `URL.pathname` stays percent-encoded and keeps a leading slash on Windows, so a
// checkout path with a space or a non-ASCII character names a file that does not
// exist. `fileURLToPath` decodes it. The pieces are joined here so that this file
// does not contain the form it looks for.
const MODULE_URL = String.raw`import\s*\.\s*meta\s*\.\s*url`;
const PATHNAME_OF_MODULE_URL = new RegExp(`${MODULE_URL}\\s*(?:,\\s*)?\\)\\s*\\??\\.\\s*pathname\\b`, "g");

const GLOBS = ["*.ts", "*.tsx"];

/** Every `line: text` in `source` where `.pathname` is read off a URL built from the module's own URL. */
function pathnameReads(source: string): { line: number; text: string }[] {
  const lines = source.split("\n");
  return [...source.matchAll(PATHNAME_OF_MODULE_URL)].map((match) => {
    const line = source.slice(0, match.index).split("\n").length;
    return { line, text: (lines[line - 1] ?? "").trim() };
  });
}

// Turbo hashes tracked files and untracked ones that .gitignore does not exclude, so the
// test reads that same set.
function sourceFiles(): string[] {
  const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", ...GLOBS], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (listed.status !== 0) {
    throw new Error(`git ls-files failed: ${listed.stderr}`);
  }
  return listed.stdout.split("\n").filter((file) => file !== "");
}

/**
 * What the task's cache key does not hash among the files it reads. For each top-level directory of `files`, the
 * `$TURBO_ROOT$/<directory>/**\/<glob>` input that `inputs` lacks; for a file at the repository root, its name unless
 * `inputs` holds `$TURBO_ROOT$/<file>` or `globalDependencies` holds `<file>`. The tooling/ directory is the
 * package's own default input and is not reported.
 */
function uncoveredInputs(files: string[], inputs: string[], globalDependencies: string[]): string[] {
  const rootFiles = files.filter(
    (file) => !file.includes("/") && !inputs.includes(`$TURBO_ROOT$/${file}`) && !globalDependencies.includes(file),
  );
  const directories = [...new Set(files.filter((file) => file.includes("/")).map((file) => file.split("/")[0] as string))];
  return [
    ...rootFiles,
    ...directories
      .filter((directory) => directory !== "tooling")
      .flatMap((directory) => GLOBS.map((glob) => `$TURBO_ROOT$/${directory}/**/${glob}`))
      .filter((input) => !inputs.includes(input)),
  ];
}

const moduleUrl = "import" + ".meta.url";

describe("file URLs read as filesystem paths", { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
  it("finds a pathname read off the module URL, across line breaks", () => {
    const source = [
      `const a = new URL("..", ${moduleUrl}).pathname;`,
      "const b = new URL(",
      '  "../..",',
      `  ${moduleUrl},`,
      ").",
      "  pathname.replace(/x/, '');",
      `const c = fileURLToPath(new URL("..", ${moduleUrl}));`,
      `const d = new URL("../x", ${moduleUrl});`,
      "const e = new URL(request.url).pathname;",
    ].join("\n");
    expect(pathnameReads(source).map((read) => read.line)).toEqual([1, 4]);
  });

  it("lists the file and line of every pathname read off the module URL", () => {
    const found = sourceFiles().flatMap((file) =>
      pathnameReads(readFileSync(resolve(ROOT, file), "utf8")).map((read) => `${file}:${String(read.line)}: ${read.text}`),
    );
    expect(found, "use fileURLToPath(new URL(…)) from node:url").toEqual([]);
  });

  it("is hashed by the task's cache key for every glob it reads", () => {
    const config = JSON.parse(readFileSync(resolve(ROOT, "turbo.json"), "utf8")) as {
      globalDependencies?: string[];
      tasks: Record<string, { inputs?: string[] } | undefined>;
    };
    const inputs = config.tasks["@slugbase/tooling#test:unit"]?.inputs ?? [];
    expect(uncoveredInputs(sourceFiles(), inputs, config.globalDependencies ?? [])).toEqual([]);
  });

  it("reports a glob the task's inputs lack for a directory it reads", () => {
    const files = ["packages/a/x.ts", "e2e/y.ts", "scripts/z.tsx", "tooling/t.ts"];
    const all = ["packages", "e2e", "scripts"].flatMap((directory) => GLOBS.map((glob) => `$TURBO_ROOT$/${directory}/**/${glob}`));
    expect(uncoveredInputs(files, all, [])).toEqual([]);
    expect(uncoveredInputs(files, all.filter((input) => input !== "$TURBO_ROOT$/scripts/**/*.tsx"), [])).toEqual([
      "$TURBO_ROOT$/scripts/**/*.tsx",
    ]);
    expect(uncoveredInputs(files, all.map((input) => (input === "$TURBO_ROOT$/e2e/**/*.ts" ? "$TURBO_ROOT$/e2e/**/*.mts" : input)), [])).toEqual([
      "$TURBO_ROOT$/e2e/**/*.ts",
    ]);
  });

  it("reports a file at the repository root that neither the inputs nor the global dependencies declare", () => {
    const files = ["packages/a/x.ts", "foo.ts", "vitest.shared.ts"];
    const packages = GLOBS.map((glob) => `$TURBO_ROOT$/packages/**/${glob}`);
    expect(uncoveredInputs(files, packages, [])).toEqual(["foo.ts", "vitest.shared.ts"]);
    expect(uncoveredInputs(files, [...packages, "$TURBO_ROOT$/foo.ts"], ["vitest.shared.ts"])).toEqual([]);
    expect(uncoveredInputs(files, packages, ["foo.ts", "vitest.shared.ts"])).toEqual([]);
    expect(uncoveredInputs(files, [...packages, "$TURBO_ROOT$/foo.ts"], [])).toEqual(["vitest.shared.ts"]);
    expect(uncoveredInputs(files, packages, ["foo.ts"])).toEqual(["vitest.shared.ts"]);
  });
});
