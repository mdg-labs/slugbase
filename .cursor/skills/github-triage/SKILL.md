---
name: github-triage
description: >-
  Investigate a SlugBase bug or task read-only, then update the GitHub issue
  body with code findings — or create a new Bug when no issue exists.
  Preserves the original reporter text under ## Report at the top. Use when the
  user asks to triage, investigate, or diagnose a GitHub issue (e.g. #12), or
  reports a bug without an existing key.
---

# GitHub triage (SlugBase)

Read-only codebase investigation, then **update the GitHub issue body and title** with findings — or **create a Bug** when the user reports a defect without an existing key.

Board constants: [orchestrator/github-board.md](../orchestrator/github-board.md). Description layout: [description-template.md](description-template.md). Summary patterns: [summary-patterns.md](summary-patterns.md). Spec shorthand: [orchestrator/doc-index.md](../orchestrator/doc-index.md).

## When to use

| User intent | Action |
|---|---|
| "Triage #12", "investigate this bug", issue URL/number | **Update mode** — full workflow below |
| Bug report, no issue key yet | **Create mode** — MCP `issue_write` (create) Bug + triage description |
| "Don't change code" / "investigate only" | Read-only — no commits, no fixes |
| "Fix it" after triage | Separate implementation pass |
| "Don't update GitHub" | Skip all issue writes (body, title, status) |

## Hard rules

1. **No implementation in a triage run** — read-only codebase investigation only. Do not modify repo files or commit fixes unless the user explicitly asks to implement after triage.
2. **Update `body` via MCP `issue_write` (method: update)** — never post investigation findings as an issue comment (comments are for verifier summaries only).
3. **Preserve the original report** under `## Report` at the top (verbatim reporter wording).
4. **Summary follows [summary-patterns.md](summary-patterns.md)** — rewrite when vague/typo/mis-scoped; keep when already correct.
5. **After successful triage:** set project Status to **Ready** (via GraphQL `updateProjectV2ItemFieldValue`) unless user opted out of updates or issue is already In Progress / In Review / Done.
6. **Never** set In Progress, In Review, or Done — orchestrator / execution / verifier own those.
7. **Regression detection — never re-open Done/Closed issues.** When investigation reveals the same bug was already filed and has board Status **Done** or **Closed**, do NOT re-open the old issue. Create a new Bug tagged with the `regression` label and a body that references the old issue `#N` as the originating fix. This applies regardless of GitHub issue state (`open`/`closed`) — board Status is the authority per `12-github-project-board.mdc`.

## Dual mode

### Update mode (existing issue)

User provides `#N` or issue URL.

### Create mode (new Bug)

User describes a bug with no key. After investigation — including a **duplicate search** via MCP `search_issues` to check whether the same bug was already filed with board Status Done/Closed:

**Standard Bug:**

```text
MCP issue_write (method: create):
- owner: mdg-labs
- repo: slugbase
- title: "Slugs: collision page shown for unambiguous slug"
- type: "Bug"
- labels: ["domain:backend"]
- assignees: ["<logged-in username from MCP get_me>"]
- milestone: <milestone_number>
- body: "<template with ## Report = user message>"
- issue_fields: [{ field_name: "Priority", field_option_name: "High" }, { field_name: "Effort", field_option_name: "Medium" }]
```

**Regression Bug** (when a Done/Closed issue for the same bug exists):

```text
MCP issue_write (method: create):
- owner: mdg-labs
- repo: slugbase
- title: "Go: authenticated user redirected to login on valid slug (regression)"
- type: "Bug"
- labels: ["domain:backend", "regression"]
- assignees: ["<logged-in username from MCP get_me>"]
- milestone: <milestone_number>
- body: "<template with ## Report + ## Regression section referencing #N>"
- issue_fields: [{ field_name: "Priority", field_option_name: "High" }, { field_name: "Effort", field_option_name: "Medium" }]
```

After create: set project Status to **Ready** (via GraphQL `updateProjectV2ItemFieldValue`). Do **not** set In Progress or Done.

## Workflow (update mode)

```text
Triage progress:
- [ ] Step 1: Resolve issue from GitHub
- [ ] Step 2: Extract and lock original ## Report text
- [ ] Step 3: Investigate codebase (read-only — no repo edits)
- [ ] Step 4: Compose body from template; draft title per summary-patterns.md
- [ ] Step 5: MCP issue_write (update) → body (+ title when changed)
- [ ] Step 6: Set project Status to Ready if currently Todo
- [ ] Step 7: Summarize findings in chat
```

### Step 1 — Fetch issue

| Input | Tool |
|---|---|
| `#12` | MCP `issue_read` (method: get, issue_number: 12) |
| Full URL | Extract number from URL → MCP `issue_read` |

Record: number, title, labels, current body, status, issue type, field values, **project board Status**.

### Step 2 — Extract original report

**First triage:** use the issue's current `body` as the report body (trim trailing whitespace).

**Re-triage:** preserve `## Report` verbatim per [description-template.md](description-template.md) rules.

### Step 3 — Investigate (read-only)

Classify scope, search codebase, read spec docs (via `§` shorthand from [doc-index.md](../orchestrator/doc-index.md)), rank suspects, recommend checks. Use `explore` sub-agents for broad pipelines. **Do not edit application code** during this step.

### Step 3a — Regression check + milestone fetch

**Regression check:** Before composing the body, check whether the same bug was already filed with board Status **Done** or **Closed**:

1. Search for duplicates via MCP `search_issues` (query: relevant keywords, owner: "mdg-labs", repo: "slugbase").
2. For each matching open-status issue, query its **project board Status** via GraphQL `repository.issue.projectItems` (see github-board.md § Projects v2 Status).
3. If an issue with board Status **Done** or **Closed** matches the same bug → this is a **regression**. Do NOT re-open or comment on the old issue. Proceed to Step 4 using the **Regression Bug** template.

This applies regardless of GitHub issue state (`open`/`closed`) — board Status is the authority.

**Milestone fetch:** In **Create mode**, fetch available milestones before composing body:

```bash
gh api /repos/mdg-labs/slugbase/milestones --jq '.[] | {number, title, state, due_on}'
```

Only consider milestones with `state: "open"`. Selection: if the user explicitly names a milestone → match by title; otherwise → pick the earliest open milestone by `due_on` (first in list if no due dates).

### Step 4 — Compose body and title

Build markdown from [description-template.md](description-template.md).

Draft or revise **title** per [summary-patterns.md](summary-patterns.md) — apply rewrite/keep rules.

### Step 5 — Update issue

When **body only** changed:

```text
MCP issue_write (method: update):
- owner: mdg-labs
- repo: slugbase
- issue_number: <NUMBER>
- body: "<composed markdown>"
```

When **both body and title** changed:

```text
MCP issue_write (method: update):
- owner: mdg-labs
- repo: slugbase
- issue_number: <NUMBER>
- title: "Go: authenticated user redirected to login on valid slug"
- body: "<composed markdown>"
```

Skip this step when user said "don't update GitHub". Do not change labels unless the user asked.

### Step 6 — Set to Ready

Skip when user opted out of updates.

**Guard — never move Done/Closed issues:** If the issue's board Status is already **Done** or **Closed**, do NOT change it. These issues represent completed work and must not be moved back to Todo/Ready. If the bug appears to be recurring, the procedure is to **create a new Regression Bug** (see Create mode above) rather than re-opening the old issue.

Otherwise, set project Status to **Ready** via GraphQL `updateProjectV2ItemFieldValue` (see github-board.md § Projects v2 Status for IDs). Only if current status is **Todo** — skip if already In Progress / In Review / Done.

### Step 7 — Reply in chat

Brief summary: issue link, verdict, whether body and/or title were updated, whether status moved to Ready, suggested next action.

## Re-triage

Re-fetch issue via MCP `issue_read` (method: get), preserve `## Report`, replace investigation sections below it, update via MCP `issue_write` (method: update). Set to Ready only if status is Todo — never if board Status is Done or Closed (create a new Regression Bug instead).

## What triage does not do

- Set **In Progress**, **In Review**, or **Done**
- Create epics or feature breakdown (use `github-intake`)
- Commit code or session memory
- Modify repo files during the triage run

## GitHub tools used

| Tool | Purpose |
|---|---|
| MCP `issue_read` (get) | Resolve issue by number |
| MCP `search_issues` | Duplicate search (including regression detection) |
| MCP `issue_write` (update) | Write investigation to body + title |
| MCP `issue_write` (create) | Create mode — new Bug (type: Bug + labels + fields); includes `milestone` parameter |
| GraphQL `updateProjectV2ItemFieldValue` | Set Status to Ready after triage (project-board field) |
| CLI `gh api /repos/…/milestones` | Fetch available milestones (no MCP equivalent) — see Step 3a |

**Forbidden during triage:** posting findings as issue comments; setting In Progress / In Review / Done; creating issues via `gh issue create` (use MCP `issue_write` instead); re-opening or re-triggering Done/Closed issues (create a Regression Bug instead).

## Labels

| Label | When to use |
|---|---|
| `domain:frontend` | Web client, React, UI, command palette, dashboard, i18n |
| `domain:backend` | API, auth, sessions, bookmarks/slugs/folders/tags/workspaces, entitlements, billing, admin |
| `domain:infrastructure` | Database, container, CI/CD, TLS/proxy, deployment, monitoring |
| `domain:operations` | Launch, marketing site, docs, billing operations, self-hosted runbooks |
| `regression` | Bug that was previously fixed (originating issue had board Status Done/Closed) — always added **alongside** a `domain:*` label, never alone |
