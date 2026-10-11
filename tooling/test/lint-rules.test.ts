import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT, run } from "./run.ts";

interface LintResult {
  filePath: string;
  messages: { ruleId: string | null; severity: number }[];
}

// The fixtures are ignored by the repository lint run; --no-ignore lints them
// with the same eslint.config.js so each rule is proven against real input.
const lint = run(
  "eslint/bin/eslint.js",
  ["--no-ignore", "--format", "json", "tooling/fixtures/lint"],
  ROOT,
);
const results = JSON.parse(lint.stdout) as LintResult[];

function errorRules(file: string): string[] {
  const result = results.find((r) => r.filePath === resolve(ROOT, "tooling/fixtures/lint", file));
  if (result === undefined) {
    throw new Error(`no lint result for ${file}`);
  }
  return result.messages.filter((m) => m.severity === 2).map((m) => m.ruleId ?? "parse-error");
}

describe("eslint.config.js", () => {
  it("lints every fixture", () => {
    expect(results).toHaveLength(4);
  });

  it("fails a file that uses any", () => {
    expect(errorRules("explicit-any.ts")).toContain("@typescript-eslint/no-explicit-any");
  });

  it("fails a file that calls console.log", () => {
    expect(errorRules("console-log.ts")).toContain("no-console");
  });

  it("fails a bare @ts-ignore", () => {
    expect(errorRules("bare-ts-ignore.ts")).toContain("@typescript-eslint/ban-ts-comment");
  });

  it("passes @ts-expect-error with an issue link", () => {
    expect(errorRules("ts-expect-error-with-issue.ts")).toEqual([]);
  });

  it("exits non-zero when any fixture fails", () => {
    expect(lint.status).toBe(1);
  });
});
