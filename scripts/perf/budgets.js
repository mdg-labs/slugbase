// The performance budgets of doc 08 section 5.3 and the shapes the list and the search are measured in, in one place. scenarios.js (k6) turns
// them into thresholds and run.mjs (node) reads each one's p(95) back from the k6 summary, so a threshold k6 enforces is always a
// budget the runner reports. Plain ES module with no imports: both k6 and node load it.
//
// Scenario ids are the `kind` tag of their requests and the k6 scenario names; a budget's name is the id with a space for the underscore (NAMES below for the two that are named otherwise).
export const SORTS = ["recent", "oldest", "title_asc", "title_desc", "most_used", "recently_opened"];
export const PAGES = ["first", "deep"];
// The list narrowed by a text (`list_q`, the first page and a deep one) and the list under a filter (`list_filter`, a tag of the account's and a folder of its, the first page
// and a deep one) are shapes of their own, so that a regression names the shape and the page.
export const FILTERS = ["tag", "folder"];
// The slug suggestions of the palette's go mode (`go_suggest`, doc 02 section 6.2) are requested with three prefixes of a slug of the seed, so that a regression names the one:
// its first character (the prefix that matches the most slugs), its leading word (`docs` of `docs-12`) and the whole slug.
export const SUGGEST_PREFIXES = ["short", "word", "full"];
// The scenarios of the budgets run, one after the other (a scenario added is added last, so that the others keep their place in the run), and the two of the import run (below), which run last:
// /go and the list while one member imports the largest files.
export const STEADY_SCENARIOS = ["go", "list", "search", "list_q", "list_filter", "go_suggest", "dashboard"];
export const IMPORT_SCENARIOS = ["go_import", "list_import"];
export const SCENARIOS = [...STEADY_SCENARIOS, ...IMPORT_SCENARIOS];
// The steady budgets, in milliseconds of the p95 of the server time.
export const BUDGETS_MS = { go: 30, go_suggest: 50, list: 100, search: 100, list_q: 100, list_filter: 100, dashboard: 100 };
// The two budgets of the import phase are not in milliseconds but ratios to the same run's steady scenario: the p95 of `go_import` may be at most `ratio` times the p95 of `go` of the run, and
// that of `list_import` at most `ratio` times the p95 of `list`. A ratio is what another member's import costs /go and the list, and it cancels most of the speed of the runner machine, which a
// millisecond budget set from a few runs did not (the p95 of go during an import was 30 to 67 ms in four runs, its ratio to steady go 3.0 to 4.4). See `RATIO_BUDGETS` below and "The import phase" in README.md.
export const RATIO_BUDGETS = { go_import: { of: "go", ratio: 8.4 }, list_import: { of: "list", ratio: 9.0 } };
// A budget is named for its scenario with a space for the underscore, unless the scenario is named here.
const NAMES = { go_import: "go during import", list_import: "list during import" };
// `go_import` and `list_import` are ratios (RATIO_BUDGETS) because an import is synchronous: while one is in flight the request thread still checks the answer of the import worker thread and runs its
// database writes (doc 02 section 13.1), on a runner whose CPUs the server, the worker thread, Postgres and k6 share, so the time of a request beside an import follows the speed of that machine
// as the time of a steady request does. Each is set by the rule of #806 over the nightly runs on the runner (the reference host of every budget), applied to the ratio: the highest ratio plus the
// spread (highest minus lowest) of the counted runs, rounded up to one decimal (8.4 and 9.0, from four counted runs of the phase of IMPORT_PHASE below); see "The import phase" in README.md. The steady `go` stays 30 ms and the steady list 100 ms.

// The import run (doc 02 section 13.1, doc 08 section 5.3): `perf-member-1` imports the largest Netscape file and then the largest SlugBase JSON file into the large workspace, while the
// instance admin's /go and list traffic goes on at the run's rate (go_import, list_import: the p95 of the requests made while an import is in flight is a budget) and `perf-member-2`
// creates bookmarks at CREATE_RATE a second, before the first import (phase `without`) and while an import is in flight (phase `during`), whose p95 is reported and has no threshold. Every
// account of the large instance has the run's password (packages/testing/src/seed/large.ts).
export const IMPORTER_EMAIL = "perf-member-1@example.test";
export const CREATOR_EMAIL = "perf-member-2@example.test";
export const CREATE_RATE = 5;
export const CREATE_PHASES = ["without", "during"];
// How long the import phase is (#818). The p95 of /go and the list "while an import is in flight" is only as stable as the number of requests behind it: one pair of the largest files is in flight for 1 to 2.5 s on
// the runner, which at the steady 40 a second was 146 to 319 requests per scenario, a p95 that is the 8th to the 16th worst of them, and a ratio that moved from 2.9 to 6.1 on a code that had not changed. So the phase
// repeats the pair, one after the other, in the same workspace (each repeat's files name addresses, slugs, folders and tags of their own, packages/testing/src/seed/import-files.ts), until the imports have been in flight for
// `targetSeconds` (the importer stops after the pair that takes it there), at most `maxRepeats` pairs. The rate stays the steady 40 a second: two runner runs of 10 pairs at 60 a second were saturated (both scenarios
// dropped 28 to 33 arrivals and used 86 to 94 VUs, their p95 was 456 to 586 ms against steady 12 to 19 ms, a queue), although the imports did not slow as the workspace grew by 100 000 bookmarks (1.7 to 2.4 s
// each in the first run, 1.6 to 2.6 s in the second, no trend); a rate of 100 saturated a local run the same way. At 40 a second the pair that was run alone never dropped an arrival, and requests follow the rate times the time in flight
// (2 446 + 31 dropped = 41.2 s x 60), so 30 s in flight is 1 200 requests per scenario. A fixed number of pairs would give that only on one speed of runner (a pair has taken 2.1 to 4.65 s there, 15 to 6.5 pairs for
// 30 s): counting the time makes the sample the same on any runner, and the number of pairs (7 to 14, 70 000 to 140 000 bookmarks) is what varies; `maxRepeats` is the pairs a runner as quick as the quickest seen needs
// (14 x 2.1 s = 29.4 s, 1 176 requests), and a run that reaches it without the minimum fails closed (below). `windowSeconds` is the time they all have to end in: 30 to 35 s of imports and about 0.3 s of signalling
// for each, 45 s at most, and room for the imports to slow.
// `minSeconds` and `minRequests` are the sample the phase must have, which run.mjs holds a run to (a run with fewer is a failed run, never a ratio judged on too few requests).
export const IMPORT_PHASE = { maxRepeats: 14, targetSeconds: 30, rate: 40, windowSeconds: 90, minSeconds: 10, minRequests: 1000 };

// The sample of an import phase against what it must have: `inFlightSeconds` (the imports' time in flight, summed) and `completed`, the requests of each of IMPORT_SCENARIOS. The reasons it falls short, none when it does not.
export function importSampleShortfalls({ inFlightSeconds, completed }) {
  const shortfalls = [];
  if (!(inFlightSeconds >= IMPORT_PHASE.minSeconds)) {
    shortfalls.push(`an import was in flight for ${String(inFlightSeconds)} s, not the ${String(IMPORT_PHASE.minSeconds)} s the phase needs`);
  }
  for (const scenario of IMPORT_SCENARIOS) {
    if (!(completed[scenario] >= IMPORT_PHASE.minRequests)) {
      shortfalls.push(`${scenario} made ${String(completed[scenario])} requests, not the ${String(IMPORT_PHASE.minRequests)} the phase needs`);
    }
  }
  return shortfalls;
}

// The k6 VUs cannot share a variable, so the run (run.mjs) keeps the state of the import for them: the importer sets it, the other scenarios read it, and a request is made, and tagged,
// by what the state is when its arrival is taken. `before` the first import, `importing` while one is in flight, `between` the two, `after` the second, `failed` when one did not succeed.
export const IMPORT_STATES = ["before", "importing", "between", "after", "failed"];

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

// The limit of a scenario's budget: `limitMs` for a steady scenario, and for one of RATIO_BUDGETS `of` (the steady scenario it is judged against) and `limitRatio`.
function limitOf(scenario) {
  const ratio = RATIO_BUDGETS[scenario];
  return ratio === undefined ? { limitMs: BUDGETS_MS[scenario] } : { of: ratio.of, limitRatio: ratio.ratio };
}

// Every p(95) budget of the server time (k6 http_req_waiting): the scenarios, then each list sort on each page, each page of the list narrowed by a text, each
// filter of the list on each page, each prefix of the slug suggestions and each search term, so that a regression names the sort and the page, the shape or the term. `scenario` is the scenario the request
// belongs to, `metric` is the k6 threshold key and the key of the summary.
export function budgets(scenarios = SCENARIOS) {
  const all = SCENARIOS.map((scenario) => ({ name: NAMES[scenario] ?? scenario.replace("_", " "), scenario, metric: `http_req_waiting{kind:${scenario}}`, ...limitOf(scenario) }));
  for (const sort of SORTS) {
    for (const page of PAGES) {
      all.push({ name: `list ${sort} ${page}`, scenario: "list", metric: `http_req_waiting{kind:list,sort:${sort},page:${page}}`, limitMs: BUDGETS_MS.list });
    }
  }
  for (const page of PAGES) {
    all.push({ name: `list q ${page}`, scenario: "list_q", metric: `http_req_waiting{kind:list_q,page:${page}}`, limitMs: BUDGETS_MS.list_q });
  }
  for (const filter of FILTERS) {
    for (const page of PAGES) {
      all.push({ name: `list filter ${filter} ${page}`, scenario: "list_filter", metric: `http_req_waiting{kind:list_filter,filter:${filter},page:${page}}`, limitMs: BUDGETS_MS.list_filter });
    }
  }
  for (const prefix of SUGGEST_PREFIXES) {
    all.push({ name: `go suggest ${prefix}`, scenario: "go_suggest", metric: `http_req_waiting{kind:go_suggest,prefix:${prefix}}`, limitMs: BUDGETS_MS.go_suggest });
  }
  for (const term of [...SEARCH_TERMS, SHARED_TERM]) {
    all.push({ name: `search ${term}`, scenario: "search", metric: `http_req_waiting{kind:search,term:${term}}`, limitMs: BUDGETS_MS.search });
  }
  return all.filter((budget) => scenarios.includes(budget.scenario));
}

// The k6 thresholds of the budgets of `scenarios`: p(95) under the limit. A ratio budget has no millisecond limit k6 could enforce, because its other side is the p95 of another k6 run (the budgets run, while the
// import phase is a run of its own) that k6 cannot see: its threshold is one that no value can fail (as the ones of `loadThresholds`), which only puts the p(95) in the summary, and run.mjs judges the ratio.
export function budgetThresholds(scenarios = SCENARIOS) {
  const thresholds = {};
  for (const { metric, limitMs } of budgets(scenarios)) {
    thresholds[metric] = [limitMs === undefined ? "p(95)>=0" : `p(95)<${limitMs}`];
  }
  return thresholds;
}

// The ratio budgets judged. `rows` are the rows of one run's budgets (steady and import together), each with `scenario`, `metric`, `p95Ms` and, for a ratio budget, `of` and `limitRatio`; `loads` is the load of each
// scenario (`dropped`, `saturated`, `peakVus`, `maxVus`). A ratio row gets the steady p95 it is judged against (`baselineP95Ms`, `baselineSaturated`), the `ratio` (rounded to two decimals, the figure the report shows and the
// one the limit is held to) and `judged`. The time of a request that waited for a server that could not keep up is not the time of a statement, so a saturated side is not one to divide by or into:
//   - the row's own import scenario dropped arrivals or was saturated: the row is a miss, `ok: false` with the reason in `saturatedMiss` (the numbers of the load, and the other reasons below when there are any). A phase
//     that queued is the import hurting /go and the list, which the ratio exists to catch. `ratio` is kept when the baseline is usable and is `null` when it is not.
//   - only the steady baseline is saturated or dropped arrivals, or its p95 is 0 ms: the row is not judged, `judged: false` with `ok: true` and the reasons in `notJudged`. The baseline has a millisecond budget of its own, which a queue
//     normally exceeds, so the problem is reported there and the import is not its cause.
// A run with no ratio row is returned as it is.
export function judgeRatios(rows, loads) {
  return rows.map((row) => {
    if (row.limitRatio === undefined) {
      return row;
    }
    const baseline = rows.find((other) => other.limitMs !== undefined && other.metric === `http_req_waiting{kind:${row.of}}`);
    if (baseline === undefined) {
      throw new Error(`the budget ${row.name} is judged against the scenario ${row.of}, which has no budget in the run`);
    }
    const loadOf = (scenario) => {
      const load = loads[scenario];
      if (load === undefined) {
        throw new Error(`the budget ${row.name} has no load for the scenario ${scenario}`);
      }
      return load;
    };
    const queued = (load) => load.dropped > 0 || load.saturated;
    const queueOf = (load) => (load.dropped > 0 ? `dropped ${String(load.dropped)} arrivals` : "was saturated");
    const own = loadOf(row.scenario);
    const base = loadOf(row.of);
    const notJudged = [];
    if (queued(base)) {
      notJudged.push(`${row.of} (the steady baseline) ${queueOf(base)}`);
    }
    if (!(baseline.p95Ms > 0)) {
      notJudged.push(`${row.of} (the steady baseline) has a p95 of 0 ms`);
    }
    const judged = { ...row, baselineP95Ms: baseline.p95Ms, baselineSaturated: baseline.saturated };
    const ratio = notJudged.length === 0 ? Math.round((row.p95Ms / baseline.p95Ms) * 100) / 100 : null;
    if (queued(own)) {
      const saturatedMiss = [`${row.scenario} ${queueOf(own)} and used ${String(own.peakVus)} of ${String(own.maxVus)} VUs; its p95 is the time of a queue`, ...notJudged].join("; ");
      return { ...judged, ratio, judged: true, saturatedMiss, ok: false };
    }
    if (notJudged.length > 0) {
      return { ...judged, ratio: null, judged: false, notJudged: notJudged.join("; "), ok: true };
    }
    return { ...judged, ratio, judged: true, ok: ratio <= row.limitRatio };
  });
}

// What a run says about its own load, per scenario: the requests that completed, the arrivals k6 dropped because every VU was busy and could not
// start another, and the most VUs active at an arrival. k6 puts a sub-metric in its summary only when a threshold names it, so each is named by a
// threshold that no value can fail (a count or a maximum is never below 0): they report and never end k6 with 99. A scenario that dropped nothing has
// `"count": 0` for `dropped_iterations` in the summary, which is a real 0; the runner reads an entry that is missing as an error, not as 0.
export function loadMetrics(scenario) {
  return {
    completed: `http_reqs{kind:${scenario}}`,
    dropped: `dropped_iterations{scenario:${scenario}}`,
    activeVus: `active_vus{kind:${scenario}}`,
  };
}

export function loadThresholds(scenarios = SCENARIOS) {
  const thresholds = {};
  for (const scenario of scenarios) {
    const { completed, dropped, activeVus } = loadMetrics(scenario);
    thresholds[completed] = ["count>=0"];
    thresholds[dropped] = ["count>=0"];
    thresholds[activeVus] = ["max>=0"];
  }
  return thresholds;
}

// What the import run reports of the creates, in each phase, without a budget: the server time of their p(95), their number, and the arrivals k6 dropped because every VU was busy
// (creates held by the import's lock keep their VU; a dropped one is a create that was never measured). As with the load above, a threshold that no value can fail puts each in the summary.
export const CREATES_SCENARIO = "creates";

export function createMetrics(phase) {
  return { p95: `http_req_waiting{kind:create,phase:${phase}}`, completed: `http_reqs{kind:create,phase:${phase}}` };
}

export const CREATES_DROPPED_METRIC = `dropped_iterations{scenario:${CREATES_SCENARIO}}`;

export function createThresholds() {
  const thresholds = { [CREATES_DROPPED_METRIC]: ["count>=0"] };
  for (const phase of CREATE_PHASES) {
    const { p95, completed } = createMetrics(phase);
    thresholds[p95] = ["p(95)>=0"];
    thresholds[completed] = ["count>=0"];
  }
  return thresholds;
}
