# Dispatch One — Jira board reference

Orchestrator and **sub-agents** use this when a prompt includes a **JIRA SYNC** block.

## Project

| Field       | Value                                                       |
| ----------- | ----------------------------------------------------------- |
| Project key | `DO`                                                        |
| Site        | `mdg-labs.atlassian.net`                                    |
| Issue URL   | `https://mdg-labs.atlassian.net/browse/DO-N` (e.g. `DO-26`) |
| MCP server  | `plugin-atlassian-atlassian`                                |
| `cloudId`   | `mdg-labs.atlassian.net` (hostname — no UUID lookup needed) |

Orchestrator resolves transition IDs once per session via `getTransitionsForJiraIssue` and **passes them in prompts**. Sub-agents use values from the prompt; re-fetch transitions only if `transitionJiraIssue` fails.

## Custom fields (DO Team-Managed)

| Field      | Jira ID             | Use                                                                                          |
| ---------- | ------------------- | -------------------------------------------------------------------------------------------- |
| Domain     | `customfield_10048` | Single-select: Frontend `10036`, Backend `10037`, Infrastructure `10038`, Operations `10039` |
| Legacy Key | `customfield_10044` | Original t0ggles key (`FE-32`) on migrated issues; empty on net-new                          |
| Roadmap ID | `customfield_10045` | Plan-file task ID when mirrored (`P2-01`)                                                    |

## Domain routing

| Domain value   | Scope                                   |
| -------------- | --------------------------------------- |
| Frontend       | Next.js, React, i18n, UI, MapLibre      |
| Backend        | NestJS REST/WS, Prisma, auth, engine    |
| Infrastructure | Fly, Neon, CI/CD, Infisical, monitoring |
| Operations     | Launch, legal, beta, runbooks           |

One Domain per issue. Cross-domain epics: Epic gets **owning** domain; each child gets its own domain.

## Workflow statuses

```
Backlog → Ready → In Progress → In Review → Done
```

| Status      | Who sets it                                             | When                                          |
| ----------- | ------------------------------------------------------- | --------------------------------------------- |
| Backlog     | Anyone (creation default)                               | Unrefined / deferred                          |
| Ready       | **jira-intake** / **jira-triage** / orchestrator / user | Fully specified; orchestrator picks from here |
| In Progress | **Execution agent**                                     | First action, before session memory           |
| In Review   | **Execution agent**                                     | Last action before verifier handoff           |
| Done        | **Verifier**                                            | After all layers PASS                         |

**Planning skills → Ready:** [jira-intake](../jira-intake/SKILL.md) transitions epic + leaves to Ready after create/enrich. [jira-triage](../jira-triage/SKILL.md) transitions **Backlog → Ready** after successful triage (skips if already In Progress / In Review / Done). Both use shared summary patterns in [summary-patterns.md](../jira-triage/summary-patterns.md).

### Failure path

Verifier FAIL → transition leaf back to **Ready** (not In Progress) + `addCommentToJiraIssue` with layer failures.

## Transition IDs (resolved 2026-05-24 on DO-21)

Use `getTransitionsForJiraIssue` to refresh if transitions fail. Current stable IDs:

| Target status | Transition ID |
| ------------- | ------------- |
| Backlog       | `11`          |
| Ready         | `2`           |
| In Progress   | `21`          |
| In Review     | `31`          |
| Done          | `41`          |

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

If the prompt has **no JIRA SYNC block**, skip step 2; still record start/end in local session memory.

### Verifier — before handoff (when JIRA SYNC present)

After verdict, **before** status transition:

```text
1. Session memory: set verification ended + duration (see § Time tracking)
2. addWorklogToJiraIssue on each LEAF key — commentBody: "Verification (<SESSION-ID>)"
3. Then apply PASS or FAIL transition below
```

### Verifier — after all layers PASS

```text
1. addCommentToJiraIssue — mandatory structured Done summary (see § Verifier Done comment below)
2. transitionJiraIssue → "Done" for each leaf key
3. If epic key listed and this completes the epic → Done on epic too
4. Optionally delete local active/<SESSION-ID>.md or move to local archive/ (never commit)
```

(Worklog is posted once in the pre-handoff step above — do not duplicate on PASS.)

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

### Orchestrator role

- Resolve issue keys + transition IDs; include in every execution + verifier prompt.
- Confirm sub-agents report sync in REQUIRED OUTPUT.
- **Recovery only** if sub-agent skipped sync.

## JIRA SYNC blocks (orchestrator copies into prompts)

Use **two variants** — never pass Done transition ID to execution agents.

### Execution variant

```text
JIRA SYNC — EXECUTION (mandatory unless user opted out):
- MCP server: plugin-atlassian-atlassian
- cloudId: mdg-labs.atlassian.net
- issues:
  - key: DO-47          # leaf
  - key: DO-44          # Epic parent (when leaf is Epic child)
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
  - key: DO-47          # leaf (In Review)
  - key: DO-44          # Epic — Done only if final child
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

Applies to **execution** and **verification** sub-agents whenever the orchestrator prompt includes a JIRA SYNC block. Skip entirely when no Jira issue is in the prompt or the user opted out of Jira updates.

### Session memory

**Execution agents**

| When                               | Action                                                        |
| ---------------------------------- | ------------------------------------------------------------- |
| Phase 1 (right after In Progress)  | Set `started: <ISO 8601 UTC>` in file header                  |
| Pre-handoff (after implementation) | Set `ended: <ISO 8601 UTC>` and `duration: <human>` in header |

Header example:

```markdown
# Session: DO-47-20260524-a1b2

_task: DO-47 | started: 2026-05-24T14:02:00Z | ended: 2026-05-24T15:34:00Z | duration: 1h 32m | agent: execution_
```

Set `ended` and `duration` in the local file header before worklog handoff. Session files are never committed — timing lives in local memory and Jira worklogs only.

**Verification agents**

| When                                       | Action                                             |
| ------------------------------------------ | -------------------------------------------------- |
| First action (after reading active memory) | Add `## Verification timing` with `started: <ISO>` |
| Pre-handoff (after verdict)                | Set `ended` and `duration` in that section         |

### Jira worklog

Before handoff, call `addWorklogToJiraIssue` on each **leaf** issue key from the JIRA SYNC block — **not** the epic parent.

```text
CallMcpTool plugin-atlassian-atlassian / addWorklogToJiraIssue
  cloudId: mdg-labs.atlassian.net
  issueIdOrKey: DO-47
  timeSpent: "1h 32m"                    # Jira format: Nh, Nm, Nd, or combinations
  started: "2026-05-24T14:02:00.000+0000" # from session memory started
  commentBody: "Execution (DO-47-20260524-a1b2)"   # or "Verification (...)"
  contentFormat: markdown
```

**Duration rules**

- Wall-clock from session memory `started` → `ended`
- Round to nearest minute; minimum `1m` if any work occurred
- **Combined batch** (multiple leaf keys): split duration evenly across keys; document the split under `## Time tracking` in session memory

**Handoff order**

| Agent     | Order                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------- |
| Execution | local memory ended → worklog → In Review → single impl commit (no session files)                              |
| Verifier  | local memory ended → worklog → Done/FAIL Jira comment → Done or Ready → optional local archive (never commit) |

Orchestrator confirms worklog in REQUIRED OUTPUT; recovery via MCP only if sub-agent skipped it.

## Issue lookup (orchestrator)

| User says          | MCP call                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| `DO-47`, Jira URL  | `getJiraIssue` with `issueIdOrKey`                                                                              |
| Legacy key `FE-32` | `searchJiraIssuesUsingJql`: `project = "DO" AND "Legacy Key" ~ "FE-32"`                                         |
| Epic children      | `searchJiraIssuesUsingJql`: `project = "DO" AND parent = DO-44`                                                 |
| Ready queue        | `searchJiraIssuesUsingJql`: `project = "DO" AND status = "Ready" AND "Domain" = Backend ORDER BY priority DESC` |
| Prerequisites      | JQL: `issue in linkedIssues("DO-47", "depends on")` (preferred) or legacy `"is blocked by"` for Blocks links    |

## Epic pattern

Feature work with **2+ issues** uses Jira **Epic** issue type + child Story/Task/Bug under the same Epic (parent link).

```text
DO-21 (Epic — Superadmin portal)
├── DO-26, DO-27 (Frontend Tasks)
├── DO-24, DO-25 (Backend Tasks)
└── DO-28, DO-29 (Infrastructure Tasks)
```

- Implement **leaf** issues; pass each leaf key to execution + verifier prompts.
- Epic **In Progress**: execution sets epic when any subtask starts.
- Epic **Done**: last subtask verifier (or orchestrator recovery).
- **Creating new epics:** [jira-intake/SKILL.md](../jira-intake/SKILL.md).

## MCP tools by role

| Tool                         | Orchestrator          | Execution                  | Verifier                  |
| ---------------------------- | --------------------- | -------------------------- | ------------------------- |
| `searchJiraIssuesUsingJql`   | Find work, deps       | —                          | —                         |
| `getJiraIssue`               | Load AC / description | —                          | —                         |
| `getTransitionsForJiraIssue` | Resolve IDs once      | Re-fetch if fail           | Re-fetch if fail          |
| `transitionJiraIssue`        | Recovery only         | → In Progress; → In Review | → Done / Ready            |
| `addWorklogToJiraIssue`      | —                     | Pre-handoff (leaf keys)    | Pre-handoff (leaf keys)   |
| `addCommentToJiraIssue`      | —                     | —                          | On FAIL (+ optional PASS) |
| `editJiraIssue`              | —                     | —                          | —                         |
| `createIssueLink`            | Intake skill          | —                          | —                         |

## What orchestrator passes sub-agents (not paste)

1. **JIRA SYNC block** — execution or verifier variant
2. **Issue key** + acceptance criteria (verbatim bullets from description)
3. **Doc references** — `§` sections cited in description
4. **File paths** from Implementation notes
5. **Dependencies** and Tests sections

Do **not** paste full spec doc bodies or entire issue descriptions. Do **not** include Done transition ID in execution prompts.

## Roadmap vs Jira

|                      | Roadmap (`P*-*`)              | Jira (`DO-N`)                                        |
| -------------------- | ----------------------------- | ---------------------------------------------------- |
| Plan file checkboxes | Verifier                      | No (unless linked via Roadmap ID)                    |
| Board status         | No                            | Execution → In Progress → In Review; Verifier → Done |
| Commit subject key   | `[P2-01]` when no Jira mirror | `[DO-47]` — **required** on every task commit        |

Some roadmap tasks have a Jira mirror — set `Roadmap ID` custom field; use **`[DO-N]`** in commits (not `[P*-*]`). If orchestrator includes JIRA SYNC, sub-agents sync Jira even in plan-file mode.

## Commit → Jira Development panel

GitHub ↔ Jira links commits when the message contains an issue key (e.g. `DO-129`). Use bracket format:

```text
feat(web)[DO-129]: add Playwright auth fixture
```

**Do not** embed Smart Commit commands — worklog and transitions go through MCP only. See `.cursor/rules/07-jira-commit-linking.mdc` and [Smart Commits docs](https://support.atlassian.com/jira-software-cloud/docs/process-issues-with-smart-commits/) (issue-key linking only).

## Standard JQL (orchestrator)

```jql
project = "DO" AND status = "Ready" AND "Domain" = Backend ORDER BY priority DESC
project = "DO" AND parent = DO-21
project = "DO" AND status = "In Review"
project = "DO" AND status = "In Progress"
project = "DO" AND status = Ready AND comment ~ "VERIFICATION FAILED"
project = "DO" AND fixVersion = "Closed Beta" AND status != Done
```
