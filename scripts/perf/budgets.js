// The performance budgets of doc 08 section 5.3 and the shapes the list and the search are measured in, in one place. scenarios.js (k6) turns
// them into thresholds and run.mjs (node) reads each one's p(95) back from the k6 summary, so a threshold k6 enforces is always a
// budget the runner reports. Plain ES module with no imports: both k6 and node load it.
//
// Scenario ids are the `kind` tag of their requests and the k6 scenario names; a budget's name is the id with a space for each underscore.
export const SORTS = ["recent", "oldest", "title_asc", "title_desc", "most_used", "recently_opened"];
export const PAGES = ["first", "deep"];
// The list narrowed by a text (`list_q`, the first page and a deep one) and the list under a filter (`list_filter`, a tag of the account's and a folder of its) are
// shapes of their own, so that a regression names the shape and the page.
export const FILTERS = ["tag", "folder"];
export const BUDGETS_MS = { go: 30, list: 100, search: 100, list_q: 100, list_filter: 100 };
export const SCENARIOS = ["go", "list", "search", "list_q", "list_filter"];

// The write-load check (doc 01 section 8.1): GO_HOT_REQUESTS requests for one forwarding slug may change the `bookmarks` table once per flush interval of the
// usage buffer and once more for the flush that follows the load, because the opens of /go are counted in the server's memory and written in one call
// per interval. The metric is the count of those requests in the k6 summary, which a threshold of the scenario names so that it is exported.
export const GO_HOT_REQUESTS = 10_000;
export const GO_HOT_METRIC = "http_reqs{kind:go_hot}";
export const FLUSH_INTERVAL_SECONDS = 10;

// The most updates of `bookmarks` that a load of `elapsedSeconds` may leave behind: one for each interval that began in it, and the flush after it.
export function writeLoadLimit(elapsedSeconds) {
  return Math.ceil(elapsedSeconds / FLUSH_INTERVAL_SECONDS) + 1;
}

// The terms of the search scenario: the `searchTerms` of the large instance (packages/testing/src/seed/large.ts, which tooling/test/perf-budgets.test.ts
// holds this list to), and the tag of a request for the slug of a bookmark that members share with the account.
export const SEARCH_TERMS = ["caching", "accessibility", "release notes", "database indexes", "docs", "reading", "do"];
export const SHARED_TERM = "shared";

// The most VUs a scenario may use (`maxVUs` of scenarios.js). A scenario that reached it could not start every arrival on time.
export const MAX_VUS = 100;

// Every p(95) budget of the server time (k6 http_req_waiting): the scenarios, then each list sort on each page, each page of the list narrowed by a text, each
// filter of the list and each search term, so that a regression names the sort and the page, the shape or the term. `scenario` is the scenario the request
// belongs to, `metric` is the k6 threshold key and the key of the summary.
export function budgets() {
  const all = SCENARIOS.map((scenario) => ({ name: scenario.replace("_", " "), scenario, metric: `http_req_waiting{kind:${scenario}}`, limitMs: BUDGETS_MS[scenario] }));
  for (const sort of SORTS) {
    for (const page of PAGES) {
      all.push({ name: `list ${sort} ${page}`, scenario: "list", metric: `http_req_waiting{kind:list,sort:${sort},page:${page}}`, limitMs: BUDGETS_MS.list });
    }
  }
  for (const page of PAGES) {
    all.push({ name: `list q ${page}`, scenario: "list_q", metric: `http_req_waiting{kind:list_q,page:${page}}`, limitMs: BUDGETS_MS.list_q });
  }
  for (const filter of FILTERS) {
    all.push({ name: `list filter ${filter}`, scenario: "list_filter", metric: `http_req_waiting{kind:list_filter,filter:${filter}}`, limitMs: BUDGETS_MS.list_filter });
  }
  for (const term of [...SEARCH_TERMS, SHARED_TERM]) {
    all.push({ name: `search ${term}`, scenario: "search", metric: `http_req_waiting{kind:search,term:${term}}`, limitMs: BUDGETS_MS.search });
  }
  return all;
}

// The k6 thresholds of the budgets: p(95) under the limit.
export function budgetThresholds() {
  const thresholds = {};
  for (const { metric, limitMs } of budgets()) {
    thresholds[metric] = [`p(95)<${limitMs}`];
  }
  return thresholds;
}

// What a run says about its own load, per scenario: the requests that completed, the arrivals k6 dropped because every VU was busy and could not
// start another, and the most VUs active at an arrival. k6 puts a sub-metric in its summary only when a threshold names it, so each is named by a
// threshold that no value can fail (a count or a maximum is never below 0): they report and never end k6 with 99. A scenario that dropped nothing has
// no `dropped_iterations` sample, which the runner reads as 0.
export function loadMetrics(scenario) {
  return {
    completed: `http_reqs{kind:${scenario}}`,
    dropped: `dropped_iterations{scenario:${scenario}}`,
    activeVus: `active_vus{kind:${scenario}}`,
  };
}

export function loadThresholds() {
  const thresholds = {};
  for (const scenario of SCENARIOS) {
    const { completed, dropped, activeVus } = loadMetrics(scenario);
    thresholds[completed] = ["count>=0"];
    thresholds[dropped] = ["count>=0"];
    thresholds[activeVus] = ["max>=0"];
  }
  return thresholds;
}
