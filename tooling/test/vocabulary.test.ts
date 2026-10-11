import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ROOT, run, SUBPROCESS_TIMEOUT_MS } from "./run.ts";

interface LintResult {
  filePath: string;
  messages: { ruleId: string | null; severity: number; message: string }[];
}

const FIXTURES = "tooling/fixtures/vocabulary";

const lint = run(
  "eslint/bin/eslint.js",
  ["--no-ignore", "--format", "json", `${FIXTURES}/identifiers`],
  ROOT,
);
const results = JSON.parse(lint.stdout) as LintResult[];

function errors(file: string): LintResult["messages"] {
  const result = results.find((r) => r.filePath === resolve(ROOT, FIXTURES, "identifiers", file));
  if (result === undefined) {
    throw new Error(`no lint result for ${file}`);
  }
  return result.messages.filter((m) => m.severity === 2);
}

function vocabularyMessages(file: string): string[] {
  return errors(file)
    .filter((m) => m.ruleId === "slugbase/no-forbidden-vocabulary")
    .map((m) => m.message);
}

describe("slugbase/no-forbidden-vocabulary", () => {
  it("lints every fixture", () => {
    expect(results).toHaveLength(11);
  });

  it("rejects variables, functions, types and properties in any casing", () => {
    const messages = vocabularyMessages("identifiers.ts");
    expect(messages).toHaveLength(5);
    expect(messages.join("\n")).toMatch(/"organizationName".*"workspace"/);
    expect(messages.join("\n")).toMatch(/"listCollections".*"folder"/);
    expect(messages.join("\n")).toMatch(/"FavoriteItem".*"pinning"/);
    expect(messages.join("\n")).toMatch(/"isFavorite".*"pinning"/);
    expect(messages.join("\n")).toMatch(/"COLLECTION_KIND".*"folder"/);
  });

  it("rejects a file name", () => {
    const messages = vocabularyMessages("favorite-list.ts");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/"favorite-list\.ts".*"pinning"/);
  });

  it("passes the canonical terms", () => {
    expect(errors("clean.ts")).toEqual([]);
  });

  it("does not flag reading a member of something else", () => {
    expect(errors("member-read.ts")).toEqual([]);
  });

  it("accepts a disable comment that carries a reason", () => {
    expect(errors("disabled-with-reason.ts")).toEqual([]);
  });

  it("accepts a disable comment with a reason for a file name", () => {
    expect(errors("favorite-file-disabled.ts")).toEqual([]);
  });

  it("rejects a disable comment without a reason, and the name it leaves unrenamed", () => {
    expect(errors("disabled-without-reason.ts").map((m) => m.ruleId).sort()).toEqual([
      "slugbase/no-forbidden-vocabulary",
      "slugbase/vocabulary-disable-reason",
    ]);
  });

  it("rejects a name under a blanket disable-line without a reason", () => {
    expect(errors("blanket-same-line-disable.ts").map((m) => m.ruleId).sort()).toEqual([
      "slugbase/no-forbidden-vocabulary",
      "slugbase/vocabulary-disable-reason",
    ]);
  });

  it("rejects a name under a file-wide blanket disable without a reason", () => {
    expect(errors("blanket-file-disable.ts").map((m) => m.ruleId)).toContain(
      "slugbase/no-forbidden-vocabulary",
    );
  });

  it("rejects a name under a disable-line that names both vocabulary rules without a reason", () => {
    expect(errors("both-rules-same-line-disable.ts").map((m) => m.ruleId).sort()).toEqual([
      "slugbase/no-forbidden-vocabulary",
      "slugbase/vocabulary-disable-reason",
    ]);
  });

  it("rejects a next-line disable of every rule without a reason", () => {
    expect(errors("blanket-disable-without-reason.ts").map((m) => m.ruleId)).toContain(
      "slugbase/vocabulary-disable-reason",
    );
  });

  it("exits non-zero when any fixture fails", () => {
    expect(lint.status).toBe(1);
  });
});

function scan(catalog: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [resolve(ROOT, "tooling/vocabulary/check-catalogs.ts"), resolve(ROOT, FIXTURES, "catalogs", catalog)],
    { encoding: "utf8", timeout: 60_000 },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("catalog scan", { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
  it("passes a clean catalog", () => {
    const result = scan("clean");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("1 catalog file(s) clean");
  });

  it("passes when there are no catalogs yet", () => {
    const result = scan("empty");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("0 catalog file(s) clean");
  });

  it("fails a forbidden word in a value", () => {
    const result = scan("bad-value");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/en\.json: value "Your Collections" at nav\.folders contains "collection".*"folder"/);
  });

  it("fails a forbidden word in a key", () => {
    const result = scan("bad-key");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/de\.json: key "organizationSwitcher" at nav\.organizationSwitcher.*"workspace"/);
  });

  it("fails closed on a catalog that does not parse", () => {
    const result = scan("malformed");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("vocabulary:");
  });

  it("scans the real repository catalogs", () => {
    const result = spawnSync(process.execPath, [resolve(ROOT, "tooling/vocabulary/check-catalogs.ts")], {
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(result.status).toBe(0);
  });
});
