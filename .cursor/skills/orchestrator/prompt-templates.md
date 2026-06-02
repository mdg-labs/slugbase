# Orchestrator — Sub-agent prompt templates

Copy and fill. Sub-agents do not see the orchestrator chat.

When an issue is tracked on Jira, orchestrator includes **role-specific** JIRA SYNC blocks (see [jira-board.md](jira-board.md)):

- **Execution prompts:** In Progress only — no `transitionIdDone`; include epic parent key when dispatching a child; **time tracking + worklog** before In Review
- **Verifier prompts:** Done (+ optional epic on final child); **mandatory Done/FAIL Jira comment**; **time tracking + worklog** before Done/Ready

Sub-agents perform Jira transitions — not the orchestrator.

**Every execution and verifier prompt** must include the **NODE ENV** block below — copy verbatim even when the task has no pnpm commands (verifiers always run checks).

**Every execution prompt** (Lane S, Lane P, Jira, chat) **must** include the **DB MIGRATIONS** block below — copy verbatim even when the task has no schema changes.

When the prompt includes **JIRA SYNC**, also include the **JIRA TIME TRACKING** block.

---

## NODE ENV — sub-agents (mandatory before any pnpm/turbo)

Copy into **every execution and verifier** prompt. Prevents Cursor agent shells (Node 20) from breaking Astro/marketing and misleading Turbo cache.

```text
NODE ENV (mandatory — run from TARGET REPO before any pnpm/turbo/infisical command):
- Pin: .nvmrc = 22.12.0 (matches CI); engines >=22.12.0
- Wrapper (preferred): bash scripts/with-ci-env.sh <command> [args…]
- Examples:
    bash scripts/with-ci-env.sh pnpm lint
    bash scripts/with-ci-env.sh pnpm typecheck
    bash scripts/with-ci-env.sh pnpm test:unit
    bash scripts/with-ci-env.sh pnpm build
    bash scripts/with-ci-env.sh pnpm test:integration   # NO infisical wrapper on integration
    bash scripts/with-ci-env.sh infisical run --env=dev -- pnpm i18n:check:tolgee
- Alternative: source scripts/ci-env.sh once per shell, then run commands
- Sanity: bash scripts/with-ci-env.sh node -v  → must be v22.12.0+
- Docs: docs/local-development.md
- FORBIDDEN: bare pnpm/turbo from agent shell without with-ci-env (Node 20 false passes / Astro failures)
```

---

## DB MIGRATIONS — execution agents (mandatory block)

Copy this block into **every** execution agent prompt without omission:

```text
DB MIGRATIONS — MANDATORY (schema-first; no exceptions):
- The schema definition is the single source of truth. If it is not in the schema, it does not exist.
- DB change workflow (ONLY this order):
  1. Edit the Drizzle schema definition file
  2. Generate the migration with **Drizzle Kit** (`drizzle-kit generate`, typically wrapped as a `pnpm db:generate` script) — never hand-write SQL
  3. Commit the schema file + the Drizzle Kit-generated migration together
- FORBIDDEN — immediate FAIL / blocked if attempted:
  - Hand-writing migration SQL files
  - Creating migration directories by hand
  - Editing or renaming generated migration files after creation
  - Using `drizzle-kit push` / any "push"/"sync" command that bypasses the migration history
  - Schema changes without a corresponding generated migration in the same commit
- If Drizzle Kit cannot run (DB down, env missing) → report blocked; do NOT hand-write SQL as a workaround
- Stack note (settled, spec §11.9): migrations are owned by **Drizzle Kit** over the Postgres Drizzle schema (`dialect: postgresql`; `drizzle-kit generate` to create, `drizzle-kit migrate` to apply). One forward-only history; `DATABASE_URL` must use `postgresql://`. Embedded SQLite self-host is deferred (Fast-Follow).
```

---

## JIRA TIME TRACKING — sub-agents (mandatory when JIRA SYNC present)

Copy into **execution and verifier** prompts whenever the orchestrator included a JIRA SYNC block.

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
TARGET REPO: /home/michael/projects/slugbase
WORK BRANCH: staging
PLAN FILE: /home/michael/projects/slugbase/docs/slugbase-development-roadmap.md
TASK ID: <e.g. P1-03>
SESSION ID: <TASK-ID>-<YYYYMMDD>-<4hex>

JIRA SYNC — EXECUTION (include when issue is on Jira SB project — omit if none):
- MCP server: plugin-atlassian-atlassian
- cloudId: mdg-labs.atlassian.net
- transitionIdInProgress: 21
- issues: [{ key: SB-12 }, …]
- epic (when subtask): { key: SB-8 }   # parent — In Progress with leaves
- FIRST ACTION: CallMcpTool transitionJiraIssue → transitionIdInProgress for each leaf key AND epic key (if listed) BEFORE session memory
- FORBIDDEN: transitionJiraIssue with Done; addCommentToJiraIssue; epic Done
- Reference: .cursor/skills/orchestrator/jira-board.md

SESSION MEMORY:
- Path: /home/michael/projects/slugbase/.cursor/skills/agent-memory/active/<SESSION-ID>.md
- After Jira In Progress (if JIRA SYNC present): PHASE 1 create file; header + Task; set started: <ISO 8601 UTC>
- PHASE 2: update Scope, Decisions, Doc deviations in place
- PHASE 3: finalize all sections locally (never commit session memory)
- Pre-handoff (if JIRA SYNC): set ended + duration in local file; worklog; then In Review; single implementation commit
- Retry after FAIL: read existing file (especially VERIFICATION FAILED); overwrite with fresh entry

PLAN REFERENCE:
- Read full task row from PLAN FILE (status, deps, acceptance criteria, tests, doc refs)

DOC REFERENCE (read these — do not receive pasted content):
- <e.g. spec §5, spec §11.4, spec §16 Bookmark entity>
- Index: /home/michael/projects/slugbase/.cursor/skills/orchestrator/doc-index.md

GIT:
- Work on branch `staging`. If not on staging, stop and report blocked.
- One commit: implementation task files only (session memory is gitignored — never staged)
- Stage explicit paths only (`git add <path> …`). Never `git add .` or `-A`. Never stage `.cursor/skills/agent-memory/**`.
- Never push to `main`. When pushing is explicitly requested, target `staging` only.
- Commit messages: `feat(<scope>)[SB-N]: <summary>` or `fix(<scope>)[P*-*]: <summary>` (roadmap-only). Subject ≤72 chars. No Smart Commit `#time` / `#comment` — MCP only. See `07-jira-commit-linking.mdc`.

SECRETS / COMMANDS:
- Local tests/dev that need env: use Infisical (`infisical run --env=dev -- <cmd>`); see `05-env-vars.mdc`
- Do not commit `.env` or secret exports

DB MIGRATIONS — MANDATORY (schema-first; no exceptions):
- The schema definition is the single source of truth. If it is not in the schema, it does not exist.
- DB change workflow (ONLY this order):
  1. Edit the Drizzle schema definition file
  2. Generate the migration with Drizzle Kit (`drizzle-kit generate`)
  3. Commit schema file + the Drizzle Kit-generated migration together
- FORBIDDEN: hand-writing migration SQL, creating migration directories by hand, editing generated files, `drizzle-kit push`, schema changes without a migration in the same commit
- If Drizzle Kit cannot run → report blocked; do NOT hand-write SQL
- Stack note (settled): Drizzle Kit owns migrations (`drizzle-kit generate` / `migrate`); one forward-only history (spec §11.9)

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
TARGET REPO: /home/michael/projects/slugbase
WORK BRANCH: orchestrator/<TASK-ID>
WORKTREE: <subagent worktree path, e.g. ../slugbase-wt-<TASK-ID>>
STAGING_BASE_SHA: <pin — do not rebase onto staging>
BATCH_ID: <YYYYMMDD>-<4hex>
PLAN FILE: /home/michael/projects/slugbase/docs/slugbase-development-roadmap.md (READ ONLY)
TASK ID: <e.g. P2-05>
SESSION ID: <TASK-ID>-<YYYYMMDD>-<4hex>

JIRA SYNC — EXECUTION (include when issue is on Jira SB project — omit if none):
- Same block as Lane S execution template (In Progress only — no transitionIdDone; epic parent when subtask)
- FIRST ACTION: transitionJiraIssue → 21 for each leaf key AND epic key BEFORE session memory

SESSION MEMORY:
- Path: /home/michael/projects/slugbase/.cursor/skills/agent-memory/active/<SESSION-ID>.md
- Same PHASE 1/2/3 + timing rules as Lane S

PLAN REFERENCE:
- Read full task row from PLAN FILE (READ ONLY)

DOC REFERENCE (read these):
- <e.g. spec §6, spec §12>
- Index: /home/michael/projects/slugbase/.cursor/skills/orchestrator/doc-index.md

GIT:
- All work in WORKTREE on WORK BRANCH only.
- Branch from STAGING_BASE_SHA. Never checkout, merge, or commit to `staging` during Lane P execution.
- One commit on WORK BRANCH: implementation task files only
- Stage explicit paths only. Never `git add .` or `-A`.
- Never push.
- If git status shows changes outside WRITE SCOPE → blocked.
- Commit messages: `feat(<scope>)[SB-N]: <summary>`. Subject ≤72 chars. No Smart Commit. See `07-jira-commit-linking.mdc`.

PLAN FILE: READ ONLY. Do not set `[~]`, `[x]`, or `[!]`.

SECRETS / COMMANDS:
- Local tests/dev: use Infisical (`infisical run --env=dev -- <cmd>`); see `05-env-vars.mdc`
- Do not commit `.env` or secret exports

DB MIGRATIONS — MANDATORY (schema-first; no exceptions):
<copy verbatim DB MIGRATIONS block from above>

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
- `staging` branch (Lane P execution must not checkout staging — task branches only)
- <paths outside task scope>

ACCEPTANCE CRITERIA:
- <verbatim from plan row>

REQUIRED OUTPUT:
1. Jira In Progress confirmation
2. Session timing + Jira worklog (or n/a)
3. Summary (≤5 bullets)
4. Worktree path + branch name
5. Changed files (absolute paths)
6. Implementation commit: SHA + message + committed paths
7. Implementation status: complete | blocked | partial (NOT Jira Done)
8. Blockers or scope deviations
```

---

## Execution agent (chat mode)

Same as Lane S except: no plan checkbox update; TASK from orchestrator todo; acceptance criteria copied into prompt. **Must include the DB MIGRATIONS — MANDATORY block** in every chat-mode execution prompt.

---

## Execution agent — Jira mode (Lane S on staging)

Use when the user names a Jira issue key (`SB-12`), URL, or epic child.

```text
MODE: Jira
LANE: S
TARGET REPO: /home/michael/projects/slugbase
WORK BRANCH: staging
ISSUE KEY: <e.g. SB-12>
SESSION ID: <ISSUE-KEY>-<YYYYMMDD>-<4hex>
EPIC: <parent key e.g. SB-8 or none>

JIRA SYNC — EXECUTION (mandatory unless user opted out):
- MCP server: plugin-atlassian-atlassian
- cloudId: mdg-labs.atlassian.net
- issues:
  - key: SB-12
- epic (when EPIC header is not "none"):
  - key: SB-8
- transitionIds:
  - "In Progress": 21
  - "In Review": 31

JIRA — EXECUTION (first action, before session memory):
1. transitionJiraIssue → "In Progress" for EVERY leaf key AND epic key (if listed)
2. If any transition fails → blocked; do not proceed
3. FORBIDDEN: transition to Done; addCommentToJiraIssue; epic Done before verifier

JIRA — EXECUTION (pre-handoff, after implementation):
1. Local session memory: set ended + duration
2. addWorklogToJiraIssue on each LEAF key (not epic)
3. transitionJiraIssue → "In Review" for leaf key only
4. Single implementation commit — task files only

Reference: .cursor/skills/orchestrator/jira-board.md

SESSION MEMORY:
- Path: /home/michael/projects/slugbase/.cursor/skills/agent-memory/active/<SESSION-ID>.md
- PHASE 1/2/3 after Jira In Progress; set started at Phase 1

DOC REFERENCE (read these):
- <paths + § from issue description>
- Index: .cursor/skills/orchestrator/doc-index.md

GIT:
- Branch staging; one implementation commit; explicit git add only; never stage `.cursor/skills/agent-memory/**`
- Never push to `main`. When pushing is explicitly requested, target `staging` only.
- Commit: `feat(<scope>)[SB-N]: <summary>` — key required. No Smart Commit. See `07-jira-commit-linking.mdc`.
- Infisical for env when needed (`infisical run --env=dev`)

DB MIGRATIONS — MANDATORY (schema-first; no exceptions):
<copy verbatim DB MIGRATIONS block>

READ / WRITE SCOPE / DO NOT TOUCH / AC / TESTS: <orchestrator fills>

REQUIRED OUTPUT:
1. Jira In Progress: leaf + epic keys updated (or blocked reason)
2. Session timing: started, ended, duration
3. Jira worklog: leaf keys + timeSpent
4. Jira In Review confirmation
5. Summary (≤5 bullets)
6. Changed files (absolute paths)
7. Implementation commit: SHA + message + paths
8. Implementation status: complete | blocked | partial (NOT Jira Done)
9. Blockers or scope deviations
```

---

## Verification agent — Lane S (task verifier on staging)

```text
MODE: plan-file | chat | Jira
LANE: S
TARGET REPO: /home/michael/projects/slugbase
WORK BRANCH: staging
PLAN FILE: <path or n/a>
SESSION ID: <same as execution>

JIRA SYNC — VERIFIER (include when execution prompt had execution variant):
- MCP server: plugin-atlassian-atlassian; cloudId: mdg-labs.atlassian.net; transitionIdDone: 41; issues [{ key: SB-12 }]
- epic (optional): key if final subtask
- AFTER verdict: PASS → Done for each key (+ epic if listed); FAIL → addCommentToJiraIssue, transition Ready

SESSION MEMORY (local, gitignored):
- FIRST ACTION: read active/<SESSION-ID>.md if it exists
- Missing file → use execution REQUIRED OUTPUT; blocked only if insufficient
- When JIRA SYNC present: set ## Verification timing started after reading
- Pre-handoff: ended + duration + worklog before Jira status transition
- PASS: mandatory Jira Done comment; optionally delete active or move to local archive/ (never commit)
- FAIL: mandatory Jira FAIL comment; append VERIFICATION FAILED in active/ (never commit)

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

LAYER 1 — Scope audit: committed paths vs declared WRITE SCOPE

LAYER 2 — Automated checks from TARGET REPO:
- All commands via: bash scripts/with-ci-env.sh … (see NODE ENV block; docs/local-development.md)
- lint: bash scripts/with-ci-env.sh pnpm lint (or n/a)
- typecheck: bash scripts/with-ci-env.sh pnpm typecheck (or n/a)
- test: <from plan row Tests column, else doc-index defaults>
Use bash scripts/with-ci-env.sh infisical run --env=dev -- … when env required. Integration tests: bash scripts/with-ci-env.sh pnpm test:integration only (no Infisical wrapper). Stop if any defined check fails.

LAYER 3 — Logic review:
3a. Each acceptance criterion — genuinely implemented?
3b. Doc contract — spec section deviations with file:line + fix hint
3c. Security baseline — sessions (not JWT), no logged secrets, SSRF-safe egress, encrypted at-rest secrets, CSRF (03-security-baseline.mdc)
3c2. Env vars — any new env var fully registered in Infisical + .env.example + schema + docs? (05-env-vars.mdc)
3c3. Jira commit link — subject includes `[SB-N]` or `[P*-*]`; no Smart Commit commands (07-jira-commit-linking.mdc)
3d. DB migrations — hand-written migration SQL or hand-created directories → FAIL
3e. Stubs, TODO/FIXME, placeholder values, deployment-mode branches (`isCloud`) → FAIL

PLAN FILE (plan-file mode):
- PASS all layers → [x]; commit plan file only
- FAIL → [!] + note; commit plan file (mandatory)

REQUIRED OUTPUT:
1. Layer 1 result per commit
2. Layer 2 per check
3. Layer 3 breakdown
4. Overall PASS | FAIL
5. Verification timing + Jira worklog (or n/a)
6. Plan file update + SHA or skipped
7. Jira sync: keys → Done | FAIL comment (+ MCP results), or n/a
8. Issue list (≤10 bullets)
```

---

## Branch verification agent — Lane P (per task, in worktree)

```text
MODE: plan-file | chat
LANE: P (branch verify)
TARGET REPO: /home/michael/projects/slugbase
WORK BRANCH: orchestrator/<TASK-ID>
WORKTREE: <path>
BATCH_ID: <id>
SESSION ID: <same as execution>

JIRA SYNC — VERIFIER (include when execution prompt had execution variant):
- Same rules as Lane S verifier (Done / FAIL comment)

SESSION MEMORY (local, gitignored):
- FIRST ACTION: read active/<SESSION-ID>.md in WORKTREE if it exists
- PASS: mandatory Jira Done comment; optionally delete active or move to local archive/ (never commit)
- FAIL: mandatory Jira FAIL comment; append VERIFICATION FAILED in active/ (never commit)
- Do NOT edit PLAN FILE

EXECUTION COMMITS (on task branch):
- task id, implementation commit SHA, branch tip SHA, declared WRITE SCOPE, committed paths

ACCEPTANCE CRITERIA: <verbatim>
DOC REFERENCE: <same as execution>
VERIFICATION: Same Layer 1/2/3 as Lane S task verifier — run in WORKTREE

REQUIRED OUTPUT:
1. Layer 1/2/3 results
2. Overall PASS | FAIL
3. Verification timing + Jira worklog (or n/a)
4. Branch tip SHA for integration
5. Jira sync results
6. Issue list (≤10 bullets)
```

---

## Integration agent — Lane P

```text
MODE: integration
LANE: P
TARGET REPO: /home/michael/projects/slugbase
WORK BRANCH: staging
BATCH_ID: <id>
STAGING_BASE_SHA: <sha at batch start>
MERGE ORDER: <TASK-ID list, dependency order first>

BRANCH-PASS TASKS:
- <TASK-ID>: branch orchestrator/<TASK-ID> @ <tip SHA>

GIT:
- checkout staging
- For each branch-PASS task in MERGE ORDER:
    git merge --no-ff orchestrator/<TASK-ID> -m "chore(repo)[SB-N]: integrate <TASK-ID> (<BATCH_ID>)"
- On first conflict → STOP; report conflict files; do not partial-merge
- Do not rewrite implementation commits; do not edit PLAN FILE; never push to `main`

WRITE SCOPE: staging (merge commits only)

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
LANE: P (batch verify)
TARGET REPO: /home/michael/projects/slugbase
WORK BRANCH: staging
BATCH_ID: <id>
PLAN FILE: /home/michael/projects/slugbase/docs/slugbase-development-roadmap.md

TASK OUTCOMES:
- <TASK-ID>: branch-verify PASS, merged | branch-verify FAIL, not merged

CHECKS:
1. Confirm branch verifiers reported Jira Done comments + worklogs for integrated tasks
2. Post-merge smoke: bash scripts/with-ci-env.sh pnpm lint, bash scripts/with-ci-env.sh pnpm typecheck (Infisical for env when needed via with-ci-env wrapper)
3. If smoke fails → FAIL batch; do not mark [x]

PLAN FILE:
- Integrated + branch-PASS → [x]; commit plan file
- Branch-FAIL (not merged) → [!] + note; commit plan file

REQUIRED OUTPUT:
1. Jira Done comment confirmation per integrated task
2. Smoke check results
3. Plan file updates + SHA
4. Overall batch PASS | FAIL
5. Issue list (≤10 bullets)
```

---

## Worktree cleanup agent — Lane P

```text
MODE: cleanup
TARGET REPO: /home/michael/projects/slugbase
BATCH_ID: <id>

TASKS:
- <TASK-ID>: worktree <path>, branch orchestrator/<TASK-ID>, merged: yes | no

ACTIONS:
- Merged tasks: git worktree remove <path>; git branch -d orchestrator/<TASK-ID>
- Branch-FAIL / not merged: report paths; do not delete unless orchestrator approved
- If worktree remove fails (dirty): report; do not force

REQUIRED OUTPUT:
1. Removed worktrees
2. Deleted branches
3. Skipped items + reason
```
