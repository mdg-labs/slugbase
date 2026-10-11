import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const packageDir = new URL("..", import.meta.url).pathname;
const apiGen = join(packageDir, "scripts/api-gen.ts");
const check = join(packageDir, "scripts/contracts-check.ts");
const before = join(packageDir, "test/fixtures/drift-before.fixture.ts");
const after = join(packageDir, "test/fixtures/drift-after.fixture.ts");
const noPolicy = join(packageDir, "test/fixtures/no-policy.fixture.ts");
const directories: string[] = [];

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

function runCheck(operations: string, generated: string, tmp: string = tmpdir()) {
  return spawnSync(process.execPath, [check, "--operations", operations, "--generated", generated], {
    cwd: packageDir,
    encoding: "utf8",
    env: { ...process.env, TMPDIR: tmp },
  });
}

function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), "utf8")]));
}

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
    expect(root.scripts["contracts:check"]).toBe("turbo run contracts:check");
  });

  it("passes on the committed generated files", () => {
    const result = spawnSync(process.execPath, [check], { cwd: packageDir, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });

  it("fails after a schema changes without regenerating, and passes once regenerated", () => {
    const generated = scratch();
    generate(before, generated);
    expect(runCheck(before, generated).status).toBe(0);

    const drifted = runCheck(after, generated);
    expect(drifted.status).not.toBe(0);
    expect(drifted.stderr).toContain("openapi.json");
    expect(drifted.stderr).toContain("schema.d.ts");
    expect(drifted.stderr).toContain("pnpm api:gen");

    generate(after, generated);
    expect(runCheck(after, generated).status).toBe(0);
  });

  it("names only the file that drifted when the other still matches", () => {
    const generated = scratch();
    generate(before, generated);
    const typesFile = join(generated, "schema.d.ts");
    writeFileSync(typesFile, `${readFileSync(typesFile, "utf8")}// hand edit\n`);
    const result = runCheck(before, generated);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("schema.d.ts");
    expect(result.stderr).not.toContain("openapi.json");
  });

  it("fails when a committed file is missing", () => {
    const generated = scratch();
    generate(before, generated);
    rmSync(join(generated, "schema.d.ts"));
    const result = runCheck(before, generated);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("schema.d.ts");
    expect(result.stderr).toContain("pnpm api:gen");
  });

  it("fails when the generator fails, and leaves the committed files untouched", () => {
    const generated = scratch();
    generate(before, generated);
    const committed = snapshot(generated);
    const result = runCheck(noPolicy, generated);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("createBookmarkWithoutPolicy");
    expect(snapshot(generated)).toEqual(committed);
  });

  it("never overwrites the committed files and cleans up its temporary directory", () => {
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
