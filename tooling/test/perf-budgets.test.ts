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
  GO_HOT_REQUESTS,
  GO_HOT_METRIC,
  FLUSH_INTERVAL_SECONDS,
  budgets,
  budgetThresholds,
  loadMetrics,
  loadThresholds,
  writeLoadLimit,
} = (await import(specifier)) as BudgetsModule;

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
    // The budgets run and the import run each set the thresholds of their own scenarios, and together they are all of them.
    expect([...STEADY_SCENARIOS, ...IMPORT_SCENARIOS]).toEqual(SCENARIOS);
    expect(new Set(SCENARIOS).size).toBe(SCENARIOS.length);
    const steady = Object.keys(budgetThresholds(STEADY_SCENARIOS));
    const imported = Object.keys(budgetThresholds(IMPORT_SCENARIOS));
    expect(steady.filter((metric) => imported.includes(metric))).toEqual([]);
    expect([...steady, ...imported].sort()).toEqual(Object.keys(thresholds).sort());
  });

  it("has the /go and list budgets during an import, named for it, at the limits of /go and of the list", () => {
    expect(IMPORT_SCENARIOS).toEqual(["go_import", "list_import"]);
    expect(budgets(IMPORT_SCENARIOS)).toEqual([
      { name: "go during import", scenario: "go_import", metric: "http_req_waiting{kind:go_import}", limitMs: 30 },
      { name: "list during import", scenario: "list_import", metric: "http_req_waiting{kind:list_import}", limitMs: 100 },
    ]);
    expect(BUDGETS_MS.go_import).toBe(BUDGETS_MS.go);
    expect(BUDGETS_MS.list_import).toBe(BUDGETS_MS.list);
    expect(budgetThresholds(IMPORT_SCENARIOS)).toEqual({ "http_req_waiting{kind:go_import}": ["p(95)<30"], "http_req_waiting{kind:list_import}": ["p(95)<100"] });
    expect(budgets(STEADY_SCENARIOS).map((budget) => budget.scenario)).not.toContain("go_import");
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
