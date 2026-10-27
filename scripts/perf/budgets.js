// The performance budgets of doc 08 section 5.3 and the shapes the list is measured in, in one place. scenarios.js (k6) turns
// them into thresholds and run.mjs (node) reads each one's p(95) back from the k6 summary, so a threshold k6 enforces is always a
// budget the runner reports. Plain ES module with no imports: both k6 and node load it.
export const SORTS = ["recent", "oldest", "title_asc", "title_desc", "most_used", "recently_opened"];
export const PAGES = ["first", "deep"];
export const BUDGETS_MS = { go: 30, list: 100, search: 100 };

// Every p(95) budget of the server time (k6 http_req_waiting): the three scenarios, then each list sort on each page, so that a
// regression names the sort and the page. `metric` is the k6 threshold key and the key of the summary.
export function budgets() {
  const all = ["go", "list", "search"].map((name) => ({ name, metric: `http_req_waiting{kind:${name}}`, limitMs: BUDGETS_MS[name] }));
  for (const sort of SORTS) {
    for (const page of PAGES) {
      all.push({ name: `list ${sort} ${page}`, metric: `http_req_waiting{kind:list,sort:${sort},page:${page}}`, limitMs: BUDGETS_MS.list });
    }
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
