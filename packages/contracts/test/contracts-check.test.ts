import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createReportPackage, runApiReport } from "./report-package.ts";
import { SUBPROCESS_TIMEOUT_MS } from "./subprocess.ts";

const packageDir = new URL("..", import.meta.url).pathname;
const apiGen = join(packageDir, "scripts/api-gen.ts");
const check = join(packageDir, "scripts/contracts-check.ts");
const before = join(packageDir, "test/fixtures/drift-before.fixture.ts");
const after = join(packageDir, "test/fixtures/drift-after.fixture.ts");
const noPolicy = join(packageDir, "test/fixtures/no-policy.fixture.ts");
const directories: string[] = [];
let reportPackage = "";

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "contracts-check-"));
  directories.push(dir);
  return dir;
}

function generate(operations: string, outDir: string): void {
  const result = spawnSync(process.execPath, [apiGen, "--operations", operations, "--out-dir", outDir], {
    cwd: packageDir,
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
}

function runCheck(operations: string, generated: string, tmp: string = tmpdir(), pkg: string = reportPackage) {
  return spawnSync(process.execPath, [check, "--operations", operations, "--generated", generated, "--package", pkg], {
    cwd: packageDir,
    encoding: "utf8",
    env: { ...process.env, TMPDIR: tmp },
  });
}

function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), "utf8")]));
}

beforeAll(() => {
  reportPackage = createReportPackage();
}, SUBPROCESS_TIMEOUT_MS);

afterAll(() => {
  rmSync(reportPackage, { recursive: true, force: true });
});

afterEach(() => {
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("pnpm contracts:check", () => {
  it("is the package script the root contracts:check task runs", () => {
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts["contracts:check"]).toBe("node scripts/contracts-check.ts");
    const root = JSON.parse(readFileSync(join(packageDir, "../../package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(root.scripts["contracts:check"]).toBe("turbo run contracts:check --continue");
  });

  it("passes on the committed generated files", { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
    const result = spawnSync(process.execPath, [check, "--package", reportPackage], { cwd: packageDir, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });

  it("fails when the exported API of the package differs from its committed report, and passes once the report is regenerated", { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
    const generated = scratch();
    generate(before, generated);
    const declarations = join(reportPackage, "dist/index.d.ts");
    const original = readFileSync(declarations, "utf8");
    try {
      writeFileSync(declarations, `${original}export declare function added(): string;\n`);
      const drifted = runCheck(before, generated);
      expect(drifted.status).toBe(1);
      expect(drifted.stderr).toContain("contracts:check failed");
      expect(drifted.stderr).toContain("@fixture/reports");
      expect(drifted.stderr).toContain("etc/reports.api.md differs");
      expect(drifted.stderr).toContain("pnpm api:extract");
      expect(drifted.stderr).toContain("Cloud follow-up");

      expect(runApiReport("extract", reportPackage).status).toBe(0);
      expect(runCheck(before, generated).status).toBe(0);
    } finally {
      writeFileSync(declarations, original);
      expect(runApiReport("extract", reportPackage).status).toBe(0);
    }
  });

  it("fails after a schema changes without regenerating", { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
    const generated = scratch();
    generate(before, generated);

    const drifted = runCheck(after, generated);
    expect(drifted.status).not.toBe(0);
    expect(drifted.stderr).toContain("openapi.json");
    expect(drifted.stderr).toContain("schema.d.ts");
    expect(drifted.stderr).toContain("pnpm api:gen");
  });

  it("passes once the generated files are regenerated after a schema changes", { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
    const generated = scratch();
    generate(before, generated);
    const stale = snapshot(generated);
    generate(after, generated);
    expect(snapshot(generated)).not.toEqual(stale);
    expect(runCheck(after, generated).status).toBe(0);
  });

  it("names only the file that drifted when the other still matches", { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
    const generated = scratch();
    generate(before, generated);
    const typesFile = join(generated, "schema.d.ts");
    writeFileSync(typesFile, `${readFileSync(typesFile, "utf8")}// hand edit\n`);
    const result = runCheck(before, generated);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("schema.d.ts");
    expect(result.stderr).not.toContain("openapi.json");
  });

  it("fails when a committed file is missing", { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
    const generated = scratch();
    generate(before, generated);
    rmSync(join(generated, "schema.d.ts"));
    const result = runCheck(before, generated);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("schema.d.ts");
    expect(result.stderr).toContain("pnpm api:gen");
  });

  it("fails when the generator fails, and leaves the committed files untouched", { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
    const generated = scratch();
    generate(before, generated);
    const committed = snapshot(generated);
    const result = runCheck(noPolicy, generated);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("createBookmarkWithoutPolicy");
    expect(snapshot(generated)).toEqual(committed);
  });

  it("never overwrites the committed files and cleans up its temporary directory", { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
    const generated = scratch();
    generate(before, generated);
    const committed = snapshot(generated);
    const temporary = scratch();

    expect(runCheck(after, generated, temporary).status).not.toBe(0);
    expect(snapshot(generated)).toEqual(committed);
    expect(readdirSync(temporary)).toEqual([]);

    expect(runCheck(noPolicy, generated, temporary).status).not.toBe(0);
    expect(readdirSync(temporary)).toEqual([]);

    expect(runCheck(before, generated, temporary).status).toBe(0);
    expect(readdirSync(temporary)).toEqual([]);
  });
});
