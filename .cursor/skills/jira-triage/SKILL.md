---
name: jira-triage
description: >-
  Investigate a SlugBase bug or task read-only, then update the Jira issue
  description with code findings — or create a new Bug when no issue exists.
  Preserves the original reporter text under ## Report at the top. Use when the
  user asks to triage, investigate, or diagnose a Jira issue (e.g. SB-12), or
  reports a bug without an existing key.
---

# Jira triage (SlugBase)

Read-only codebase investigation, then **update the Jira issue description and summary** with findings — or **create a Bug** when the user reports a defect without an existing key.

Board constants: [orchestrator/jira-board.md](../orchestrator/jira-board.md). Description layout: [description-template.md](description-template.md). Summary patterns: [summary-patterns.md](summary-patterns.md). Spec shorthand: [orchestrator/doc-index.md](../orchestrator/doc-index.md).

## When to use

| User intent | Action |
|---|---|
| "Triage SB-12", "investigate this bug", issue URL/key | **Update mode** — full workflow below |
| Bug report, no Jira key yet | **Create mode** — `createJiraIssue` Bug + triage description |
| "Don't change code" / "investigate only" | Read-only — no commits, no fixes |
| "Fix it" after triage | Separate implementation pass |
| "Don't update Jira" | Skip all Jira writes (description, summary, status) |

## Hard rules

1. **No implementation in a triage run** — read-only codebase investigation only. Do not modify repo files or commit fixes unless the user explicitly asks to implement after triage.
2. **Update `description` via `editJiraIssue`** — never post investigation findings as `addCommentToJiraIssue` (comments are for verifier FAIL summaries only).
3. **Preserve the original report** under `## Report` at the top (verbatim reporter wording).
4. **Summary follows [summary-patterns.md](summary-patterns.md)** — rewrite when vague/typo/mis-scoped; keep when already correct.
5. **After successful triage:** transition **Backlog → Ready** (`transition id: 2`) unless user opted out of Jira updates or issue is already In Progress / In Review / Done.
6. **Never** transition to In Progress, In Review, or Done — orchestrator / execution / verifier own those.
7. Read MCP tool schemas under `mcps/plugin-atlassian-atlassian/tools/` before calling.

## Board constants

```text
MCP server: plugin-atlassian-atlassian
cloudId: mdg-labs.atlassian.net
projectKey: SB
Ready transition id: 2
```

## Dual mode

### Update mode (existing issue)

User provides `SB-N` or Jira URL.

### Create mode (new Bug)

User describes a bug with no key. After investigation:

```text
createJiraIssue
  cloudId: mdg-labs.atlassian.net
  projectKey: SB
  issueTypeName: Bug
  summary: "Slugs: collision page shown for unambiguous slug"   # Bug pattern — summary-patterns.md
  description: <template with ## Report = user message>
  additional_fields:
    customfield_10081: { id: "<domain option id>" }   # Domain required: 10092=Frontend 10093=Backend 10094=Infra 10095=Ops
    labels: ["Bug"]
```

After create: transition to **Ready** if status is Backlog. Do **not** set In Progress or Done.

## Workflow (update mode)

```text
Triage progress:
- [ ] Step 1: Resolve issue from Jira
- [ ] Step 2: Extract and lock original ## Report text
- [ ] Step 3: Investigate codebase (read-only — no repo edits)
- [ ] Step 4: Compose description from template; draft summary per summary-patterns.md
- [ ] Step 5: editJiraIssue → description (+ summary when changed)
- [ ] Step 6: transitionJiraIssue → Ready if status is Backlog
- [ ] Step 7: Summarize findings in chat
```

### Step 1 — Fetch issue

| Input | MCP call |
|---|---|
| `SB-12` | `getJiraIssue` with `issueIdOrKey: SB-12` |
| Full Jira URL | Extract key from `/browse/SB-N` → `getJiraIssue` |

Also inspect issue links (`depends on` / `is required by`) when description mentions prerequisites or parent epics.

Record: key, summary, Domain, current description, **status**.

### Step 2 — Extract original report

**First triage:** use the issue's current `description` as the report body (trim trailing whitespace).

**Re-triage:** preserve `## Report` verbatim per [description-template.md](description-template.md) rules.

### Step 3 — Investigate (read-only)

Classify scope, search codebase, read spec docs (via `§` shorthand from [doc-index.md](../orchestrator/doc-index.md)), rank suspects, recommend checks. Use `explore` sub-agents for broad pipelines. **Do not edit application code** during this step.

### Step 4 — Compose description and summary

Build markdown from [description-template.md](description-template.md).

Draft or revise **summary** per [summary-patterns.md](summary-patterns.md) — apply rewrite/keep rules.

### Step 5 — Update Jira

When **description only** changed:

```text
CallMcpTool plugin-atlassian-atlassian / editJiraIssue
  cloudId: mdg-labs.atlassian.net
  issueIdOrKey: SB-12
  fields: { description: "<composed markdown>" }
  contentFormat: markdown
```

When **both description and summary** changed:

```text
CallMcpTool plugin-atlassian-atlassian / editJiraIssue
  cloudId: mdg-labs.atlassian.net
  issueIdOrKey: SB-12
  fields:
    description: "<composed markdown>"
    summary: "Go: authenticated user redirected to login on valid slug"
  contentFormat: markdown
```

Skip this step when user said "don't update Jira". Do not change Domain or labels unless the user asked.

### Step 6 — Transition to Ready

Skip when user opted out of Jira updates.

```text
CallMcpTool plugin-atlassian-atlassian / transitionJiraIssue
  cloudId: mdg-labs.atlassian.net
  issueIdOrKey: SB-12
  transition: { id: "2" }    # Ready
```

| Current status | Action |
|---|---|
| Backlog | Transition → Ready |
| Ready | No transition (already Ready) |
| In Progress / In Review / Done | Skip — do not change status |

### Step 7 — Reply in chat

Brief summary: issue link, verdict, whether description and/or summary were updated, whether status moved to Ready, suggested next action.

## Re-triage

Re-fetch issue, preserve `## Report`, replace investigation sections below it, `editJiraIssue` again. Apply Ready transition only if status is Backlog.

## What triage does not do

- Set **In Progress**, **In Review**, or **Done**
- Create epics or feature breakdown (use `jira-intake`)
- Commit code or session memory
- Modify repo files during the triage run

## MCP tools used

| Tool | Purpose |
|---|---|
| `getJiraIssue` | Resolve issue by key |
| `searchJiraIssuesUsingJql` | Duplicate search |
| `editJiraIssue` | Write investigation to description + summary |
| `createJiraIssue` | Create mode — new Bug |
| `transitionJiraIssue` | Backlog → Ready after successful triage |

**Forbidden during triage:** `addCommentToJiraIssue` for findings; transitions to In Progress / In Review / Done.
