---
name: jira-triage
description: >-
  Investigate a Dispatch One bug or task read-only, then update the Jira issue
  description with code findings — or create a new Bug when no issue exists.
  Preserves the original reporter text under ## Report at the top. Use when the
  user asks to triage, investigate, or diagnose a Jira issue (e.g. DO-50), or
  reports a bug without an existing key.
---

# Jira triage (Dispatch One)

Read-only codebase investigation, then **update the Jira issue description and summary** with findings — or **create a Bug** when the user reports a defect without an existing key.

Board constants: [orchestrator/jira-board.md](../orchestrator/jira-board.md). Description layout: [description-template.md](description-template.md). Summary patterns: [summary-patterns.md](summary-patterns.md). Spec shorthand: [orchestrator/doc-index.md](../orchestrator/doc-index.md).

## When to use

| User intent                                           | Action                                                       |
| ----------------------------------------------------- | ------------------------------------------------------------ |
| "Triage DO-50", "investigate this bug", issue URL/key | **Update mode** — full workflow below                        |
| Bug report, no Jira key yet                           | **Create mode** — `createJiraIssue` Bug + triage description |
| "Don't change code" / "investigate only"              | Read-only — no commits, no fixes                             |
| "Fix it" after triage                                 | Separate implementation pass                                 |
| "Don't update Jira"                                   | Skip all Jira writes (description, summary, status)          |

## Hard rules

1. **No implementation in a triage run** — read-only codebase investigation only. Do not modify repo files, commit, or apply fixes unless the user explicitly asks to implement after triage.
2. **Update `description` via `editJiraIssue`** — never post investigation findings as `addCommentToJiraIssue` (comments are for verifier FAIL summaries only).
3. **Preserve the original report** under `## Report` at the top (verbatim reporter wording).
4. **Summary follows [summary-patterns.md](summary-patterns.md)** — rewrite when vague/typo/mis-scoped; keep when already correct.
5. **After successful triage:** transition **Backlog → Ready** (`transition id: 2`) unless user opted out of Jira updates or issue is already In Progress / In Review / Done.
6. **Never** transition to In Progress, In Review, or Done — orchestrator / execution / verifier own those statuses.
7. Read MCP tool schemas under `mcps/plugin-atlassian-atlassian/tools/` before calling.

## Board constants

```text
MCP server: plugin-atlassian-atlassian
cloudId: mdg-labs.atlassian.net
projectKey: DO
Ready transition id: 2
```

## Dual mode

### Update mode (existing issue)

User provides `DO-N` or Jira URL.

### Create mode (new Bug)

User describes a bug with no key. After investigation:

```text
createJiraIssue
  projectKey: DO
  issueTypeName: Bug
  summary: "Map: vehicle icon shown while on scene or at station"   # Bug pattern — summary-patterns.md
  description: <template with ## Report = user message>
  additional_fields:
    customfield_10048: { id: "<domain option id>" }
    labels: ["Bug"]
```

After create: transition to **Ready** if status is Backlog (same rules as update mode). Do **not** set In Progress or Done.

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

| Input              | MCP call                                                              |
| ------------------ | --------------------------------------------------------------------- |
| `DO-50`            | `getJiraIssue` with `issueIdOrKey: DO-50`                             |
| Full Jira URL      | Extract key from `/browse/DO-N` → `getJiraIssue`                      |
| Legacy key `FE-50` | `searchJiraIssuesUsingJql`: `project = DO AND "Legacy Key" ~ "FE-50"` |

Also inspect issue links (`Depends` / `depends on`, or legacy `Blocks` / `is blocked by`) when description mentions prerequisites or parent epics.

Record: key, summary, Domain, current description, **status**.

### Step 2 — Extract original report

**First triage:** use the issue's current `description` as the report body (trim trailing whitespace).

**Re-triage:** preserve `## Report` verbatim per [description-template.md](description-template.md) rules.

### Step 3 — Investigate (read-only)

Classify scope, search codebase, read spec docs, rank suspects, recommend operator checks. Use `explore` sub-agents for broad pipelines. **Do not edit application code** during this step.

### Step 4 — Compose description and summary

Build markdown from [description-template.md](description-template.md).

Draft or revise **summary** per [summary-patterns.md](summary-patterns.md) — apply rewrite/keep rules based on investigation scope and issue type.

### Step 5 — Update Jira

When **description only** changed:

```text
CallMcpTool plugin-atlassian-atlassian / editJiraIssue
  cloudId: mdg-labs.atlassian.net
  issueIdOrKey: DO-50
  fields: { description: "<composed markdown>" }
```

When **both description and summary** changed:

```text
CallMcpTool plugin-atlassian-atlassian / editJiraIssue
  cloudId: mdg-labs.atlassian.net
  issueIdOrKey: DO-50
  fields:
    description: "<composed markdown>"
    summary: "Dispatch: ETA not shown in vehicle picker"
```

Skip this step when user said "don't update Jira".

Do not change assignee, labels, or Domain unless the user asked.

### Step 6 — Transition to Ready

Skip when user opted out of Jira updates.

```text
CallMcpTool plugin-atlassian-atlassian / transitionJiraIssue
  cloudId: mdg-labs.atlassian.net
  issueIdOrKey: DO-50
  transition: { id: "2" }    # Ready
```

| Current status                 | Action                        |
| ------------------------------ | ----------------------------- |
| Backlog                        | Transition → Ready            |
| Ready                          | No transition (already Ready) |
| In Progress / In Review / Done | Skip — do not change status   |

### Step 7 — Reply in chat

Brief summary: issue link, verdict, whether description and/or summary were updated, whether status moved to Ready, suggested next action.

## Re-triage

Re-fetch issue, preserve `## Report`, replace investigation sections below it, `editJiraIssue` again (description + summary when warranted). Apply Ready transition only if status is Backlog.

## What triage does not do

- Set **In Progress**, **In Review**, or **Done** (orchestrator / execution / verifier own status sync)
- Create epics or feature breakdown (use [jira-intake](../jira-intake/SKILL.md))
- Commit code or session memory
- Run the full CI gate (no code changes)
- Modify repo files during the triage run (unless user explicitly requests implementation)

## MCP tools used

| Tool                       | Purpose                                      |
| -------------------------- | -------------------------------------------- |
| `getJiraIssue`             | Resolve issue by key                         |
| `searchJiraIssuesUsingJql` | Legacy Key lookup; duplicates                |
| `editJiraIssue`            | Write investigation to description + summary |
| `createJiraIssue`          | Create mode — new Bug                        |
| `transitionJiraIssue`      | Backlog → Ready after successful triage      |

**Forbidden during triage:** `addCommentToJiraIssue` for findings; transitions to In Progress / In Review / Done.
