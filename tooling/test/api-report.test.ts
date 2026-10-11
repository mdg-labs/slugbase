import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ROOT, SUBPROCESS_TIMEOUT_MS } from "./run.ts";

const RUNNER = join(ROOT, "tooling/api-report/api-report.ts");
const TSC = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** A package shaped like the real ones (src, tsconfig.build.json, api-extractor.json, an exports map), built with tsc. */
function createPackage(parent: string, name: string, source: string): string {
  const directory = join(parent, name);
  mkdirSync(join(directory, "src"), { recursive: true });
  writeJson(join(directory, "package.json"), {
    name: `@fixture/${name}`,
    type: "module",
    exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
  });
  writeJson(join(directory, "tsconfig.build.json"), {
    extends: join(ROOT, "tsconfig.base.json"),
    compilerOptions: { outDir: "dist", rootDir: "src" },
    include: ["src"],
  });
  writeJson(join(directory, "api-extractor.json"), {
    extends: join(ROOT, "api-extractor.base.json"),
    projectFolder: ".",
  });
  setSource(directory, source);
  return directory;
}

function setSource(directory: string, source: string): void {
  writeFileSync(join(directory, "src/index.ts"), source);
  const build = spawnSync(process.execPath, [TSC, "-p", "tsconfig.build.json"], { cwd: directory, encoding: "utf8" });
  expect(build.status, build.stdout + build.stderr).toBe(0);
}

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "api-report-test-"));
  directories.push(directory);
  return directory;
}

function runner(command: "check" | "extract", packages: string[]) {
  return spawnSync(process.execPath, [RUNNER, command, ...packages.flatMap((directory) => ["--package", directory])], {
    encoding: "utf8",
  });
}

function report(directory: string, name: string): string {
  return readFileSync(join(directory, "etc", `${name}.api.md`), "utf8");
}

const STABLE = "export function stable(): number {\n  return 1;\n}\n";

describe("the API Extractor report check", () => {
  it("fails when an export is added without updating the report, and passes once the report is regenerated", { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
    const directory = createPackage(workspace(), "core", STABLE);
    expect(runner("extract", [directory]).status).toBe(0);
    expect(report(directory, "core")).toContain("export function stable(): number;");
    expect(runner("check", [directory]).status).toBe(0);

    setSource(directory, `${STABLE}export function added(): string {\n  return "";\n}\n`);
    const committed = report(directory, "core");
    const drifted = runner("check", [directory]);
    expect(drifted.status).toBe(1);
    expect(drifted.stderr).toContain("@fixture/core");
    expect(drifted.stderr).toContain("etc/core.api.md differs");
    expect(drifted.stderr).toContain("+ export function added(): string;");
    expect(drifted.stderr).toContain("contract change");
    expect(drifted.stderr).toContain("pnpm api:extract");
    expect(drifted.stderr).toContain("commit body");
    expect(drifted.stderr).toContain("Cloud follow-up");
    expect(report(directory, "core")).toBe(committed);

    expect(runner("extract", [directory]).status).toBe(0);
    expect(report(directory, "core")).toContain("export function added(): string;");
    expect(runner("check", [directory]).status).toBe(0);
  });

  it("fails when an export is removed without updating the report", { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
    const directory = createPackage(workspace(), "core", `${STABLE}export function gone(): void {}\n`);
    expect(runner("extract", [directory]).status).toBe(0);

    setSource(directory, STABLE);
    const drifted = runner("check", [directory]);
    expect(drifted.status).toBe(1);
    expect(drifted.stderr).toContain("- export function gone(): void;");
  });

  it("fails on an exported API that references a type the package does not export", { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
    const directory = createPackage(
      workspace(),
      "core",
      "interface Hidden {\n  readonly value: number;\n}\nexport function leaky(): Hidden {\n  return { value: 1 };\n}\n",
    );
    for (const command of ["check", "extract"] as const) {
      const result = runner(command, [directory]);
      expect(result.status, command).toBe(1);
      expect(result.stderr).toContain("@fixture/core");
      expect(result.stderr).toContain("ae-forgotten-export");
    }
    expect(existsSync(join(directory, "etc"))).toBe(false);
  });

  it("keeps @internal exports out of the report and shows @deprecated ones", { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
    const directory = createPackage(
      workspace(),
      "core",
      `${STABLE}/** @internal */\nexport function hiddenFromConsumers(): void {}\n\n/** @deprecated use stable */\nexport function legacy(): number {\n  return 0;\n}\n`,
    );
    expect(runner("extract", [directory]).status).toBe(0);
    const committed = report(directory, "core");
    expect(committed).not.toContain("hiddenFromConsumers");
    expect(committed).toContain("export function legacy(): number;");
    expect(committed).toMatch(/@deprecated[^\n]*\nexport function legacy/);
    expect(runner("check", [directory]).status).toBe(0);
  });

  it("fails on a package that is not built", { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
    const directory = createPackage(workspace(), "core", STABLE);
    rmSync(join(directory, "dist"), { recursive: true });
    const result = runner("check", [directory]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("@fixture/core");
    expect(result.stderr).toContain("pnpm build");
  });

  it("fails when the committed report is missing or no longer matches an entry point", { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
    const directory = createPackage(workspace(), "core", STABLE);
    const missing = runner("check", [directory]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("etc/core.api.md is missing");

    expect(runner("extract", [directory]).status).toBe(0);
    writeFileSync(join(directory, "etc/old.api.md"), "stale\n");
    const stale = runner("check", [directory]);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain("etc/old.api.md no longer matches an entry point");

    expect(runner("extract", [directory]).status).toBe(0);
    expect(readdirSync(join(directory, "etc"))).toEqual(["core.api.md"]);
  });

  it("writes one report per exports entry", { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
    const directory = createPackage(workspace(), "kit", STABLE);
    writeFileSync(join(directory, "src/extra.ts"), "export const extra = 1;\n");
    writeJson(join(directory, "package.json"), {
      name: "@fixture/kit",
      type: "module",
      exports: {
        ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
        "./extra": { types: "./dist/extra.d.ts", import: "./dist/extra.js" },
      },
    });
    setSource(directory, STABLE);
    expect(runner("extract", [directory]).status).toBe(0);
    expect(readdirSync(join(directory, "etc")).sort()).toEqual(["kit-extra.api.md", "kit.api.md"]);
    expect(report(directory, "kit-extra")).toContain("export const extra = 1;");
  });

  it("names every failing package and writes no report when one of them fails", { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
    const parent = workspace();
    const good = createPackage(parent, "good", STABLE);
    const leaky = createPackage(parent, "leaky", "interface Hidden {\n  readonly value: number;\n}\nexport const hidden: Hidden = { value: 1 };\n");
    const unbuilt = createPackage(parent, "unbuilt", STABLE);
    rmSync(join(unbuilt, "dist"), { recursive: true });

    const extract = runner("extract", [good, leaky, unbuilt]);
    expect(extract.status).toBe(1);
    expect(extract.stderr).toContain("@fixture/leaky");
    expect(extract.stderr).toContain("@fixture/unbuilt");
    expect(existsSync(join(good, "etc"))).toBe(false);

    const check = runner("check", [good, leaky, unbuilt]);
    expect(check.status).toBe(1);
    expect(check.stderr).toContain("@fixture/leaky");
    expect(check.stderr).toContain("@fixture/unbuilt");
    expect(check.stderr).toContain("@fixture/good");
  });
});

interface Manifest {
  name: string;
  exports: Record<string, unknown>;
  scripts: Record<string, string>;
}

function manifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

describe("the API Extractor setup of the workspace", () => {
  const packages = readdirSync(join(ROOT, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  it("covers every package", () => {
    expect(packages).toEqual(["adapters", "contracts", "core", "db", "email", "server", "testing", "ui", "web"]);
  });

  it.each(packages)("%s extends the shared base configuration and commits a report per entry point", (name) => {
    const directory = join(ROOT, "packages", name);
    const config = JSON.parse(readFileSync(join(directory, "api-extractor.json"), "utf8")) as { extends: string };
    expect(config.extends).toBe("../../api-extractor.base.json");
    const entries = Object.keys(manifest(join(directory, "package.json")).exports);
    const expected = entries.map((subpath) => (subpath === "." ? `${name}.api.md` : `${name}-${subpath.slice(2)}.api.md`));
    expect(readdirSync(join(directory, "etc")).sort()).toEqual(expected.sort());
  });

  it.each(packages.filter((name) => name !== "contracts"))("%s runs the check from its contracts:check script", (name) => {
    expect(manifest(join(ROOT, "packages", name, "package.json")).scripts["contracts:check"]).toBe(
      "node ../../tooling/api-report/api-report.ts check --package .",
    );
  });

  it("runs every package's contracts:check, after its own build and uncached, from the root script and the gate", () => {
    const root = manifest(join(ROOT, "package.json"));
    expect(root.scripts["contracts:check"]).toBe("turbo run contracts:check --continue");
    expect(root.scripts["gate"]).toContain("pnpm contracts:check");
    expect(root.scripts["api:extract"]).toBe("turbo run build && node tooling/api-report/api-report.ts extract");
    const turbo = JSON.parse(readFileSync(join(ROOT, "turbo.json"), "utf8")) as {
      tasks: Record<string, { dependsOn: string[]; cache?: boolean }>;
    };
    expect(turbo.tasks["contracts:check"]?.dependsOn).toEqual(["^build", "build"]);
    expect(turbo.tasks["contracts:check"]?.cache).toBe(false);
  });
});
