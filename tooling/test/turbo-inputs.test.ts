import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./run.ts";

const TASK = "@slugbase/tooling#test:unit";

interface TurboConfig {
  tasks: Record<string, { inputs?: string[] } | undefined>;
}

/** The globs the CLAUDE.md sweeps hand to `sweep()` and `sourceFiles()`, one entry per call site. */
function sweepGlobs(source: string): string[] {
  const calls = [...source.matchAll(/(?<!function )\b(?:sweep|sourceFiles)\(/g)].length;
  const globs = [
    ...[...source.matchAll(/\bsweep\(\s*(?:\[[^\]]*\]|\w+)\s*,\s*"([^"]+)"/g)].map((match) => match[1] as string),
    ...[...source.matchAll(/\bsourceFiles\(\s*"([^"]+)"/g)].map((match) => match[1] as string),
  ];
  // A call whose glob this reader cannot see would leave its paths unchecked, so it is an error.
  if (globs.length !== calls) {
    throw new Error(`found ${String(calls)} sweep call(s) but read ${String(globs.length)} glob(s); teach sweepGlobs the new call shape`);
  }
  return globs;
}

/** The sweep globs that no entry of the task's `inputs` hashes. */
function uncoveredGlobs(globs: string[], inputs: string[]): string[] {
  return [...new Set(globs)].filter((glob) => !inputs.includes(`$TURBO_ROOT$/${glob}`));
}

describe(`${TASK} cache key`, () => {
  const inputs = (config: TurboConfig): string[] => config.tasks[TASK]?.inputs ?? [];
  const real = JSON.parse(readFileSync(resolve(ROOT, "turbo.json"), "utf8")) as TurboConfig;
  const boundaries = readFileSync(resolve(ROOT, "tooling/test/boundaries.test.ts"), "utf8");

  it("reads the sweep globs out of boundaries.test.ts", () => {
    const globs = new Set(sweepGlobs(boundaries));
    expect(globs).toContain("packages/**/*.ts");
    expect(globs).toContain("packages/**/*.tsx");
    expect(globs).toContain("apps/**/*.ts");
    expect(globs).toContain("apps/**/*.tsx");
  });

  it("hashes every path the CLAUDE.md sweeps read", () => {
    expect(uncoveredGlobs(sweepGlobs(boundaries), inputs(real))).toEqual([]);
  });

  const covered = ["packages/**/*.ts", "packages/**/*.tsx", "apps/**/*.ts", "apps/**/*.tsx"].map((glob) => `$TURBO_ROOT$/${glob}`);

  it("reports the apps globs when the task's inputs lack them", () => {
    const withoutApps = covered.filter((input) => !input.startsWith("$TURBO_ROOT$/apps/"));
    expect(uncoveredGlobs(sweepGlobs(boundaries), withoutApps)).toEqual(["apps/**/*.ts", "apps/**/*.tsx"]);
    expect(uncoveredGlobs(sweepGlobs(boundaries), covered)).toEqual([]);
  });

  it("reports a glob a new sweep adds", () => {
    const added = `${boundaries}\nsweep(flags, "scripts/**/*.mjs");\nsourceFiles("e2e/**/*.ts");\n`;
    expect(uncoveredGlobs(sweepGlobs(added), covered)).toEqual(["scripts/**/*.mjs", "e2e/**/*.ts"]);
  });

  it("refuses a sweep call whose glob it cannot read", () => {
    expect(() => sweepGlobs(`${boundaries}\nsweep(flags, someGlob);\n`)).toThrow(/sweep call/);
  });
});
