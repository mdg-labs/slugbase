// What the performance run files (doc 08 section 5.3), decided here and not in the workflow: it reads `result.json` of run.mjs and the open issues, and prints the
// actions to take, which the `performance` job of .github/workflows/nightly.yml then executes and nothing more.
//
// Every exceeded budget is filed under one issue of its scenario, titled `Performance budget exceeded: <name>`:
//   go           the `go` scenario
//   go suggest   the `go_suggest` scenario (the slugs the palette's go mode suggests) and each of its prefixes
//   list         the `list` scenario and the shapes of the list narrowed by a text (`list_q`) and filtered (`list_filter`), which are
//                the bookmark list and cost what the list costs
//   dashboard    the `dashboard` scenario
//   search       the `search` scenario and each of its terms
//   import       `go_import` and `list_import`, the /go and list budgets while an import is in flight, which are ratios to the same run's steady /go and list p95 (budgets.js RATIO_BUDGETS): their
//                cause is the import (its lock, its load), not /go or the list on their own, so they are not filed under `go` or `list`, whose budgets hold with no import. The issue lists every ratio row of
//                the run, with both p95, the ratio and the limit, and says which missed because the import scenario was saturated or dropped arrivals, and which were not judged (only the steady side saturated, or dropped arrivals) and why,
//                and the pool and the lock waits sampled while an import was in flight (`importPhase.pool`, `importPhase.lockWaits` of the result): they say whether the creates that wait for the import's lock held the server's connections
//   write load   the write-load check of /go (doc 01 section 8.1), which is not a p95 and has its own issue
// A run that exceeds a budget whose issue is open comments on that issue (the lowest number when the title is on several), and one whose issue is not open creates
// it. The title must match exactly: an issue of another scenario, or one that names several, is never extended. A result that cannot be read, a budget of a scenario
// that has no issue and a list of issues that is not one are errors, never a run with nothing to file.
//
//   node scripts/perf/report.mjs --result <result.json> --issues <issues.json> --run-url <url> [--event <name>] [--body-dir <dir>] [--expect-action]
//
// `issues.json` is the output of `gh issue list --state open --json number,title`. Without --body-dir the actions carry their bodies and nothing is written (a
// dry run); with it each body is a file in the directory and the action names it, for `gh issue create --body-file`. The actions are printed as a JSON array:
// `{ "kind": "create", "title", "bodyFile" }` or `{ "kind": "comment", "number", "title", "bodyFile" }`. --expect-action ends with status 1 when there is none, for a
// caller that knows the run exceeded something. Nothing here calls GitHub or runs a command.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { SCENARIOS } from "./budgets.js";

export const TITLE_PREFIX = "Performance budget exceeded: ";
export const WRITE_LOAD = "write load";
// The issue each scenario of budgets.js is filed under.
export const ISSUE_OF = {
  go: "go",
  go_suggest: "go suggest",
  list: "list",
  list_q: "list",
  list_filter: "list",
  search: "search",
  dashboard: "dashboard",
  go_import: "import",
  list_import: "import",
};

// Every scenario of budgets.js has an issue; a scenario added there without one is refused here at once.
for (const scenario of SCENARIOS) {
  if (!Object.hasOwn(ISSUE_OF, scenario)) {
    fail(`the scenario ${scenario} has no issue`);
  }
}

const NAME = /^[a-z0-9][a-z0-9 _.-]{0,79}$/;
const COMMIT = /^[0-9a-f]{40}$/;
// The reason a ratio was not judged, or was missed by saturation, goes into an issue: plain words, no markup or line break.
const REASON = /^[A-Za-z0-9 ;,()._-]{1,300}$/;

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;

function fail(message) {
  throw new Error(`perf report: ${message}`);
}

function requireCounts(source, keys, what) {
  if (!isRecord(source)) {
    fail(`${what} is missing`);
  }
  for (const key of keys) {
    if (!isCount(source[key])) {
      fail(`${what} has no number ${key}`);
    }
  }
}

// The result of run.mjs, checked for everything the report reads. A field of the wrong type is an error: a budget is never dropped for being unreadable.
export function parseResult(text) {
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    fail("result.json is not JSON");
  }
  if (!isRecord(result)) {
    fail("result.json is not an object");
  }
  if (result.commit !== null && !(typeof result.commit === "string" && COMMIT.test(result.commit))) {
    fail("result.json has no commit, null or 40 hex digits");
  }
  requireCounts(result.database, ["bookmarks", "workspaces", "largestWorkspace"], "database");
  if (!isRecord(result.scenarios)) {
    fail("result.json has no scenarios");
  }
  for (const [name, load] of Object.entries(result.scenarios)) {
    requireCounts(load, ["completed", "dropped", "peakVus", "maxVus"], `scenario ${name}`);
    if (typeof load.saturated !== "boolean") {
      fail(`scenario ${name} has no saturated flag`);
    }
  }
  if (!Array.isArray(result.budgets) || result.budgets.length === 0) {
    fail("result.json has no budgets");
  }
  for (const budget of result.budgets) {
    if (!isRecord(budget) || typeof budget.name !== "string" || !NAME.test(budget.name)) {
      fail("a budget has no usable name");
    }
    if (typeof budget.scenario !== "string" || !Object.hasOwn(ISSUE_OF, budget.scenario)) {
      fail(`the budget ${budget.name} belongs to the scenario ${String(budget.scenario)}, which has no issue`);
    }
    if (!Object.hasOwn(result.scenarios, budget.scenario)) {
      fail(`the budget ${budget.name} belongs to the scenario ${budget.scenario}, which has no load in the result`);
    }
    if (Object.hasOwn(budget, "limitRatio")) {
      // A ratio budget: the p95 of the scenario against that of the steady scenario of the same run. It is judged, or missed by saturation of its own import scenario (`saturatedMiss`), or it says why it was not judged, and a row that is not judged is never an exceeded one.
      requireCounts(budget, ["p95Ms", "limitRatio", "baselineP95Ms"], `budget ${budget.name}`);
      if (typeof budget.of !== "string" || !Object.hasOwn(result.scenarios, budget.of)) {
        fail(`the budget ${budget.name} is judged against the scenario ${String(budget.of)}, which has no load in the result`);
      }
      if (typeof budget.judged !== "boolean" || typeof budget.baselineSaturated !== "boolean") {
        fail(`budget ${budget.name} has no judged and baselineSaturated flags`);
      }
      if (Object.hasOwn(budget, "saturatedMiss")) {
        // Missed because its own import scenario was saturated or dropped arrivals: always exceeded, with the reason, and a ratio only when the baseline was usable.
        if (budget.judged !== true || budget.ok !== false || typeof budget.saturatedMiss !== "string" || !REASON.test(budget.saturatedMiss) || (budget.ratio !== null && !isCount(budget.ratio))) {
          fail(`budget ${budget.name} is missed by saturation without a reason, a ratio or null, and ok false`);
        }
      } else if (budget.judged ? !isCount(budget.ratio) : budget.ratio !== null || typeof budget.notJudged !== "string" || !REASON.test(budget.notJudged) || budget.ok !== true) {
        fail(`budget ${budget.name} is judged without a ratio, or not judged without a reason, a null ratio and ok`);
      }
    } else {
      requireCounts(budget, ["p95Ms", "limitMs"], `budget ${budget.name}`);
    }
    if (typeof budget.ok !== "boolean" || typeof budget.saturated !== "boolean") {
      fail(`budget ${budget.name} has no ok and saturated flags`);
    }
  }
  // The pool and the lock waits sampled while an import was in flight (run.mjs): a result without them, or with a figure that is not a number, is not one the report can explain an import budget with.
  if (!isRecord(result.importPhase)) {
    fail("result.json has no importPhase");
  }
  requireCounts(result.importPhase.pool, ["intervalMs", "samples", "size", "max", "p95", "samplesAboveSize"], "importPhase.pool");
  requireCounts(result.importPhase.lockWaits, ["intervalMs", "samples", "max", "p95"], "importPhase.lockWaits");
  for (const [name, figure] of [["importPhase.pool", result.importPhase.pool], ["importPhase.lockWaits", result.importPhase.lockWaits]]) {
    if (figure.samples < 1 || figure.p95 > figure.max) {
      fail(`${name} has no sample, or a p95 above its maximum`);
    }
  }
  requireCounts(result.writeLoad, ["requests", "updates", "elapsedSeconds", "flushIntervalSeconds", "limit"], "writeLoad");
  if (typeof result.writeLoad.ok !== "boolean") {
    fail("writeLoad has no ok flag");
  }
  return result;
}

// The output of `gh issue list --json number,title`: an array, each with a whole number and a title.
export function parseIssues(text) {
  let issues;
  try {
    issues = JSON.parse(text);
  } catch {
    fail("the list of issues is not JSON");
  }
  if (!Array.isArray(issues)) {
    fail("the list of issues is not an array");
  }
  for (const issue of issues) {
    if (!isRecord(issue) || !Number.isInteger(issue.number) || issue.number < 1 || typeof issue.title !== "string") {
      fail("an issue in the list has no number and title");
    }
  }
  return issues;
}

const ratioStatus = (row) => (row.saturatedMiss !== undefined ? `exceeded, saturated: ${row.saturatedMiss}` : !row.judged ? `not judged: ${row.notJudged ?? ""}` : row.ok ? "within the limit" : "exceeded");
const ratioCell = (row) => (row.ratio !== null ? String(row.ratio) : row.saturatedMiss !== undefined ? "no ratio" : "not judged");

const loadRow = (name, load) => `| ${name} | ${String(load.completed)} | ${String(load.dropped)} | ${String(load.peakVus)} of ${String(load.maxVus)} | ${load.saturated ? "saturated" : ""} |`;

function describe(result, group, rows, runUrl, event) {
  const commit = result.commit === null ? "an unknown commit" : `\`${result.commit}\``;
  const lines = [`The performance run exceeded ${group === WRITE_LOAD ? "the write load of /go" : `the \`${group}\` budget`} of doc 08 section 5.3 on \`${event}\` at ${commit}.`, ""];
  if (group === WRITE_LOAD) {
    const w = result.writeLoad;
    lines.push(
      `${String(w.requests)} requests for one slug updated ${String(w.updates)} rows of bookmarks in ${String(w.elapsedSeconds)} s, and at most ${String(w.limit)} are allowed: one for each flush interval of ${String(w.flushIntervalSeconds)} s, and one more (doc 01 section 8.1).`,
    );
  } else {
    const milliseconds = rows.filter((row) => row.limitRatio === undefined);
    if (milliseconds.length > 0) {
      lines.push("| Shape | p95 server time | Budget | |", "|---|---|---|---|");
      for (const row of milliseconds) {
        lines.push(`| ${row.name} | ${String(row.p95Ms)} ms | ${String(row.limitMs)} ms | exceeded${row.saturated ? " (saturated)" : ""} |`);
      }
      lines.push("");
    }
    // The ratio rows of the group, all of them and not only the exceeded: a ratio is read against its baseline, and one that was not judged or was missed by saturation says so here and is not left out.
    const ratios = result.budgets.filter((budget) => budget.limitRatio !== undefined && ISSUE_OF[budget.scenario] === group);
    if (ratios.length > 0) {
      lines.push("| Shape | p95 server time | p95 of the same run's steady scenario | Ratio | Limit | |", "|---|---|---|---|---|---|");
      for (const row of ratios) {
        lines.push(`| ${row.name} | ${String(row.p95Ms)} ms | ${String(row.baselineP95Ms)} ms (${row.of}) | ${ratioCell(row)} | ${String(row.limitRatio)} | ${ratioStatus(row)} |`);
      }
      lines.push(
        "",
        "A ratio is the p95 while an import is in flight over the p95 of the steady scenario of the same run (budgets.js `RATIO_BUDGETS`), so that the speed of the runner machine cancels. An import scenario that is saturated or dropped arrivals is a miss, since its p95 is the time of a queue; a ratio is not judged when only its steady scenario is saturated or dropped arrivals (that scenario has a budget of its own).",
        "",
      );
    }
    if (group === "import") {
      const { pool, lockWaits } = result.importPhase;
      lines.push(
        `Sampled every ${String(pool.intervalMs)} ms while an import was in flight: the server had at most ${String(pool.max)} tenant transactions open or waiting (p95 ${String(pool.p95)}) against a pool of ${String(pool.size)} connections, and ${String(pool.samplesAboveSize)} of ${String(pool.samples)} samples were above the pool, which is transactions queueing; at most ${String(lockWaits.max)} backends of the database waited for a lock (p95 ${String(lockWaits.p95)}, ${String(lockWaits.samples)} samples).`,
        "",
      );
    }
    // The scenarios of the issue, and the steady ones its ratios are judged against: a ratio that was not judged names a baseline whose load is then of interest.
    const scenarios = [...Object.keys(ISSUE_OF).filter((scenario) => ISSUE_OF[scenario] === group && Object.hasOwn(result.scenarios, scenario)), ...new Set(ratios.map((row) => row.of))];
    lines.push("| Scenario | Requests completed | Dropped iterations | Peak VUs | |", "|---|---|---|---|---|");
    for (const scenario of scenarios) {
      lines.push(loadRow(scenario, result.scenarios[scenario]));
    }
    if (rows.some((row) => row.saturated && row.limitRatio === undefined)) {
      lines.push(
        "",
        "A saturated scenario dropped arrivals or used every VU it may, so its requests waited for a server that could not keep up: its p95 includes that queue and is not the time of one statement.",
      );
    }
    if (group === "go") {
      lines.push("", "A `/go` p95 above its budget is risk R3 (doc 12 section 5): name the plan or the policy shape that costs the time.");
    }
  }
  const { bookmarks, workspaces, largestWorkspace } = result.database;
  lines.push(
    "",
    `Database: ${String(bookmarks)} bookmarks, ${String(workspaces)} workspaces, the largest with ${String(largestWorkspace)}. Run: ${runUrl}`,
    "",
    "The k6 output and the result are in the `perf-results` artifact of the run.",
  );
  return `${lines.join("\n")}\n`;
}

// The actions for a result and the open issues: for each group with an exceeded budget, a comment on the open issue with its exact title, or a create.
export function plan({ result, issues, runUrl, event = "workflow_dispatch" }) {
  if (!/^https:\/\/[^\s)]+$/.test(runUrl)) {
    fail("the run URL is not an https address");
  }
  if (!/^[a-z_]{1,40}$/.test(event)) {
    fail("the event is not a name");
  }
  const groups = new Map();
  for (const budget of result.budgets) {
    if (!budget.ok) {
      const group = ISSUE_OF[budget.scenario];
      groups.set(group, [...(groups.get(group) ?? []), budget]);
    }
  }
  if (!result.writeLoad.ok) {
    groups.set(WRITE_LOAD, []);
  }
  const actions = [];
  for (const [group, rows] of groups) {
    const title = `${TITLE_PREFIX}${group}`;
    const body = describe(result, group, rows, runUrl, event);
    const open = issues.filter((issue) => issue.title === title).sort((a, b) => a.number - b.number)[0];
    actions.push(open === undefined ? { kind: "create", title, body } : { kind: "comment", number: open.number, title, body });
  }
  return actions;
}

function main() {
  const { values } = parseArgs({
    options: {
      result: { type: "string" },
      issues: { type: "string" },
      "run-url": { type: "string" },
      event: { type: "string", default: "workflow_dispatch" },
      "body-dir": { type: "string" },
      "expect-action": { type: "boolean", default: false },
    },
  });
  if (values.result === undefined || values.issues === undefined || values["run-url"] === undefined) {
    fail("--result, --issues and --run-url are required");
  }
  const actions = plan({
    result: parseResult(readFileSync(values.result, "utf8")),
    issues: parseIssues(readFileSync(values.issues, "utf8")),
    runUrl: values["run-url"],
    event: values.event,
  });
  if (values["expect-action"] && actions.length === 0) {
    fail("the run exited with an exceeded budget, but the result has none");
  }
  if (values["body-dir"] === undefined) {
    process.stdout.write(`${JSON.stringify(actions, null, 2)}\n`);
    return;
  }
  const dir = resolve(values["body-dir"]);
  mkdirSync(dir, { recursive: true });
  const written = actions.map(({ body, ...action }) => {
    const bodyFile = join(dir, `${action.title.slice(TITLE_PREFIX.length).replaceAll(" ", "-")}.md`);
    writeFileSync(bodyFile, body);
    return { ...action, bodyFile };
  });
  process.stdout.write(`${JSON.stringify(written, null, 2)}\n`);
}

// Run as a script, not when a test imports the module.
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "perf report: failed"}\n`);
    process.exit(1);
  }
}
