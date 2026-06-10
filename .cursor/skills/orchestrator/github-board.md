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
| **Priority** | single-select | `Critical`, `High`, `Medium`, `Low` | `issue_fields: [{ field_name: "Priority", field_option_name: "High" }]` |
| **Effort** | single-select | `S`, `M`, `L`, `XL` | `issue_fields: [{ field_name: "Effort", field_option_name: "M" }]` |
| **Start date** | date | YYYY-MM-DD | `issue_fields: [{ field_name: "Start date", value: "2026-06-10" }]` |
| **Target date** | date | YYYY-MM-DD | `issue_fields: [{ field_name: "Target date", value: "2026-06-20" }]` |

## Projects v2 fields (board-level)

The project board adds a **Status** field (single-select on the project item, not on the issue itself). Set via `gh project item-edit`.

```
Backlog → Ready → In Progress → In Review → Done
                        ↓
                   Declined
```

| Status | Who sets it | When |
|---|---|---|
| Backlog | Default for new project items | Unrefined / deferred |
| Ready | **intake** / **triage** / orchestrator / user | Fully specified; orchestrator picks from here |
| In Progress | **Execution agent** | First action, before session memory |
| In Review | **Execution agent** | Last action before verifier handoff |
| Done | **Verifier** | After all layers PASS |
| Declined | Orchestrator / user | Permanently declined |

### Failure path

Verifier FAIL → set Status back to **Ready** (not In Progress) + `add_issue_comment` with layer failures.

## Domain labels

One domain label per issue. Cross-domain epics: parent gets the **owning** domain; each child gets its own.

| Label | Scope |
|---|---|
| `domain:frontend` | Web client, React, UI, command palette, dashboard, i18n |
| `domain:backend` | API, auth, sessions, bookmarks/slugs/folders/tags/workspaces, entitlements, billing, admin |
| `domain:infrastructure` | Database, container, CI/CD, TLS/proxy, deployment, monitoring |
| `domain:operations` | Launch, marketing site, docs, billing operations, self-hosted runbooks |

## Status sync — sub-agent duties (mandatory)

Skip only when user said **"don't update GitHub"** or prompt has no GITHUB SYNC block.

### Execution agent — first action (before session memory)

Set project Status to **"In Progress"** on every listed issue (leaf + parent).

```bash
gh project item-edit --project-id <PROJECT_ID> --id <ITEM_ID> \
  --field-id <STATUS_FIELD_ID> --single-select-option-id <IN_PROGRESS_OPTION_ID>
```

Or via `issue_write` if the prompt passes the status field differently — use whichever the prompt specifies.

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
- nodeIds:
  - issue 8: <node_id>  # needed for sub_issue_write if linking
  - issue 12: <node_id>
- FIRST ACTION: Set project Status → "In Progress" for EVERY listed issue (leaf + parent) BEFORE session memory
- LAST ACTIONS (in order): local session memory ended/duration → Set project Status → "In Review" (leaf only) → single implementation commit (no session files)
- FORBIDDEN: Set Status → Done; add comment for verification outcomes; committing session memory files
- COMMIT: include [#N] in subject; add "Fixes #N" in body for auto-close on main
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
- PRE-HANDOFF: local session memory verification ended/duration
- AFTER PASS: add_issue_comment (mandatory clean summary) → Set project Status → "Done" for leaf (+ parent if final child)
- AFTER FAIL: add_issue_comment (FAIL template) → Set project Status → "Ready"; do NOT set Done
- Reference: .cursor/skills/orchestrator/github-board.md
```

### Key differences from Jira

| Concern | Jira | GitHub |
|---|---|---|
| Time tracking | `addWorklogToJiraIssue` required | **Removed** — no equivalent; session memory records timing locally only |
| Status transitions | Numeric transition IDs (2, 21, 31, 41) | Status is a field value — set via `gh project item-edit`; no IDs to resolve |
| Parent-child | `parent` field + JQL search | `sub_issue_write` via MCP (requires **node IDs**, not issue numbers) |
| Auto-close | Transition to Done closes issue | `Fixes #N` in commit body; project-level auto-close disabled |
| Verifier comments | Heavy: session IDs, sub-agent names, worklog | Clean: commit SHA + summary + AC; no session IDs, no sub-agent names |
| Issue linking | `createIssueLink` ("Depends on") | Body text "Depends on: #N" or Projects v2 dependencies |

## Issue lookup (orchestrator)

| User says | Command |
|---|---|
| Issue #12, GitHub URL | MCP `issue_read` (method: get, issue_number: 12) or `gh issue view 12` |
| Sub-issues | MCP `issue_read` (method: get_sub_issues, issue_number: N) |
| Ready queue | `list_issues` with field filter `field_name: "Status", value: "Ready"` (via project board), or `gh project item-list` filtered by Status |
| By domain | `list_issues` with labels filter (e.g. `["domain:backend"]`) |
| By priority | `list_issues` with field_filter `{ field_name: "Priority", value: "High" }` |
| Node IDs for sub-issues | See § GraphQL for node IDs below |

### GraphQL — get node IDs for sub-issues

`sub_issue_write` requires the sub-issue's **node ID** (not the issue number). Obtain it via:

```bash
gh api graphql -f query='
{ repository(owner:"mdg-labs",name:"slugbase") {
  issue(number:12) {
    id
    number
    title
    subIssues(first:50) {
      nodes {
        id
        number
        title
      }
    }
  }
} }'
```

The top-level `id` field is the node ID of the issue itself. Child `nodes[].id` values are the node IDs of each sub-issue.

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

```bash
# Direct sub-issues of a Feature
gh api graphql -f query='
{ repository(owner:"mdg-labs",name:"slugbase") {
  issue(number:1) {
    subIssues(first:50) {
      nodes { id number title }
    }
  }
} }'

# For each sub-issue that itself has children, recurse:
gh api graphql -f query='
{ repository(owner:"mdg-labs",name:"slugbase") {
  issue(number:10) {
    subIssues(first:50) {
      nodes { id number title }
    }
  }
} }'
```

Leaf set = atomic issues (no children) **+** all deepest-level children. Batch leaves by domain + Lane.

- Implement **leaf** issues; pass each leaf number to execution + verifier prompts. A parent Feature is never implemented directly — only its children.
- Parent **In Progress**: execution sets parent when any leaf starts; set the intermediate parent In Progress too when implementing one of its sub-issues.
- Parent **Done**: last leaf verifier marks the intermediate parent Done (when its last child passes) and the top-level parent Done (when its last child passes) — or orchestrator recovery.

## MCP tools by role

| Tool | Orchestrator | Execution | Verifier |
|---|---|---|---|
| `list_issues` | Find work, query by status/domain/priority | — | — |
| `search_issues` | Find work, check for duplicates | — | — |
| `issue_read` (get) | Load AC / description | — | — |
| `issue_read` (get_sub_issues) | Enumerate leaf set | — | — |
| `issue_read` (get_comments) | Check for prior verification failures | — | — |
| `list_issue_types` | Verify valid type names | — | — |
| `list_issue_fields` | Verify valid field names/options | — | — |
| `issue_write` (create) | Intake/triage creates issues | — | — |
| `issue_write` (update) | Recovery only | Set issue-level fields | — |
| `sub_issue_write` (add) | Intake links parent-child | — | — |
| `sub_issue_write` (reprioritize) | Reorder children | — | — |
| `add_issue_comment` | — | — | On PASS (summary) + on FAIL (detail) |

**Status (project-board field)** is set via `gh project item-edit` (CLI) — not via MCP. MCP `issue_write` handles issue-level fields only (Priority, Effort, dates, type, labels).

### Status update via gh CLI

```bash
# Get project item ID for an issue
gh project item-list 2 --owner mdg-labs --format json \
  | jq '.items[] | select(.content.number == 12) | .id'

# Get the Status field ID and single-select option IDs
gh project field-list 2 --owner mdg-labs --format json \
  | jq '.fields[] | select(.name == "Status")'

# Set Status to "In Progress"
gh project item-edit --project-id <PROJECT_NODE_ID> --id <ITEM_NODE_ID> \
  --field-id <STATUS_FIELD_ID> --single-select-option-id <IN_PROGRESS_OPTION_ID>
```

## Standard queries (orchestrator)

```bash
# Ready queue — all domains (via project board)
gh project item-list 2 --owner mdg-labs --format json \
  | jq '[.items[] | select(.fieldValues[]? | select(.field.name == "Status" and .text == "Ready"))]'

# By domain
gh issue list --state open --label "domain:backend" --json number,title,labels

# Issues in a milestone
gh issue list --milestone "MVP Alpha" --state open --json number,title,labels

# Sub-issues of a parent
gh api graphql -f query='{ repository(owner:"mdg-labs",name:"slugbase") {
  issue(number:N) { subIssues(first:50) { nodes { id number title } } } } }'

# Issues with verification failures (check comments)
gh issue list --state open --json number,title,comments \
  --jq '.[] | select(.comments[]?.body | contains("Verification failed"))'

# All issues by priority (via MCP)
CallMcpTool user-github list_issues
  arguments: { owner: "mdg-labs", repo: "slugbase", state: "OPEN",
    field_filters: [{ field_name: "Priority", value: "High" }] }
```
