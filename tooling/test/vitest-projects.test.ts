import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT, run, SUBPROCESS_TIMEOUT_MS } from "./run.ts";

interface JsonReport {
  numFailedTests: number;
  numPassedTests: number;
  testResults: { name: string }[];
}

function vitestRun(fixture: string, project: "unit" | "integration"): { report: JsonReport; files: string[] } {
  const cwd = resolve(ROOT, "tooling/fixtures", fixture);
  const outDir = mkdtempSync(join(tmpdir(), "slugbase-vitest-"));
  const outFile = join(outDir, "report.json");
  let report: JsonReport;
  try {
    const result = run(
      "vitest/vitest.mjs",
      ["run", "--project", project, "--reporter", "json", "--outputFile", outFile],
      cwd,
    );
    expect(result.status, result.stderr).toBe(0);
    report = JSON.parse(readFileSync(outFile, "utf8")) as JsonReport;
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
  return { report, files: report.testResults.map((r) => r.name.slice(cwd.length + 1)).sort() };
}

describe("shared vitest base", { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
  it("runs only *.test.ts and *.test.tsx in the unit project", () => {
    const { files } = vitestRun("vitest-split", "unit");
    expect(files).toEqual(["alpha.test.ts", "beta.test.tsx"]);
  });

  it("never executes an *.integration.test.ts file in the unit project", () => {
    const { files } = vitestRun("vitest-split", "unit");
    expect(files.some((f) => f.includes(".integration."))).toBe(false);
  });

  it("runs only *.integration.test.ts in the integration project", () => {
    const { files } = vitestRun("vitest-split", "integration");
    expect(files).toEqual(["gamma.integration.test.ts"]);
  });

  it("gives the unit project a DOM only when the package opts into jsdom", () => {
    const unit = vitestRun("vitest-jsdom", "unit");
    expect(unit.files).toEqual(["dom.test.ts"]);
    expect(unit.report.numFailedTests).toBe(0);
    expect(unit.report.numPassedTests).toBe(1);
  });

  it("keeps the integration project on node even with the jsdom preset", () => {
    const integration = vitestRun("vitest-jsdom", "integration");
    expect(integration.files).toEqual(["dom.integration.test.ts"]);
    expect(integration.report.numFailedTests).toBe(0);
    expect(integration.report.numPassedTests).toBe(1);
  });
});
