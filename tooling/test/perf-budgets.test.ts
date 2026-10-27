import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { ROOT } from "./run.ts";

interface Budget {
  name: string;
  metric: string;
  limitMs: number;
}

interface BudgetsModule {
  SORTS: string[];
  PAGES: string[];
  BUDGETS_MS: Record<"go" | "list" | "search", number>;
  budgets: () => Budget[];
  budgetThresholds: () => Record<string, string[]>;
}

// The module is plain JavaScript that k6 and node both load, so it has no declaration file; a computed specifier keeps
// tsc from resolving it.
const specifier = pathToFileURL(resolve(ROOT, "scripts/perf/budgets.js")).href;
const { SORTS, PAGES, BUDGETS_MS, budgets, budgetThresholds } = (await import(specifier)) as BudgetsModule;

const read = (file: string): string => readFileSync(resolve(ROOT, "scripts/perf", file), "utf8");

describe("performance budgets", () => {
  it("has a budget for each scenario and for each list sort on each page", () => {
    const metrics = budgets().map((budget) => budget.metric);
    expect(metrics).toHaveLength(3 + SORTS.length * PAGES.length);
    expect(new Set(metrics).size).toBe(metrics.length);
    expect(metrics).toContain("http_req_waiting{kind:go}");
    expect(metrics).toContain("http_req_waiting{kind:list,sort:title_desc,page:deep}");
  });

  it("limits each budget to its scenario's", () => {
    for (const { metric, limitMs } of budgets()) {
      const kind = /kind:(go|list|search)/.exec(metric)?.[1] as keyof typeof BUDGETS_MS;
      expect(limitMs, metric).toBe(BUDGETS_MS[kind]);
    }
  });

  it("is exactly the set of budget thresholds the scenarios set, so none can end k6 with 99 unreported", () => {
    const thresholds = budgetThresholds();
    expect(Object.keys(thresholds).sort()).toEqual(budgets().map((budget) => budget.metric).sort());
    for (const { metric, limitMs } of budgets()) {
      expect(thresholds[metric], metric).toEqual([`p(95)<${String(limitMs)}`]);
    }
  });

  it("is what scenarios.js and run.mjs read, with no copy of their own", () => {
    const scenarios = read("scenarios.js");
    const runner = read("run.mjs");
    expect(scenarios).toMatch(/import \{[^}]*\bbudgetThresholds\b[^}]*\} from "\.\/budgets\.js"/);
    expect(scenarios).toMatch(/\.\.\.budgetThresholds\(\)/);
    expect(scenarios).not.toMatch(/http_req_waiting\{/);
    expect(scenarios).not.toMatch(/const (SORTS|PAGES|BUDGETS_MS)\b/);
    expect(runner).toMatch(/import \{ budgets as \w+ \} from "\.\/budgets\.js"/);
    expect(runner).not.toMatch(/http_req_waiting\{/);
  });

  it("imports nothing, so k6 and node can both load it", () => {
    expect(read("budgets.js")).not.toMatch(/^\s*import\b/m);
  });
});
