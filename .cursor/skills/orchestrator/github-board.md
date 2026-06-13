# SlugBase — GitHub board reference

Orchestrator and **sub-agents** use this when a prompt includes a **GITHUB SYNC** block.

## Project

| Field | Value |
|---|---|
| Org | `mdg-labs` |
| Repo | `slugbase` |
| Issue URL | `https://github.com/mdg-labs/slugbase/issues/N` |
| Project | SlugBase Roadmap (Projects v2, project number: 2) |
| MCP server | `user-github` |
| Auto-close | Disabled on project; use `fixes #N` commit convention |

## Tool selection policy

**MCP is the default.** All GitHub interactions go through the `user-github` MCP tools unless the table below explicitly requires CLI or GraphQL.

### Operation → tool mapping

| Operation | Tool | Why |
|---|---|---|
| **Create issue** | MCP `issue_write` (method: create) | Supports `type`, `labels`, `milestone`, `issue_fields` in one call — `gh issue create --type` does not work for org-level types |
| **Update issue** (title, body, state, labels, type, fields) | MCP `issue_write` (method: update) | Unified write; handles org-level issue fields via `issue_fields` array |
| **Read issue** (body, labels, state, milestone) | MCP `issue_read` (method: get) | Returns structured data matching MCP write tool expectations |
| **Read issue comments** | MCP `issue_read` (method: get_comments) | Paginated; use for verifier failure checks |
| **Read sub-issues** | MCP `issue_read` (method: get_sub_issues) | Returns child issue numbers and titles |
| **Read issue labels** | MCP `issue_read` (method: get_labels) | Returns label objects |
| **List issues** (filter by state, labels, fields) | MCP `list_issues` | Supports `field_filters` for org-level fields (Priority, Effort, Status); paginated via `after` cursor |
| **Search issues** (full-text) | MCP `search_issues` | GitHub search syntax; scoped to `is:issue` |
| **Add comment** | MCP `add_issue_comment` | Verifier PASS/FAIL comments |
| **Link sub-issue** | MCP `sub_issue_write` (method: add) | Requires **database IDs** (not issue numbers); see § Getting database IDs below |
| **Unlink sub-issue** | MCP `sub_issue_write` (method: remove) | Requires database IDs |
| **Reorder sub-issues** | MCP `sub_issue_write` (method: reprioritize) | Requires database IDs |
| **Set project Status** | GraphQL `updateProjectV2ItemFieldValue` | Status is a project-board field — see § Projects v2 Status (via GraphQL) |
| **Get project item ID** | GraphQL `repository.issue.projectItems` | Direct lookup by issue number — no pagination needed |
| **Get project fields/options** | GraphQL `organization.projectV2.fields` | Hardcoded in § Projects v2 Status |
| **Fetch Dependabot alerts** | CLI `gh api` (REST) | No MCP tool covers Dependabot alerts endpoint |
| **Get issue node IDs** | CLI `gh api graphql` | Needed for `sub_issue_write` database ID lookups |
| **Fetch milestones** | CLI `gh api /repos/mdg-labs/slugbase/milestones` | No MCP tool for milestones — returns `[{number, title, state, due_on}]`; filter by `state: "open"` |
| **Bulk operations** (100+ items) | CLI `gh api graphql` | Faster than sequential MCP calls for migrations |

### Getting database IDs for sub_issue_write

MCP `sub_issue_write` requires **database IDs** (integer), not issue numbers or GraphQL node IDs. Obtain them via GraphQL:

```bash
gh api graphql -f 'query=query { repository(owner:"mdg-labs", name:"slugbase") {
  issue(number:N) { databaseId number title }
} }'
```

For bulk operations, paginate with `first:100` and `after` cursor.

### Projects v2 Status (via GraphQL)

Project board Status is a **project-level field** — it lives on the project item, not on the issue itself. MCP `issue_write` handles issue-level fields only (Priority, Effort, dates, type, labels). Status is set via GraphQL mutations.

**Hardcoded IDs** (never change):

| Entity | ID |
|---|---|
| Project node ID | `PVT_kwDODv-LLc4BaOr9` |
| Status field ID | `PVTSSF_lADODv-LLc4BaOr9zhVHxUI` |
| Backlog | `9485f8e2` |
| Ready | `a0e7153f` |
| In Progress | `47fc9ee4` |
| In Review | `81f76819` |
| Done | `98236657` |
| Declined | `e36e1062` |

**Step 1 — Get project item ID for an issue:**

```bash
gh api graphql -f 'query=query {
  repository(owner:"mdg-labs",name:"slugbase") {
    issue(number:N) {
      projectItems(first:10) {
        nodes { id project { number } }
      }
    }
  }
}'
```

Filter `nodes` where `project.number == 2`, take the `id`.

**Step 2 — Set Status:**

```bash
gh api graphql -f 'query=mutation {
  updateProjectV2ItemFieldValue(input: {
    projectId: "PVT_kwDODv-LLc4BaOr9"
    itemId: "<ITEM_ID>"
    fieldId: "PVTSSF_lADODv-LLc4BaOr9zhVHxUI"
    value: { singleSelectOptionId: "<OPTION_ID>" }
  }) {
    projectV2Item {
      fieldValueByName(name: "Status") {
        ... on ProjectV2ItemFieldSingleSelectValue { name }
      }
    }
  }
}'
```

**Why GraphQL, not `gh project` CLI?** No pagination issues (direct lookup by issue number), no jq parsing, works at any project size.

## Org-level issue types

Set via MCP `issue_write` → `type` parameter. Discover valid types with `list_issue_types` (owner: `mdg-labs`).

| Type | Use for | Example |
|---|---|---|
| **Task** | Concrete implementation work — sub-tasks, refactors, config, CI | Session store, migration, env schema |
| **Bug** | Defects, regressions, Dependabot alerts | Broken CSRF check, 500 on workspace picker |
| **Feature** | New capabilities / epics — parent containers for sub-issues | Auth system, search, billing |

**Hierarchy via sub-issues:** Feature (parent) → Feature/Task/Bug (children). Features with no children are *atomic* (themselves the leaf).

## Org-level issue fields

Set via MCP `issue_write` → `issue_fields` array. Each entry takes `field_name` + `field_option_name` (single-select) or `value` (text/date/number).

| Field | Type | Options | Example |
|---|---|---|---|
| **Priority** | single-select | `Urgent`, `High`, `Medium`, `Low` | `issue_fields: [{ field_name: "Priority", field_option_name: "High" }]` |
| **Effort** | single-select | `High`, `Medium`, `Low` | `issue_fields: [{ field_name: "Effort", field_option_name: "M" }]` |
| **Start date** | date | YYYY-MM-DD | `issue_fields: [{ field_name: "Start date", value: "2026-06-10" }]` |
| **Target date** | date | YYYY-MM-DD | `issue_fields: [{ field_name: "Target date", value: "2026-06-20" }]` |

### Required fields — every issue must have all six

**Never create or update an issue without all six set.** This is a hard rule — the verifier (Layer 3c) checks it.

| Field | Required | How to set |
|---|---|---|
| **Type** (Task/Bug/Feature) | Always | MCP `issue_write` → `type` parameter |
| **Domain label** (`domain:frontend` etc.) | Always | MCP `issue_write` → `labels` array |
| **Priority** | Always | MCP `issue_write` → `issue_fields` |
| **Effort** | Always | MCP `issue_write` → `issue_fields` |
| **Assignee** | Always | MCP `issue_write` → `assignees` (use MCP `get_me` to discover logged-in username) |
| **Milestone** | Always | MCP `issue_write` → `milestone` (integer) — see § Milestones below |

**Why MCP only?** `gh issue create --type` does not work for org-level issue types. `gh issue create --label` sets the GitHub built-in label, not our custom domain labels. MCP `issue_write` is the only tool that sets all six atomically.

## Projects v2 fields (board-level)

The project board adds a **Status** field (single-select on the project item, not on the issue itself). Set via GraphQL — see § Projects v2 Status (via GraphQL).

```
Backlog → Ready → In Progress → In Review → Done → Closed
                        ↓
                   Declined
```

| Status | Who sets it | When | Notes |
|---|---|---|---|
| Backlog | Default for new project items | Unrefined / deferred | — |
| Ready | **intake** / **triage** / orchestrator / user | Fully specified; orchestrator picks from here | — |
| In Progress | **Execution agent** | First action, before session memory | — |
| In Review | **Execution agent** | Last action before verifier handoff | — |
| Done | **Verifier** | After all layers PASS | Issue may still be open — verified and ready for merge to `main` |
| Closed | GitHub project workflow (auto) | When the GitHub issue closes (via `fixes #N` on `main`) | Agents never set this. Auto-set by project workflow when commit lands on default branch. |
| Declined | Orchestrator / user | Permanently declined | — |

### Failure path

Verifier FAIL → set Status back to **Ready** (not In Progress) + `add_issue_comment` with layer failures.

### FORBIDDEN — agents must not set GitHub issue state

Agents must **never** modify the GitHub issue state (`open` / `closed`). Issue state is driven solely by commit messages — when a commit with `fixes #N` lands on the default branch (`main`), GitHub auto-closes the issue.

All status management must happen via **board Status** only (see status table above):

| Instead of… | Use… |
|---|---|
| Closing the GitHub issue on verifier PASS | Board Status → `Done` |
| Reopening the GitHub issue on verifier FAIL | Board Status → `Ready` |
| Closing the issue by execution after comment | Board Status → `In Review` (handoff to verifier) |

## Domain labels

One domain label per issue. Cross-domain epics: parent gets the **owning** domain; each child gets its own.

| Label | Scope |
|---|---|
| `domain:frontend` | Web client, React, UI, command palette, dashboard, i18n |
| `domain:backend` | API, auth, sessions, bookmarks/slugs/folders/tags/workspaces, entitlements, billing, admin |
| `domain:infrastructure` | Database, container, CI/CD, TLS/proxy, deployment, monitoring |
| `domain:operations` | Launch, marketing site, docs, billing operations, self-hosted runbooks |
| `regression` | Bug that was previously fixed (originating issue had board Status Done/Closed) — always added **alongside** a `domain:*` label, never alone |

The `regression` label must be created in the repo before first use. If it doesn't exist yet:

```bash
gh api /repos/mdg-labs/slugbase/labels -X POST -f name=regression -f color=fbca04 -f description="Bug that was previously fixed but has reappeared (regression/escaped defect)"
```

The `domain:*` labels should already exist from repo setup.

## Milestones

**Every issue created on the board must have a milestone set.** This is a required field (see § Required fields above).

### Fetch milestones (no MCP equivalent)

```bash
gh api /repos/mdg-labs/slugbase/milestones --jq '.[] | {number, title, state, due_on}'
```

Only consider milestones with `state: "open"`. Closed milestones represent already-delivered work.

### Selection logic

1. **User explicitly names a milestone** → match by `title` from the fetched list; use its `number`
2. **No user mention of milestone** → pick the **earliest open milestone by `due_on`** (the one most likely to ship next). If no due dates are set, pick the first open milestone by list order.

### How to set via MCP

Pass the milestone integer `number` in every `issue_write` (method: create):

```text
MCP issue_write (method: create):
- milestone: <milestone_number>
```

## Status sync — sub-agent duties (mandatory)

Skip only when user said **"don't update GitHub"** or prompt has no GITHUB SYNC block.

### Execution agent — first action (before session memory)

Set project Status to **"In Progress"** on every listed issue (leaf + parent).

Project-board Status is a **project-level field** — must be set via GraphQL (see § Projects v2 Status):

```bash
gh api graphql -f 'query=mutation {
  updateProjectV2ItemFieldValue(input: {
    projectId: "PVT_kwDODv-LLc4BaOr9"
    itemId: "<ITEM_ID>"
    fieldId: "PVTSSF_lADODv-LLc4BaOr9zhVHxUI"
    value: { singleSelectOptionId: "<IN_PROGRESS_OPTION_ID>" }
  }) { projectV2Item { fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } } } }
}'
```

Get the `<ITEM_ID>` for each issue via the Step 1 query in § Projects v2 Status.

For issue-level fields (Priority, Effort, type, labels), use MCP `issue_write` (method: update).

- Combined batch: set **In Progress** on **every** listed issue.
- **Parent issue:** when prompt lists a parent, set parent **In Progress** in the **same first-action batch** as the leaf.
- If already In Progress or Done, continue (idempotent).
- If status update fails → `blocked`; do not start implementation.

### Execution agent — last actions (before verifier handoff)

When the prompt includes **GITHUB SYNC**, perform these in order:

```text
1. Session memory (local): set ended + duration in header (wall-clock from started → now)
2. Set project Status → "In Review" for each LEAF issue (not parent)
   (parent stays In Progress unless implementing the parent itself)
3. Single implementation commit — task files only (session memory stays local, never committed)
```

### Verifier — before handoff (when GITHUB SYNC present)

```text
1. Session memory: set verification ended + duration
2. Then apply PASS or FAIL below
```

### Verifier — after all layers PASS

```text
1. add_issue_comment — mandatory clean summary (see § Verifier Done comment)
2. Set project Status → "Done" for each leaf issue
3. If parent issue listed and this completes the parent → Done on parent too
4. Optionally delete local active/<SESSION-ID>.md or move to local archive/ (never commit)
```

### Verifier — on FAIL

```text
Set project Status → "Ready" for each leaf issue
add_issue_comment with layer failures + fix hints (see § Verifier FAIL comment)
Do NOT set Done
Append VERIFICATION FAILED to local active/<SESSION-ID>.md if file exists (never commit)
```

## Verifier Done comment (mandatory on PASS)

Post via `add_issue_comment` on each **leaf** issue before setting Done. Use markdown.

```markdown
**Verified** `abc1234`

Server-side session store with configurable TTL. DB-backed sessions, HTTP-only cookie, individual revocation, double-submit CSRF with §5.8 exempt allowlist.

AC met:
- Session create/revoke round-trips correctly
- CSRF rejects missing token on mutations; allowlisted endpoints exempt
- Configurable TTL defaults per spec §3

Lint, typecheck, unit tests pass. No deviations.
```

### Comment rules

1. **First line is the verdict**: `**Verified** <sha>`
2. **One-line commit SHA** for traceability
3. **Brief summary** — what was implemented, 2-3 sentences max
4. **AC checklist** — which criteria were met
5. **Check results** — one-line summary (all pass), not a table
6. **No session IDs** in comments — they're internal tracking
7. **No sub-agent identifiers** — just the work
8. **Omit empty sections** — no "None" placeholders

## Verifier FAIL comment (mandatory on FAIL)

Post via `add_issue_comment` on each **leaf** issue before setting Ready.

```markdown
**Verification failed**

Layer 1 (scope): PASS
Layer 2 (automated): FAIL — typecheck error in `session.service.ts:42`
Layer 3 (logic): PASS

`session.service.ts:42` — `SessionStore.create()` missing workspace_id scoping. Expected per spec §4.4; fix: add `workspaceId` parameter and stamp on all writes.
```

### FAIL comment rules

1. **First line**: `**Verification failed**`
2. **Layer results** — one line each: PASS or FAIL with detail
3. **Fix hints** — `file:line` — expected per AC/doc — fix suggestion
4. **No filler** — omit PASS layers' detail if not relevant to the failure

## GITHUB SYNC blocks (orchestrator copies into prompts)

Two variants — **never tell execution agents to set Done**.

### Execution variant

```text
GITHUB SYNC — EXECUTION (mandatory unless user opted out):
- MCP server: user-github
- owner: mdg-labs
- repo: slugbase
- project: 2 (SlugBase Roadmap)
- issues:
  - number: 12          # leaf
  - number: 8           # Parent issue (when leaf is a sub-issue)
- CLOSE_PARENTS: <[#8] | [#10, #1] | none>   # parents to fixes-close in this commit
- nodeIds:
  - issue 8: <node_id>  # needed for sub_issue_write if linking
  - issue 12: <node_id>
- FIRST ACTION: Set project Status → "In Progress" for EVERY listed issue (leaf + parent) BEFORE session memory
- LAST ACTIONS (in order): local session memory ended/duration → Set project Status → "In Review" (leaf only) → single implementation commit (no session files)
- FORBIDDEN: Set Status → Done; add comment for verification outcomes; committing session memory files
- COMMIT: subject `[#<leaf>]`; body `fixes #<leaf>` always; add `fixes #<parent>` one line per issue in CLOSE_PARENTS (omit when none); FORBIDDEN: fixes parent not in CLOSE_PARENTS
- Reference: .cursor/skills/orchestrator/github-board.md
```

### Verifier variant

```text
GITHUB SYNC — VERIFIER (mandatory unless user opted out):
- MCP server: user-github
- owner: mdg-labs
- repo: slugbase
- project: 2 (SlugBase Roadmap)
- issues:
  - number: 12          # leaf (In Review)
  - number: 8           # Parent — Done only if final child
- CLOSE_PARENTS: <[#8] | none>   # same as execution — verifier Layer 3c3 checks commit body
- PRE-HANDOFF: local session memory verification ended/duration
- AFTER PASS: add_issue_comment (mandatory clean summary) → Set project Status → "Done" for leaf (+ parent if final child)
- AFTER FAIL: add_issue_comment (FAIL template) → Set project Status → "Ready"; do NOT set Done
- Reference: .cursor/skills/orchestrator/github-board.md
```

### Key differences from Jira

| Concern | Jira | GitHub |
|---|---|---|
| Time tracking | `addWorklogToJiraIssue` required | **Removed** — no equivalent; session memory records timing locally only |
| Status transitions | Numeric transition IDs (2, 21, 31, 41) | Status is a field value — set via GraphQL `updateProjectV2ItemFieldValue`; no IDs to resolve |
| Parent-child | `parent` field + JQL search | `sub_issue_write` via MCP (requires **database IDs**, not issue numbers) |
| Auto-close | Transition to Done closes issue | `Fixes #N` in commit body; project-level auto-close disabled |
| Verifier comments | Heavy: session IDs, sub-agent names, worklog | Clean: commit SHA + summary + AC; no session IDs, no sub-agent names |
| Issue linking | `createIssueLink` ("Depends on") | **`addBlockedBy`** GraphQL mutation (requires **Node IDs** `I_...`, not database IDs) — see [github-intake §5a](../github-intake/SKILL.md) |

## Issue lookup (orchestrator)

| User says | Tool (MCP preferred) |
|---|---|
| Issue #12, GitHub URL | MCP `issue_read` (method: get, issue_number: 12) |
| Sub-issues | MCP `issue_read` (method: get_sub_issues, issue_number: N) |
| Set project Status | GraphQL `updateProjectV2ItemFieldValue` (see § Projects v2 Status) |
| Project item ID for issue | GraphQL `repository.issue.projectItems` (see § Projects v2 Status) |
| By domain | MCP `list_issues` (labels filter) |
| By priority | MCP `list_issues` (field_filters) |
| Database IDs for sub-issues | CLI `gh api graphql` (see § Getting database IDs above) |
| Dependencies (blocked-by) | CLI `gh api graphql` `addBlockedBy`/`removeBlockedBy` (see [github-intake §5a](../github-intake/SKILL.md)) |

## Epic pattern

SlugBase uses a **Feature + sub-issues** hierarchy:

- **Feature (parent)** — epic-level scope, e.g. "Auth system"
- **Sub-issues** — child Features, Tasks, or Bugs that break down the parent

```text
#1 (Feature — Auth system)
├── #10 (Feature — Auth UI)               ← parent of subtasks
│   ├── #11 (Task — auth shell + sign-in)  ← leaf
│   ├── #12 (Task — MFA challenge screen)  ← leaf
│   └── #13 (Task — register + verify)     ← leaf
├── #20 (Task — Session store)             ← atomic leaf (no children)
└── #21 (Bug — CSRF bypass on /login)      ← atomic leaf
```

**Enumerate the leaf set for a parent** (the things to actually implement):

```text
# Direct sub-issues of a Feature (MCP preferred)
CallMcpTool issue_read: { method: "get_sub_issues", owner: "mdg-labs", repo: "slugbase", issue_number: 1 }

# For each sub-issue that itself has children, recurse:
CallMcpTool issue_read: { method: "get_sub_issues", owner: "mdg-labs", repo: "slugbase", issue_number: 10 }
```

**Bulk enumeration** (when you need node IDs for all children at once):

```bash
gh api graphql -f query='{ repository(owner:"mdg-labs",name:"slugbase") {
  issue(number:1) {
    subIssues(first:50) { nodes { databaseId number title } }
  } } }'
```

Leaf set = atomic issues (no children) **+** all deepest-level children. Batch leaves by domain + Lane.

- Implement **leaf** issues; pass each leaf number to execution + verifier prompts. A parent Feature is never implemented directly — only its children.
- Parent **In Progress**: execution sets parent when any leaf starts; set the intermediate parent In Progress too when implementing one of its sub-issues.
- Parent **Done**: last leaf verifier marks the intermediate parent Done (when its last child passes) and the top-level parent Done (when its last child passes) — or orchestrator recovery.

### Commit close

Board Status **Done** does **not** close the GitHub issue. Epic parents auto-close on `main` only when a commit body includes `fixes #<epic>`.

- **Intermediate subtask:** body has `fixes #<leaf>` only.
- **Final in-scope child of parent P:** same commit adds `fixes #<P>` (one line per parent completed, including nested intermediates).
- Orchestrator computes `CLOSE_PARENTS` and passes it in execution + verifier prompts; execution agents must not guess; verifier Layer 3c3 enforces alignment.

```text
# Last child of epic #8
fixes #12
fixes #8
```

## MCP tools by role

| Tool | Orchestrator | Execution | Verifier |
|---|---|---|---|
| `list_issues` | Find work, query by status/domain/priority | — | — |
| `search_issues` | Find work, check for duplicates | — | — |
| `issue_read` (get) | Load AC / description | — | — |
| `issue_read` (get_sub_issues) | Enumerate leaf set | — | — |
| `issue_read` (get_comments) | Check for prior verification failures | — | — |
| `issue_write` (create) | Intake/triage creates issues | — | — |
| `issue_write` (update) | Recovery only | Set issue-level fields | — |
| `sub_issue_write` (add) | Intake links parent-child | — | — |
| `sub_issue_write` (reprioritize) | Reorder children | — | — |
| `add_issue_comment` | — | — | On PASS (summary) + on FAIL (detail) |
| GraphQL `updateProjectV2ItemFieldValue` | — | Set Status → In Progress / In Review | Set Status → Done / Ready |

## Standard queries

**MCP preferred** for issue queries. GraphQL for project board operations.

```text
# Set Status (GraphQL — see § Projects v2 Status for IDs)
gh api graphql -f 'query=mutation { updateProjectV2ItemFieldValue(input: {
  projectId: "PVT_kwDODv-LLc4BaOr9"
  itemId: "<ITEM_ID>"
  fieldId: "PVTSSF_lADODv-LLc4BaOr9zhVHxUI"
  value: { singleSelectOptionId: "<OPTION_ID>" }
}) { projectV2Item { fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } } } } }'

# By domain (MCP preferred)
CallMcpTool list_issues: { owner, repo, labels: ["domain:backend"] }

# By priority (MCP — field_filters only available via MCP)
CallMcpTool list_issues: { owner, repo, state: "OPEN",
  field_filters: [{ field_name: "Priority", value: "High" }] }

# Sub-issues of a parent (MCP preferred)
CallMcpTool issue_read: { method: "get_sub_issues", owner, repo, issue_number: N }

# Search by keyword (MCP preferred)
CallMcpTool search_issues: { query: "csrf", owner, repo }

# Check for verification failures (MCP preferred)
CallMcpTool issue_read: { method: "get_comments", owner, repo, issue_number: N }
# Then inspect comment bodies for "Verification failed"
```
