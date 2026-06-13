---
name: jira-intake
description: >-
  Create or enrich Dispatch One Jira issues from a feature description, codebase
  change, or user-drafted issue. Single Story/Task/Bug for small work; Epic +
  children for multi-task features. Dual mode: create net-new issues or enrich
  an existing DO-* issue. Stops at Ready. Use when the user describes a new
  feature, asks to plan or ticket work on Jira, flesh out a draft issue, or
  break a change into board tasks before implementation.
---

# Jira intake (Dispatch One)

Turn a feature request, codebase change, or rough Jira draft into **Ready** issues on project **DO**. Canonical example: [DO-21](https://mdg-labs.atlassian.net/browse/DO-21) (Superadmin player statistics portal epic).

Board sync for execution/verification: [orchestrator/jira-board.md](../orchestrator/jira-board.md). Description templates: [templates.md](templates.md). Summary patterns: [../jira-triage/summary-patterns.md](../jira-triage/summary-patterns.md).

## When to use

| User intent                            | Action                                           |
| -------------------------------------- | ------------------------------------------------ |
| Feature or change needing **2+ tasks** | **Epic** + child Stories/Tasks                   |
| Single task sufficient                 | **One** Story, Task, or Bug — no Epic            |
| Bug fix (one task)                     | Bug in affected domain; label `Bug`              |
| User provides `DO-N` draft issue       | **Enrich mode** — add AC, files, tests, children |
| User says "don't create Jira issues"   | Skip MCP; optionally draft markdown plan only    |

**Ask before creating** if fix version, priority, owning domain, or product rules are unclear.

## Board constants (resolve once per session)

```text
MCP server: plugin-atlassian-atlassian
cloudId: mdg-labs.atlassian.net
projectKey: DO
Ready transition id: 2
```

Custom fields — see [jira-board.md](../orchestrator/jira-board.md):

| Field      | ID                  | Notes                                                                         |
| ---------- | ------------------- | ----------------------------------------------------------------------------- |
| Domain     | `customfield_10048` | Frontend `10036`, Backend `10037`, Infrastructure `10038`, Operations `10039` |
| Legacy Key | `customfield_10044` | Empty on net-new issues                                                       |
| Roadmap ID | `customfield_10045` | When mirroring plan-file `P*-*`                                               |

Fix versions: `MVP Alpha`, `Closed Beta`, `Public Launch v1.0.0`.

## Issue summaries

Every `createJiraIssue` and enrich-mode `editJiraIssue` must follow [summary-patterns.md](../jira-triage/summary-patterns.md):

| Issue type | Pattern                     | Example                                             |
| ---------- | --------------------------- | --------------------------------------------------- |
| Epic       | `{Feature name}`            | `Routed return legs`                                |
| Story      | `{Player-visible outcome}`  | `Show routed ETA in dispatch vehicle picker`        |
| Task       | `{Verb} {target}`           | `Add Redis lock helper for spawn scheduler`         |
| Bug        | `{Area}: {observed defect}` | `Spawn: duplicate incidents when player reconnects` |

Apply **rewrite vs keep** rules from summary-patterns when enriching existing issues — rewrite vague drafts; keep summaries that already match the pattern.

## Dual mode

### Mode A — Create net-new

User describes a feature with no existing Jira key.

### Mode B — Enrich existing

User names `DO-N` or pastes a Jira URL. Fetch with `getJiraIssue`, **merge** structured sections into description via `editJiraIssue`. Rewrite **summary** when vague per [summary-patterns.md](../jira-triage/summary-patterns.md) (same rules as jira-triage); keep when already correct unless user asked for a specific title. Add child Stories/Tasks if scope grew. Do not wipe user prose — append/replace investigation-style sections only where templates apply.

## Domain routing

| Domain value   | Scope                                   |
| -------------- | --------------------------------------- |
| Frontend       | Next.js UI, i18n, client flows          |
| Backend        | NestJS REST/WS, Prisma, auth, engine    |
| Infrastructure | Fly, Neon, CI/CD, Infisical, monitoring |
| Operations     | Launch, legal, beta, runbooks           |

**Epic** gets the **owning** domain (usually Frontend for player-facing features). Each child gets its own domain — a Frontend epic may have Backend and Infrastructure children.

## Issue type mapping

| Work                   | Jira type |
| ---------------------- | --------- |
| Epic parent (2+ tasks) | Epic      |
| Feature leaf           | Story     |
| Bug                    | Bug       |
| Chore / DX / spike     | Task      |

## Workflow

### 1. Understand the request

1. Read relevant spec docs (`docs/dispatch-one-*.md`) — cite `§` sections in descriptions.
2. Search the codebase for patterns / file paths.
3. `searchJiraIssuesUsingJql` for duplicates and related Done work (`project = DO AND text ~ "..."` or `Legacy Key` lookup).
4. Split into **leaf issues** — each independently implementable and verifiable.

### 2. Draft plan — show user before MCP writes

```markdown
## Proposed Jira structure

**Epic:** DO-?? — Routed return legs → Domain: Backend → fix: Closed Beta
**Children:**

| Key   | Domain   | Type  | Summary                                    | Depends on |
| ----- | -------- | ----- | ------------------------------------------ | ---------- |
| DO-?? | Backend  | Story | Compute return-leg route on incident close | —          |
| DO-?? | Frontend | Story | Show routed ETA in dispatch vehicle picker | DO-??      |

**Implementation order:** …
**Open questions:** …
```

Wait for approval unless the user said "create the issues now".

### 3. Create Epic (Mode A only)

```text
createJiraIssue
  cloudId: mdg-labs.atlassian.net
  projectKey: DO
  issueTypeName: Epic
  summary: "Routed return legs"          # Epic pattern — no "(epic)" suffix
  description: <epic template — templates.md>
  additional_fields:
    priority: { name: "Medium" }
    labels: ["Feature"]
    customfield_10048: { id: "10036" }   # Domain option id
    fixVersions: [{ name: "Closed Beta" }]
```

Record returned issue key (e.g. `DO-78`).

### 4. Create children (Mode A) or enrich + add children (Mode B)

```text
createJiraIssue
  issueTypeName: Story | Task | Bug
  summary: "Show routed ETA in dispatch vehicle picker"   # Story pattern
  parent: DO-78                        # Epic key when applicable
  description: <subtask template>
  additional_fields:
    customfield_10048: { id: "10037" }
    fixVersions: [{ name: "Closed Beta" }]
    labels: ["Feature"]
```

Mode B enrich — when summary needs rewrite:

```text
editJiraIssue
  issueIdOrKey: DO-N
  fields:
    description: "<merged markdown>"
    summary: "Auth: refresh token not rotated on WebSocket reconnect"   # when vague draft
```

### 5. Dependencies

```text
createIssueLink
  linkType: "Depends"
  inwardIssue: DO-24    # prerequisite (is required by …)
  outwardIssue: DO-25   # dependent (depends on …)
```

Legacy migration links may still use `Blocks` (`inwardIssue` = blocker, `outwardIssue` = blocked). Prefer **`Depends`** for new links.

Also document **Depends on** in each leaf description with Jira browse URLs.

### 6. Finalize Epic description

`editJiraIssue` on the Epic — **Subtasks table** with every child key, domain, one-line scope, browse URLs, and **Suggested implementation order**.

### 7. Transition to Ready

Intake stops at **Ready** — not In Progress or Done.

```text
transitionJiraIssue
  issueIdOrKey: <each created/enriched leaf + epic>
  transition: { id: "2" }    # Ready — refresh via getTransitionsForJiraIssue if needed
```

Execution agents set **In Progress** when implementation starts (see jira-board.md).

## Description rules

- **Epic:** cross-cutting product rules, subtask table, suggested order. Subtasks hold implementable AC.
- **Leaf:** parent epic link, Depends on (Jira link + prose), technical sections, AC checklist, Files, Tests.
- Use **Markdown** in descriptions (Jira ADF via MCP handles conversion).
  _jira-intake note: commit suffixes use `[DO-47]` in subject (not trailing parens)._

## Sizing guidelines

| Good leaf                          | Too big — split                |
| ---------------------------------- | ------------------------------ |
| One migration + schema doc         | "All backend auth changes"     |
| One API surface if tightly coupled | Entire feature in one BE story |
| One UI flow                        | "All auth UI"                  |

## After creation — handoff

```markdown
Created on Jira DO:

- Epic: https://mdg-labs.atlassian.net/browse/DO-21
- DO-24 … / DO-26 … (all leaf URLs)

Suggested order: DO-24 → DO-27 → DO-26
Ready for orchestrator: "implement DO-26" or "orchestrate DO-21 epic"
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
- [ ] editJiraIssue epic (subtask table + order)
- [ ] transitionJiraIssue → Ready on epic + leaves
- [ ] Report URLs + suggested order
```

## Forbidden

- Setting In Progress or Done during intake
- Inventing product behaviour not in spec docs — ask first
- Pasting secrets into issue descriptions
- Creating a multi-task feature without an Epic parent
- Omitting Domain or fix version on feature work without user approval
- Vague summary placeholders when pattern table applies
