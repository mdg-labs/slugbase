import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { ROOT } from "./run.ts";

interface Budget {
  name: string;
  scenario: string;
  metric: string;
  limitMs?: number;
  of?: string;
  limitRatio?: number;
}

interface RatioRow {
  name: string;
  scenario: string;
  metric: string;
  p95Ms: number;
  ok: boolean;
  saturated: boolean;
  limitMs?: number;
  of?: string;
  limitRatio?: number;
  baselineP95Ms?: number;
  baselineSaturated?: boolean;
  ratio?: number | null;
  judged?: boolean;
  notJudged?: string;
  saturatedMiss?: string;
}

interface BudgetsModule {
  SORTS: string[];
  PAGES: string[];
  FILTERS: string[];
  SUGGEST_PREFIXES: string[];
  SCENARIOS: string[];
  STEADY_SCENARIOS: string[];
  IMPORT_SCENARIOS: string[];
  CREATES_SCENARIO: string;
  CREATE_PHASES: string[];
  CREATE_RATE: number;
  IMPORTER_EMAIL: string;
  CREATOR_EMAIL: string;
  IMPORT_STATES: string[];
  IMPORT_PHASE: { maxRepeats: number; targetSeconds: number; rate: number; windowSeconds: number; minSeconds: number; minRequests: number };
  importSampleShortfalls: (sample: { inFlightSeconds: number; completed: Record<string, number> }) => string[];
  createMetrics: (phase: string) => { p95: string; completed: string };
  createThresholds: () => Record<string, string[]>;
  SEARCH_TERMS: string[];
  SHARED_TERM: string;
  MAX_VUS: number;
  BUDGETS_MS: Record<string, number>;
  RATIO_BUDGETS: Record<string, { of: string; ratio: number }>;
  judgeRatios: (rows: RatioRow[], loads: Record<string, { dropped: number; saturated: boolean; peakVus: number; maxVus: number }>) => RatioRow[];
  GO_HOT_REQUESTS: number;
  GO_HOT_METRIC: string;
  FLUSH_INTERVAL_SECONDS: number;
  writeLoadLimit: (elapsedSeconds: number) => number;
  budgets: (scenarios?: string[]) => Budget[];
  budgetThresholds: (scenarios?: string[]) => Record<string, string[]>;
  loadMetrics: (scenario: string) => { completed: string; dropped: string; activeVus: string };
  loadThresholds: (scenarios?: string[]) => Record<string, string[]>;
}

// The module is plain JavaScript that k6 and node both load, so it has no declaration file; a computed specifier keeps
// tsc from resolving it.
const specifier = pathToFileURL(resolve(ROOT, "scripts/perf/budgets.js")).href;
const {
  SORTS,
  PAGES,
  FILTERS,
  SUGGEST_PREFIXES,
  SCENARIOS,
  STEADY_SCENARIOS,
  IMPORT_SCENARIOS,
  CREATES_SCENARIO,
  CREATE_PHASES,
  CREATE_RATE,
  IMPORTER_EMAIL,
  CREATOR_EMAIL,
  IMPORT_STATES,
  IMPORT_PHASE,
  importSampleShortfalls,
  createMetrics,
  createThresholds,
  SEARCH_TERMS,
  SHARED_TERM,
  MAX_VUS,
  BUDGETS_MS,
  RATIO_BUDGETS,
  judgeRatios,
  GO_HOT_REQUESTS,
  GO_HOT_METRIC,
  FLUSH_INTERVAL_SECONDS,
  budgets,
  budgetThresholds,
  loadMetrics,
  loadThresholds,
  writeLoadLimit,
} = (await import(specifier)) as BudgetsModule;

interface Summary {
  metrics: Record<string, Record<string, number>>;
}

interface Load {
  completed: number;
  dropped: number;
  peakVus: number;
  maxVus: number;
  vusOf: string;
  saturated: boolean;
}

interface Evaluated {
  budgets: { name: string; p95Ms: number; limitMs?: number; ok: boolean; saturated: boolean }[];
  scenarios: Record<string, Load>;
}

interface Sampled {
  pool: { intervalMs: number; samples: number; size: number; max: number; p95: number; samplesAboveSize: number };
  lockWaits: { intervalMs: number; samples: number; max: number; p95: number };
}

// The runner is a script that does nothing but export `evaluate`, `loadOf`, `createsOf`, `summarizeSamples` and `startSampler` when it is imported rather than run.
const runnerSpecifier = pathToFileURL(resolve(ROOT, "scripts/perf/run.mjs")).href;
const { evaluate, loadOf, createsOf, startSampler, summarizeSamples } = (await import(runnerSpecifier)) as {
  evaluate: (summary: Summary, ids: string[], vus?: { capacity: number; of: string }) => Evaluated;
  loadOf: (summary: Summary, scenario: string, vus: { capacity: number; of: string }) => Load;
  createsOf: (summary: Summary) => Record<string, unknown> & { dropped: number };
  startSampler: (options: { held: { state: string }; metricsPort: number; serverUrl: string; databaseName: string; lockWaitTimeoutMs?: number }) => { stop: () => Promise<Sampled> };
  summarizeSamples: (values: number[]) => { max: number; p95: number };
};

// The k6 summary of a run in which every shape of `ids` was requested `requests` times: the p(95) of each budget (half its limit), the count of its requests, and the load of each scenario.
// `without` names the budget metrics whose requests are left out, which k6 1.3.0 writes as zeros.
function summaryOf(ids: string[], { requests = 20, without = [], peakVus = 3 }: { requests?: number; without?: string[]; peakVus?: number } = {}): Summary {
  const metrics: Summary["metrics"] = {};
  for (const { metric, limitMs } of budgets(ids)) {
    const none = without.includes(metric);
    metrics[metric] = { "p(95)": none ? 0 : (limitMs ?? 20) / 2 };
    metrics[metric.replace(/^http_req_waiting/, "http_reqs")] = { count: none ? 0 : requests };
  }
  for (const scenario of ids) {
    const load = loadMetrics(scenario);
    metrics[load.completed] = { count: without.includes(`http_req_waiting{kind:${scenario}}`) ? 0 : requests };
    metrics[load.dropped] = { count: 0 };
    metrics[load.activeVus] = { max: peakVus };
  }
  return { metrics };
}

// The summary with one entry left out, as when k6 writes none.
const omitting = (summary: Summary, key: string): Summary => ({ metrics: Object.fromEntries(Object.entries(summary.metrics).filter(([name]) => name !== key)) });

// The committed ratios, set by the rule of #806 over the nightly runs on the runner (scripts/perf/README.md, "The import phase").
const GO_RATIO = 8.4;
const LIST_RATIO = 9.0;

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
  it("has a budget for each scenario, for each list sort on each page, for each page of the list narrowed by a text, for each filter of the list on each page, for each prefix of the slug suggestions and for each search term", () => {
    const metrics = budgets().map((budget) => budget.metric);
    expect(metrics).toHaveLength(SCENARIOS.length + SORTS.length * PAGES.length + PAGES.length + FILTERS.length * PAGES.length + SUGGEST_PREFIXES.length + SEARCH_TERMS.length + 1);
    expect(new Set(metrics).size).toBe(metrics.length);
    expect(metrics).toContain("http_req_waiting{kind:go}");
    expect(metrics).toContain("http_req_waiting{kind:list_q,page:first}");
    expect(metrics).toContain("http_req_waiting{kind:list_q,page:deep}");
    expect(metrics).toContain("http_req_waiting{kind:list_filter,filter:tag,page:first}");
    expect(metrics).toContain("http_req_waiting{kind:list_filter,filter:tag,page:deep}");
    expect(metrics).toContain("http_req_waiting{kind:list_filter,filter:folder,page:first}");
    expect(metrics).toContain("http_req_waiting{kind:list_filter,filter:folder,page:deep}");
    expect(metrics).toContain("http_req_waiting{kind:go_suggest}");
    expect(metrics).toContain("http_req_waiting{kind:go_suggest,prefix:short}");
    expect(metrics).toContain("http_req_waiting{kind:dashboard}");
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
    expect(named.map((budget) => budget.name)).toEqual([
      "list q",
      "list filter",
      "list q first",
      "list q deep",
      "list filter tag first",
      "list filter tag deep",
      "list filter folder first",
      "list filter folder deep",
    ]);
    for (const budget of named) {
      expect(budget.limitMs, budget.name).toBe(100);
    }
  });

  it("holds the slug suggestions to 50 ms, by prefix, and the dashboard to the 100 ms of a page, each in a scenario of its own that runs after the others", () => {
    expect(SUGGEST_PREFIXES).toEqual(["short", "word", "full"]);
    expect(BUDGETS_MS.go_suggest).toBe(50);
    expect(BUDGETS_MS.dashboard).toBe(100);
    const named = budgets().filter((budget) => budget.scenario === "go_suggest" || budget.scenario === "dashboard");
    expect(named.map((budget) => [budget.name, budget.limitMs])).toEqual([
      ["go suggest", 50],
      ["dashboard", 100],
      ["go suggest short", 50],
      ["go suggest word", 50],
      ["go suggest full", 50],
    ]);
    // The scenarios that were there keep their place (and so their start) in the run.
    expect(STEADY_SCENARIOS).toEqual(["go", "list", "search", "list_q", "list_filter", "go_suggest", "dashboard"]);
    expect(budgetThresholds(["go_suggest"])).toEqual({
      "http_req_waiting{kind:go_suggest}": ["p(95)<50"],
      "http_req_waiting{kind:go_suggest,prefix:short}": ["p(95)<50"],
      "http_req_waiting{kind:go_suggest,prefix:word}": ["p(95)<50"],
      "http_req_waiting{kind:go_suggest,prefix:full}": ["p(95)<50"],
    });
  });

  it("requests the suggestions, the dashboard and the pages under a filter as the web app and the seed have them, and takes the shape of each arrival in turn so that none is left out of a run", () => {
    const scenarios = read("scenarios.js");
    const seed = readFileSync(resolve(ROOT, "packages/testing/src/seed/large.ts"), "utf8");
    const contracts = ["go.ts", "dashboard.ts"].map((file) => readFileSync(resolve(ROOT, "packages/contracts/src/operations", file), "utf8")).join("\n");
    const web = readFileSync(resolve(ROOT, "packages/web/src/dashboard/dashboard.ts"), "utf8");
    // The operations exist, and the dashboard is the one the web app calls.
    expect(contracts).toContain('path: "/api/v1/go/suggest"');
    expect(contracts).toContain('path: "/api/v1/dashboard"');
    expect(web).toContain('api.GET("/api/v1/dashboard"');
    expect(scenarios).toMatch(/\/api\/v1\/go\/suggest\?prefix=\$\{encodeURIComponent\(text\)\}/);
    expect(scenarios).toContain('get("/api/v1/dashboard"');
    // The prefixes are made of the seed's own forwarding slugs, which are a word of the seed's list with or without a number (`docs`, `docs-12`), and the filters of its tags and folders of the admin's.
    expect(seed).toMatch(/slugs: forwarding\.filter\(/);
    expect(seed).toMatch(/return count === 1 \? word : `\$\{word\}-\$\{String\(count\)\}`;/);
    expect(seed).toMatch(/tagIds: large\.tags\.filter\(\(tag\) => tag\.ownerId === admin\.id\)/);
    expect(seed).toMatch(/folderIds: large\.folders\.filter\(\(folder\) => folder\.ownerId === admin\.id\)/);
    expect(scenarios).toMatch(/fixtures\.slugs\[Math\.floor\(arrival \/ SUGGEST_PREFIXES\.length\) % fixtures\.slugs\.length\]/);
    expect(scenarios).toMatch(/kind: "go_suggest", prefix \}/);
    expect(scenarios).toMatch(/kind: "list_filter", filter, page \}/);
    expect(scenarios).toMatch(/fixtures\.tagIds/);
    expect(scenarios).toMatch(/fixtures\.folderIds/);
    // Each arrival takes its shape from its number and not by chance, so that a short run requests every shape.
    expect(scenarios).toMatch(/SUGGEST_PREFIXES\[arrival % SUGGEST_PREFIXES\.length\]/);
    expect(scenarios).toMatch(/FILTER_SHAPES\[arrival % FILTER_SHAPES\.length\]/);
    const shapes = scenarios.slice(scenarios.indexOf("export function listFilter"), scenarios.indexOf("export function dashboard"));
    expect(shapes).not.toContain("Math.random");
    // So do the list, the list narrowed by a text and the search: the twelve shapes of the list, the two pages of the text and the terms of the search with the shared slugs.
    expect(scenarios).toMatch(/LIST_SHAPES\[execution\.scenario\.iterationInTest % LIST_SHAPES\.length\]/);
    expect(scenarios).toMatch(/PAGES\[arrival % PAGES\.length\]/);
    expect(scenarios).toMatch(/terms\[arrival % terms\.length\]/);
    const listShapes = scenarios.slice(scenarios.indexOf("const LIST_SHAPES"), scenarios.indexOf("export function listFilter"));
    expect(listShapes).not.toContain("Math.random");
    expect(SORTS.length * PAGES.length).toBe(12);
    expect(read("README.md")).toMatch(/12 for `list`, the most, 8 for `search`/);
    expect(SEARCH_TERMS.length + 1).toBe(8);
    // A deep page is requested with a cursor that setup() found under the same filter, and a filter with none ends the run.
    expect(scenarios).toMatch(/data\.filterCursors\[filter\]\[turn % data\.filterCursors\[filter\]\.length\]/);
    expect(scenarios).toMatch(/no \$\{filter\} of the instance holds enough bookmarks for a deep page/);
    // The limits are not touched: the suggestions take a token of the go bucket and the dashboard one of the read bucket, which the run raises like the others.
    expect(contracts).toMatch(/operationId: "suggestSlugs"[^}]*rate: "go"/s);
    expect(contracts).toMatch(/operationId: "getDashboard"[^}]*rate: "read"/s);
    const runner = read("run.mjs");
    for (const key of ["RATE_LIMIT_GO_IP", "RATE_LIMIT_GO_ACCOUNT", "RATE_LIMIT_READ_IP", "RATE_LIMIT_READ_ACCOUNT"]) {
      expect(runner, key).toMatch(new RegExp(`${key}: UNLIMITED`));
    }
    expect(scenarios).toMatch(/maxVUs: MAX_VUS/);
  });

  it("fails the run on a budget with no request, in the budgets run and in the import run, never reading k6's zero as 0 ms and ok", () => {
    for (const ids of [STEADY_SCENARIOS, IMPORT_SCENARIOS]) {
      // Every shape requested: the budgets are judged, and the p(95) is the one k6 wrote.
      const healthy = evaluate(summaryOf(ids), ids);
      expect(healthy.budgets.map((budget) => budget.name)).toEqual(budgets(ids).map((budget) => budget.name));
      expect(healthy.budgets.every((budget) => budget.ok && budget.p95Ms > 0)).toBe(true);
      // One shape with no request at all, whichever it is: k6 wrote a p(95) of 0 for it, which would be ok, and the run fails by its name instead.
      for (const { name, scenario, metric, limitMs } of budgets(ids)) {
        const summary = summaryOf(ids, { without: [metric] });
        expect(summary.metrics[metric], metric).toEqual({ "p(95)": 0 });
        expect(limitMs === undefined || 0 < limitMs).toBe(true);
        // A scenario with no request at all is caught by its load, one shape of it by the budget's own count.
        const wholeScenario = metric === `http_req_waiting{kind:${scenario}}`;
        expect(() => evaluate(summary, ids), metric).toThrow(wholeScenario ? /made no request/ : `no request was made for "${name}"`);
      }
    }
    // Several shapes with none are all named.
    const some = budgets(STEADY_SCENARIOS).filter((budget) => budget.name === "search do" || budget.name === "go suggest word");
    expect(some).toHaveLength(2);
    expect(() => evaluate(summaryOf(STEADY_SCENARIOS, { without: some.map((budget) => budget.metric) }), STEADY_SCENARIOS)).toThrow(/"search do", "go suggest word"|"go suggest word", "search do"/);
    // The count is missing, or is not a number: an error as well, never a pass.
    const search = budgets(STEADY_SCENARIOS).find((budget) => budget.name === "search do");
    const summary = omitting(summaryOf(STEADY_SCENARIOS), (search?.metric ?? "").replace(/^http_req_waiting/, "http_reqs"));
    expect(() => evaluate(summary, STEADY_SCENARIOS)).toThrow(/no request count or p\(95\)/);
  });

  it("asks k6 for the count of the requests behind every budget, from the tags of the budget", () => {
    const scenarios = read("scenarios.js");
    expect(scenarios).toMatch(/for \(const \{ metric \} of budgets\(scenarios\)\)/);
    expect(scenarios).toContain('samples[metric.replace(/^http_req_waiting/, "http_reqs")] = ["count>=0"];');
    expect(scenarios).toMatch(/\.\.\.sampleThresholds\(IMPORT \? IMPORT_SCENARIOS : STEADY_SCENARIOS\)/);
    expect(read("run.mjs")).toContain('metric.replace(/^http_req_waiting/u, "http_reqs")');
  });

  it("fails the run on a scenario with no request or no entry for its load, and reads a dropped count of 0 as 0", () => {
    const vus = { capacity: MAX_VUS, of: "scenario" };
    const ok = summaryOf(["go"]);
    expect(loadOf(ok, "go", vus)).toEqual({ completed: 20, dropped: 0, peakVus: 3, maxVus: MAX_VUS, vusOf: "scenario", saturated: false });
    const { completed, dropped, activeVus } = loadMetrics("go");
    for (const metric of [completed, dropped, activeVus]) {
      expect(() => loadOf(omitting(summaryOf(["go"]), metric), "go", vus), metric).toThrow(/no requests, dropped arrivals or VUs/);
    }
    const none = summaryOf(["go"]);
    none.metrics[completed] = { count: 0 };
    expect(() => loadOf(none, "go", vus)).toThrow(/made no request/);
    const dropping = summaryOf(["go"]);
    dropping.metrics[dropped] = { count: 3 };
    expect(loadOf(dropping, "go", vus).saturated).toBe(true);
  });

  it("fails the run on creates with no entry for their dropped arrivals, and reads a dropped count of 0 as 0", () => {
    const metrics: Summary["metrics"] = {};
    for (const phase of CREATE_PHASES) {
      const { p95, completed } = createMetrics(phase);
      metrics[p95] = { "p(95)": 12 };
      metrics[completed] = { count: 40 };
    }
    const dropped = `dropped_iterations{scenario:${CREATES_SCENARIO}}`;
    metrics[dropped] = { count: 0 };
    expect(createsOf({ metrics }).dropped).toBe(0);
    metrics[dropped] = { count: 2 };
    expect(createsOf({ metrics }).dropped).toBe(2);
    expect(() => createsOf(omitting({ metrics }, dropped))).toThrow(/no dropped arrivals for the creates/);
  });

  it("reports the VUs of the import run as the run's, against the VUs the run may use, so no figure claims more than that and no scenario is saturated by the others", () => {
    // The creates, /go, the list and the importer are active together: 221 VUs are more than a scenario's 100 and fewer than the 301 the run may use.
    const together = { capacity: MAX_VUS * (IMPORT_SCENARIOS.length + 1) + 1, of: "run" };
    expect(together.capacity).toBe(301);
    const summary = summaryOf(IMPORT_SCENARIOS, { peakVus: 221 });
    const imported = evaluate(summary, IMPORT_SCENARIOS, together);
    for (const scenario of IMPORT_SCENARIOS) {
      expect(imported.scenarios[scenario], scenario).toMatchObject({ peakVus: 221, maxVus: 301, vusOf: "run", saturated: false });
    }
    expect(imported.budgets.every((budget) => !budget.saturated)).toBe(true);
    // The runner passes it for the import run only; the scenarios of the budgets run are alone, so their peak is theirs, against the 100 of one.
    expect(read("run.mjs")).toMatch(/evaluate\(summary, IMPORT_SCENARIOS, \{ capacity: MAX_VUS \* \(IMPORT_SCENARIOS\.length \+ 1\) \+ 1, of: "run" \}\)/);
    const alone = evaluate(summaryOf(STEADY_SCENARIOS, { peakVus: MAX_VUS }), STEADY_SCENARIOS);
    expect(Object.values(alone.scenarios).every((load) => load.maxVus === MAX_VUS && load.vusOf === "scenario" && load.saturated)).toBe(true);
    // Four scenarios of the import run in k6: the three that overlap and the importer.
    const scenarios = read("scenarios.js");
    const set = scenarios.slice(scenarios.indexOf("function importScenarios"), scenarios.indexOf("// The VUs active at the start"));
    expect(set.match(/maxVUs: MAX_VUS/g)).toHaveLength(2);
    expect(set).toMatch(/\[CREATES_SCENARIO\]: \{/);
    expect(set).toMatch(/importer: \{ executor: "per-vu-iterations", vus: 1,/);
    expect(set).toMatch(/go_import: load\(/);
    expect(set).toMatch(/list_import: load\(/);
  });

  it("limits each budget to its scenario's", () => {
    for (const { metric, limitMs, limitRatio, of, scenario } of budgets()) {
      const kind = /kind:(\w+)/.exec(metric)?.[1] ?? "";
      expect(kind, metric).toBe(scenario);
      // A scenario has a limit in milliseconds or a ratio to a steady scenario, never both.
      if (RATIO_BUDGETS[kind] === undefined) {
        expect(limitMs, metric).toBe(BUDGETS_MS[kind]);
        expect(limitRatio, metric).toBeUndefined();
      } else {
        expect(limitMs, metric).toBeUndefined();
        expect({ of, limitRatio }, metric).toEqual({ of: RATIO_BUDGETS[kind].of, limitRatio: RATIO_BUDGETS[kind].ratio });
      }
    }
    expect([...Object.keys(BUDGETS_MS), ...Object.keys(RATIO_BUDGETS)].sort()).toEqual([...SCENARIOS].sort());
  });

  it("is exactly the set of budget thresholds the scenarios set, so none can end k6 with 99 unreported", () => {
    const thresholds = budgetThresholds();
    expect(Object.keys(thresholds).sort()).toEqual(budgets().map((budget) => budget.metric).sort());
    for (const { metric, limitMs } of budgets()) {
      // k6 enforces a limit in milliseconds; a ratio has none k6 could hold, so its threshold is one no value fails and k6 only exports the p(95).
      expect(thresholds[metric], metric).toEqual([limitMs === undefined ? "p(95)>=0" : `p(95)<${String(limitMs)}`]);
    }
    // The budgets run and the import run each set the thresholds of their own scenarios, and together they are all of them.
    expect([...STEADY_SCENARIOS, ...IMPORT_SCENARIOS]).toEqual(SCENARIOS);
    expect(new Set(SCENARIOS).size).toBe(SCENARIOS.length);
    const steady = Object.keys(budgetThresholds(STEADY_SCENARIOS));
    const imported = Object.keys(budgetThresholds(IMPORT_SCENARIOS));
    expect(steady.filter((metric) => imported.includes(metric))).toEqual([]);
    expect([...steady, ...imported].sort()).toEqual(Object.keys(thresholds).sort());
  });

  it("has the /go and list budgets during an import as ratios to the same run's steady /go and list, named for the import, with the steady budgets in milliseconds and unchanged", () => {
    expect(IMPORT_SCENARIOS).toEqual(["go_import", "list_import"]);
    expect(RATIO_BUDGETS).toEqual({ go_import: { of: "go", ratio: GO_RATIO }, list_import: { of: "list", ratio: LIST_RATIO } });
    expect(budgets(IMPORT_SCENARIOS)).toEqual([
      { name: "go during import", scenario: "go_import", metric: "http_req_waiting{kind:go_import}", of: "go", limitRatio: GO_RATIO },
      { name: "list during import", scenario: "list_import", metric: "http_req_waiting{kind:list_import}", of: "list", limitRatio: LIST_RATIO },
    ]);
    expect(BUDGETS_MS).toEqual({ go: 30, go_suggest: 50, list: 100, search: 100, list_q: 100, list_filter: 100, dashboard: 100 });
    // There is no millisecond limit of the import scenarios for k6 to fail the run on: its thresholds only put the p(95) in the summary, and run.mjs judges the ratio.
    expect(budgetThresholds(IMPORT_SCENARIOS)).toEqual({ "http_req_waiting{kind:go_import}": ["p(95)>=0"], "http_req_waiting{kind:list_import}": ["p(95)>=0"] });
    expect(budgets(STEADY_SCENARIOS).map((budget) => budget.scenario)).not.toContain("go_import");
    // Both are ratios of the steady scenarios that are budgets of the budgets run, one decimal each, above 1 (an import may not make a request faster than none).
    for (const { of, ratio } of Object.values(RATIO_BUDGETS)) {
      expect(STEADY_SCENARIOS).toContain(of);
      expect(ratio).toBeGreaterThan(1);
      expect(Math.round(ratio * 10) / 10).toBe(ratio);
    }
    expect(read("run.mjs")).toContain("judgeRatios([...steady.budgets, ...importRun.budgets], scenarios)");
  });

  describe("the ratio budgets of the import phase", () => {
    const load = { dropped: 0, saturated: false, peakVus: 3, maxVus: 301 };
    const loads = { go: load, list: load, go_import: load, list_import: load };
    // The rows of one run as run.mjs hands them to `judgeRatios`: the steady budgets of go and list with the p95 of the run, and the import budgets as `evaluate` leaves them (the p95 and nothing judged).
    const rows = (p95: { go: number; list: number; goImport: number; listImport: number }): RatioRow[] =>
      budgets()
        .filter((budget) => ["go", "list", "go_import", "list_import"].includes(budget.scenario) && /^http_req_waiting\{kind:\w+\}$/.test(budget.metric))
        .map((budget) => ({ ...budget, p95Ms: { go: p95.go, list: p95.list, go_import: p95.goImport, list_import: p95.listImport }[budget.scenario] ?? 0, ok: true, saturated: false }));
    const importRows = (judged: RatioRow[]): RatioRow[] => judged.filter((row) => row.limitRatio !== undefined);

    it("passes a ratio under its limit, with both p95, the ratio and the limit on the row", () => {
      const [go, list] = importRows(judgeRatios(rows({ go: 10, list: 15, goImport: 10 * GO_RATIO - 1, listImport: 15 * LIST_RATIO - 1 }), loads));
      expect(go).toMatchObject({ name: "go during import", of: "go", p95Ms: 10 * GO_RATIO - 1, baselineP95Ms: 10, limitRatio: GO_RATIO, judged: true, ok: true });
      expect(go?.ratio).toBeCloseTo(GO_RATIO - 0.1, 5);
      expect(list).toMatchObject({ name: "list during import", of: "list", baselineP95Ms: 15, limitRatio: LIST_RATIO, judged: true, ok: true });
    });

    it("passes a ratio exactly at its limit and misses one above it, whatever the milliseconds are", () => {
      const at = importRows(judgeRatios(rows({ go: 10, list: 20, goImport: 10 * GO_RATIO, listImport: 20 * LIST_RATIO }), loads));
      expect(at.map((row) => [row.ratio, row.ok])).toEqual([[GO_RATIO, true], [LIST_RATIO, true]]);
      const miss = importRows(judgeRatios(rows({ go: 10, list: 20, goImport: 10 * GO_RATIO + 1, listImport: 20 * LIST_RATIO + 1 }), loads));
      expect(miss.map((row) => [row.judged, row.ok])).toEqual([[true, false], [true, false]]);
      expect(miss[0]?.ratio).toBeGreaterThan(GO_RATIO);
      // A slow runner: 150 ms during an import is far above the 55 ms the budget was, and it passes against a steady go of 50 ms; the same 150 ms against a steady go of 10 ms does not.
      const slow = importRows(judgeRatios(rows({ go: 50, list: 60, goImport: 150, listImport: 180 }), loads));
      expect(slow.every((row) => row.judged && row.ok)).toBe(true);
      expect(importRows(judgeRatios(rows({ go: 10, list: 60, goImport: 150, listImport: 180 }), loads))[0]).toMatchObject({ judged: true, ok: false });
    });

    it("does not judge a ratio whose steady baseline is saturated or dropped arrivals while its own scenario is clean, and says which", () => {
      const slow = rows({ go: 10, list: 15, goImport: 1000, listImport: 1000 });
      // Saturated baseline: the p95 of go is the time of a queue, so no ratio to it is a measurement; the steady budget of go reports the queue, and the import is not its cause.
      const baseline = importRows(judgeRatios(slow, { ...loads, go: { ...load, saturated: true } }));
      expect(baseline[0]).toMatchObject({ judged: false, ratio: null, ok: true, notJudged: "go (the steady baseline) was saturated", baselineP95Ms: 10, baselineSaturated: false });
      expect(baseline[0]).not.toHaveProperty("saturatedMiss");
      expect(baseline[1]).toMatchObject({ judged: true, ok: false });
      const dropped = importRows(judgeRatios(slow, { ...loads, list: { ...load, dropped: 3, saturated: true } }));
      expect(dropped[1]).toMatchObject({ judged: false, ratio: null, ok: true, notJudged: "list (the steady baseline) dropped 3 arrivals" });
    });

    it("misses a ratio whose own import scenario was saturated or dropped arrivals, with the numbers of its load, whatever the p95 is (the nightlies of 2026-11-10: 385 / 419 ms, 13 / 14 dropped)", () => {
      // The p95 of a queue is 385 ms against a steady 10 ms here, and the same run at a p95 that is within the limit is a miss all the same.
      for (const [goImport, listImport] of [[385, 419], [10, 15]] as const) {
        const row = rows({ go: 10, list: 15, goImport, listImport });
        const dropped = importRows(judgeRatios(row, { ...loads, go_import: { dropped: 13, saturated: true, peakVus: 61, maxVus: 301 }, list_import: { dropped: 14, saturated: true, peakVus: 301, maxVus: 301 } }));
        expect(dropped[0]).toMatchObject({
          judged: true,
          ok: false,
          ratio: Math.round((goImport / 10) * 100) / 100,
          baselineP95Ms: 10,
          saturatedMiss: "go_import dropped 13 arrivals and used 61 of 301 VUs; its p95 is the time of a queue",
        });
        expect(dropped[1]).toMatchObject({ ok: false, saturatedMiss: "list_import dropped 14 arrivals and used 301 of 301 VUs; its p95 is the time of a queue" });
      }
      // The flag alone: the VUs reached the cap and nothing was dropped.
      const flagged = importRows(judgeRatios(rows({ go: 10, list: 15, goImport: 20, listImport: 30 }), { ...loads, go_import: { dropped: 0, saturated: true, peakVus: 301, maxVus: 301 } }));
      expect(flagged[0]).toMatchObject({ judged: true, ok: false, saturatedMiss: "go_import was saturated and used 301 of 301 VUs; its p95 is the time of a queue" });
      expect(flagged[0]).not.toHaveProperty("notJudged");
      // The other import scenario, clean, is judged as ever.
      expect(flagged[1]).toMatchObject({ judged: true, ok: true });
    });

    it("names both sides when the import scenario and its steady baseline are saturated, and keeps no ratio when the baseline is unusable", () => {
      const both = importRows(judgeRatios(rows({ go: 10, list: 15, goImport: 385, listImport: 15 }), { ...loads, go: { ...load, saturated: true }, go_import: { dropped: 0, saturated: true, peakVus: 301, maxVus: 301 } }));
      expect(both[0]).toMatchObject({
        judged: true,
        ok: false,
        ratio: null,
        saturatedMiss: "go_import was saturated and used 301 of 301 VUs; its p95 is the time of a queue; go (the steady baseline) was saturated",
      });
      const zero = importRows(judgeRatios(rows({ go: 0, list: 15, goImport: 385, listImport: 15 }), { ...loads, go_import: { dropped: 5, saturated: true, peakVus: 301, maxVus: 301 } }));
      expect(zero[0]).toMatchObject({ ok: false, ratio: null });
      expect(zero[0]?.saturatedMiss).toMatch(/^go_import dropped 5 arrivals .*; go \(the steady baseline\) has a p95 of 0 ms$/);
    });

    it("never takes a missing baseline, a missing load or a baseline of 0 ms for a ratio", () => {
      expect(() => judgeRatios(rows({ go: 10, list: 15, goImport: 20, listImport: 30 }).filter((row) => row.scenario !== "go"), loads)).toThrow(/go_import|go during import.*scenario go/);
      const { go, ...withoutGo } = loads;
      expect(go).toBe(load);
      expect(() => judgeRatios(rows({ go: 10, list: 15, goImport: 20, listImport: 30 }), withoutGo)).toThrow(/no load for the scenario go/);
      expect(importRows(judgeRatios(rows({ go: 0, list: 15, goImport: 20, listImport: 30 }), loads))[0]).toMatchObject({ judged: false, ok: true, ratio: null });
    });

    it("leaves the steady rows as they are, and judges the rows that run.mjs evaluates from two k6 summaries, the import run's own p95 in milliseconds being no budget", () => {
      const steady = evaluate(summaryOf(STEADY_SCENARIOS), STEADY_SCENARIOS);
      // The import run: go during import at 90 ms, which a limit of 55 ms would have failed and a steady go of 15 ms (the p95 of summaryOf is half the limit) allows.
      const imported = summaryOf(IMPORT_SCENARIOS);
      imported.metrics["http_req_waiting{kind:go_import}"] = { "p(95)": 15 * GO_RATIO - 0.5 };
      imported.metrics["http_req_waiting{kind:list_import}"] = { "p(95)": 50 * LIST_RATIO + 5 };
      const importRun = evaluate(imported, IMPORT_SCENARIOS, { capacity: 301, of: "run" });
      expect(importRun.budgets.every((row) => row.ok && row.limitMs === undefined)).toBe(true);
      const judged = judgeRatios([...steady.budgets, ...importRun.budgets] as RatioRow[], { ...steady.scenarios, ...importRun.scenarios });
      expect(judged.slice(0, steady.budgets.length)).toEqual(steady.budgets);
      expect(importRows(judged).map((row) => [row.name, row.baselineP95Ms, row.ok])).toEqual([
        ["go during import", 15, true],
        ["list during import", 50, false],
      ]);
    });
  });

  describe("the length of the import phase", () => {
    // The quickest and the slowest pair of the two largest imports seen on the runner (netscape + JSON, scripts/perf/README.md, "The import phase"), in seconds.
    const QUICKEST_PAIR = 1.188 + 0.922;
    const SLOWEST_PAIR = 2.54 + 2.108;

    it("repeats the pairs until the imports have been in flight long enough for the requests the phase needs, at the rate the steady scenarios keep up with, and a runner as quick as the quickest seen has the pairs for it", () => {
      expect(IMPORT_PHASE.minSeconds).toBeGreaterThanOrEqual(10);
      expect(IMPORT_PHASE.minRequests).toBeGreaterThanOrEqual(1000);
      // The requests follow the rate times the time in flight: the target is a fifth over the minimum, and the minimum of seconds is far under it.
      expect(IMPORT_PHASE.targetSeconds).toBeGreaterThanOrEqual(IMPORT_PHASE.minSeconds * 2);
      expect(IMPORT_PHASE.targetSeconds * IMPORT_PHASE.rate).toBeGreaterThanOrEqual(IMPORT_PHASE.minRequests * 1.2);
      // The rate is the steady one: 60 a second saturated two runner runs (28 to 33 arrivals dropped, a queue for a p95), and the run's default rate is this one.
      expect(IMPORT_PHASE.rate).toBe(40);
      expect(read("run.mjs")).toContain(`rate: { type: "string", default: "${String(IMPORT_PHASE.rate)}" }`);
      // The pairs there are files for: enough at the quickest pair for the target to within a pair and for the minimum of requests with 15 % to spare.
      expect(Number.isInteger(IMPORT_PHASE.maxRepeats)).toBe(true);
      expect(IMPORT_PHASE.maxRepeats * QUICKEST_PAIR).toBeGreaterThanOrEqual(IMPORT_PHASE.targetSeconds - QUICKEST_PAIR);
      expect(IMPORT_PHASE.maxRepeats * QUICKEST_PAIR * IMPORT_PHASE.rate).toBeGreaterThanOrEqual(IMPORT_PHASE.minRequests * 1.15);
      // The slowest runner seen reaches the target in whole pairs and ends them in the window with room to spare: twice over.
      expect((IMPORT_PHASE.targetSeconds + SLOWEST_PAIR) * 2).toBeLessThanOrEqual(IMPORT_PHASE.windowSeconds);
    });

    it("holds a sample to its minimums, and names each one it falls short of", () => {
      const ok = { inFlightSeconds: IMPORT_PHASE.minSeconds, completed: { go_import: IMPORT_PHASE.minRequests, list_import: IMPORT_PHASE.minRequests } };
      expect(importSampleShortfalls(ok)).toEqual([]);
      expect(importSampleShortfalls({ ...ok, inFlightSeconds: IMPORT_PHASE.minSeconds - 0.1 })).toEqual([expect.stringMatching(/in flight for 9\.9 s, not the 10 s/)]);
      expect(importSampleShortfalls({ ...ok, completed: { go_import: IMPORT_PHASE.minRequests - 1, list_import: IMPORT_PHASE.minRequests } })).toEqual([expect.stringMatching(/^go_import made 999 requests, not the 1000/)]);
      expect(importSampleShortfalls({ inFlightSeconds: 2, completed: { go_import: 147, list_import: 146 } })).toHaveLength(3);
      // A sample that is not a number is a shortfall, never a pass.
      expect(importSampleShortfalls({ inFlightSeconds: Number.NaN, completed: {} })).toHaveLength(3);
    });

    it("is read by the scripts from budgets.js, runs the imports back to back in one workspace with files of their own, and holds a run to the sample unless it is a trial", () => {
      const runner = read("run.mjs");
      const scenarios = read("scenarios.js");
      expect(runner).toMatch(/const DEFAULT_IMPORT_WINDOW_SECONDS = String\(IMPORT_PHASE\.windowSeconds\)/);
      expect(runner).toMatch(/IMPORT_REPEATS: String\(importMaxRepeats\),\s*IMPORT_TARGET_SECONDS: String\(IMPORT_PHASE\.targetSeconds\),\s*IMPORT_RATE: String\(importRate\),\s*SIGNAL_URL/);
      expect(runner).toMatch(/importSampleShortfalls\(\{ inFlightSeconds, completed: requests \}\)/);
      expect(runner).toMatch(/importRun\.sample\.enforced && importRun\.sample\.shortfalls\.length > 0/);
      expect(runner).toMatch(/buildImportFiles\(\{ collidingSlugs: \[\.\.\.collidingSlugs, \.\.\.slugs\], repeat \}\)/);
      // The result records the window, the number of imports and the requests of each scenario.
      expect(runner).toMatch(/phase: \{ windowSeconds: Number\(args\["import-window"\]\), maxRepeats: importMaxRepeats, repeats: imports\.length \/ 2, importCount: imports\.length, targetSeconds: IMPORT_PHASE\.targetSeconds, rate: importRate, inFlightSeconds, requests,/);
      // k6: the load of /go and the list is at the rate of the phase, the files are read by repeat, and the state is `after` only when the last import of the last repeat has answered.
      expect(scenarios).toMatch(/rate: IMPORT_RATE,/);
      expect(scenarios).toMatch(/const IMPORT_RATE = Number\(__ENV\.IMPORT_RATE \|\| RATE\)/);
      expect(scenarios).toMatch(/open\(`\/data\/import-netscape-\$\{repeat\}\.html`\)/);
      expect(scenarios).toMatch(/open\(`\/data\/import-\$\{repeat\}\.json`\)/);
      // The importer stops after the pair that takes the time in flight to the target, or at the last pair there is a file for, and that import is the one that says `after`.
      expect(scenarios).toMatch(/index === imports\.length - 1 && \(repeat === IMPORT_REPEATS - 1 \|\| inFlightMs >= IMPORT_TARGET_SECONDS \* 1000\)/);
      expect(scenarios).toMatch(/setImportState\(last \? "after" : "between", record\);\s*if \(last\) \{\s*return;/);
      expect(runner).toMatch(/held\.imports\.length % 2 !== 0 \|\| held\.imports\.length < 2 \|\| held\.imports\.length > files\.length \* 2/);
      expect(scenarios).toMatch(new RegExp(`__ENV\\.IMPORT_WINDOW_SECONDS \\|\\| ${String(IMPORT_PHASE.windowSeconds)}\\)`));
    });

    it("judges every import of every repeat as it judged the pair: its own success, the bookmarks of its file created, none skipped or refused", () => {
      const runner = read("run.mjs");
      expect(runner).toMatch(/answered\?\.import !== name \|\| answered\.repeat !== repeat \|\| answered\.status !== 200 \|\| answered\.replayed !== false/);
      expect(runner).toMatch(/answered\.created !== file\.bookmarks \|\| answered\.skipped !== 0 \|\| answered\.failed !== 0/);
      expect(runner).toMatch(/files\.flatMap\(\(pair, repeat\) => \[\s*\["netscape", pair\.netscape, repeat\],\s*\["json", pair\.json, repeat\]/);
    });
  });

  it("reports the creates beside an import, with and without it, by thresholds that no value can fail and that are no budget", () => {
    expect(CREATE_PHASES).toEqual(["without", "during"]);
    expect(CREATE_RATE).toBeGreaterThan(0);
    expect(createMetrics("during")).toEqual({ p95: "http_req_waiting{kind:create,phase:during}", completed: "http_reqs{kind:create,phase:during}" });
    const thresholds = createThresholds();
    expect(Object.keys(thresholds).sort()).toEqual(
      [...CREATE_PHASES.flatMap((phase) => Object.values(createMetrics(phase))), `dropped_iterations{scenario:${CREATES_SCENARIO}}`].sort(),
    );
    for (const [metric, rules] of Object.entries(thresholds)) {
      // A count and a percentile are never negative: these hold for any run, with samples or without.
      expect(rules, metric).toEqual([metric.startsWith("http_req_waiting") ? "p(95)>=0" : "count>=0"]);
      expect(Object.keys(budgetThresholds()), metric).not.toContain(metric);
      expect(Object.keys(loadThresholds()), metric).not.toContain(metric);
    }
  });

  it("signs in as the members of the large instance's seed, and keeps the state of the import in the states the scenarios read", () => {
    const seed = readFileSync(resolve(ROOT, "packages/testing/src/seed/large.ts"), "utf8");
    expect(seed).toContain(`account("${IMPORTER_EMAIL}", "Perf Member 1")`);
    expect(seed).toContain(`account("${CREATOR_EMAIL}", "Perf Member 2")`);
    expect(IMPORTER_EMAIL).not.toBe(CREATOR_EMAIL);
    expect(IMPORT_STATES).toEqual(["before", "importing", "between", "after", "failed"]);
  });

  it("builds files of the caps that the contracts declare, so that a change of a cap leaves no stale file", () => {
    const contract = readFileSync(resolve(ROOT, "packages/contracts/src/operations/import.ts"), "utf8");
    const files = readFileSync(resolve(ROOT, "packages/testing/src/seed/import-files.ts"), "utf8");
    expect(/export const IMPORT_MAX_BOOKMARKS = (\d+);/.exec(contract)?.[1]).toBe(/export const IMPORT_FILE_MAX_BOOKMARKS = (\d+);/.exec(files)?.[1]);
    expect(/export const IMPORT_MAX_BYTES = ([^;]+);/.exec(contract)?.[1]).toBe(/export const IMPORT_FILE_MAX_BYTES = ([^;]+);/.exec(files)?.[1]);
  });

  it("imports last, after the budgets, with the limits of the bulk and write buckets raised and a key on each import, and ends the run on an import that was not a success", () => {
    const runner = read("run.mjs");
    expect(runner.indexOf('k6Run("budgets"')).toBeGreaterThan(0);
    expect(runner.indexOf("await measureImports(")).toBeGreaterThan(runner.indexOf('k6Run("budgets"'));
    for (const key of ["RATE_LIMIT_BULK_IP", "RATE_LIMIT_BULK_ACCOUNT", "RATE_LIMIT_WRITE_IP", "RATE_LIMIT_WRITE_ACCOUNT"]) {
      expect(runner, key).toMatch(new RegExp(`${key}: UNLIMITED`));
    }
    // An import that was answered with anything else than the success of the whole file is an error of the run, never a time.
    expect(runner).toMatch(/answered\.status !== 200 \|\| answered\.replayed !== false/);
    expect(runner).toMatch(/answered\.created !== file\.bookmarks \|\| answered\.skipped !== 0 \|\| answered\.failed !== 0/);
    expect(runner).toMatch(/held\.state !== "after"/);
    expect(runner).toMatch(/k6 reported no creates in the phase/);
    // k6 exports a sub-metric with a threshold and no sample as zeros: a scenario that made no request (no /go or list arrival fell in an import) must end the run, not read as 0 ms.
    expect(runner).toMatch(/if \(completed < 1\) \{\s*throw new Error\(`the scenario \$\{scenario\} made no request/);
    const scenarios = read("scenarios.js");
    expect(scenarios).toMatch(/\/api\/v1\/import\/netscape/);
    expect(scenarios).toMatch(/\/api\/v1\/import\/json/);
    expect(scenarios.match(/"Idempotency-Key": key/g)).toHaveLength(2);
    expect(scenarios).toMatch(/record\.status !== 200 \|\| record\.replayed \|\| ended > deadline/);
    expect(scenarios).toMatch(/execution\.test\.abort\(/);
    // The load is requested, and the creates are made, only in the state they measure.
    expect(scenarios).toMatch(/importState\(\) === "importing"\) \{\s*goRequest\(data, "go_import"\)/);
    expect(scenarios).toMatch(/importState\(\) === "importing"\) \{\s*listRequest\(data, "list_import"\)/);
    expect(scenarios).toMatch(/state === "before" \? "without" : state === "importing" \? "during" : null/);
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
    expect(scenarios).toMatch(/\.\.\.loadThresholds\(IMPORT \? IMPORT_SCENARIOS : STEADY_SCENARIOS\)/);
    expect(scenarios).toMatch(/\.\.\.\(IMPORT && CREATES_PER_SECOND > 0 \? createThresholds\(\) : \{\}\)/);
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
    expect(scenarios).toMatch(/\.\.\.budgetThresholds\(IMPORT \? IMPORT_SCENARIOS : STEADY_SCENARIOS\)/);
    expect(scenarios).not.toMatch(/http_req_waiting\{/);
    expect(scenarios).not.toMatch(/const (SORTS|PAGES|BUDGETS_MS)\b/);
    expect(runner).toMatch(/import \{[^}]*\bbudgets as \w+\b[^}]*\} from "\.\/budgets\.js"/);
    expect(runner).not.toMatch(/http_req_waiting\{/);
  });

  it("imports nothing, so k6 and node can both load it", () => {
    expect(read("budgets.js")).not.toMatch(/^\s*import\b/m);
  });
});

// The k6 scenarios that are a constant arrival rate, each with the `preAllocatedVUs` and the `maxVUs` it is written with.
function arrivalRateVus(source: string): { preAllocated: string; max: string }[] {
  return source
    .split('executor: "constant-arrival-rate"')
    .slice(1)
    .map((chunk) => {
      const scenario = chunk.slice(0, chunk.search(/\n\s*(?:exec|tags)\b/u));
      return { preAllocated: /preAllocatedVUs: (\w+)/u.exec(scenario)?.[1] ?? "none", max: /maxVUs: (\w+)/u.exec(scenario)?.[1] ?? "none" };
    });
}

describe("the VUs of the arrival-rate scenarios", () => {
  it("are all preallocated, so that a dropped arrival means the scenario's own cap was reached and not a VU that was still being started", () => {
    const scenarios = read("scenarios.js");
    const vus = arrivalRateVus(scenarios);
    // The steady scenarios (one function), go_import and list_import (one function), and the creates.
    expect(vus).toHaveLength(3);
    for (const { preAllocated, max } of vus) {
      expect(max).toBe("MAX_VUS");
      expect(preAllocated).toBe(max);
    }
    expect(scenarios.match(/preAllocatedVUs:/g)).toHaveLength(vus.length);
    // The check sees a scenario that preallocates fewer VUs than it may use, as the import scenarios did with 10 of 100.
    const fewer = arrivalRateVus(scenarios.replace("preAllocatedVUs: MAX_VUS,", "preAllocatedVUs: 10,"));
    expect(fewer.filter(({ preAllocated, max }) => preAllocated !== max)).toHaveLength(1);
  });

  it("are described by budgets.js and the README as the reason a dropped arrival is a reached cap, with the run that showed it", () => {
    for (const text of [read("budgets.js"), read("README.md")]) {
      expect(text).toContain("`preAllocatedVUs`");
      expect(text).toMatch(/`vus_max` (?:went )?from 31 to 40/);
      expect(text).toMatch(/9 (?:more VUs for the 9 )?dropped arrivals/);
    }
  });
});

describe("the pool and the lock waits sampled while an import is in flight", () => {
  const dirs: string[] = [];
  const servers: Server[] = [];

  afterAll(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>((done) => {
        server.close(() => {
          done();
        });
      });
    }
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is the nearest-rank p95 and the maximum, and refuses no samples or one that is not a number", () => {
    const values = Array.from({ length: 20 }, (_, index) => index + 1);
    expect(summarizeSamples(values)).toEqual({ max: 20, p95: 19 });
    expect(summarizeSamples([3])).toEqual({ max: 3, p95: 3 });
    expect(summarizeSamples([0, 0, 0])).toEqual({ max: 0, p95: 0 });
    expect(() => summarizeSamples([])).toThrow(/no samples/);
    expect(() => summarizeSamples([1, Number.NaN])).toThrow(/not a number/);
    expect(() => summarizeSamples([1, -1])).toThrow(/not a number/);
  });

  // A metrics listener that answers what the test says and a `psql` that prints what the test says, so the run's own sampler runs end to end.
  // `lateBy` makes the stub's answer arrive after the stub itself has exited: a process it leaves running prints it a moment later, as a pipe read late by a loaded host does.
  async function rig(options: { metrics: () => { status: number; body: string }; backends: string; lateBy?: number; hang?: boolean }): Promise<{ metricsPort: number; restore: () => void }> {
    const server = createServer((request, response) => {
      const answer = options.metrics();
      response.writeHead(answer.status, { "content-type": "text/plain" });
      response.end(request.url === "/metrics" ? answer.body : "");
    });
    servers.push(server);
    await new Promise<void>((done) => {
      server.listen(0, "127.0.0.1", done);
    });
    const dir = mkdtempSync(join(tmpdir(), "perf-sampler-"));
    dirs.push(dir);
    const answer = `printf '%s\\n' '${options.backends}'`;
    // A `psql` that never answers and never exits, as one that waits for a connection does; `exec` makes the process the deadline kills the one that holds the output open.
    const body = options.hang === true ? "exec sleep 30" : options.lateBy === undefined ? answer : `(sleep ${String(options.lateBy)}; ${answer}) &`;
    writeFileSync(join(dir, "psql"), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, "psql"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${dir}:${path ?? ""}`;
    return {
      metricsPort: (server.address() as AddressInfo).port,
      restore: () => {
        process.env.PATH = path;
      },
    };
  }

  const exposition = (inFlight: number, size: number): string =>
    `# TYPE slugbase_db_pool_size gauge\nslugbase_db_pool_size ${String(size)}\n# TYPE slugbase_db_tenant_transactions_in_flight gauge\nslugbase_db_tenant_transactions_in_flight ${String(inFlight)}\n`;
  const sampleOptions = (metricsPort: number, state: string) => ({ held: { state }, metricsPort, serverUrl: "postgres://sampler:sampler@127.0.0.1:1/postgres", databaseName: "sampled" });
  const wait = (ms: number): Promise<void> =>
    new Promise((done) => {
      setTimeout(done, ms);
    });
  // Polls for what the sampler does on its own clock, with a bound, and fails by naming it.
  async function until(done: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (!done()) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${what}`);
      }
      await wait(20);
    }
  }

  it("records the transactions in flight against the pool size and the backends that wait for a lock, only while an import is in flight, with their maximum and p95", async () => {
    let scrapes = 0;
    const { metricsPort, restore } = await rig({
      metrics: () => {
        scrapes += 1;
        return { status: 200, body: exposition(scrapes <= 2 ? 4 : 13, 10) };
      },
      backends: "7|0",
    });
    try {
      const held = { state: "before" };
      const sampler = startSampler({ ...sampleOptions(metricsPort, "before"), held });
      // Two intervals pass with no import in flight, and nothing is scraped.
      await wait(550);
      expect(scrapes).toBe(0);
      held.state = "importing";
      await until(() => scrapes >= 4, "the sampler to scrape four times while an import is in flight");
      held.state = "after";
      const figures = await sampler.stop();
      expect(scrapes).toBe(figures.pool.samples);
      expect(figures.pool.samples).toBeGreaterThanOrEqual(4);
      expect(figures.pool).toMatchObject({ intervalMs: 250, size: 10, max: 13, p95: 13 });
      expect(figures.pool.samplesAboveSize).toBe(figures.pool.samples - 2);
      expect(figures.lockWaits).toMatchObject({ intervalMs: 250, samples: figures.pool.samples, max: 7, p95: 7 });
    } finally {
      restore();
    }
  });

  it("fails the run on a sample it cannot read, and on a phase it never sampled, and never reads either as 0", async () => {
    const cases: [string, { metrics: () => { status: number; body: string }; backends: string }, RegExp][] = [
      ["a metrics listener that answers an error", { metrics: () => ({ status: 500, body: "" }), backends: "0|0" }, /answered 500/],
      ["a metrics text without the transactions in flight", { metrics: () => ({ status: 200, body: "slugbase_db_pool_size 10\n" }), backends: "0|0" }, /no readable slugbase_db_tenant_transactions_in_flight/],
      ["a metrics text without the pool size", { metrics: () => ({ status: 200, body: "slugbase_db_tenant_transactions_in_flight 3\n" }), backends: "0|0" }, /no readable slugbase_db_pool_size/],
      ["a count that is not a number", { metrics: () => ({ status: 200, body: exposition(Number.NaN, 10) }), backends: "0|0" }, /no readable slugbase_db_tenant_transactions_in_flight/],
      ["backends whose activity the role may not see", { metrics: () => ({ status: 200, body: exposition(2, 10) }), backends: "0|3" }, /could not be read/],
      ["an answer of psql that is no count", { metrics: () => ({ status: 200, body: exposition(2, 10) }), backends: "ERROR" }, /could not be read/],
    ];
    for (const [name, options, failure] of cases) {
      const { metricsPort, restore } = await rig(options);
      try {
        const sampler = startSampler(sampleOptions(metricsPort, "importing"));
        await expect(sampler.stop(), name).rejects.toThrow(failure);
      } finally {
        restore();
      }
    }
    const { metricsPort, restore } = await rig({ metrics: () => ({ status: 200, body: exposition(2, 10) }), backends: "0|0" });
    try {
      const sampler = startSampler(sampleOptions(metricsPort, "before"));
      await expect(sampler.stop()).rejects.toThrow(/no sample of the pool or of the lock waits was taken while an import was in flight/);
    } finally {
      restore();
    }
  });

  it("reads what psql printed even when psql has exited before it is read, and still fails the run on a failure that the late answer does not hide", async () => {
    const late = await rig({ metrics: () => ({ status: 200, body: exposition(2, 10) }), backends: "5|0", lateBy: 0.3 });
    try {
      const held = { state: "importing" };
      const sampler = startSampler({ ...sampleOptions(late.metricsPort, "importing"), held });
      await wait(100);
      held.state = "after";
      const figures = await sampler.stop();
      expect(figures.lockWaits).toMatchObject({ max: 5, p95: 5 });
    } finally {
      late.restore();
    }
    const refused = await rig({ metrics: () => ({ status: 200, body: "slugbase_db_tenant_transactions_in_flight 3\n" }), backends: "0|0", lateBy: 0.3 });
    try {
      await expect(startSampler(sampleOptions(refused.metricsPort, "importing")).stop()).rejects.toThrow(/no readable slugbase_db_pool_size/);
    } finally {
      refused.restore();
    }
  });

  it("ends a psql that never answers at the deadline and fails the run with the sample it could not read", async () => {
    const stalled = await rig({ metrics: () => ({ status: 200, body: exposition(2, 10) }), backends: "0|0", hang: true });
    try {
      const began = Date.now();
      const sampler = startSampler({ ...sampleOptions(stalled.metricsPort, "importing"), lockWaitTimeoutMs: 300 });
      await expect(sampler.stop()).rejects.toThrow(/backends that wait for a lock could not be read/);
      // The stub would run for 30 seconds: a stop that returns well before is the deadline's, not the stub's.
      expect(Date.now() - began).toBeLessThan(10_000);
    } finally {
      stalled.restore();
    }
  }, 20_000);

  it("is read from a server started with a METRICS_PORT of its own, as the image and as the local build, and written to the result by the names the report reads", () => {
    const runner = read("run.mjs");
    // `serverEnv` is what both servers get: the local build's environment, and the image's by name (`-e NAME`), on the host network.
    expect(runner).toMatch(/PORT: String\(port\),\s*METRICS_PORT: String\(metricsPort\),/);
    expect(runner).toMatch(/env: \{ PATH: process\.env\.PATH \?\? "", \.\.\.serverEnv \}/);
    expect(runner).toMatch(/Object\.keys\(serverEnv\)\.flatMap\(\(name\) => \["-e", name\]\)/);
    expect(runner).toContain("http://127.0.0.1:${String(metricsPort)}/metrics");
    expect(runner).toContain('"slugbase_db_tenant_transactions_in_flight"');
    expect(runner).toContain('"slugbase_db_pool_size"');
    expect(runner).toContain("wait_event_type = 'Lock'");
    expect(runner).toMatch(/const SAMPLE_INTERVAL_MS = 250;/);
    expect(runner).toMatch(/imports, creates: \{.*\}, pool: sampled\.figures\.pool, lockWaits: sampled\.figures\.lockWaits \}/);
    // The sampling's failure is the run's: thrown once k6 and the import have been judged, and the sampler is stopped whichever way k6 ended.
    expect(runner).toMatch(/if \(sampled\.error !== undefined\) \{\s*throw sampled\.error;/);
    expect(runner).toMatch(/\} finally \{[^}]*sampled = await sampler\.stop\(\)/s);
  });

  it("takes a rate of creates for a trial, as it takes a rate of imports, and leaves the creates out of the import run at 0", () => {
    const runner = read("run.mjs");
    const scenarios = read("scenarios.js");
    expect(runner).toMatch(/"create-rate": \{ type: "string" \}/);
    expect(runner).toContain("const createRate = Number(args[\"create-rate\"] ?? CREATE_RATE);");
    expect(runner).toMatch(/const importTrial = [^;]*createRate !== CREATE_RATE;/);
    expect(runner).toMatch(/CREATE_RATE: String\(createRate\),/);
    expect(scenarios).toContain("const CREATES_PER_SECOND = __ENV.CREATE_RATE === undefined ? CREATE_RATE : Number(__ENV.CREATE_RATE);");
    expect(scenarios).toMatch(/\.\.\.\(CREATES_PER_SECOND > 0\s*\? \{\s*\[CREATES_SCENARIO\]: \{/);
    expect(scenarios).toContain("...(IMPORT && CREATES_PER_SECOND > 0 ? createThresholds() : {}),");
  });
});
