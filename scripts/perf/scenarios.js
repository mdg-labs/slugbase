/* global __ENV, open */
// The k6 scenarios of the performance budgets (doc 08 section 5.3, doc 01 section 9.3), run by scripts/perf/run.mjs against a
// server on this machine whose database holds the large instance. One session is made in setup() and every request carries it.
// The scenarios run one after the other, so each budget is measured without the load of the others. "Server time" is the time
// k6 waits for the first byte of the answer (http_req_waiting): /go p95 under 30 ms, list and search p95 under 100 ms. /go and search
// include the bookmarks that members share with the account (doc 02 sections 6.3 and 8), and the budgets cover them. The list is measured in three
// shapes: with no text and no filter (every sort, first and deep page), narrowed by a text (first and deep page) and under a tag and under a folder of the account's.
// A second set of one scenario, `go-hot`, requests one forwarding slug 10 000 times for the write-load check of run.mjs (doc 01 section 8.1).
import http from "k6/http";
import execution from "k6/execution";
import { check, fail } from "k6";
import { Trend } from "k6/metrics";
import { GO_HOT_METRIC, GO_HOT_REQUESTS, MAX_VUS, PAGES, SEARCH_TERMS, SHARED_TERM, SORTS, budgetThresholds, loadThresholds } from "./budgets.js";

const BASE_URL = __ENV.BASE_URL;
const ORIGIN = __ENV.APP_ORIGIN;
const EMAIL = __ENV.SLUGBASE_PERF_EMAIL;
const PASSWORD = __ENV.SLUGBASE_PERF_PASSWORD;
const RATE = Number(__ENV.RATE || 40);
const DURATION_SECONDS = Number(__ENV.DURATION_SECONDS || 30);
const GAP_SECONDS = 5;
// A page of 48 is the default of the API and of the web app; the deep page is the 400th of them, row 19 152 of 50 000.
const PAGE_SIZE = 48;
const DEEP_PAGE = Number(__ENV.DEEP_PAGE || 400);
// The deep page of a list narrowed by a text is the 20th of them, or the last one a term has when it matches fewer; a term of one page has none.
const DEEP_TEXT_PAGE = Number(__ENV.DEEP_TEXT_PAGE || 20);
const GO_HOT_VUS = 20;
const GO_HOT = __ENV.SCENARIO_SET === "go-hot";

const fixtures = JSON.parse(open("/data/fixtures.json"));

// A slug nobody has, or one whose bookmark is plan-archived, is answered 404 on purpose, so that is not a failed request.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 399 }, 404));

function scenario(index, exec, tags) {
  return {
    executor: "constant-arrival-rate",
    rate: RATE,
    timeUnit: "1s",
    duration: `${DURATION_SECONDS}s`,
    startTime: `${index * (DURATION_SECONDS + GAP_SECONDS)}s`,
    preAllocatedVUs: 10,
    maxVUs: MAX_VUS,
    exec,
    tags,
  };
}

const thresholds = GO_HOT
  ? {
      checks: ["rate==1"],
      // The requests of the load are all made, so that the number the runner compares the updates to is the number asked for.
      [GO_HOT_METRIC]: [`count==${GO_HOT_REQUESTS}`],
    }
  : {
      // A request that did not answer as asked would be fast and wrong.
      checks: ["rate==1"],
      ...budgetThresholds(),
      // Not budgets: they only put the load of each scenario in the summary (budgets.js), and no value fails them.
      ...loadThresholds(),
    };

// The VUs active at the start of each iteration, by scenario: its maximum is the most the scenario needed.
const activeVus = new Trend("active_vus");

export const options = {
  setupTimeout: "600s",
  scenarios: GO_HOT
    ? { go_hot: { executor: "shared-iterations", vus: GO_HOT_VUS, iterations: GO_HOT_REQUESTS, maxDuration: "300s", exec: "goHot", tags: { kind: "go_hot" } } }
    : {
        go: scenario(0, "go", { kind: "go" }),
        list: scenario(1, "list", { kind: "list" }),
        search: scenario(2, "search", { kind: "search" }),
        list_q: scenario(3, "listText", { kind: "list_q" }),
        list_filter: scenario(4, "listFilter", { kind: "list_filter" }),
      },
  thresholds,
};

function get(path, headers, tags, redirects) {
  return http.get(`${BASE_URL}${path}`, { headers, tags, redirects });
}

export function setup() {
  // A term of the instance that budgets.js does not list would be measured under no budget and reported by none.
  if (JSON.stringify(fixtures.searchTerms) !== JSON.stringify(SEARCH_TERMS)) {
    fail(`the search terms of the instance (${fixtures.searchTerms.join(", ")}) are not those of budgets.js (${SEARCH_TERMS.join(", ")})`);
  }
  const login = http.post(`${BASE_URL}/api/v1/auth/login`, JSON.stringify({ email: EMAIL, password: PASSWORD }), {
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    tags: { kind: "setup" },
  });
  const cookies = Object.entries(login.cookies).map(([name, list]) => `${name}=${list[0].value}`);
  if (login.status !== 200 || cookies.length === 0) {
    fail(`signing in answered ${login.status}`);
  }
  const headers = { Cookie: cookies.join("; ") };
  if (GO_HOT) {
    return { headers };
  }
  if (fixtures.tagIds.length === 0 || fixtures.folderIds.length === 0) {
    fail("the instance has no tag or no folder of the account's to filter the list by");
  }
  // The cursor of the deep page of each sort is found the way a client finds it: by following the pages.
  const cursors = {};
  for (const sort of SORTS) {
    let cursor = null;
    for (let page = 1; page < DEEP_PAGE; page += 1) {
      const query = `sort=${sort}&limit=${PAGE_SIZE}${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
      const response = get(`/api/v1/bookmarks?${query}`, headers, { kind: "setup" });
      cursor = response.status === 200 ? response.json("nextCursor") : null;
      if (cursor === null) {
        fail(`the list sorted by ${sort} ended before page ${DEEP_PAGE} (status ${response.status})`);
      }
    }
    cursors[sort] = cursor;
  }
  // A cursor is valid only for the text it was issued for, so each term is followed on its own.
  const textCursors = {};
  for (const term of fixtures.searchTerms) {
    let cursor = null;
    for (let page = 1; page < DEEP_TEXT_PAGE; page += 1) {
      const response = get(`/api/v1/bookmarks?${textQuery(term, cursor)}`, headers, { kind: "setup" });
      if (response.status !== 200) {
        fail(`the list narrowed by "${term}" answered ${response.status}`);
      }
      const next = response.json("nextCursor");
      if (next === null) {
        break;
      }
      cursor = next;
    }
    if (cursor !== null) {
      textCursors[term] = cursor;
    }
  }
  if (Object.keys(textCursors).length === 0) {
    fail("no search term of the instance matches enough bookmarks for a deep page of the list narrowed by a text");
  }
  return { headers, cursors, textCursors };
}

function textQuery(term, cursor) {
  return `q=${encodeURIComponent(term)}&limit=${PAGE_SIZE}${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
}

// Where a request of the /go scenario goes: most to a slug of the account's own, some to a slug that a member shares with the account as well
// (the account's own comes first), to a slug only one member shares (forwarded to), to a slug several members share and the account has none of
// (the disambiguation page, which the server answers with the single-page app and status 200), some to a slug nobody has and some to a slug of an archived
// bookmark of the account's own (not found as well). The kinds with no slug on the instance are left out.
const GO_KINDS = [
  { kind: "own", weight: 60, slugs: () => fixtures.slugs },
  { kind: "colliding", weight: 15, slugs: () => fixtures.collidingSlugs || [] },
  { kind: "shared", weight: 5, slugs: () => fixtures.sharedSlugs || [] },
  { kind: "ambiguous", weight: 5, slugs: () => fixtures.ambiguousSlugs || [] },
  { kind: "missing", weight: 15, slugs: () => [`no-such-slug-${Math.floor(Math.random() * 1000)}`] },
  // The account's own plan-archived bookmarks (doc 05 section 2.2): /go does not forward to them.
  { kind: "archived", weight: 5, slugs: () => fixtures.archivedSlugs || [] },
];

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function goKind() {
  const available = GO_KINDS.filter((entry) => entry.slugs().length > 0);
  let roll = Math.random() * available.reduce((sum, entry) => sum + entry.weight, 0);
  for (const entry of available) {
    roll -= entry.weight;
    if (roll < 0) {
      return entry;
    }
  }
  return available[0];
}

const GO_CHECKS = {
  own: { "a slug forwards": (r) => r.status === 302 && /^https?:\/\//.test(r.headers.Location) },
  colliding: { "a slug shared by a member forwards to the account's own": (r) => r.status === 302 && /^https?:\/\//.test(r.headers.Location) },
  shared: { "a slug only a member shares forwards": (r) => r.status === 302 && /^https?:\/\//.test(r.headers.Location) },
  ambiguous: { "a slug several members share asks to choose": (r) => r.status === 200 },
  missing: { "an unknown slug is not found": (r) => r.status === 404 },
  archived: { "the slug of an archived bookmark is not found": (r) => r.status === 404 },
};

export function go(data) {
  activeVus.add(execution.instance.vusActive, { kind: "go" });
  const entry = goKind();
  const response = get(`/go/${pick(entry.slugs())}`, data.headers, { kind: "go", hit: String(entry.kind !== "missing" && entry.kind !== "archived"), route: entry.kind }, 0);
  check(response, GO_CHECKS[entry.kind]);
}

export function list(data) {
  activeVus.add(execution.instance.vusActive, { kind: "list" });
  const sort = SORTS[Math.floor(Math.random() * SORTS.length)];
  const page = PAGES[Math.floor(Math.random() * PAGES.length)];
  const cursor = page === "deep" ? `&cursor=${encodeURIComponent(data.cursors[sort])}` : "";
  const response = get(`/api/v1/bookmarks?sort=${sort}&limit=${PAGE_SIZE}${cursor}`, data.headers, { kind: "list", sort, page });
  check(response, { "a page of bookmarks": (r) => r.status === 200 && r.json("items").length === PAGE_SIZE });
}

export function search(data) {
  activeVus.add(execution.instance.vusActive, { kind: "search" });
  // Some of the terms only bookmarks that members share with the account match, so the search reads the shares as well as the account's own bookmarks.
  const shared = fixtures.sharedSearchTerms || [];
  const useShared = shared.length > 0 && Math.random() < 0.2;
  const term = useShared ? pick(shared) : pick(fixtures.searchTerms);
  const response = get(`/api/v1/search?q=${encodeURIComponent(term)}`, data.headers, { kind: "search", term: useShared ? SHARED_TERM : term });
  check(response, {
    "search results": (r) => r.status === 200 && Array.isArray(r.json("bookmarks")),
    "a shared bookmark is found": (r) => !useShared || (r.status === 200 && r.json("bookmarks").length > 0),
  });
}

export function listText(data) {
  activeVus.add(execution.instance.vusActive, { kind: "list_q" });
  const deep = Object.keys(data.textCursors);
  const page = PAGES[Math.floor(Math.random() * PAGES.length)];
  const term = page === "deep" ? pick(deep) : pick(fixtures.searchTerms);
  const response = get(`/api/v1/bookmarks?${textQuery(term, page === "deep" ? data.textCursors[term] : null)}`, data.headers, { kind: "list_q", page });
  check(response, { "a page of the bookmarks a text finds": (r) => r.status === 200 && r.json("items").length > 0 });
}

export function listFilter(data) {
  activeVus.add(execution.instance.vusActive, { kind: "list_filter" });
  const filter = Math.random() < 0.5 ? "tag" : "folder";
  const id = pick(filter === "tag" ? fixtures.tagIds : fixtures.folderIds);
  const response = get(`/api/v1/bookmarks?${filter === "tag" ? "tag" : "folderId"}=${id}&limit=${PAGE_SIZE}`, data.headers, { kind: "list_filter", filter });
  check(response, { "a page of the bookmarks under a filter": (r) => r.status === 200 && r.json("items").length > 0 });
}

// One forwarding slug, requested GO_HOT_REQUESTS times: the opens it records must not become a write for each request (run.mjs reads the writes).
export function goHot(data) {
  const response = get(`/go/${fixtures.slugs[0]}`, data.headers, { kind: "go_hot" }, 0);
  check(response, { "the hot slug forwards": (r) => r.status === 302 && /^https?:\/\//.test(r.headers.Location) });
}
