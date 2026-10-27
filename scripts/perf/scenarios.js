/* global __ENV, open */
// The k6 scenarios of the performance budgets (doc 08 section 5.3, doc 01 section 9.3), run by scripts/perf/run.mjs against a
// server on this machine whose database holds the large instance. One session is made in setup() and every request carries it.
// The scenarios run one after the other, so each budget is measured without the load of the others. "Server time" is the time
// k6 waits for the first byte of the answer (http_req_waiting): /go p95 under 30 ms, list and search p95 under 100 ms.
import http from "k6/http";
import { check, fail } from "k6";
import { PAGES, SORTS, budgetThresholds } from "./budgets.js";

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

const fixtures = JSON.parse(open("/data/fixtures.json"));

// A slug nobody has is answered 404 on purpose, so that is not a failed request.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 399 }, 404));

function scenario(index, exec, tags) {
  return {
    executor: "constant-arrival-rate",
    rate: RATE,
    timeUnit: "1s",
    duration: `${DURATION_SECONDS}s`,
    startTime: `${index * (DURATION_SECONDS + GAP_SECONDS)}s`,
    preAllocatedVUs: 10,
    maxVUs: 100,
    exec,
    tags,
  };
}

const thresholds = {
  // A request that did not answer as asked would be fast and wrong.
  checks: ["rate==1"],
  ...budgetThresholds(),
};

export const options = {
  setupTimeout: "600s",
  scenarios: {
    go: scenario(0, "go", { kind: "go" }),
    list: scenario(1, "list", { kind: "list" }),
    search: scenario(2, "search", { kind: "search" }),
  },
  thresholds,
};

function get(path, headers, tags, redirects) {
  return http.get(`${BASE_URL}${path}`, { headers, tags, redirects });
}

export function setup() {
  const login = http.post(`${BASE_URL}/api/v1/auth/login`, JSON.stringify({ email: EMAIL, password: PASSWORD }), {
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    tags: { kind: "setup" },
  });
  const cookies = Object.entries(login.cookies).map(([name, list]) => `${name}=${list[0].value}`);
  if (login.status !== 200 || cookies.length === 0) {
    fail(`signing in answered ${login.status}`);
  }
  const headers = { Cookie: cookies.join("; ") };
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
  return { headers, cursors };
}

export function go(data) {
  // One request in ten asks for a slug nobody has, which the product answers with its not-found page.
  const hit = Math.random() >= 0.1;
  const slug = hit ? fixtures.slugs[Math.floor(Math.random() * fixtures.slugs.length)] : `no-such-slug-${Math.floor(Math.random() * 1000)}`;
  const response = get(`/go/${slug}`, data.headers, { kind: "go", hit: String(hit) }, 0);
  check(response, hit ? { "a slug forwards": (r) => r.status === 302 && /^https?:\/\//.test(r.headers.Location) } : { "an unknown slug is not found": (r) => r.status === 404 });
}

export function list(data) {
  const sort = SORTS[Math.floor(Math.random() * SORTS.length)];
  const page = PAGES[Math.floor(Math.random() * PAGES.length)];
  const cursor = page === "deep" ? `&cursor=${encodeURIComponent(data.cursors[sort])}` : "";
  const response = get(`/api/v1/bookmarks?sort=${sort}&limit=${PAGE_SIZE}${cursor}`, data.headers, { kind: "list", sort, page });
  check(response, { "a page of bookmarks": (r) => r.status === 200 && r.json("items").length === PAGE_SIZE });
}

export function search(data) {
  const term = fixtures.searchTerms[Math.floor(Math.random() * fixtures.searchTerms.length)];
  const response = get(`/api/v1/search?q=${encodeURIComponent(term)}`, data.headers, { kind: "search" });
  check(response, { "search results": (r) => r.status === 200 && Array.isArray(r.json("bookmarks")) });
}
