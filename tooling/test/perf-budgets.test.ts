import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
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
  createMetrics: (phase: string) => { p95: string; completed: string };
  createThresholds: () => Record<string, string[]>;
  SEARCH_TERMS: string[];
  SHARED_TERM: string;
  MAX_VUS: number;
  BUDGETS_MS: Record<string, number>;
  RATIO_BUDGETS: Record<string, { of: string; ratio: number }>;
  judgeRatios: (rows: RatioRow[], loads: Record<string, { dropped: number; saturated: boolean }>) => RatioRow[];
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

// The runner is a script that does nothing but export `evaluate`, `loadOf` and `createsOf` when it is imported rather than run.
const runnerSpecifier = pathToFileURL(resolve(ROOT, "scripts/perf/run.mjs")).href;
const { evaluate, loadOf, createsOf } = (await import(runnerSpecifier)) as {
  evaluate: (summary: Summary, ids: string[], vus?: { capacity: number; of: string }) => Evaluated;
  loadOf: (summary: Summary, scenario: string, vus: { capacity: number; of: string }) => Load;
  createsOf: (summary: Summary) => Record<string, unknown> & { dropped: number };
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
const GO_RATIO = 5.9;
const LIST_RATIO = 5.8;

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
    const load = { dropped: 0, saturated: false };
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

    it("does not judge a ratio whose baseline is saturated or dropped arrivals, nor one whose own scenario is, and says which", () => {
      const slow = rows({ go: 10, list: 15, goImport: 1000, listImport: 1000 });
      // Saturated baseline: the p95 of go is the time of a queue, so no ratio to it is a measurement; the miss it would be is not reported as one.
      const baseline = importRows(judgeRatios(slow, { ...loads, go: { dropped: 0, saturated: true } }));
      expect(baseline[0]).toMatchObject({ judged: false, ratio: null, ok: true, notJudged: "go (the steady baseline) was saturated", baselineP95Ms: 10, baselineSaturated: false });
      expect(baseline[1]).toMatchObject({ judged: true, ok: false });
      // Dropped arrivals, in the baseline and in the import scenario, and both sides at once.
      const dropped = importRows(judgeRatios(slow, { ...loads, list: { dropped: 3, saturated: true }, list_import: { dropped: 7, saturated: true } }));
      expect(dropped[0]).toMatchObject({ judged: true, ok: false });
      expect(dropped[1]).toMatchObject({ judged: false, ratio: null, ok: true, notJudged: "list_import dropped 7 arrivals; list (the steady baseline) dropped 3 arrivals" });
      expect(importRows(judgeRatios(slow, { ...loads, go_import: { dropped: 0, saturated: true } }))[0]).toMatchObject({ judged: false, notJudged: "go_import was saturated" });
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
    expect(scenarios).toMatch(/\.\.\.\(IMPORT \? createThresholds\(\) : \{\}\)/);
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
