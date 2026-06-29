---
name: linear-triage
description: >-
  Investigate a SlugBase bug or task read-only, then update the Linear issue
  description with code findings — or create a new Bug when no issue exists.
  Linear-first (SlugBase team, SB-N); GitHub #N syncs via two-way integration.
  Preserves original reporter text under ## Report. Use when the user asks to
  triage SB-N, #N, or reports a bug without an existing key.
---

# Linear triage (SlugBase)

Read-only codebase investigation, then **update the Linear issue** — or **create a Bug** when no key exists.

Board: [orchestrator/linear-board.md](../orchestrator/linear-board.md). Layout: [description-template.md](description-template.md). Summaries: [summary-patterns.md](summary-patterns.md).

## Constants

```text
MCP server: plugin-linear-linear
Team: SlugBase
Issue key: SB-N
```

## Hard rules

1. **No implementation** during triage — read-only unless user asks to fix after.
2. **Update `description` via `save_issue`** — never post investigation as comments.
3. **Preserve `## Report`** verbatim at top.
4. **After triage:** `save_issue` state → **Ready** unless user opted out or state is In Progress / In Review / Done.
5. **Never** set In Progress, In Review, or Done.
6. **Regression:** if same bug was fixed on an issue with Linear state **Done** or **Closed**, create **new** Bug with `regression` label — do not re-open old issue.

## Create mode (new Bug)

```text
save_issue:
  title: "Slugs: collision page shown for unambiguous slug"
  team: "SlugBase"
  description: "<template with ## Report>"
  labels: ["domain:backend"]
  priority: 2
  assignee: "me"
```

Poll `get_issue` for synced `#N`; add header `**Linear:** SB-N · **GitHub:** #N`.

Then: `save_issue { id: "SB-N", state: "Ready" }`.

## Update mode workflow

1. `get_issue { id: "SB-N" }` or `list_issues { query: "#12" }`
2. Lock `## Report` text
3. Investigate codebase (read-only)
4. Regression check: `list_issues` for duplicates; if match is Done/Closed → new Regression Bug
5. Compose body from [description-template.md](description-template.md); title per [summary-patterns.md](summary-patterns.md)
6. `save_issue { id: "SB-N", title, description }`
7. `save_issue { id: "SB-N", state: "Ready" }` if not Done/Closed and not already In Progress/In Review

## Tools

| Tool | Purpose |
|---|---|
| `get_issue` | Load issue + relations |
| `list_issues` | Search / duplicates |
| `save_issue` | Create, update, set Ready |
| `gh api` Dependabot | Alerts only (via dependabot-triage) |

**Forbidden:** `save_comment` for findings; GraphQL project board; issue keys in commit subjects.

## What triage does not do

- Set In Progress / In Review / Done
- Feature breakdown (use `linear-intake`)
- Commit code
