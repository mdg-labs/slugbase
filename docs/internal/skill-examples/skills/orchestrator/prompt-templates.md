# Orchestrator — Sub-Agent Prompt Templates

Copy and fill. Sub-agents do not see the orchestrator chat.

When an issue is tracked on Jira, orchestrator includes **role-specific** JIRA SYNC blocks (see [jira-board.md](jira-board.md)):

- **Execution prompts:** In Progress only — no `transitionIdDone`; include epic parent key when dispatching a child (epic → In Progress with the leaf); **time tracking + worklog** before In Review
- **Verifier prompts:** Done (+ optional epic on final child); **mandatory Done/FAIL Jira comment**; **time tracking + worklog** before Done/Ready

Sub-agents perform Jira transitions — not the orchestrator.

**Every execution prompt** (Lane S, Lane P, Jira, chat) **must** include the **PRISMA MIGRATIONS** block below — copy verbatim even when the task has no schema changes (agents must know the rule).

When the prompt includes **JIRA SYNC**, also include the **JIRA TIME TRACKING** block below (omit when no Jira issue is in the prompt).

---

## PRISMA MIGRATIONS — execution agents (mandatory block)

Copy this block into **every** execution agent prompt without omission:

```text
PRISMA MIGRATIONS — MANDATORY (schema-first; no exceptions):
- Contract: apps/backend/prisma/schema.prisma — if it is not in the schema, it does not exist
- DB change workflow (ONLY this order):
  1. Edit schema.prisma
  2. Generate migration: infisical run --env=development -- pnpm migrate:dev --name <snake_case_description>
  3. Commit schema.prisma + the Prisma-generated migration directory together
- FORBIDDEN — immediate FAIL / blocked if attempted:
  - Hand-writing migration.sql or any SQL under apps/backend/prisma/migrations/
  - Creating migration directories by hand (including round timestamps like 20260522120000)
  - Editing or renaming Prisma-generated migration files after creation
  - Using prisma db push instead of migrate:dev for schema changes
  - Schema changes without a corresponding Prisma-generated migration in the same commit
- If migrate:dev cannot run (DB down, shadow DB, env missing) → report blocked; do NOT hand-write SQL as a workaround
- Rule reference: .cursor/rules/prisma.mdc
```

---

## JIRA TIME TRACKING — sub-agents (mandatory when JIRA SYNC present)

Copy into **execution and verifier** prompts whenever the orchestrator included a JIRA SYNC block. Omit when no Jira issue is in the prompt.

```text
JIRA TIME TRACKING (mandatory when JIRA SYNC block is present):
- Session memory: record wall-clock start and end — see .cursor/skills/orchestrator/jira-board.md § Time tracking
- Execution Phase 1: set header started: <ISO 8601 UTC> immediately after Jira In Progress
- Execution pre-handoff: set header ended + duration; add ## Time tracking section with worklog details
- Verifier: after reading session memory, add ## Verification timing with started; set ended + duration pre-handoff
- Jira worklog (before status handoff):
  CallMcpTool plugin-atlassian-atlassian / addWorklogToJiraIssue
    cloudId: mdg-labs.atlassian.net
    issueIdOrKey: <each LEAF key from JIRA SYNC — not epic parent>
    timeSpent: "<Jira format e.g. 1h 30m>"
    started: "<started ISO from session memory>"
    commentBody: "Execution (<SESSION-ID>)" | "Verification (<SESSION-ID>)"
    contentFormat: markdown
- Combined batch: split duration evenly across leaf keys; document split in session memory
- Execution handoff order: local memory ended → worklog → transition In Review → single implementation commit (no session files in git)
- Verifier handoff order: local memory ended → worklog → Jira Done/FAIL comment → status transition (never commit session files)
- Round duration to nearest minute; minimum 1m if any work occurred
- Skip only when JIRA SYNC was omitted or user opted out of Jira updates
```

---

## Execution agent — Lane S (serial on staging, plan-file mode)

```text
MODE: plan-file
LANE: S
TARGET REPO: /home/michael/projects/dispatch-one
WORK BRANCH: staging
PLAN FILE: /home/michael/projects/dispatch-one/docs/dispatch-one-development-roadmap.md
TASK ID: <e.g. P0-03>
SESSION ID: <TASK-ID>-<YYYYMMDD>-<4hex>

JIRA SYNC — EXECUTION (include when issue is on Jira DO project — omit if none):
- MCP server: plugin-atlassian-atlassian
- cloudId: mdg-labs.atlassian.net
- transitionIdInProgress: <uuid>
- issues: [{ key: DO-47 }, …]
- epic (when subtask): { key: DO-21 }   # parent — In Progress with leaves
- FIRST ACTION: CallMcpTool transitionJiraIssue → transitionIdInProgress for each leaf key AND epic key (if listed) BEFORE session memory
- FORBIDDEN: transitionJiraIssue with Done; addCommentToJiraIssue; epic Done
- Reference: .cursor/skills/orchestrator/jira-board.md

SESSION MEMORY:
- Path: /home/michael/projects/dispatch-one/.cursor/skills/agent-memory/active/<SESSION-ID>.md
- After Jira In Progress (if JIRA SYNC present): PHASE 1 create file; header + Task; set started: <ISO 8601 UTC>
- PHASE 2: update Scope, Decisions, Doc deviations in place
- PHASE 3: finalize all sections locally (never commit session memory)
- Pre-handoff (if JIRA SYNC): set ended + duration in local file; worklog; then In Review; single implementation commit
- Retry after FAIL: read existing file (especially VERIFICATION FAILED); overwrite with fresh entry

PLAN REFERENCE:
- Read full task row from PLAN FILE (status, deps, acceptance criteria, tests, doc refs)

DOC REFERENCE (read these — do not receive pasted content):
- <e.g. impl-spec §4, schema Player model, testing §6.4>
- Index: /home/michael/projects/dispatch-one/.cursor/skills/orchestrator/doc-index.md

GIT:
- Work on branch `staging`. If not on staging, stop and report blocked.
- One commit: implementation task files only (session memory is gitignored — never staged)
- Stage explicit paths only (`git add <path> …`). Never `git add .` or `-A`. Never stage `.cursor/skills/agent-memory/**`.
- Never push unless the user explicitly requested push in this orchestration run.
- Commit messages: `feat(<area>)[DO-123]: <summary>` or `fix(<area>)[P2-01]: <summary>` (roadmap-only). Subject ≤72 chars. No Smart Commit `#time` / `#comment` — MCP only. See `07-jira-commit-linking.mdc`.

SECRETS / COMMANDS:
- Local tests/dev that need env: `infisical run --env=development -- <command>`
- Do not commit `.env` or secret exports

PRISMA MIGRATIONS — MANDATORY (schema-first; no exceptions):
- Contract: apps/backend/prisma/schema.prisma — if it is not in the schema, it does not exist
- DB change workflow (ONLY this order):
  1. Edit schema.prisma
  2. Generate migration: infisical run --env=development -- pnpm migrate:dev --name <snake_case_description>
  3. Commit schema.prisma + the Prisma-generated migration directory together
- FORBIDDEN — immediate FAIL / blocked if attempted:
  - Hand-writing migration.sql or any SQL under apps/backend/prisma/migrations/
  - Creating migration directories by hand (including round timestamps like 20260522120000)
  - Editing or renaming Prisma-generated migration files after creation
  - Using prisma db push instead of migrate:dev for schema changes
  - Schema changes without a corresponding Prisma-generated migration in the same commit
- If migrate:dev cannot run (DB down, shadow DB, env missing) → report blocked; do NOT hand-write SQL as a workaround
- Rule reference: .cursor/rules/prisma.mdc

READ SCOPE:
- PLAN FILE
- DOC REFERENCE paths above
- Session memory path (active)
- <implementation paths needed>

WRITE SCOPE:
- <implementation paths, one per line> (never `.cursor/skills/agent-memory/**`)

DO NOT TOUCH:
- `.cursor/skills/agent-memory/**` (gitignored)
- <paths or none>

ACCEPTANCE CRITERIA (must all pass):
- <verbatim from plan row>

REQUIRED OUTPUT:
1. Jira In Progress confirmation (leaf + epic keys updated, or skipped + why)
2. Session timing: started, ended, duration (or n/a if no JIRA SYNC)
3. Jira worklog: leaf keys + timeSpent logged (or skipped + why)
4. Summary (≤5 bullets)
5. Changed files (absolute paths)
6. Implementation commit: SHA + message + committed paths (or "no commit" + why)
7. Plan checkbox: `[~]` only if PLAN FILE in WRITE SCOPE; never `[x]`
8. Implementation status: complete | blocked | partial + reason (NOT Jira Done — verifier sets that)
9. Blockers or scope deviations
```

---

## Execution agent — Lane P (parallel isolated, plan-file mode)

Use subagent type **`best-of-n-runner`**. Orchestrator sets **`run_in_background: true`** when dispatching multiple Lane P tasks.

```text
MODE: plan-file
LANE: P
TARGET REPO: /home/michael/projects/dispatch-one
WORK BRANCH: orchestrator/<TASK-ID>
WORKTREE: <subagent worktree path, e.g. ../dispatch-one-wt-<TASK-ID>>
STAGING_BASE_SHA: <pin — do not rebase onto staging>
BATCH_ID: <YYYYMMDD>-<4hex>
PLAN FILE: /home/michael/projects/dispatch-one/docs/dispatch-one-development-roadmap.md (READ ONLY)
TASK ID: <e.g. P3-05>
SESSION ID: <TASK-ID>-<YYYYMMDD>-<4hex>

JIRA SYNC — EXECUTION (include when issue is on Jira DO project — omit if none):
- Same block as Lane S execution template (In Progress only — no transitionIdDone; epic parent when subtask)
- FIRST ACTION: transitionJiraIssue → transitionIdInProgress for each leaf key AND epic key (if listed) BEFORE session memory

SESSION MEMORY:
- Path: /home/michael/projects/dispatch-one/.cursor/skills/agent-memory/active/<SESSION-ID>.md
- Same PHASE 1/2/3 + timing rules as Lane S (started at Phase 1; ended + worklog pre-handoff when JIRA SYNC present)
- Retry after FAIL: read existing file (especially VERIFICATION FAILED); overwrite with fresh entry

PLAN REFERENCE:
- Read full task row from PLAN FILE (status, deps, acceptance criteria, tests, doc refs)

DOC REFERENCE (read these — do not receive pasted content):
- <e.g. impl-spec §4, schema Player model, testing §6.4>
- Index: /home/michael/projects/dispatch-one/.cursor/skills/orchestrator/doc-index.md

GIT:
- All work in WORKTREE on WORK BRANCH only.
- Branch from STAGING_BASE_SHA. Never checkout, merge, or commit to `staging`.
- One commit on WORK BRANCH: implementation task files only (session memory gitignored)
- Stage explicit paths only. Never `git add .` or `-A`.
- Never push unless the user explicitly requested push in this orchestration run.
- If git status shows changes outside WRITE SCOPE → blocked.
- Commit messages: `feat(<area>)[DO-123]: <summary>` or `fix(<area>)[P2-01]: <summary>` (roadmap-only). Subject ≤72 chars. No Smart Commit `#time` / `#comment` — MCP only. See `07-jira-commit-linking.mdc`.

PLAN FILE:
- READ ONLY. Do not set `[~]`, `[x]`, or `[!]`.

SECRETS / COMMANDS:
- Local tests/dev that need env: `infisical run --env=development -- <command>`
- Do not commit `.env` or secret exports

PRISMA MIGRATIONS — MANDATORY (schema-first; no exceptions):
- Contract: apps/backend/prisma/schema.prisma — if it is not in the schema, it does not exist
- DB change workflow (ONLY this order):
  1. Edit schema.prisma
  2. Generate migration: infisical run --env=development -- pnpm migrate:dev --name <snake_case_description>
  3. Commit schema.prisma + the Prisma-generated migration directory together
- FORBIDDEN — immediate FAIL / blocked if attempted:
  - Hand-writing migration.sql or any SQL under apps/backend/prisma/migrations/
  - Creating migration directories by hand (including round timestamps like 20260522120000)
  - Editing or renaming Prisma-generated migration files after creation
  - Using prisma db push instead of migrate:dev for schema changes
  - Schema changes without a corresponding Prisma-generated migration in the same commit
- If migrate:dev cannot run (DB down, shadow DB, env missing) → report blocked; do NOT hand-write SQL as a workaround
- Rule reference: .cursor/rules/prisma.mdc

READ SCOPE:
- PLAN FILE (read only)
- DOC REFERENCE paths above
- Session memory path (active)
- <implementation paths needed>

WRITE SCOPE:
- Session memory path (active)
- <implementation paths, one per line>

DO NOT TOUCH:
- PLAN FILE
- `staging` branch
- <paths outside task scope>

ACCEPTANCE CRITERIA (must all pass):
- <verbatim from plan row>

REQUIRED OUTPUT:
1. Jira In Progress confirmation
2. Session timing + Jira worklog (or n/a)
3. Summary (≤5 bullets)
4. Worktree path + branch name
5. Changed files (absolute paths)
6. Implementation commit: SHA + message + committed paths (or "no commit" + why)
7. Implementation status: complete | blocked | partial + reason (NOT Jira Done — verifier sets that)
8. Blockers or scope deviations
```

---

## Execution agent (chat mode)

Same as Lane S or Lane P except: no plan checkbox update; TASK from orchestrator todo; acceptance criteria copied into prompt.

**Must include the PRISMA MIGRATIONS — MANDATORY block** (see above) in every chat-mode execution prompt.

---

## Execution agent — Jira mode (Lane S on staging)

Use when the user names a Jira issue key (`DO-47`), URL, or epic child. Orchestrator loads AC from MCP; sub-agent **must** sync Jira status.

```text
MODE: Jira
LANE: S
TARGET REPO: /home/michael/projects/dispatch-one
WORK BRANCH: staging
ISSUE KEY: <e.g. DO-47>   # or multiple keys for combined batch
SESSION ID: <ISSUE-KEY>-<YYYYMMDD>-<4hex>
EPIC: <parent key e.g. DO-21 or none>

JIRA SYNC — EXECUTION (mandatory unless user opted out):
- MCP server: plugin-atlassian-atlassian
- cloudId: mdg-labs.atlassian.net
- issues:
  - key: DO-47
  # combined batch: list DO-24, DO-25, DO-26 each with key
- epic (when EPIC header is not "none"):
  - key: DO-21
- transitionIds:
  - "In Progress": 21
  - "In Review": 31

JIRA — EXECUTION (first action, before session memory):
1. transitionJiraIssue → "In Progress" for EVERY leaf key AND epic key (if listed)
2. If any transition fails → blocked; do not proceed
3. Report leaf + epic keys set In Progress in REQUIRED OUTPUT
4. FORBIDDEN: transition to Done; addCommentToJiraIssue; epic Done before verifier

JIRA — EXECUTION (pre-handoff, after implementation):
1. Local session memory: set ended + duration in header and ## Time tracking
2. addWorklogToJiraIssue on each LEAF key (not epic)
3. transitionJiraIssue → "In Review" for leaf key only
4. Single implementation commit — task files only (never commit session memory)

Reference: .cursor/skills/orchestrator/jira-board.md

SESSION MEMORY:
- Path: /home/michael/projects/dispatch-one/.cursor/skills/agent-memory/active/<SESSION-ID>.md
- PHASE 1/2/3 after Jira In Progress; set started at Phase 1
- Pre-handoff: ended + duration + worklog per jira-board.md
- Combined batch: document all keys in Task section

JIRA REFERENCE (orchestrator extracted — not full description body):
- Summary, parent epic, dependencies satisfied

DOC REFERENCE (read these — do not receive pasted content):
- <paths + § from issue description>
- Index: .cursor/skills/orchestrator/doc-index.md

GIT:
- Branch staging; one implementation commit; explicit git add only; never stage `.cursor/skills/agent-memory/**`
- Commit messages: `feat(<area>)[DO-123]: <summary>` — `[ISSUE-KEY]` required. No Smart Commit commands. See `07-jira-commit-linking.mdc`.
- Full local CI gate before implementation commit
- infisical run --env=development -- when env required

PRISMA MIGRATIONS — MANDATORY (schema-first; no exceptions):
- Contract: apps/backend/prisma/schema.prisma — if it is not in the schema, it does not exist
- DB change workflow (ONLY this order):
  1. Edit schema.prisma
  2. Generate migration: infisical run --env=development -- pnpm migrate:dev --name <snake_case_description>
  3. Commit schema.prisma + the Prisma-generated migration directory together
- FORBIDDEN — immediate FAIL / blocked if attempted:
  - Hand-writing migration.sql or any SQL under apps/backend/prisma/migrations/
  - Creating migration directories by hand (including round timestamps like 20260522120000)
  - Editing or renaming Prisma-generated migration files after creation
  - Using prisma db push instead of migrate:dev for schema changes
  - Schema changes without a corresponding Prisma-generated migration in the same commit
- If migrate:dev cannot run (DB down, shadow DB, env missing) → report blocked; do NOT hand-write SQL as a workaround
- Rule reference: .cursor/rules/prisma.mdc

READ / WRITE SCOPE / DO NOT TOUCH / AC / TESTS: <orchestrator fills>

REQUIRED OUTPUT:
1. Jira In Progress: leaf + epic keys updated (or blocked reason)
2. Session timing: started, ended, duration
3. Jira worklog: leaf keys + timeSpent (or blocked reason)
4. Jira In Review confirmation
5. Summary (≤5 bullets)
6. Changed files (absolute paths)
7. Implementation commit: SHA + message + paths
8. Implementation status: complete | blocked | partial (NOT Jira Done)
9. Blockers or scope deviations
```

Combined batch (DO-24/25/26): one prompt, all leaf keys + epic parent In Progress at start; verifier sets Done on PASS.

Orchestrator: resolve epic parent via `getJiraIssue` / JQL `parent = DO-N` and include epic in every child execution prompt.

## Verification agent — Jira mode (Lane S)

Same three layers as plan-file Lane S verifier. **Verifier** owns Jira Done / FAIL comment.

```text
MODE: Jira
LANE: S — verification
PLAN FILE: DO NOT EDIT

JIRA SYNC — VERIFIER (mandatory unless user opted out):
- Same cloudId and issues list as execution prompt; orchestrator adds transitionIdDone here (execution prompt never had it)
- epic (optional): include epic key if this completes the epic

JIRA — VERIFIER (after verification verdict):
PASS all layers:
1. Local session memory: set verification ended + duration; worklog on each LEAF key
2. addCommentToJiraIssue — mandatory Done summary (jira-board.md § Verifier Done comment)
3. CallMcpTool transitionJiraIssue → transitionIdDone for EVERY leaf key
4. If epic key listed → transitionJiraIssue epic → Done
5. Optionally delete local active file or move to local archive/ (never commit)

FAIL any layer:
1. Local session memory: set verification ended + duration; worklog on each LEAF key
2. addCommentToJiraIssue — mandatory FAIL template (layer failures + fix hints)
3. Append VERIFICATION FAILED to local active/ if file exists (never commit)
4. transitionJiraIssue → Ready; do NOT set Done

Reference: .cursor/skills/orchestrator/jira-board.md

<standard verifier fields: SESSION ID, EXECUTION COMMITS, AC, LAYER 1/2/3>

WRITE SCOPE:
- PLAN FILE (plan-file mode only: [x] or [!])
- DO NOT commit `.cursor/skills/agent-memory/**`

REQUIRED OUTPUT:
1. Layer 1/2/3 results
2. Overall PASS | FAIL
3. Verification timing + Jira worklog (or n/a)
4. Jira sync: keys → Done | Ready + mandatory comment + MCP call results
5. Issue list (≤10 bullets)
```

---

## Verification agent — Lane S (task verifier on staging)

```text
MODE: plan-file | chat | Jira
LANE: S
TARGET REPO: /home/michael/projects/dispatch-one
WORK BRANCH: staging
PLAN FILE: <path or n/a>
SESSION ID: <same as execution>

JIRA SYNC — VERIFIER (include when execution prompt had execution variant — omit if none):
- MCP server: plugin-atlassian-atlassian; cloudId: mdg-labs.atlassian.net; transitionIdDone; issues [{ key: DO-47 }]
- epic (optional): key if final subtask
- AFTER verdict: PASS → transitionJiraIssue Done for each key (+ epic if listed); FAIL → addCommentToJiraIssue, transition to Ready (not Done)
- See jira-board.md and "Verification agent — Jira mode" above

SESSION MEMORY (local, gitignored):
- FIRST ACTION: read active/<SESSION-ID>.md if it exists
- Missing file → use execution REQUIRED OUTPUT (impl SHA, paths, scope); blocked only if insufficient
- When JIRA SYNC present: set ## Verification timing started after reading memory or execution output
- Pre-handoff: ended + duration + worklog before Jira status transition
- PASS: mandatory Jira Done comment; optionally delete active or move to local archive/ (never commit)
- FAIL: mandatory Jira FAIL comment; append VERIFICATION FAILED in active/ if file exists (never commit)

EXECUTION COMMITS:
- task id: <id>
- implementation commit SHA: <sha>
- declared WRITE SCOPE: <paths>
- committed paths: <list>

ACCEPTANCE CRITERIA:
- <verbatim>

DOC REFERENCE (for Layer 3b):
- <same as execution task>

READ SCOPE:
- Session memory (active)
- Doc reference paths
- All paths in implementation commit
- TARGET REPO (run checks)

WRITE SCOPE:
- PLAN FILE (plan-file mode only: [x] or [!])
- DO NOT commit `.cursor/skills/agent-memory/**`

VERIFICATION:

LAYER 1 — Scope audit per implementation commit vs WRITE SCOPE
(Apply cross-cutting exception rules from SKILL.md)

LAYER 2 — Automated checks from TARGET REPO:
- test: <from plan row Tests column, else doc-index defaults>
- lint: pnpm lint (or n/a)
- typecheck: pnpm typecheck (or n/a)
Use: infisical run --env=development -- <command> when needed
Stop if Layer 2 fails.

LAYER 3 — Logic review:
3a. Each acceptance criterion — PASS/FAIL
3b. Doc contract — deviations with file:line + fix hint
3c. Stubs, TODO/FIXME, missing edge cases, placeholder values
3d. Prisma: hand-written migrations → FAIL (see .cursor/rules/prisma.mdc)

PLAN FILE (plan-file mode):
- PASS all layers → [x]; commit plan file only
- FAIL → [!] + note; commit plan file (mandatory)

REQUIRED OUTPUT:
1. Layer 1 result per commit
2. Layer 2 per check
3. Layer 3 breakdown
4. Overall PASS | FAIL
5. Verification timing + Jira worklog (or n/a)
6. Plan file update + SHA or skipped (plan-file mode only)
7. Jira sync: keys → Done | FAIL comment (+ MCP results), or n/a
8. Issue list (≤10 bullets)
```

---

## Branch verification agent — Lane P (per task, in worktree)

```text
MODE: plan-file | chat
LANE: P (branch verify)
TARGET REPO: /home/michael/projects/dispatch-one
WORK BRANCH: orchestrator/<TASK-ID>
WORKTREE: <path>
BATCH_ID: <id>
SESSION ID: <same as execution>

JIRA SYNC — VERIFIER (include when execution prompt had execution variant — omit if none):
- AFTER verdict on task branch: same rules as Lane S verifier (Done / FAIL comment)
- See jira-board.md

SESSION MEMORY (local, gitignored):
- FIRST ACTION: read active/<SESSION-ID>.md in WORKTREE if it exists
- Missing file → use execution REQUIRED OUTPUT; blocked only if insufficient
- When JIRA SYNC present: verification timing + worklog same as Lane S verifier
- PASS: mandatory Jira Done comment; optionally delete active or move to local archive/ (never commit)
- FAIL: mandatory Jira FAIL comment; append VERIFICATION FAILED in active/ if file exists (never commit)
- Do NOT edit PLAN FILE

EXECUTION COMMITS (on task branch):
- task id: <id>
- implementation commit SHA: <sha>
- branch tip SHA: <sha>
- declared WRITE SCOPE: <paths>
- committed paths: <list>

ACCEPTANCE CRITERIA:
- <verbatim>

DOC REFERENCE (for Layer 3b):
- <same as execution task>

READ SCOPE:
- Session memory (active) in worktree
- Doc reference paths
- All paths in implementation commit
- WORKTREE repo (run checks)

WRITE SCOPE:
- PLAN FILE: DO NOT TOUCH
- DO NOT commit `.cursor/skills/agent-memory/**`

VERIFICATION:
(Same Layer 1 / 2 / 3 as Lane S task verifier — run in WORKTREE)

REQUIRED OUTPUT:
1. Layer 1 result per commit
2. Layer 2 per check
3. Layer 3 breakdown
4. Overall PASS | FAIL
5. Verification timing + Jira worklog (or n/a)
6. Branch tip SHA for integration
7. Jira sync: keys → Done | FAIL comment (+ MCP results), or n/a
8. Issue list (≤10 bullets)
```

---

## Integration agent — Lane P

```text
MODE: integration
LANE: P
TARGET REPO: /home/michael/projects/dispatch-one
WORK BRANCH: staging
BATCH_ID: <id>
STAGING_BASE_SHA: <sha at batch start>
MERGE ORDER: <TASK-ID list, dependency order first>

BRANCH-PASS TASKS:
- <TASK-ID>: branch orchestrator/<TASK-ID> @ <tip SHA>
- ...

GIT:
- checkout staging
- For each branch-PASS task in MERGE ORDER:
    git merge --no-ff orchestrator/<TASK-ID> -m "chore(repo): integrate <TASK-ID> (<BATCH_ID>)"
- On first conflict → STOP; report conflict files; do not partial-merge
- Do not rewrite implementation commits
- Do not edit PLAN FILE
- Never push

READ SCOPE:
- staging
- branch tips listed above

WRITE SCOPE:
- staging (merge commits only)

DO NOT TOUCH:
- PLAN FILE
- branch-FAIL task branches
- implementation commit contents

REQUIRED OUTPUT:
1. Per-task merge result (merged | skipped-fail | conflict)
2. Final staging HEAD SHA
3. Conflict details if stopped
4. Status: done | blocked
```

---

## Staging batch verifier — Lane P (after integration)

```text
MODE: plan-file | chat
LANE: P (staging batch verify)
TARGET REPO: /home/michael/projects/dispatch-one
WORK BRANCH: staging
BATCH_ID: <id>
PLAN FILE: /home/michael/projects/dispatch-one/docs/dispatch-one-development-roadmap.md

TASK OUTCOMES:
- <TASK-ID>: branch-verify PASS, merged | branch-verify FAIL, not merged
- ...

INTEGRATION:
- final staging HEAD SHA: <sha>
- merge commits: <list>

READ SCOPE:
- PLAN FILE
- Branch verifier reports / Jira Done comments for integrated tasks
- staging repo

WRITE SCOPE:
- PLAN FILE (plan-file mode: [x] for integrated branch-PASS tasks; [!] for branch-FAIL tasks)

CHECKS:
1. Confirm branch verifiers reported Jira Done comments + worklogs for integrated tasks
2. Post-merge smoke (from repo root):
   - lint: pnpm lint
   - typecheck: pnpm typecheck
   Use: infisical run --env=development -- <command> when needed
3. If smoke fails or merge conflicts were reported → FAIL batch; do not mark [x]

PLAN FILE (plan-file mode):
- Integrated + branch-PASS → [x] per task; commit plan file
- Branch-FAIL (not merged) → [!] + note per task; commit plan file

REQUIRED OUTPUT:
1. Jira Done comment confirmation per integrated task (or orchestrator recovery note)
2. Smoke check results
3. Plan file updates + SHA
4. Overall batch PASS | FAIL
5. Issue list (≤10 bullets)
```

---

## Worktree cleanup agent — Lane P

```text
MODE: cleanup
LANE: P
TARGET REPO: /home/michael/projects/dispatch-one
BATCH_ID: <id>

TASKS:
- <TASK-ID>: worktree <path>, branch orchestrator/<TASK-ID>, merged: yes | no

ACTIONS:
- For merged tasks: git worktree remove <path>; git branch -d orchestrator/<TASK-ID>
- For branch-FAIL / not merged: report paths; do not delete unless orchestrator approved
- If worktree remove fails (dirty): report; do not force

REQUIRED OUTPUT:
1. Removed worktrees
2. Deleted branches
3. Skipped items + reason
```
