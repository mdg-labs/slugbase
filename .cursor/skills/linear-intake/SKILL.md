---
name: linear-intake
description: >-
  Create or enrich SlugBase Linear issues (SlugBase team, SB-N) from a feature
  description, spec section, codebase change, or user draft. Single issue for small
  work; epic + children for multi-task features. Linear-first — two-way sync creates
  GitHub mirror #N. Dual mode: create net-new or enrich SB-N (never when state is
  Done/Closed). Stops at Ready. Use when the user describes a new feature, asks to
  plan or ticket work, or break a change into tasks before implementation.
---

# Linear intake (SlugBase)

Turn a feature request, spec section, or rough draft into **Ready** issues on the SlugBase Linear team. Canonical spec: `docs/internal/slugbase-mvp-spec.md`.

Board sync: [orchestrator/linear-board.md](../orchestrator/linear-board.md). Templates: [templates.md](templates.md). Summary patterns: [../linear-triage/summary-patterns.md](../linear-triage/summary-patterns.md).

## Constants

```text
MCP server: plugin-linear-linear
Team: SlugBase
Issue key: SB-N
GitHub sync: mdg-labs/slugbase (two-way)
```

## When to use

| User intent | Action |
|---|---|
| Feature needing **2+ tasks** | Parent epic + child issues (`parentId`) |
| Single task | One issue — no epic |
| Bug fix (one task) | Bug with `domain:*` label |
| User provides `SB-N` or `#N` draft | **Enrich mode** — only if Linear state is not Done/Closed |
| User says "don't create issues" | Skip MCP; draft markdown plan only |

## Linear state vs GitHub issue state

| System | Authority |
|---|---|
| **Linear workflow state** | Done / Closed = delivered — do not enrich |
| **GitHub `open`/`closed`** | Do not use alone — mirror may stay `open` until `main` |

Query state: `get_issue { id: "SB-N" }` → check `state`.

When Done/Closed: create **new** issues; cite finished work as `Related: SB-N / #N — Done`.

## Dual mode

### Mode A — Create net-new

User describes work with no existing `SB-N`.

### Mode B — Enrich existing

User names `SB-N` or `#N`. Fetch via `get_issue` / `list_issues`. If state is **Done** or **Closed**, stop — propose new issues instead.

## Domain labels

`domain:frontend` · `domain:backend` · `domain:infrastructure` · `domain:operations`

## Workflow

### 1. Understand

1. Read spec sections (`spec §N`).
2. Search codebase and duplicates: `list_issues { team: "SlugBase", query: "…" }`.
3. Split into **leaf** issues.

### 2. Draft plan — STOP for approval

Propose structure with `SB-??` placeholders and synced `#??` after create. Wait for explicit approval before MCP writes.

### 3. Create epic (Mode A)

```text
save_issue:
  title: "Server-side session infrastructure"
  team: "SlugBase"
  description: "<epic template>"
  labels: ["domain:backend"]
  priority: 2
  assignee: "me"
```

Poll `get_issue` until GitHub `#N` appears in links/attachments. Record both keys in description header:

```markdown
**Linear:** SB-8 · **GitHub:** #612
```

### 4. Create children

```text
save_issue:
  title: "Add session store with configurable TTL"
  team: "SlugBase"
  parentId: "<epic id or SB-8>"
  labels: ["domain:backend"]
  priority: 3
  assignee: "me"
  description: "<subtask template>"
```

### 5. Dependencies

```text
save_issue:
  id: "SB-312"
  blockedBy: ["SB-4"]
```

### 6. Finalize epic description

Sub-issues table with `SB-N` / `#N` for each child + suggested order.

### 7. Set Ready

```text
save_issue: { id: "SB-N", state: "Ready" }
```

Intake stops at **Ready** — not In Progress or Done.

## After creation — handoff

```markdown
Created on Linear (SlugBase):

- Epic: SB-8 / #612 — Server-side session infrastructure
- SB-9 / #613 … (children)

Suggested order: SB-9 → SB-10
Ready: "implement SB-11" or "orchestrate SB-8 epic"
```

## Forbidden

- Enriching Done/Closed issues
- Linking sub-issues under Done/Closed parent epics
- Setting In Progress or Done during intake
- Issue keys in commit subjects (body only per `07-issue-commit-linking.mdc`)
- GraphQL GitHub project board mutations
- Creating issues without user approval of draft structure
