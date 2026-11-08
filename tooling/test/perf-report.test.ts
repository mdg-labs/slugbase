import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { ROOT, SUBPROCESS_TIMEOUT_MS } from "./run.ts";

interface Budget {
  name: string;
  scenario: string;
  metric: string;
  limitMs: number;
}

interface Row extends Budget {
  p95Ms: number;
  ok: boolean;
  saturated: boolean;
}

interface Load {
  completed: number;
  dropped: number;
  peakVus: number;
  maxVus: number;
  saturated: boolean;
}

interface PerfResult {
  commit: string | null;
  database: { bookmarks: number; workspaces: number; largestWorkspace: number };
  rate: number;
  durationSeconds: number;
  scenarios: Record<string, Load>;
  budgets: Row[];
  writeLoad: { requests: number; updates: number; elapsedSeconds: number; flushIntervalSeconds: number; limit: number; ok: boolean };
}

interface Action {
  kind: "create" | "comment";
  number?: number;
  title: string;
  body: string;
}

interface Issue {
  number: number;
  title: string;
}

interface ReportModule {
  TITLE_PREFIX: string;
  ISSUE_OF: Record<string, string>;
  parseResult: (text: string) => PerfResult;
  parseIssues: (text: string) => Issue[];
  plan: (input: { result: PerfResult; issues: Issue[]; runUrl: string; event?: string }) => Action[];
}

// Plain JavaScript that node runs as a script and the tests import; it has no declaration file, so a computed specifier keeps tsc from resolving it.
const budgetsSpecifier = pathToFileURL(resolve(ROOT, "scripts/perf/budgets.js")).href;
const reportSpecifier = pathToFileURL(resolve(ROOT, "scripts/perf/report.mjs")).href;
const { SCENARIOS, budgets } = (await import(budgetsSpecifier)) as { SCENARIOS: string[]; budgets: () => Budget[] };
const { TITLE_PREFIX, ISSUE_OF, parseResult, parseIssues, plan } = (await import(reportSpecifier)) as ReportModule;

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const RUN_URL = "https://github.com/mdg-labs/slugbase/actions/runs/42";

// A run in which every budget holds: each at half its limit, no scenario saturated, the write load within its limit.
function withinBudgets(): PerfResult {
  return {
    commit: COMMIT,
    database: { bookmarks: 50_000, workspaces: 2_001, largestWorkspace: 40_000 },
    rate: 40,
    durationSeconds: 30,
    scenarios: Object.fromEntries(SCENARIOS.map((scenario) => [scenario, { completed: 1200, dropped: 0, peakVus: 3, maxVus: 100, saturated: false }])),
    budgets: budgets().map((budget) => ({ ...budget, p95Ms: budget.limitMs / 2, ok: true, saturated: false })),
    writeLoad: { requests: 10_000, updates: 2, elapsedSeconds: 8.1, flushIntervalSeconds: 10, limit: 2, ok: true },
  };
}

// Raises the p95 of the budgets named to twice their limit.
function exceeding(result: PerfResult, ...names: string[]): PerfResult {
  const known = new Set(result.budgets.map((budget) => budget.name));
  for (const name of names) {
    expect(known.has(name), name).toBe(true);
  }
  return { ...result, budgets: result.budgets.map((budget) => (names.includes(budget.name) ? { ...budget, p95Ms: budget.limitMs * 2, ok: false } : budget)) };
}

const goAt230 = (): PerfResult => exceeding(withinBudgets(), "go");
const plain = (result: PerfResult, issues: Issue[] = [], event = "schedule"): Action[] => plan({ result, issues, runUrl: RUN_URL, event });
const summary = (actions: Action[]): string[] => actions.map((action) => `${action.kind}${action.number === undefined ? "" : ` #${String(action.number)}`}: ${action.title}`);

describe("the issues a performance run files", () => {
  it("creates one issue, for go, when /go is at 230 ms and every other budget holds", () => {
    const result = withinBudgets();
    const go = result.budgets.find((budget) => budget.name === "go");
    if (go === undefined) {
      throw new Error("no go budget");
    }
    Object.assign(go, { p95Ms: 230, ok: false });
    const actions = plain(result);
    expect(summary(actions)).toEqual(["create: Performance budget exceeded: go"]);
    const body = actions[0]?.body ?? "";
    expect(body).toContain("| go | 230 ms | 30 ms | exceeded |");
    expect(body).toContain(COMMIT);
    expect(body).toContain(RUN_URL);
    expect(body).toContain("`schedule`");
    expect(body).toContain("R3");
  });

  it("comments on the open issue of go, and creates nothing, when go is exceeded again", () => {
    const actions = plain(goAt230(), [{ number: 640, title: "Performance budget exceeded: go" }]);
    expect(summary(actions)).toEqual(["comment #640: Performance budget exceeded: go"]);
    expect(actions[0]?.body).toContain(COMMIT);
  });

  it("creates the issue of go when only the issue of search is open, and never comments on it", () => {
    const actions = plain(goAt230(), [{ number: 623, title: "Performance budget exceeded: search" }]);
    expect(summary(actions)).toEqual(["create: Performance budget exceeded: go"]);
  });

  it("files nothing when every budget and the write load hold", () => {
    expect(plain(withinBudgets())).toEqual([]);
    expect(plain(withinBudgets(), [{ number: 640, title: "Performance budget exceeded: go" }])).toEqual([]);
  });

  it("files one issue for each scenario with an exceeded budget, in one run", () => {
    const result = exceeding(withinBudgets(), "go", "search", "search caching", "list");
    const actions = plain(result, [{ number: 623, title: "Performance budget exceeded: search" }]);
    expect(summary(actions)).toEqual(["create: Performance budget exceeded: go", "create: Performance budget exceeded: list", "comment #623: Performance budget exceeded: search"]);
    const search = actions[2]?.body ?? "";
    expect(search).toContain("| search | 200 ms | 100 ms | exceeded |");
    expect(search).toContain("| search caching | 200 ms | 100 ms | exceeded |");
    expect(search).not.toContain("| go |");
    expect(actions[0]?.body).not.toContain("search caching");
  });

  it("lists every exceeded shape of the list under one issue: a sort and page, a text, a filter", () => {
    const result = exceeding(withinBudgets(), "list title_asc deep", "list q deep", "list filter tag");
    const actions = plain(result);
    expect(summary(actions)).toEqual(["create: Performance budget exceeded: list"]);
    const body = actions[0]?.body ?? "";
    for (const shape of ["list title_asc deep", "list q deep", "list filter tag"]) {
      expect(body, shape).toContain(`| ${shape} | 200 ms | 100 ms | exceeded |`);
    }
    expect(body).not.toContain("| list oldest first |");
    // The load of each scenario that the issue covers.
    for (const scenario of ["list", "list_q", "list_filter"]) {
      expect(body, scenario).toContain(`| ${scenario} | 1200 | 0 | 3 of 100 |  |`);
    }
    expect(body).not.toContain("| search |");
    expect(body).not.toContain("R3");
  });

  it("names a saturated scenario and its flag in the body, and explains the queue", () => {
    const base = exceeding(withinBudgets(), "search docs");
    const result: PerfResult = {
      ...base,
      scenarios: { ...base.scenarios, search: { completed: 900, dropped: 300, peakVus: 100, maxVus: 100, saturated: true } },
      budgets: base.budgets.map((budget) => (budget.scenario === "search" ? { ...budget, saturated: true } : budget)),
    };
    const body = plain(result)[0]?.body ?? "";
    expect(body).toContain("| search docs | 200 ms | 100 ms | exceeded (saturated) |");
    expect(body).toContain("| search | 900 | 300 | 100 of 100 | saturated |");
    expect(body).toContain("includes that queue");
    expect(plain(goAt230())[0]?.body).not.toContain("includes that queue");
  });

  it("files the write load under an issue of its own, and not under go", () => {
    const result: PerfResult = { ...withinBudgets(), writeLoad: { requests: 10_000, updates: 40, elapsedSeconds: 8.1, flushIntervalSeconds: 10, limit: 2, ok: false } };
    const actions = plain(result, [{ number: 640, title: "Performance budget exceeded: go" }]);
    expect(summary(actions)).toEqual(["create: Performance budget exceeded: write load"]);
    expect(actions[0]?.body).toContain("10000 requests for one slug updated 40 rows of bookmarks in 8.1 s, and at most 2 are allowed");
    expect(plain(result, [{ number: 650, title: "Performance budget exceeded: write load" }]).map((action) => action.number)).toEqual([650]);
  });

  it("matches the title exactly: an issue that names other scenarios, or only part of the title, is never extended", () => {
    const issues = [
      { number: 5, title: "Performance budget exceeded: go, search" },
      { number: 6, title: "Performance budget exceeded: goo" },
      { number: 7, title: "performance budget exceeded: go" },
      { number: 8, title: "Performance budget exceeded: go " },
      { number: 9, title: "Performance budget exceeded: list" },
    ];
    expect(summary(plain(goAt230(), issues))).toEqual(["create: Performance budget exceeded: go"]);
  });

  it("comments on the lowest-numbered issue when the title is on several, and never creates a second", () => {
    const issues = [
      { number: 90, title: "Performance budget exceeded: go" },
      { number: 31, title: "Performance budget exceeded: go" },
    ];
    expect(summary(plain(goAt230(), issues))).toEqual(["comment #31: Performance budget exceeded: go"]);
  });

  it("names the commit measured, or says that it is unknown", () => {
    expect(plain({ ...goAt230(), commit: null })[0]?.body).toContain("an unknown commit");
  });

  it("files every scenario of budgets.js under an issue, and nothing else", () => {
    expect(Object.keys(ISSUE_OF).sort()).toEqual([...SCENARIOS].sort());
    expect(new Set(Object.values(ISSUE_OF))).toEqual(new Set(["go", "list", "search"]));
    expect(TITLE_PREFIX).toBe("Performance budget exceeded: ");
    // Whatever shape a scenario has, an exceeded budget of it is filed under the issue of ISSUE_OF.
    for (const row of budgets()) {
      const actions = plain(exceeding(withinBudgets(), row.name));
      expect(actions.map((action) => action.title), row.name).toEqual([`${TITLE_PREFIX}${ISSUE_OF[row.scenario] ?? "?"}`]);
    }
  });
});

describe("a result or a list of issues that cannot be read", () => {
  const text = (value: unknown): string => JSON.stringify(value);

  it("is an error and never a run with nothing to file", () => {
    expect(() => parseResult("{")).toThrow(/not JSON/);
    expect(() => parseResult("[]")).toThrow(/not an object/);
    expect(() => parseResult("null")).toThrow(/not an object/);
    expect(() => parseResult(text({ ...withinBudgets(), budgets: [] }))).toThrow(/no budgets/);
    expect(() => parseResult(text({ ...withinBudgets(), budgets: undefined }))).toThrow(/no budgets/);
    expect(() => parseResult(text({ ...withinBudgets(), writeLoad: undefined }))).toThrow(/writeLoad/);
    expect(() => parseResult(text({ ...withinBudgets(), commit: "main" }))).toThrow(/commit/);
    expect(() => parseResult(text({ ...withinBudgets(), commit: undefined }))).toThrow(/commit/);
    expect(() => parseResult(text({ ...withinBudgets(), scenarios: undefined }))).toThrow(/no scenarios/);
    expect(parseResult(text(withinBudgets())).commit).toBe(COMMIT);
    expect(parseResult(text({ ...withinBudgets(), commit: null })).commit).toBeNull();
  });

  it("refuses a budget with a flag or a number that is not one, so an exceeded budget is never read as ok", () => {
    for (const change of [{ ok: "false" }, { ok: undefined }, { p95Ms: "230" }, { p95Ms: null }, { limitMs: undefined }, { saturated: undefined }]) {
      const result = withinBudgets();
      Object.assign(result.budgets[0] as Row, change);
      expect(() => parseResult(text(result)), JSON.stringify(change)).toThrow(/budget go/);
    }
    const result = withinBudgets();
    Object.assign(result.writeLoad, { ok: "no" });
    expect(() => parseResult(text(result))).toThrow(/writeLoad has no ok/);
  });

  it("refuses a scenario that has no issue, so it is never filed under another scenario's", () => {
    const result = withinBudgets();
    result.budgets.push({ name: "import", scenario: "import", metric: "http_req_waiting{kind:import}", limitMs: 100, p95Ms: 400, ok: false, saturated: false });
    expect(() => parseResult(text(result))).toThrow(/budget import belongs to the scenario import, which has no issue/);
    const noLoad = withinBudgets();
    delete noLoad.scenarios.search;
    expect(() => parseResult(text(noLoad))).toThrow(/search.*no load/);
    const named = withinBudgets();
    named.budgets.push({ name: "go\n- [ ] injected", scenario: "go", metric: "m", limitMs: 30, p95Ms: 1, ok: true, saturated: false });
    expect(() => parseResult(text(named))).toThrow(/no usable name/);
  });

  it("refuses a list of issues that is not one, such as a failed listing", () => {
    expect(() => parseIssues("")).toThrow(/not JSON/);
    expect(() => parseIssues("{}")).toThrow(/not an array/);
    expect(() => parseIssues(text([{ number: "6", title: "x" }]))).toThrow(/number and title/);
    expect(() => parseIssues(text([{ number: 6 }]))).toThrow(/number and title/);
    expect(parseIssues(text([{ number: 6, title: "x", labels: [] }]))).toEqual([{ number: 6, title: "x", labels: [] }]);
    expect(parseIssues("[]")).toEqual([]);
  });

  it("refuses a run address or an event that could carry markup", () => {
    expect(() => plain({ ...goAt230() }, [], "x\ny")).toThrow(/event/);
    expect(() => plan({ result: goAt230(), issues: [], runUrl: "javascript:alert(1)" })).toThrow(/run URL/);
    expect(() => plan({ result: goAt230(), issues: [], runUrl: "https://example.org/a b" })).toThrow(/run URL/);
  });
});

describe("the script and the job that run it", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function report(result: string, issues: string, extra: string[] = []): { status: number | null; stdout: string; stderr: string; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), "perf-report-test-"));
    dirs.push(dir);
    writeFileSync(join(dir, "result.json"), result);
    writeFileSync(join(dir, "issues.json"), issues);
    const run = spawnSync(
      process.execPath,
      [resolve(ROOT, "scripts/perf/report.mjs"), "--result", join(dir, "result.json"), "--issues", join(dir, "issues.json"), "--run-url", RUN_URL, "--event", "pull_request", ...extra],
      { encoding: "utf8", timeout: 30_000 },
    );
    return { status: run.status, stdout: run.stdout, stderr: run.stderr, dir };
  }

  it("prints the actions with their bodies as a dry run, and writes nothing", () => {
    const run = report(JSON.stringify(exceeding(withinBudgets(), "go", "search")), JSON.stringify([{ number: 623, title: "Performance budget exceeded: search" }]));
    expect(run.status, run.stderr).toBe(0);
    const actions = JSON.parse(run.stdout) as Action[];
    expect(summary(actions)).toEqual(["create: Performance budget exceeded: go", "comment #623: Performance budget exceeded: search"]);
    expect(actions[0]?.body).toContain("`pull_request`");
  });

  it("writes each body to a file named by the action, for gh --body-file", () => {
    const dir = mkdtempSync(join(tmpdir(), "perf-report-bodies-"));
    dirs.push(dir);
    const result: PerfResult = { ...exceeding(withinBudgets(), "go"), writeLoad: { requests: 10_000, updates: 9, elapsedSeconds: 8, flushIntervalSeconds: 10, limit: 2, ok: false } };
    const run = report(JSON.stringify(result), "[]", ["--body-dir", join(dir, "bodies")]);
    expect(run.status, run.stderr).toBe(0);
    const actions = JSON.parse(run.stdout) as (Omit<Action, "body"> & { bodyFile: string; body?: string })[];
    expect(actions.map((action) => action.title)).toEqual(["Performance budget exceeded: go", "Performance budget exceeded: write load"]);
    expect(actions.every((action) => action.body === undefined)).toBe(true);
    expect(readFileSync(actions[0]?.bodyFile ?? "", "utf8")).toContain("| go | 60 ms | 30 ms | exceeded |");
    expect(readFileSync(actions[1]?.bodyFile ?? "", "utf8")).toContain("updated 9 rows of bookmarks");
  }, SUBPROCESS_TIMEOUT_MS);

  it("ends with status 1 on a result it cannot read, on a failed listing and, when asked, on a run with nothing exceeded", () => {
    const issues = "[]";
    expect(report("{", issues).status).toBe(1);
    expect(report(JSON.stringify(goAt230()), "").status).toBe(1);
    expect(report(JSON.stringify(withinBudgets()), issues).status).toBe(0);
    const none = report(JSON.stringify(withinBudgets()), issues, ["--expect-action"]);
    expect(none.status).toBe(1);
    expect(none.stderr).toContain("none");
  }, SUBPROCESS_TIMEOUT_MS);

  const workflow = readFileSync(resolve(ROOT, ".github/workflows/nightly.yml"), "utf8");

  it("is run by the performance job when the run exits 10, on the schedule, by dispatch and on a pull request to main, and passes values by environment", () => {
    expect(workflow).toMatch(/- name: Open an issue for an exceeded budget\n\s+if: \$\{\{ steps\.measure\.outputs\.status == '10' \}\}/);
    expect(workflow).toContain("node scripts/perf/report.mjs --result perf-results/result.json");
    expect(workflow).toContain("--expect-action");
    expect(workflow).toMatch(/--commit "\$MEASURED_COMMIT"/);
    expect(workflow).toMatch(/MEASURED_COMMIT: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
    expect(workflow).toMatch(/schedule:/);
    expect(workflow).toMatch(/workflow_dispatch:/);
    expect(workflow).toMatch(/pull_request:\n\s+branches: \[main\]/);
    // No expression is interpolated into a script: every `${{ }}` of the file is in a key (`if`, `env`, `with`, `group`, `name`), never in a run block.
    const runBlocks = workflow.split(/\n\s+run: \|\n/).slice(1).map((block) => block.split(/\n\s+- (?:name|uses): /)[0] ?? "");
    expect(runBlocks.length).toBeGreaterThan(3);
    for (const block of runBlocks) {
      expect(block).not.toContain("${{");
    }
  });

  it("holds contents: read and issues: write only, no secret, and neither a push nor a pull_request_target trigger", () => {
    expect(workflow).not.toMatch(/secrets\./);
    expect(workflow).not.toMatch(/pull_request_target:/);
    expect(workflow).not.toMatch(/^\s+push:/m);
    expect(workflow).toMatch(/permissions:\n\s+contents: read\n\s+issues: write\n/);
    expect(workflow).not.toMatch(/(?:actions|checks|deployments|id-token|packages|pull-requests|statuses|security-events|write-all)\s*:\s*write/);
  });

  // The step's own script, run with a `gh` that logs its calls: what it lists, creates and comments on, and a failure it is told to make.
  function runStep(result: PerfResult, issues: Issue[], failOn: string): { status: number | null; stderr: string; stdout: string; calls: string[] } {
    const dir = mkdtempSync(join(tmpdir(), "perf-step-test-"));
    dirs.push(dir);
    const step = workflow.split("      - name: Open an issue for an exceeded budget\n")[1]?.split("\n      - name: ")[0] ?? "";
    const script = step.split("        run: |\n")[1]?.replace(/^ {10}/gm, "") ?? "";
    expect(script).toContain("report.mjs");
    mkdirSync(join(dir, "perf-results"));
    writeFileSync(join(dir, "perf-results", "result.json"), JSON.stringify(result));
    symlinkSync(resolve(ROOT, "scripts"), join(dir, "scripts"));
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "issues.json"), JSON.stringify(issues));
    writeFileSync(
      join(dir, "bin", "gh"),
      [
        "#!/bin/bash",
        'printf "%s\\n" "$*" >> "$CALLS"',
        'case "$*" in *"$FAIL_ON"*) exit 1;; esac',
        'if [ "$2" = "list" ]; then cat "$ISSUES"; exit 0; fi',
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(join(dir, "bin", "gh"), 0o755);
    // The `unit` job runs in an image without jq, so the step must not use it: a jq that is not found stands first on the PATH, on a machine that has one too.
    writeFileSync(join(dir, "bin", "jq"), ["#!/bin/bash", 'echo "jq: command not found" >&2', "exit 127", ""].join("\n"));
    chmodSync(join(dir, "bin", "jq"), 0o755);
    const run = spawnSync("bash", ["-c", script], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        PATH: `${join(dir, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin`,
        CALLS: join(dir, "calls.log"),
        ISSUES: join(dir, "issues.json"),
        FAIL_ON: failOn,
        TMPDIR: dir,
        GH_TOKEN: "x",
        RUN_URL: RUN_URL,
        REPOSITORY: "mdg-labs/slugbase",
        EVENT: "schedule",
      },
    });
    let calls: string[] = [];
    try {
      calls = readFileSync(join(dir, "calls.log"), "utf8").split("\n").filter((line) => line !== "");
    } catch {
      // gh was never called
    }
    return { status: run.status, stderr: run.stderr, stdout: run.stdout, calls };
  }

  it("runs the actions: a comment where the issue is open, a create where it is not, and fails with the others done when one create fails", () => {
    const result = exceeding(withinBudgets(), "go", "list", "search");
    const open = [{ number: 623, title: "Performance budget exceeded: search" }];
    const good = runStep(result, open, "no-such-call");
    expect(good.status, good.stderr).toBe(0);
    expect(good.calls.filter((call) => !call.startsWith("issue list")).map((call) => call.replace(/--body-file \S+/, "--body-file F"))).toEqual([
      "issue create --repo mdg-labs/slugbase --title Performance budget exceeded: go --label area:ci --body-file F",
      "issue create --repo mdg-labs/slugbase --title Performance budget exceeded: list --label area:ci --body-file F",
      "issue comment 623 --repo mdg-labs/slugbase --body-file F",
    ]);
    expect(good.stdout).toContain("created: Performance budget exceeded: go");
    expect(good.stdout).toContain("commented on #623");

    const partial = runStep(result, open, "title Performance budget exceeded: go ");
    expect(partial.status).toBe(1);
    expect(partial.stdout).not.toContain("created: Performance budget exceeded: go");
    expect(partial.stdout).toContain("created: Performance budget exceeded: list");
    expect(partial.stdout).toContain("commented on #623");
    expect(partial.stdout).toContain("::error::could not create: Performance budget exceeded: go");
  }, SUBPROCESS_TIMEOUT_MS);

  it("fails the step when the issues cannot be listed or the result cannot be read, and files nothing", () => {
    const listing = runStep(goAt230(), [], "issue list");
    expect(listing.status).toBe(1);
    expect(listing.calls.filter((call) => call.includes("create") || call.includes("comment"))).toEqual([]);
  }, SUBPROCESS_TIMEOUT_MS);

  it("names the commit in the result and in the job summary", () => {
    expect(readFileSync(resolve(ROOT, "scripts/perf/run.mjs"), "utf8")).toMatch(/commit: await measuredCommit\(\),\n\s+database: instance\.counts,/);
    expect(workflow).toMatch(/"Commit: `\\\(\.commit \/\/ "unknown"\)`\./);
  });
});
