// What the performance run files (doc 08 section 5.3), decided here and not in the workflow: it reads `result.json` of run.mjs and the open issues, and prints the
// actions to take, which the `performance` job of .github/workflows/nightly.yml then executes and nothing more.
//
// Every exceeded budget is filed under one issue of its scenario, titled `Performance budget exceeded: <name>`:
//   go           the `go` scenario
//   list         the `list` scenario and the shapes of the list narrowed by a text (`list_q`) and filtered (`list_filter`), which are
//                the bookmark list and cost what the list costs
//   search       the `search` scenario and each of its terms
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
export const ISSUE_OF = { go: "go", list: "list", list_q: "list", list_filter: "list", search: "search" };

// Every scenario of budgets.js has an issue; a scenario added there without one is refused here at once.
for (const scenario of SCENARIOS) {
  if (!Object.hasOwn(ISSUE_OF, scenario)) {
    fail(`the scenario ${scenario} has no issue`);
  }
}

const NAME = /^[a-z0-9][a-z0-9 _.-]{0,79}$/;
const COMMIT = /^[0-9a-f]{40}$/;

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
    requireCounts(budget, ["p95Ms", "limitMs"], `budget ${budget.name}`);
    if (typeof budget.ok !== "boolean" || typeof budget.saturated !== "boolean") {
      fail(`budget ${budget.name} has no ok and saturated flags`);
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
    lines.push("| Shape | p95 server time | Budget | |", "|---|---|---|---|");
    for (const row of rows) {
      lines.push(`| ${row.name} | ${String(row.p95Ms)} ms | ${String(row.limitMs)} ms | exceeded${row.saturated ? " (saturated)" : ""} |`);
    }
    lines.push("");
    const scenarios = Object.keys(ISSUE_OF).filter((scenario) => ISSUE_OF[scenario] === group && Object.hasOwn(result.scenarios, scenario));
    lines.push("| Scenario | Requests completed | Dropped iterations | Peak VUs | |", "|---|---|---|---|---|");
    for (const scenario of scenarios) {
      lines.push(loadRow(scenario, result.scenarios[scenario]));
    }
    if (rows.some((row) => row.saturated)) {
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
