import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const packageDir = new URL("..", import.meta.url).pathname;
const script = join(packageDir, "scripts/api-gen.ts");
const directories: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "api-gen-"));
  directories.push(dir);
  return dir;
}

function apiGen(args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd: packageDir, encoding: "utf8" });
}

afterEach(() => {
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("pnpm api:gen", () => {
  it("runs the generator script from the package manifest", () => {
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts["api:gen"]).toBe("node scripts/api-gen.ts");
    const root = JSON.parse(readFileSync(join(packageDir, "../../package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(root.scripts["api:gen"]).toBe("pnpm --filter @slugbase/contracts api:gen");
  });

  it("writes the committed document", () => {
    const out = join(scratch(), "openapi.json");
    const result = apiGen(["--out", out]);
    expect(result.status).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(readFileSync(join(packageDir, "generated/openapi.json"), "utf8"));
  });

  it("fails, names the operation and writes nothing when an operation has no policy", () => {
    const out = join(scratch(), "openapi.json");
    const result = apiGen(["--operations", join(packageDir, "test/fixtures/no-policy.fixture.ts"), "--out", out]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("createBookmarkWithoutPolicy");
    expect(result.stderr).toContain("x-slugbase-auth");
    expect(existsSync(out)).toBe(false);
  });
});
