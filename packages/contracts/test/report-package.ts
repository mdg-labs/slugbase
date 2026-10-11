import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = new URL("../../..", import.meta.url).pathname;
const apiReport = join(repo, "tooling/api-report/api-report.ts");

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function runApiReport(command: "check" | "extract", directory: string) {
  return spawnSync(process.execPath, [apiReport, command, "--package", directory], { encoding: "utf8" });
}

/**
 * A small package with a built declaration file and a committed report, so the
 * `contracts:check` chain runs its report check without depending on the real
 * package having been built. The caller removes the returned directory.
 */
export function createReportPackage(): string {
  const directory = mkdtempSync(join(tmpdir(), "contracts-report-package-"));
  mkdirSync(join(directory, "dist"), { recursive: true });
  writeJson(join(directory, "package.json"), {
    name: "@fixture/reports",
    type: "module",
    exports: { ".": { types: "./dist/index.d.ts" } },
  });
  writeJson(join(directory, "tsconfig.build.json"), { extends: join(repo, "tsconfig.base.json") });
  writeJson(join(directory, "api-extractor.json"), { extends: join(repo, "api-extractor.base.json"), projectFolder: "." });
  writeFileSync(join(directory, "dist/index.d.ts"), "export declare function stable(): number;\n");
  const extracted = runApiReport("extract", directory);
  if (extracted.status !== 0) {
    throw new Error(extracted.stderr);
  }
  return directory;
}
