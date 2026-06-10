---
name: github-intake
description: >-
  Create or enrich SlugBase GitHub Issues from a feature description, spec section,
  codebase change, or user-drafted issue. Single Task/Bug for small work;
  Feature (epic) + children for multi-task features. Dual mode: create net-new issues or
  enrich an existing #N issue. Stops at Ready. Use when the user describes a
  new feature, asks to plan or ticket work, flesh out a draft issue, or
  break a change into board tasks before implementation.
---

# GitHub intake (SlugBase)

Turn a feature request, spec section, codebase change, or rough draft into **Ready** issues on the SlugBase GitHub project. Canonical spec: `docs/slugbase-mvp-spec.md`.

Board sync for execution/verification: [orchestrator/github-board.md](../orchestrator/github-board.md). Description templates: [templates.md](templates.md). Summary patterns: [../github-triage/summary-patterns.md](../github-triage/summary-patterns.md).

## When to use

| User intent | Action |
|---|---|
| Feature or spec section needing **2+ tasks** | **Feature (epic)** + child Tasks/Bugs |
| Single task sufficient | **One** Task or Bug — no epic |
| Bug fix (one task) | Bug in affected domain; `type: Bug` |
| User provides `#N` draft issue | **Enrich mode** — add AC, spec refs, files, tests, children |
| User says "don't create issues" | Skip MCP; optionally draft markdown plan only |

**Ask before creating** if priority, owning domain, or product rules are unclear.

## Board constants

```text
MCP server: user-github
Owner: mdg-labs
Repo: slugbase
Project number: 2 (SlugBase Roadmap)
```

Org-level issue types: **Task**, **Bug**, **Feature** — see [github-board.md](../orchestrator/github-board.md).

Org-level issue fields: **Priority** (Critical/High/Medium/Low), **Effort** (High/Medium/Low).

## Issue summaries

Every issue creation or enrich-mode update must follow [summary-patterns.md](../github-triage/summary-patterns.md):

| Issue type | Pattern | Example |
|---|---|---|
| Feature (epic) | `{Feature name}` | `Server-side session infrastructure` |
| Task | `{Verb} {target}` | `Add SSRF-safe egress service for metadata fetch` |
| Bug | `{Area}: {observed defect}` | `Slugs: collision page shown for unambiguous slug` |

Apply **rewrite vs keep** rules when enriching — rewrite vague drafts; keep summaries that already match.

## Dual mode

### Mode A — Create net-new

User describes a feature with no existing issue number.

### Mode B — Enrich existing

User names `#N`. Fetch with MCP `issue_read` (method: get, issue_number: N), **merge** structured sections into body via MCP `issue_write` (method: update). Rewrite summary when vague. Add sub-issues if scope grew. Do not wipe user prose.

## Domain labels

| Label | Scope |
|---|---|
| `domain:frontend` | Web client, React, UI, command palette, dashboard, i18n |
| `domain:backend` | API, auth, sessions, bookmarks/slugs/folders/tags/workspaces, entitlements, billing, admin |
| `domain:infrastructure` | Database, container, CI/CD, TLS/proxy, deployment, monitoring |
| `domain:operations` | Launch, marketing site, docs, billing operations, self-hosted runbooks |

**Feature (epic)** gets the **owning** domain label. Each child gets its own.

## Issue type mapping

| Work | GitHub type |
|---|---|
| Epic parent (2+ tasks) | Feature |
| Feature leaf | Task |
| Bug | Bug |
| Chore / DX / spike | Task |

## Workflow

### 1. Understand the request

1. Read relevant spec sections (`spec §N` from [doc-index.md](../orchestrator/doc-index.md)) — cite `§` refs in descriptions.
2. Search the codebase for patterns / file paths.
3. Search for duplicates: MCP `search_issues` (query: "<keywords>", owner: "mdg-labs", repo: "slugbase").
4. Split into **leaf issues** — each independently implementable and verifiable.

### 2. Draft plan — show user before MCP writes

```markdown
## Proposed issue structure

**Feature (epic):** #?? — Server-side session infrastructure → Domain: backend
**Children:**

| # | Domain | Type | Summary | Depends on |
|---|---|---|---|---|
| #?? | backend | Task | Implement session store with configurable TTL | — |
| #?? | backend | Task | Add workspace-context middleware to session | #?? |
| #?? | frontend | Task | Show active workspace in nav and workspace switcher | #?? |

**Implementation order:** …
**Open questions:** …
**Spec refs:** spec §5.3 (sessions), spec §4.3 (workspace resolution), spec §2.5 (multi-tenant)
```

Wait for approval unless the user said "create the issues now".

### 3. Create Feature epic (Mode A only)

```text
MCP issue_write (method: create):
- owner: mdg-labs
- repo: slugbase
- title: "Server-side session infrastructure"
- type: "Feature"
- labels: ["domain:backend"]
- assignees: ["<logged-in username from MCP get_me>"]
- body: "<epic template — templates.md>"
- issue_fields: [{ field_name: "Priority", field_option_name: "High" }, { field_name: "Effort", field_option_name: "High" }]
```

Record returned issue number (e.g. `#8`).

### 4. Create children (Mode A) or enrich + add children (Mode B)

```text
MCP issue_write (method: create):
- owner: mdg-labs
- repo: slugbase
- title: "Redirect to bookmark destination via /go/<slug>"
- type: "Task"
- labels: ["domain:backend"]
- body: "<subtask template>"
- issue_fields: [{ field_name: "Priority", field_option_name: "Medium" }, { field_name: "Effort", field_option_name: "Medium" }]
```

Mode B enrich — when summary needs rewrite:

```text
MCP issue_write (method: update):
- owner: mdg-labs
- repo: slugbase
- issue_number: <NUMBER>
- title: "Go: redirect resolves slug within active workspace context"
- body: "<merged markdown>"
```

### 5. Sub-issue relationships

```text
# Get database IDs via GraphQL (CLI — needed for sub_issue_write)
gh api graphql -f 'query=query { repository(owner:"mdg-labs", name:"slugbase") {
  issue(number: 8) { databaseId } issue(number: 9) { databaseId } } }'

# Create sub-issue relationship via MCP
# sub_issue_write: method: add, issue_number: 8, sub_issue_id: <database ID of child>
```

Document sub-issue relationships in each leaf description with `#N` references.

### 6. Finalize Feature description

Update the Feature epic — **Sub-issues table** with every child number, domain, one-line scope, and **Suggested implementation order**. Include relevant spec `§` refs.

### 7. Set project Status to Ready

Issues are automatically added to the project board by the repo connection. Just get the project item ID and set Status.

```bash
# Get project item ID from issue (needed for setting Status)
ITEM_ID=$(gh api graphql -f 'query=query { repository(owner:"mdg-labs",name:"slugbase") { issue(number:<NUMBER>) { projectItems(first:10) { nodes { id project { number } } } } } }' --jq '.data.repository.issue.projectItems.nodes[] | select(.project.number == 2) | .id')

# Set Status to Ready — GraphQL mutation (see github-board.md § Projects v2 Status)
gh api graphql -f 'query=mutation {
  updateProjectV2ItemFieldValue(input: {
    projectId: "PVT_kwDODv-LLc4BaOr9"
    itemId: "'"$ITEM_ID"'"
    fieldId: "PVTSSF_lADODv-LLc4BaOr9zhVHxUI"
    value: { singleSelectOptionId: "a0e7153f" }
  }) { projectV2Item { fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } } } }
}'
```

Intake stops at **Ready** — not In Progress or Done.

## Description rules

- **Feature (epic):** context from spec, sub-issues table, suggested order, product rules (cite `spec §N`). Children hold the implementable AC.
- **Leaf:** parent epic link, Depends on, spec refs, technical sections, AC checklist, Files, Tests.
- Use **Markdown** in descriptions.

## Sizing guidelines

| Good leaf | Too big — split |
|---|---|
| One migration + one schema entity | "All backend auth changes" |
| One API surface if tightly coupled | Entire feature in one story |
| One UI flow or one component | "All auth UI" |

## After creation — handoff

```markdown
Created on GitHub:

- Feature (epic): #8 — Server-side session infrastructure
- #9 … / #11 … (all child issues)

Suggested order: #9 → #10 → #11
Ready for orchestrator: "implement #11" or "orchestrate #8 epic"
```

## Forbidden

- **Creating issues via `gh issue create`** — always use MCP `issue_write` (org-level types and fields require it)
- Setting In Progress or Done during intake
- Inventing product behaviour not in spec docs — ask first
- Pasting secrets into issue descriptions
- Creating a multi-task feature without a Feature (epic) parent
- **Omitting type, domain label, Priority, or Effort** — all four are mandatory on every issue
- Vague summary placeholders when pattern table applies
- Referencing "organization", "favorites", "collection" — use canonical vocabulary (spec §3, rule `04-naming.mdc`)
