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
| Bug report, no issue key yet | **Create mode** — `gh issue create` Bug + triage description |
| "Don't change code" / "investigate only" | Read-only — no commits, no fixes |
| "Fix it" after triage | Separate implementation pass |
| "Don't update GitHub" | Skip all issue writes (body, title, status) |

## Hard rules

1. **No implementation in a triage run** — read-only codebase investigation only. Do not modify repo files or commit fixes unless the user explicitly asks to implement after triage.
2. **Update `body` via `gh issue edit`** — never post investigation findings as an issue comment (comments are for verifier summaries only).
3. **Preserve the original report** under `## Report` at the top (verbatim reporter wording).
4. **Summary follows [summary-patterns.md](summary-patterns.md)** — rewrite when vague/typo/mis-scoped; keep when already correct.
5. **After successful triage:** set project Status to **Ready** (via `gh project item-edit`) unless user opted out of updates or issue is already In Progress / In Review / Done.
6. **Never** set In Progress, In Review, or Done — orchestrator / execution / verifier own those.

## Dual mode

### Update mode (existing issue)

User provides `#N` or issue URL.

### Create mode (new Bug)

User describes a bug with no key. After investigation:

```bash
gh issue create \
  --repo mdg-labs/slugbase \
  --title "Slugs: collision page shown for unambiguous slug" \
  --type "Bug" \
  --label "domain:backend" \
  --body "<template with ## Report = user message>"
```

After create: set project Status to **Ready**. Do **not** set In Progress or Done.

## Workflow (update mode)

```text
Triage progress:
- [ ] Step 1: Resolve issue from GitHub
- [ ] Step 2: Extract and lock original ## Report text
- [ ] Step 3: Investigate codebase (read-only — no repo edits)
- [ ] Step 4: Compose body from template; draft title per summary-patterns.md
- [ ] Step 5: gh issue edit → body (+ title when changed)
- [ ] Step 6: Set project Status to Ready if currently Todo
- [ ] Step 7: Summarize findings in chat
```

### Step 1 — Fetch issue

| Input | Command |
|---|---|
| `#12` | `gh issue view 12 --repo mdg-labs/slugbase` |
| Full URL | Extract number from URL → `gh issue view` |

Record: number, title, labels, current body, status.

### Step 2 — Extract original report

**First triage:** use the issue's current `body` as the report body (trim trailing whitespace).

**Re-triage:** preserve `## Report` verbatim per [description-template.md](description-template.md) rules.

### Step 3 — Investigate (read-only)

Classify scope, search codebase, read spec docs (via `§` shorthand from [doc-index.md](../orchestrator/doc-index.md)), rank suspects, recommend checks. Use `explore` sub-agents for broad pipelines. **Do not edit application code** during this step.

### Step 4 — Compose body and title

Build markdown from [description-template.md](description-template.md).

Draft or revise **title** per [summary-patterns.md](summary-patterns.md) — apply rewrite/keep rules.

### Step 5 — Update issue

When **body only** changed:

```bash
gh issue edit <NUMBER> --repo mdg-labs/slugbase --body "<composed markdown>"
```

When **both body and title** changed:

```bash
gh issue edit <NUMBER> --repo mdg-labs/slugbase \
  --title "Go: authenticated user redirected to login on valid slug" \
  --body "<composed markdown>"
```

Skip this step when user said "don't update GitHub". Do not change labels unless the user asked.

### Step 6 — Set to Ready

Skip when user opted out of updates.

Set project Status to **Ready** via `gh project item-edit` (or MCP `issue_write` with status field). Only if current status is **Todo** — skip if already In Progress / In Review / Done.

### Step 7 — Reply in chat

Brief summary: issue link, verdict, whether body and/or title were updated, whether status moved to Ready, suggested next action.

## Re-triage

Re-fetch issue, preserve `## Report`, replace investigation sections below it, `gh issue edit` again. Set to Ready only if status is Todo.

## What triage does not do

- Set **In Progress**, **In Review**, or **Done**
- Create epics or feature breakdown (use `github-intake`)
- Commit code or session memory
- Modify repo files during the triage run

## GitHub tools used

| Tool | Purpose |
|---|---|
| `gh issue view` | Resolve issue by number |
| `gh issue list --search` | Duplicate search |
| `gh issue edit` | Write investigation to body + title |
| `gh issue create` | Create mode — new Bug |
| `gh project item-edit` | Set Status to Ready after triage |

**Forbidden during triage:** posting findings as issue comments; setting In Progress / In Review / Done.
