---
name: jira-intake
description: >-
  Create or enrich SlugBase Jira issues from a feature description, spec section,
  codebase change, or user-drafted issue. Single Story/Task/Bug for small work;
  Epic + children for multi-task features. Dual mode: create net-new issues or
  enrich an existing SB-* issue. Stops at Ready. Use when the user describes a
  new feature, asks to plan or ticket work on Jira, flesh out a draft issue, or
  break a change into board tasks before implementation.
---

# Jira intake (SlugBase)

Turn a feature request, spec section, codebase change, or rough Jira draft into **Ready** issues on project **SB**. Canonical spec: `docs/slugbase-mvp-spec.md`.

Board sync for execution/verification: [orchestrator/jira-board.md](../orchestrator/jira-board.md). Description templates: [templates.md](templates.md). Summary patterns: [../jira-triage/summary-patterns.md](../jira-triage/summary-patterns.md).

## When to use

| User intent | Action |
|---|---|
| Feature or spec section needing **2+ tasks** | **Epic** + child Stories/Tasks |
| Single task sufficient | **One** Story, Task, or Bug — no Epic |
| Bug fix (one task) | Bug in affected domain; label `Bug` |
| User provides `SB-N` draft issue | **Enrich mode** — add AC, spec refs, files, tests, children |
| User says "don't create Jira issues" | Skip MCP; optionally draft markdown plan only |

**Ask before creating** if fix version, priority, owning domain, or product rules are unclear.

## Board constants (resolve once per session)

```text
MCP server: plugin-atlassian-atlassian
cloudId: mdg-labs.atlassian.net
projectKey: SB
Ready transition id: 2
```

Custom fields — see [jira-board.md](../orchestrator/jira-board.md):

| Field | ID | Notes |
|---|---|---|
| Domain | `customfield_10081` | **Required.** Frontend `10092`, Backend `10093`, Infrastructure `10094`, Operations `10095` |
| Roadmap ID | `customfield_10082` | When mirroring plan-file `P*-*` |
| Legacy Key | `customfield_10083` | Leave empty on greenfield SB issues |

Fix versions: `MVP Alpha`, `Public Launch v1.0.0`.

## Issue summaries

Every `createJiraIssue` and enrich-mode `editJiraIssue` must follow [summary-patterns.md](../jira-triage/summary-patterns.md):

| Issue type | Pattern | Example |
|---|---|---|
| Epic | `{Feature name}` | `Server-side session infrastructure` |
| Story | `{User-visible outcome}` | `Redirect to bookmark destination via /go/<slug>` |
| Task | `{Verb} {target}` | `Add SSRF-safe egress service for metadata fetch` |
| Bug | `{Area}: {observed defect}` | `Slugs: collision page shown for unambiguous slug` |

Apply **rewrite vs keep** rules when enriching — rewrite vague drafts; keep summaries that already match.

## Dual mode

### Mode A — Create net-new

User describes a feature with no existing Jira key.

### Mode B — Enrich existing

User names `SB-N` or pastes a Jira URL. Fetch with `getJiraIssue`, **merge** structured sections into description via `editJiraIssue`. Rewrite summary when vague. Add children if scope grew. Do not wipe user prose.

## Domain routing

| Domain value | Scope |
|---|---|
| Frontend | Web client, React, UI, command palette, dashboard, i18n |
| Backend | API, auth, sessions, bookmarks/slugs/folders/tags/workspaces, entitlements, billing, admin |
| Infrastructure | Database, container, CI/CD, TLS/proxy, deployment, monitoring |
| Operations | Launch, marketing site, docs, billing operations, self-hosted runbooks |

**Epic** gets the **owning** domain. Each child gets its own — a Frontend epic may have Backend and Infrastructure children.

## Issue type mapping

| Work | Jira type |
|---|---|
| Epic parent (2+ tasks) | Epic |
| Feature leaf | Story |
| Bug | Bug |
| Chore / DX / spike | Task |

## Workflow

### 1. Understand the request

1. Read relevant spec sections (`spec §N` from [doc-index.md](../orchestrator/doc-index.md)) — cite `§` refs in descriptions.
2. Search the codebase for patterns / file paths.
3. `searchJiraIssuesUsingJql` for duplicates and related Done work.
4. Split into **leaf issues** — each independently implementable and verifiable.

### 2. Draft plan — show user before MCP writes

```markdown
## Proposed Jira structure

**Epic:** SB-?? — Server-side session infrastructure → Domain: Backend → fix: MVP Alpha
**Children:**

| Key | Domain | Type | Summary | Depends on |
|---|---|---|---|---|
| SB-?? | Backend | Task | Implement session store with configurable TTL | — |
| SB-?? | Backend | Task | Add workspace-context middleware to session | SB-?? |
| SB-?? | Frontend | Story | Show active workspace in nav and workspace switcher | SB-?? |

**Implementation order:** …
**Open questions:** …
**Spec refs:** spec §5.3 (sessions), spec §4.3 (workspace resolution), spec §2.5 (multi-tenant)
```

Wait for approval unless the user said "create the issues now".

### 3. Create Epic (Mode A only)

```text
createJiraIssue
  cloudId: mdg-labs.atlassian.net
  projectKey: SB
  issueTypeName: Epic
  summary: "Server-side session infrastructure"
  description: <epic template — templates.md>
  additional_fields:
    priority: { name: "High" }
    labels: ["Feature"]
    customfield_10081: { id: "10093" }   # Domain: Backend
    fixVersions: [{ name: "MVP Alpha" }]
```

Record returned issue key (e.g. `SB-8`).

### 4. Create children (Mode A) or enrich + add children (Mode B)

```text
createJiraIssue
  issueTypeName: Story | Task | Bug
  summary: "Redirect to bookmark destination via /go/<slug>"
  parent: SB-8
  description: <subtask template>
  additional_fields:
    customfield_10081: { id: "10093" }   # Domain: Backend
    fixVersions: [{ name: "MVP Alpha" }]
    labels: ["Feature"]
```

Mode B enrich — when summary needs rewrite:

```text
editJiraIssue
  issueIdOrKey: SB-N
  fields:
    description: "<merged markdown>"
    summary: "Go: redirect resolves slug within active workspace context"
  contentFormat: markdown
```

### 5. Dependencies

```text
createIssueLink
  cloudId: mdg-labs.atlassian.net
  linkType: "Depends"
  inwardIssue: SB-9    # prerequisite (is required by …)
  outwardIssue: SB-10  # dependent (depends on …)
```

Use **`Depends`** for new links (link type id `10006`). Also document **Depends on** in each leaf description with browse URLs.

### 6. Finalize Epic description

`editJiraIssue` on the Epic — **Subtasks table** with every child key, domain, one-line scope, browse URLs, and **Suggested implementation order**. Include relevant spec `§` refs.

### 7. Transition to Ready

Intake stops at **Ready** — not In Progress or Done.

```text
transitionJiraIssue
  issueIdOrKey: <each created/enriched leaf + epic>
  transition: { id: "2" }    # Ready
```

## Description rules

- **Epic:** context from spec, subtask table, suggested order, product rules (cite `spec §N`). Subtasks hold the implementable AC.
- **Leaf:** parent epic link, Depends on, spec refs, technical sections, AC checklist, Files, Tests.
- Use **Markdown** in descriptions (`contentFormat: markdown`).

## Sizing guidelines

| Good leaf | Too big — split |
|---|---|
| One migration + one schema entity | "All backend auth changes" |
| One API surface if tightly coupled | Entire feature in one story |
| One UI flow or one component | "All auth UI" |

## After creation — handoff

```markdown
Created on Jira SB:

- Epic: https://mdg-labs.atlassian.net/browse/SB-8
- SB-9 … / SB-11 … (all leaf URLs)

Suggested order: SB-9 → SB-10 → SB-11
Ready for orchestrator: "implement SB-11" or "orchestrate SB-8 epic"
```

## MCP checklist

```
- [ ] Read MCP tool schemas under mcps/plugin-atlassian-atlassian/tools/
- [ ] searchJiraIssuesUsingJql (avoid duplicates)
- [ ] User approved breakdown (unless "create now")
- [ ] Summaries follow summary-patterns.md (Epic + leaves)
- [ ] createJiraIssue (Epic) OR getJiraIssue + editJiraIssue (enrich + summary when vague)
- [ ] createJiraIssue × N (children)
- [ ] createIssueLink (blocking edges)
- [ ] editJiraIssue epic (subtask table + order + spec refs)
- [ ] transitionJiraIssue → Ready on epic + leaves
- [ ] Report URLs + suggested order
```

## Forbidden

- Setting In Progress or Done during intake
- Inventing product behaviour not in spec docs — ask first
- Pasting secrets into issue descriptions
- Creating a multi-task feature without an Epic parent
- Omitting Domain (`customfield_10081`) — it is **required** on all SB issues
- Omitting fix version on feature work without user approval
- Vague summary placeholders when pattern table applies
- Referencing "organization", "favorites", "collection" — use canonical vocabulary (spec §3, rule `04-naming.mdc`)
