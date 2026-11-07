import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { ROOT } from "./run.ts";

interface Budget {
  name: string;
  scenario: string;
  metric: string;
  limitMs: number;
}

interface BudgetsModule {
  SORTS: string[];
  PAGES: string[];
  FILTERS: string[];
  SCENARIOS: string[];
  SEARCH_TERMS: string[];
  SHARED_TERM: string;
  MAX_VUS: number;
  BUDGETS_MS: Record<string, number>;
  GO_HOT_REQUESTS: number;
  GO_HOT_METRIC: string;
  FLUSH_INTERVAL_SECONDS: number;
  writeLoadLimit: (elapsedSeconds: number) => number;
  budgets: () => Budget[];
  budgetThresholds: () => Record<string, string[]>;
  loadMetrics: (scenario: string) => { completed: string; dropped: string; activeVus: string };
  loadThresholds: () => Record<string, string[]>;
}

// The module is plain JavaScript that k6 and node both load, so it has no declaration file; a computed specifier keeps
// tsc from resolving it.
const specifier = pathToFileURL(resolve(ROOT, "scripts/perf/budgets.js")).href;
const { SORTS, PAGES, FILTERS, SCENARIOS, SEARCH_TERMS, SHARED_TERM, MAX_VUS, BUDGETS_MS, GO_HOT_REQUESTS, GO_HOT_METRIC, FLUSH_INTERVAL_SECONDS, budgets, budgetThresholds, loadMetrics, loadThresholds, writeLoadLimit } =
  (await import(specifier)) as BudgetsModule;

const read = (file: string): string => readFileSync(resolve(ROOT, "scripts/perf", file), "utf8");

// The terms the seed of the large instance puts in `fixtures.searchTerms`, read from its source (the module is TypeScript for another build, which tooling does not run).
function seedSearchTerms(): string[] {
  const source = readFileSync(resolve(ROOT, "packages/testing/src/seed/large.ts"), "utf8");
  const list = /const SEARCH_TERMS = (\[[^\]]*\]) as const;/.exec(source)?.[1];
  if (list === undefined) {
    throw new Error("the seed lists no SEARCH_TERMS");
  }
  return JSON.parse(list) as string[];
}

describe("performance budgets", () => {
  it("has a budget for each scenario, for each list sort on each page, for each page of the list narrowed by a text, for each filter of the list and for each search term", () => {
    const metrics = budgets().map((budget) => budget.metric);
    expect(metrics).toHaveLength(SCENARIOS.length + SORTS.length * PAGES.length + PAGES.length + FILTERS.length + SEARCH_TERMS.length + 1);
    expect(new Set(metrics).size).toBe(metrics.length);
    expect(metrics).toContain("http_req_waiting{kind:go}");
    expect(metrics).toContain("http_req_waiting{kind:list_q,page:first}");
    expect(metrics).toContain("http_req_waiting{kind:list_q,page:deep}");
    expect(metrics).toContain("http_req_waiting{kind:list_filter,filter:tag}");
    expect(metrics).toContain("http_req_waiting{kind:list_filter,filter:folder}");
    expect(metrics).toContain("http_req_waiting{kind:list,sort:title_desc,page:deep}");
    expect(metrics).toContain("http_req_waiting{kind:search,term:release notes}");
    expect(metrics).toContain(`http_req_waiting{kind:search,term:${SHARED_TERM}}`);
  });

  it("names the search terms of the large instance's seed, so that a regression names the term and a term of the seed is never measured unreported", () => {
    expect(SEARCH_TERMS).toEqual(seedSearchTerms());
    expect(SEARCH_TERMS).not.toContain(SHARED_TERM);
    expect(budgets().filter((budget) => budget.scenario === "search" && budget.name !== "search").map((budget) => budget.name)).toEqual([...SEARCH_TERMS, SHARED_TERM].map((term) => `search ${term}`));
  });

  it("names the list narrowed by a text and the list under a filter by shape and page, each with the 100 ms of the list", () => {
    const named = budgets().filter((budget) => budget.scenario === "list_q" || budget.scenario === "list_filter");
    expect(named.map((budget) => budget.name)).toEqual(["list q", "list filter", "list q first", "list q deep", "list filter tag", "list filter folder"]);
    for (const budget of named) {
      expect(budget.limitMs, budget.name).toBe(100);
    }
  });

  it("limits each budget to its scenario's", () => {
    for (const { metric, limitMs, scenario } of budgets()) {
      const kind = /kind:(\w+)/.exec(metric)?.[1] ?? "";
      expect(kind, metric).toBe(scenario);
      expect(limitMs, metric).toBe(BUDGETS_MS[kind]);
    }
    expect(Object.keys(BUDGETS_MS).sort()).toEqual([...SCENARIOS].sort());
  });

  it("is exactly the set of budget thresholds the scenarios set, so none can end k6 with 99 unreported", () => {
    const thresholds = budgetThresholds();
    expect(Object.keys(thresholds).sort()).toEqual(budgets().map((budget) => budget.metric).sort());
    for (const { metric, limitMs } of budgets()) {
      expect(thresholds[metric], metric).toEqual([`p(95)<${String(limitMs)}`]);
    }
  });

  it("reports the load of each scenario by thresholds that no value can fail, so a saturated run is reported and never ends k6 with 99", () => {
    const thresholds = loadThresholds();
    const wanted = SCENARIOS.flatMap((scenario) => Object.values(loadMetrics(scenario)));
    expect(Object.keys(thresholds).sort()).toEqual([...wanted].sort());
    expect(new Set(wanted).size).toBe(SCENARIOS.length * 3);
    for (const [metric, rules] of Object.entries(thresholds)) {
      // A count and a maximum are never negative: these hold for any run, with samples or without.
      expect(rules, metric).toEqual([metric.startsWith("active_vus") ? "max>=0" : "count>=0"]);
    }
    for (const metric of Object.keys(thresholds)) {
      expect(Object.keys(budgetThresholds()), metric).not.toContain(metric);
    }
    expect(MAX_VUS).toBe(100);
  });

  it("allows /go one update of bookmarks for each flush interval of the load and one more for the flush after it", () => {
    expect(GO_HOT_REQUESTS).toBe(10_000);
    expect(FLUSH_INTERVAL_SECONDS).toBe(10);
    expect(writeLoadLimit(0.5)).toBe(2);
    expect(writeLoadLimit(10)).toBe(2);
    expect(writeLoadLimit(10.1)).toBe(3);
    expect(writeLoadLimit(35)).toBe(5);
    // The load is a set of its own, so its requests are no budget and no budget threshold names it.
    expect(GO_HOT_METRIC).toBe("http_reqs{kind:go_hot}");
    expect(Object.keys(budgetThresholds())).not.toContain(GO_HOT_METRIC);
    expect(Object.keys(loadThresholds())).not.toContain(GO_HOT_METRIC);
  });

  it("requests the list narrowed by a text, the list under a filter and the archived slugs of /go, and counts the requests for one slug", () => {
    const scenarios = read("scenarios.js");
    expect(scenarios).toMatch(/\/api\/v1\/bookmarks\?\$\{textQuery\(/);
    expect(scenarios).toMatch(/kind: "list_q", page/);
    expect(scenarios).toMatch(/kind: "list_filter", filter/);
    expect(scenarios).toMatch(/fixtures\.tagIds/);
    expect(scenarios).toMatch(/fixtures\.folderIds/);
    expect(scenarios).toMatch(/kind: "archived", weight: \d+, slugs: \(\) => fixtures\.archivedSlugs/);
    expect(scenarios).toMatch(/the slug of an archived bookmark is not found": \(r\) => r\.status === 404/);
    expect(scenarios).toMatch(/\[GO_HOT_METRIC\]: \[`count==\$\{GO_HOT_REQUESTS\}`\]/);
    expect(scenarios).toMatch(/iterations: GO_HOT_REQUESTS/);
    expect(scenarios).not.toMatch(/10_?000/);
    const runner = read("run.mjs");
    expect(runner).toMatch(/writeLoadLimit\(/);
    expect(runner).not.toMatch(/10_?000/);
  });

  it("tags each search request by its term, and by the shared tag for the slugs members share, with the load reported from the same module", () => {
    const scenarios = read("scenarios.js");
    expect(scenarios).toMatch(/\.\.\.loadThresholds\(\)/);
    expect(scenarios).toMatch(/term: useShared \? SHARED_TERM : term/);
    expect(scenarios).toMatch(/maxVUs: MAX_VUS/);
    expect(scenarios).not.toMatch(/shared: String\(useShared\)/);
    expect(scenarios).toMatch(/activeVus\.add\(execution\.instance\.vusActive, \{ kind: "search" \}\)/);
    const runner = read("run.mjs");
    expect(runner).toMatch(/loadMetrics/);
    expect(runner).not.toMatch(/(dropped_iterations|active_vus|http_reqs)\{/);
  });

  it("is what scenarios.js and run.mjs read, with no copy of their own", () => {
    const scenarios = read("scenarios.js");
    const runner = read("run.mjs");
    expect(scenarios).toMatch(/import \{[^}]*\bbudgetThresholds\b[^}]*\} from "\.\/budgets\.js"/);
    expect(scenarios).toMatch(/\.\.\.budgetThresholds\(\)/);
    expect(scenarios).not.toMatch(/http_req_waiting\{/);
    expect(scenarios).not.toMatch(/const (SORTS|PAGES|BUDGETS_MS)\b/);
    expect(runner).toMatch(/import \{[^}]*\bbudgets as \w+\b[^}]*\} from "\.\/budgets\.js"/);
    expect(runner).not.toMatch(/http_req_waiting\{/);
  });

  it("imports nothing, so k6 and node can both load it", () => {
    expect(read("budgets.js")).not.toMatch(/^\s*import\b/m);
  });
});
