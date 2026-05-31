# SlugBase — Jira board reference

Orchestrator and **sub-agents** use this when a prompt includes a **JIRA SYNC** block.

## Project

| Field | Value |
|---|---|
| Project key | `SB` |
| Site | `mdg-labs.atlassian.net` |
| Issue URL | `https://mdg-labs.atlassian.net/browse/SB-N` (e.g. `SB-12`) |
| MCP server | `plugin-atlassian-atlassian` |
| `cloudId` | `mdg-labs.atlassian.net` (hostname — no UUID lookup needed) |

Orchestrator resolves transition IDs once per session via `getTransitionsForJiraIssue` and **passes them in prompts**. Sub-agents use values from the prompt; re-fetch only if `transitionJiraIssue` fails.

## Custom fields (SB — verified 2026-05-31)

| Field | Jira ID | Use |
|---|---|---|
| Domain | `customfield_10081` | Single-select (required on all issues): Frontend `10092`, Backend `10093`, Infrastructure `10094`, Operations `10095` |
| Roadmap ID | `customfield_10082` | Plan-file task ID when mirrored (`P2-01`) |
| Legacy Key | `customfield_10083` | Unused on greenfield SB issues; leave empty |

## Domain routing

| Domain value | Scope |
|---|---|
| Frontend | Web client, React, UI, command palette, dashboard, i18n |
| Backend | API, auth, sessions, bookmarks/slugs/folders/tags/workspaces, entitlements, billing, admin |
| Infrastructure | Database, container, CI/CD, TLS/proxy, deployment, monitoring |
| Operations | Launch, marketing site, docs, billing operations, self-hosted runbooks |

One Domain per issue. Cross-domain epics: Epic gets the **owning** domain; each child gets its own.

## Fix versions (SB — verified 2026-05-31)

| Name | Jira ID |
|---|---|
| `MVP Alpha` | `10035` |
| `Public Launch v1.0.0` | `10037` |

## Workflow statuses

```
Backlog → Ready → In Progress → In Review → Done
                ↓                          ↓
           Cancelled                   Cancelled
```

| Status | Who sets it | When |
|---|---|---|
| Backlog | Anyone (creation default) | Unrefined / deferred |
| Ready | **jira-intake** / **jira-triage** / orchestrator / user | Fully specified; orchestrator picks from here |
| In Progress | **Execution agent** | First action, before session memory |
| In Review | **Execution agent** | Last action before verifier handoff |
| Done | **Verifier** | After all layers PASS |
| Paused | Orchestrator / user | Blocked indefinitely |
| Cancelled | Orchestrator / user | Permanently abandoned |

**Planning skills → Ready:** `jira-intake` transitions epic + leaves to Ready after create/enrich. `jira-triage` transitions **Backlog → Ready** after successful triage (skips if already In Progress / In Review / Done).

### Failure path

Verifier FAIL → transition leaf back to **Ready** (not In Progress) + `addCommentToJiraIssue` with layer failures.

## Transition IDs (verified 2026-05-31 on SB-1)

Use `getTransitionsForJiraIssue` to refresh if transitions fail.

| Target status | Transition ID |
|---|---|
| Backlog | `11` |
| Ready | `2` |
| Paused | `4` |
| Cancelled | `3` |
| In Progress | `21` |
| In Review | `31` |
| Done | `41` |

## Status sync — sub-agent duties (mandatory)

Skip only when user said **"don't update Jira"** or prompt has no JIRA SYNC block.

### Execution agent — first action (before session memory)

```text
CallMcpTool plugin-atlassian-atlassian / transitionJiraIssue
  cloudId: mdg-labs.atlassian.net
  issueIdOrKey: <each leaf key>
  transition: { id: "<In Progress transition id from prompt>" }
```

- Combined batch: set **In Progress** on **every** listed leaf issue.
- **Epic parent:** when prompt lists epic key, transition epic **In Progress** in the **same first-action batch** as the leaf.
- If already In Progress or Done, continue (idempotent).
- If transition fails → `blocked`; do not start implementation.

### Execution agent — last actions (before verifier handoff)

When the prompt includes **JIRA SYNC**, perform these in order:

```text
1. Session memory (local): set ended + duration in header (wall-clock from started → now)
2. addWorklogToJiraIssue on each LEAF key (not epic parent) — see § Time tracking
3. transitionJiraIssue → "In Review" for leaf key only
   (epic stays In Progress unless implementing the epic shell itself)
4. Single implementation commit — task files only (session memory stays local, never committed)
```

### Verifier — before handoff (when JIRA SYNC present)

```text
1. Session memory: set verification ended + duration
2. addWorklogToJiraIssue on each LEAF key — commentBody: "Verification (<SESSION-ID>)"
3. Then apply PASS or FAIL transition below
```

### Verifier — after all layers PASS

```text
1. addCommentToJiraIssue — mandatory structured Done summary (see § Verifier Done comment)
2. transitionJiraIssue → "Done" for each leaf key
3. If epic key listed and this completes the epic → Done on epic too
4. Optionally delete local active/<SESSION-ID>.md or move to local archive/ (never commit)
```

### Verifier — on FAIL

```text
transitionJiraIssue → "Ready" for leaf key
addCommentToJiraIssue with Layer failures + fix hints (see § Verifier FAIL comment)
Do NOT set Done
(worklog from pre-handoff step still required)
Append VERIFICATION FAILED to local active/<SESSION-ID>.md if file exists (never commit)
```

## Verifier Done comment (mandatory on PASS)

Post via `addCommentToJiraIssue` on each **leaf** key before transitioning to Done. Use markdown.

```markdown
## Verified — <SESSION-ID>

**Commit:** `<sha>` — <subject one line>

### Summary

- <1–3 bullets: what shipped>

### Scope

- <key paths or areas touched>

### Automated checks

- lint: PASS | FAIL | n/a
- typecheck: PASS | FAIL | n/a
- <task-specific>: PASS | FAIL | n/a

### Operator follow-ups

- <items or "None">

### Deviations / open questions

- <items or "None">
```

## Verifier FAIL comment (mandatory on FAIL)

```markdown
## Verification failed — <SESSION-ID>

### Layers failed

- Layer 1: PASS | FAIL — <detail>
- Layer 2: PASS | FAIL — <detail>
- Layer 3: PASS | FAIL — <detail>

### Fix hints

- <file>:<line> — <expected per AC/doc>
```

## JIRA SYNC blocks (orchestrator copies into prompts)

Two variants — **never pass Done transition ID to execution agents**.

### Execution variant

```text
JIRA SYNC — EXECUTION (mandatory unless user opted out):
- MCP server: plugin-atlassian-atlassian
- cloudId: mdg-labs.atlassian.net
- issues:
  - key: SB-12          # leaf
  - key: SB-8           # Epic parent (when leaf is Epic child)
- transitionIds (from orchestrator session resolve):
  - "In Progress": 21
  - "In Review": 31
- FIRST ACTION: transitionJiraIssue → "In Progress" for EVERY listed key (leaf + epic) BEFORE session memory
- LAST ACTIONS (in order): local session memory ended/duration → addWorklogToJiraIssue (leaf keys) → transitionJiraIssue → "In Review" (leaf only) → single implementation commit (no session files)
- FORBIDDEN: transition to Done; addCommentToJiraIssue for verification outcomes; committing session memory files
- TIME TRACKING: mandatory — see § Time tracking below
- Reference: .cursor/skills/orchestrator/jira-board.md
```

### Verifier variant

```text
JIRA SYNC — VERIFIER (mandatory unless user opted out):
- MCP server: plugin-atlassian-atlassian
- cloudId: mdg-labs.atlassian.net
- issues:
  - key: SB-12          # leaf (In Review)
  - key: SB-8           # Epic — Done only if final child
- transitionIds:
  - "Done": 41
  - "Ready": 2          # FAIL path
- PRE-HANDOFF: local session memory verification ended/duration → addWorklogToJiraIssue (leaf keys)
- AFTER PASS: addCommentToJiraIssue (mandatory Done summary) → transitionJiraIssue → "Done" for leaf (+ epic if final child)
- AFTER FAIL: addCommentToJiraIssue (FAIL template) → transitionJiraIssue → "Ready"; do NOT set Done
- TIME TRACKING: mandatory — see § Time tracking below
- Reference: .cursor/skills/orchestrator/jira-board.md
```

## Time tracking (mandatory when JIRA SYNC is in prompt)

### Session memory

**Execution agents**

| When | Action |
|---|---|
| Phase 1 (right after In Progress) | Set `started: <ISO 8601 UTC>` in file header |
| Pre-handoff (after implementation) | Set `ended: <ISO 8601 UTC>` and `duration: <human>` in header |

**Verification agents**

| When | Action |
|---|---|
| First action (after reading active memory) | Add `## Verification timing` with `started: <ISO>` |
| Pre-handoff (after verdict) | Set `ended` and `duration` in that section |

### Jira worklog

Before handoff, call `addWorklogToJiraIssue` on each **leaf** issue key — **not** the epic parent.

```text
CallMcpTool plugin-atlassian-atlassian / addWorklogToJiraIssue
  cloudId: mdg-labs.atlassian.net
  issueIdOrKey: SB-12
  timeSpent: "1h 30m"
  started: "2026-05-31T00:00:00.000+0000"
  commentBody: "Execution (SB-12-20260531-a1b2)" | "Verification (...)"
  contentFormat: markdown
```

**Duration rules:** wall-clock from `started` → `ended`; round to nearest minute; minimum `1m`. Combined batch: split evenly; document split in session memory.

## Issue lookup (orchestrator)

| User says | MCP call |
|---|---|
| `SB-12`, Jira URL | `getJiraIssue` with `issueIdOrKey` |
| Epic children | `searchJiraIssuesUsingJql`: `project = "SB" AND parent = SB-N` |
| Ready queue | `searchJiraIssuesUsingJql`: `project = "SB" AND status = "Ready" ORDER BY priority DESC` |
| By domain | `project = "SB" AND status = "Ready" AND "Domain" = Backend ORDER BY priority DESC` |
| Prerequisites | JQL: `issue in linkedIssues("SB-12", "depends on")` |

## Epic pattern

SlugBase uses a 3-level hierarchy: **Epic = roadmap phase** → **Story = deliverable** → **Sub-task = commit-sized leaf**. A Story with no Sub-tasks is itself the leaf (an *atomic* Story).

```text
SB-8 (Epic — P3 Bookmarks, slugs, search & AI)
├── SB-30 (Story — Bookmark domain)                 ← atomic leaf (no subtasks)
├── SB-31 (Story — Slugs & /go)                      ← atomic leaf
└── SB-40 (Story — Auth UI)                          ← parent of subtasks
    ├── SB-41 (Sub-task — auth shell + sign-in)       ← leaf
    ├── SB-42 (Sub-task — MFA challenge screen)       ← leaf
    └── SB-43 (Sub-task — register + verify)          ← leaf
```

**Enumerate the leaf set for an epic** (the things to actually implement):

```jql
# Stories under the epic
project = "SB" AND parent = SB-8
# Sub-tasks under a parent Story (run once per Story that has children)
project = "SB" AND parent = SB-40
```

Leaf set = atomic Stories (no children) **+** all Sub-tasks. Batch leaves by `depends on` links + Lane.

- Implement **leaf** issues; pass each leaf key to execution + verifier prompts. A parent Story is never implemented directly — only its Sub-tasks.
- Epic **In Progress**: execution sets epic when any leaf starts; set the parent **Story** In Progress too when implementing one of its Sub-tasks.
- Epic **Done**: last leaf verifier marks the parent Story Done (when its last Sub-task passes) and the Epic Done (when its last Story passes) — or orchestrator recovery.

## MCP tools by role

| Tool | Orchestrator | Execution | Verifier |
|---|---|---|---|
| `searchJiraIssuesUsingJql` | Find work, deps | — | — |
| `getJiraIssue` | Load AC / description | — | — |
| `getTransitionsForJiraIssue` | Resolve IDs once | Re-fetch if fail | Re-fetch if fail |
| `transitionJiraIssue` | Recovery only | → In Progress; → In Review | → Done / Ready |
| `addWorklogToJiraIssue` | — | Pre-handoff (leaf keys) | Pre-handoff (leaf keys) |
| `addCommentToJiraIssue` | — | — | On FAIL (+ mandatory PASS) |
| `editJiraIssue` | — | — | — |
| `createIssueLink` | Intake skill | — | — |

## Standard JQL (orchestrator)

```jql
project = "SB" AND status = "Ready" ORDER BY priority DESC
project = "SB" AND status = "Ready" AND "Domain" = Backend ORDER BY priority DESC
project = "SB" AND parent = SB-8
project = "SB" AND status = "In Review"
project = "SB" AND status = "In Progress"
project = "SB" AND status = Ready AND comment ~ "VERIFICATION FAILED"
project = "SB" AND fixVersion = "MVP Alpha" AND status != Done
```
