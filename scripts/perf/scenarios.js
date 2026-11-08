/* global __ENV, open */
// The k6 scenarios of the performance budgets (doc 08 section 5.3, doc 01 section 9.3), run by scripts/perf/run.mjs against a
// server on this machine whose database holds the large instance. One session is made in setup() and every request carries it.
// The scenarios run one after the other, so each budget is measured without the load of the others. "Server time" is the time
// k6 waits for the first byte of the answer (http_req_waiting): /go p95 under 30 ms, list and search p95 under 100 ms. /go and search
// include the bookmarks that members share with the account (doc 02 sections 6.3 and 8), and the budgets cover them. The list is measured in three
// shapes: with no text and no filter (every sort, first and deep page), narrowed by a text (first and deep page) and under a tag and under a folder of the account's.
// A second set of one scenario, `go-hot`, requests one forwarding slug 10 000 times for the write-load check of run.mjs (doc 01 section 8.1).
// A third set, `import`, runs last (a run of its own, after the budgets, so that the bookmarks it adds change none of their measurements): one member imports the largest Netscape
// file and the largest SlugBase JSON file into the large workspace while the admin's /go and list traffic goes on at the run's rate and another member creates bookmarks.
import http from "k6/http";
import execution from "k6/execution";
import { check, fail } from "k6";
import { SharedArray } from "k6/data";
import { Trend } from "k6/metrics";
import {
  CREATES_SCENARIO,
  CREATE_RATE,
  CREATOR_EMAIL,
  GO_HOT_METRIC,
  GO_HOT_REQUESTS,
  IMPORTER_EMAIL,
  IMPORT_SCENARIOS,
  MAX_VUS,
  PAGES,
  SEARCH_TERMS,
  SHARED_TERM,
  SORTS,
  STEADY_SCENARIOS,
  budgetThresholds,
  createThresholds,
  loadThresholds,
} from "./budgets.js";

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
const IMPORT = __ENV.SCENARIO_SET === "import";
// The import run: the creates go on for DURATION_SECONDS before the first import (their baseline), and the load of /go and the list lasts for IMPORT_WINDOW_SECONDS from the start
// of the import, which must end within it. The state of the import is kept by run.mjs (budgets.js IMPORT_STATES), which this run reaches at SIGNAL_URL.
const IMPORT_WINDOW_SECONDS = Number(__ENV.IMPORT_WINDOW_SECONDS || 60);
const SIGNAL_URL = __ENV.SIGNAL_URL;

const fixtures = JSON.parse(open("/data/fixtures.json"));
// The files are read once and shared by the VUs; only the importer sends them.
const netscapeFile = IMPORT ? new SharedArray("netscape", () => [open("/data/import-netscape.html")]) : [];
const jsonFile = IMPORT ? new SharedArray("json", () => [open("/data/import.json")]) : [];

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
      ...budgetThresholds(IMPORT ? IMPORT_SCENARIOS : STEADY_SCENARIOS),
      // Not budgets: they only put the load of each scenario in the summary (budgets.js), and no value fails them.
      ...loadThresholds(IMPORT ? IMPORT_SCENARIOS : STEADY_SCENARIOS),
      ...(IMPORT ? createThresholds() : {}),
    };

// The import run: the creates start with the run; the load of /go and the list starts when they have had their baseline, and lasts the window and a second; the import starts a second after
// the load and has the window to end in (importer() fails the run if it does not).
function importScenarios() {
  const baseline = DURATION_SECONDS;
  const load = (exec, tags) => ({
    executor: "constant-arrival-rate",
    rate: RATE,
    timeUnit: "1s",
    duration: `${IMPORT_WINDOW_SECONDS + 1}s`,
    startTime: `${baseline}s`,
    preAllocatedVUs: 10,
    maxVUs: MAX_VUS,
    exec,
    tags,
  });
  return {
    [CREATES_SCENARIO]: {
      executor: "constant-arrival-rate",
      rate: CREATE_RATE,
      timeUnit: "1s",
      duration: `${baseline + IMPORT_WINDOW_SECONDS + 1}s`,
      preAllocatedVUs: 10,
      maxVUs: MAX_VUS,
      exec: "createDuringImport",
      tags: { kind: "create" },
    },
    importer: { executor: "per-vu-iterations", vus: 1, iterations: 1, startTime: `${baseline + 1}s`, maxDuration: `${IMPORT_WINDOW_SECONDS + 60}s`, exec: "importer", tags: { kind: "import" } },
    go_import: load("goDuringImport", { kind: "go_import" }),
    list_import: load("listDuringImport", { kind: "list_import" }),
  };
}

// The VUs active at the start of each iteration, by scenario: its maximum is the most the scenario needed.
const activeVus = new Trend("active_vus");

export const options = {
  setupTimeout: "600s",
  scenarios: GO_HOT
    ? { go_hot: { executor: "shared-iterations", vus: GO_HOT_VUS, iterations: GO_HOT_REQUESTS, maxDuration: "300s", exec: "goHot", tags: { kind: "go_hot" } } }
    : IMPORT
      ? importScenarios()
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

// The cookies of a session for `email`, as the header a request carries; the run's password is every account's. Each sign-in has a jar of its own: one that carried the cookie of an earlier
// session would end that session by signing in over it.
function signIn(email) {
  const login = http.post(`${BASE_URL}/api/v1/auth/login`, JSON.stringify({ email, password: PASSWORD }), {
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    jar: new http.CookieJar(),
    tags: { kind: "setup" },
  });
  const cookies = Object.entries(login.cookies).map(([name, list]) => `${name}=${list[0].value}`);
  if (login.status !== 200 || cookies.length === 0) {
    fail(`signing in answered ${login.status}`);
  }
  return { Cookie: cookies.join("; ") };
}

// The cursor of the deep page of each sort is found the way a client finds it: by following the pages.
function deepCursors(headers) {
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
  return cursors;
}

export function setup() {
  // A term of the instance that budgets.js does not list would be measured under no budget and reported by none.
  if (JSON.stringify(fixtures.searchTerms) !== JSON.stringify(SEARCH_TERMS)) {
    fail(`the search terms of the instance (${fixtures.searchTerms.join(", ")}) are not those of budgets.js (${SEARCH_TERMS.join(", ")})`);
  }
  const headers = signIn(EMAIL);
  if (GO_HOT) {
    return { headers };
  }
  if (IMPORT) {
    if (netscapeFile.length !== 1 || jsonFile.length !== 1 || SIGNAL_URL === undefined) {
      fail("the import run has no files to import or no address for the state of the import");
    }
    // The importer and the member that creates are signed in once, here, as the admin is; the creates' addresses are made of a number of this run.
    return { headers, cursors: deepCursors(headers), importer: signIn(IMPORTER_EMAIL), creator: signIn(CREATOR_EMAIL), runId: uuid() };
  }
  if (fixtures.tagIds.length === 0 || fixtures.folderIds.length === 0) {
    fail("the instance has no tag or no folder of the account's to filter the list by");
  }
  const cursors = deepCursors(headers);
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

function goRequest(data, kind) {
  activeVus.add(execution.instance.vusActive, { kind });
  const entry = goKind();
  const response = get(`/go/${pick(entry.slugs())}`, data.headers, { kind, hit: String(entry.kind !== "missing" && entry.kind !== "archived"), route: entry.kind }, 0);
  check(response, GO_CHECKS[entry.kind]);
}

export function go(data) {
  goRequest(data, "go");
}

function listRequest(data, kind) {
  activeVus.add(execution.instance.vusActive, { kind });
  const sort = SORTS[Math.floor(Math.random() * SORTS.length)];
  const page = PAGES[Math.floor(Math.random() * PAGES.length)];
  const cursor = page === "deep" ? `&cursor=${encodeURIComponent(data.cursors[sort])}` : "";
  const response = get(`/api/v1/bookmarks?sort=${sort}&limit=${PAGE_SIZE}${cursor}`, data.headers, { kind, sort, page });
  check(response, { "a page of bookmarks": (r) => r.status === 200 && r.json("items").length === PAGE_SIZE });
}

export function list(data) {
  listRequest(data, "list");
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

// The import run (doc 02 section 13.1). The state of the import is read from, and set at, the run (SIGNAL_URL): a VU cannot see another's variables.
function uuid() {
  const hex = () => Math.floor(Math.random() * 16).toString(16);
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => (c === "x" ? hex() : ((Math.floor(Math.random() * 4) + 8).toString(16))));
}

// The state of the import; null when the run does not answer, which is a failed check (a request made or left out on a guess would be measured wrong).
function importState() {
  const response = http.get(SIGNAL_URL, { tags: { kind: "signal" } });
  const answered = response.status === 200;
  check(response, { "the run answers with the state of the import": () => answered });
  return answered ? response.json("state") : null;
}

function setImportState(state, result) {
  const response = http.post(SIGNAL_URL, JSON.stringify({ state, ...(result === undefined ? {} : { result }) }), { tags: { kind: "signal" } });
  if (response.status !== 200) {
    execution.test.abort(`the run did not take the state ${state} of the import (status ${response.status})`);
  }
}

// /go and the list are requested only while an import is in flight, so their p95 is the p95 of that time and no other.
export function goDuringImport(data) {
  if (importState() === "importing") {
    goRequest(data, "go_import");
  }
}

export function listDuringImport(data) {
  if (importState() === "importing") {
    listRequest(data, "list_import");
  }
}

// A create by perf-member-2 before the first import (phase `without`) and while one is in flight (phase `during`); one that comes between the imports or after them is not made. A create
// that arrives while an import holds the workspace row lock waits for it, and that wait is what the phase `during` measures.
export function createDuringImport(data) {
  const state = importState();
  const phase = state === "before" ? "without" : state === "importing" ? "during" : null;
  if (phase === null) {
    return;
  }
  const number = execution.scenario.iterationInTest;
  const body = JSON.stringify({ url: `https://create.import.example.test/${data.runId}/${number}`, title: `Created beside an import ${number}` });
  const response = http.post(`${BASE_URL}/api/v1/bookmarks`, body, {
    headers: { ...data.creator, "Content-Type": "application/json", Origin: ORIGIN, "Idempotency-Key": uuid() },
    tags: { kind: "create", phase },
  });
  check(response, { "a bookmark is created": (r) => r.status === 201 });
}

// What the import answered, as the run keeps it (run.mjs reads it back and judges it): the counts of the answer, its status and how long the request took.
function importRecord(name, bytes, response) {
  const answer = response.status === 200 ? response.json() : null;
  const dropped = answer === null ? [] : answer.droppedSlugs;
  return {
    import: name,
    bytes,
    status: response.status,
    durationMs: Math.round(response.timings.duration * 100) / 100,
    replayed: response.headers["Idempotency-Replayed"] !== undefined,
    detected: answer === null ? null : answer.detected,
    created: answer === null ? null : answer.created,
    skipped: answer === null ? null : answer.skipped.length,
    failed: answer === null ? null : answer.failed.length,
    slugsDropped: answer === null ? null : answer.slugsDropped,
    slugsDroppedInvalid: dropped.filter((entry) => entry.reason === "slug_invalid").length,
    slugsDroppedConflict: dropped.filter((entry) => entry.reason === "slug_conflict").length,
    foldersCreated: answer === null ? null : answer.foldersCreated,
    tagsCreated: answer === null ? null : answer.tagsCreated,
  };
}

// perf-member-1 imports the Netscape file and then the JSON file, each with an Idempotency-Key of its own, and the state tells the other scenarios which time to measure. An import that is
// not answered 200 or is replayed, or that does not end within the window of the load, ends the run: it would be measured as fast, or without the load.
export function importer(data) {
  const deadline = execution.scenario.startTime + IMPORT_WINDOW_SECONDS * 1000;
  const headers = { ...data.importer, Origin: ORIGIN };
  const imports = [
    {
      name: "netscape",
      bytes: netscapeFile[0].length,
      send: (key) =>
        http.post(`${BASE_URL}/api/v1/import/netscape`, { file: http.file(netscapeFile[0], "bookmarks.html", "text/html") }, { headers: { ...headers, "Idempotency-Key": key }, timeout: "300s", tags: { kind: "import", import: "netscape" } }),
    },
    {
      name: "json",
      bytes: jsonFile[0].length,
      send: (key) =>
        http.post(`${BASE_URL}/api/v1/import/json`, jsonFile[0], { headers: { ...headers, "Content-Type": "application/json", "Idempotency-Key": key }, timeout: "300s", tags: { kind: "import", import: "json" } }),
    },
  ];
  imports.forEach((entry, index) => {
    setImportState("importing");
    const response = entry.send(uuid());
    const record = importRecord(entry.name, entry.bytes, response);
    const ended = Date.now();
    if (record.status !== 200 || record.replayed || ended > deadline) {
      setImportState("failed", record);
      execution.test.abort(
        record.status !== 200
          ? `the ${entry.name} import answered ${record.status}`
          : record.replayed
            ? `the ${entry.name} import was answered from an earlier request`
            : `the ${entry.name} import did not end within the ${IMPORT_WINDOW_SECONDS} s of the load`,
      );
    }
    setImportState(index === imports.length - 1 ? "after" : "between", record);
  });
}
