# Orchestrator — Sub-agent prompt templates

Copy and fill. Sub-agents do not see the orchestrator chat.

When an issue is tracked on the GitHub project board, orchestrator includes **role-specific** GITHUB SYNC blocks (see [github-board.md](github-board.md)):

- **Execution prompts:** Status → In Progress on leaf + parent (when subtask); **no Status → Done** — verifier only; pass `CLOSE_PARENTS` for epic commit close
- **Verifier prompts:** on PASS → Status → Done; on FAIL → Status → Ready; **mandatory structured comment**

Sub-agents perform GitHub status updates — not the orchestrator.

**Every execution and verifier prompt** must include the **GITHUB TOOLS** block below — copy verbatim. Defines which tool (MCP vs CLI) to use for each operation.

**Every execution and verifier prompt** must include the **NODE ENV** block below — copy verbatim even when the task has no pnpm commands (verifiers always run checks).

**Every execution prompt** (Lane S, Lane P, chat) **must** include the **DB MIGRATIONS** block below — copy verbatim even when the task has no schema changes.

---

## GITHUB TOOLS — sub-agents (mandatory in every GITHUB SYNC prompt)

Copy this block into **every** execution and verifier prompt that has a GITHUB SYNC section. Tells sub-agents which tool to use for each operation.

```text
GITHUB TOOLS — MANDATORY (MCP preferred; GraphQL for project board):
- MCP server: user-github (always preferred for issue operations)
- Issue create/update (title, body, type, labels, fields): MCP issue_write
  - ALWAYS set type, labels, Priority, Effort, AND assignees on create — all five are mandatory
  - ALWAYS assign to the logged-in user (discover via MCP get_me, then use the returned username in assignees)
  - Valid Priority options: Urgent, High, Medium, Low
  - Valid Effort options: High, Medium, Low
  - gh issue create --type does NOT work for org-level issue types — MCP only
- Issue read (body, labels, state, type, fields): MCP issue_read (method: get)
- Issue comments: MCP add_issue_comment
- Sub-issues (link/unlink/reorder): MCP sub_issue_write (requires database IDs, not issue numbers)
  - Get database IDs: gh api graphql -f 'query=query { repository(owner:"mdg-labs",name:"slugbase") { issue(number:N) { databaseId } } }'
- Issue search: MCP search_issues
- Issue list with field filters: MCP list_issues (field_filters for Priority, Effort, etc.)

PROJECT STATUS (In Progress / In Review / Done / Ready) — via GraphQL:
Status is a project-board field — MCP issue_write cannot set it. Do NOT check "is issue in project" (see always-applied rule 12-github-project-board.mdc) — if the GITHUB SYNC block lists the issue, it IS in the project. Do NOT use gh project CLI — use GraphQL.

Hardcoded IDs (never change):
- Project node ID: PVT_kwDODv-LLc4BaOr9
- Status field ID: PVTSSF_lADODv-LLc4BaOr9zhVHxUI
- Option IDs: Backlog=9485f8e2, Ready=a0e7153f, In Progress=47fc9ee4, In Review=81f76819, Done=98236657, Declined=e36e1062

Step 1: Get project item ID for the issue (one query per issue):
  gh api graphql -f 'query=query { repository(owner:"mdg-labs",name:"slugbase") { issue(number:N) { projectItems(first:10) { nodes { id project { number } } } } } }'
  → Filter nodes where project.number == 2, take .id

Step 2: Set Status (one mutation):
  gh api graphql -f 'query=mutation { updateProjectV2ItemFieldValue(input: {
    projectId: "PVT_kwDODv-LLc4BaOr9"
    itemId: "<ITEM_ID from Step 1>"
    fieldId: "PVTSSF_lADODv-LLc4BaOr9zhVHxUI"
    value: { singleSelectOptionId: "<OPTION_ID>" }
  }) { projectV2Item { fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } } } } }'

FORBIDDEN:
- gh issue create, gh issue edit, gh issue view (always use MCP instead)
- Setting issue fields via gh CLI (always use MCP issue_write)
- Checking "is issue in project" — if it's in the GITHUB SYNC block, it's in the project
- gh project item-list, gh project item-edit, gh project field-list (use GraphQL instead)
- Setting GitHub issue state (open/closed) — board Status only; never modify GitHub issue state directly
```

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
    bash scripts/with-ci-env.sh pnpm i18n:validate
- Alternative: source scripts/ci-env.sh once per shell, then run commands
- Sanity: bash scripts/with-ci-env.sh node -v  → must be v22.12.0+
- Docs: docs/internal/local-development.md
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

## Execution agent — Lane S (serial on staging, plan-file mode)

```text
MODE: plan-file
LANE: S
TARGET REPO: /home/michael/projects/slugbase
WORK BRANCH: staging
PLAN FILE: /home/michael/projects/slugbase/docs/internal/slugbase-development-roadmap.md
TASK ID: <e.g. P1-03>
SESSION ID: <TASK-ID>-<YYYYMMDD>-<4hex>
PARENT: <parent issue number or none>
CLOSE_PARENTS: <[#8] | [#10, #1] | none>   # parents to fixes-close in this commit

GITHUB SYNC — EXECUTION (include when issue is on GitHub project board — omit if none):
- MCP server: user-github (always preferred — see GITHUB TOOLS block)
- owner: mdg-labs
- repo: slugbase
- project: <PROJECT_NUMBER>
- issues: [{ number: 12 }, …]
- parent (when subtask): { number: 8 }   # parent — Status → In Progress with leaves
- FIRST ACTION: Set project Status → "In Progress" for each leaf issue AND parent issue (if listed) BEFORE session memory
- LAST ACTIONS (in order): Set project Status → "In Review" (leaf only) → single implementation commit
- FORBIDDEN: Set Status → Done; add comment for verification outcomes; set parent Done
- Status is set via GraphQL `updateProjectV2ItemFieldValue` (see GITHUB TOOLS block for IDs)
- Reference: .cursor/skills/orchestrator/github-board.md

SESSION MEMORY:
- Path: /home/michael/projects/slugbase/.cursor/skills/agent-memory/active/<SESSION-ID>.md
- After GitHub In Progress (if GITHUB SYNC present): PHASE 1 create file; header + Task; set started: <ISO 8601 UTC>
- PHASE 2: update Scope, Decisions, Doc deviations in place
- PHASE 3: finalize all sections locally (never commit session memory)
- Pre-handoff: set ended + duration in local file; then In Review; single implementation commit
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
- Commit subject: `feat(<scope>)[#<leaf>]: <summary>` or `fix(<scope>)[P*-*]: <summary>` (roadmap-only). Leaf number only in brackets. Subject ≤72 chars.
- Commit body (GitHub-tracked):
    fixes #<leaf>                    # always
    fixes #<parent>                  # one line per issue in CLOSE_PARENTS (omit when none)
- FORBIDDEN: fixes #<parent> when parent not in CLOSE_PARENTS
- No Smart Commit commands. See `07-issue-commit-linking.mdc`.

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
1. GitHub In Progress confirmation (leaf + parent issues updated, or skipped + why)
2. Session timing: started, ended, duration
3. Summary (≤5 bullets)
4. Changed files (absolute paths)
5. Implementation commit: SHA + subject + body (`fixes #<leaf>` + `fixes #<parent>` per CLOSE_PARENTS) + committed paths (or "no commit" + why)
6. Plan checkbox: `[~]` only if PLAN FILE in WRITE SCOPE; never `[x]`
7. Implementation status: complete | blocked | partial + reason (NOT GitHub Done — verifier sets that)
8. Blockers or scope deviations
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
PLAN FILE: /home/michael/projects/slugbase/docs/internal/slugbase-development-roadmap.md (READ ONLY)
TASK ID: <e.g. P2-05>
SESSION ID: <TASK-ID>-<YYYYMMDD>-<4hex>
PARENT: <parent issue number or none>
CLOSE_PARENTS: <[#8] | [#10, #1] | none>   # parents to fixes-close in this commit

GITHUB SYNC — EXECUTION (include when issue is on GitHub project board — omit if none):
- Same block as Lane S execution template (Status → In Progress only — no Done; parent when subtask)
- FIRST ACTION: Set project Status → "In Progress" for each leaf issue AND parent issue BEFORE session memory

WORK DEP — MANDATORY (Lane P worktrees have no node_modules):
- Worktrees are bare checkouts — **no `node_modules`** present at branch start
- FIRST action after GitHub In Progress (before session memory and implementation code):
    cd <WORKTREE> && bash scripts/with-ci-env.sh pnpm install
- If `pnpm install` fails → blocked; report install error
- After install, confirm node -v via bash scripts/with-ci-env.sh node -v (must be v22.12.0+)

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
- Commit subject: `feat(<scope>)[#<leaf>]: <summary>`. Leaf number only in brackets. Subject ≤72 chars. No Smart Commit.
- Commit body (GitHub-tracked):
    fixes #<leaf>                    # always
    fixes #<parent>                  # one line per issue in CLOSE_PARENTS (omit when none)
- FORBIDDEN: fixes #<parent> when parent not in CLOSE_PARENTS
- See `07-issue-commit-linking.mdc`.

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
1. GitHub In Progress confirmation
2. Session timing
3. Summary (≤5 bullets)
4. Worktree path + branch name
5. Changed files (absolute paths)
6. Implementation commit: SHA + subject + body (`fixes #<leaf>` + `fixes #<parent>` per CLOSE_PARENTS) + committed paths
7. Implementation status: complete | blocked | partial (NOT GitHub Done)
8. Blockers or scope deviations
```

---

## Execution agent (chat mode)

Same as Lane S except: no plan checkbox update; TASK from orchestrator todo; acceptance criteria copied into prompt. **Must include the DB MIGRATIONS — MANDATORY block** in every chat-mode execution prompt.

---

## Execution agent — GitHub mode (Lane S on staging)

Use when the user names a GitHub issue (`#12`), URL, or parent/child.

```text
MODE: GitHub
LANE: S
TARGET REPO: /home/michael/projects/slugbase
WORK BRANCH: staging
ISSUE NUMBER: <e.g. 12>
SESSION ID: #<ISSUE-NUMBER>-<YYYYMMDD>-<4hex>
PARENT: <parent issue number e.g. 8 or none>
CLOSE_PARENTS: <[#8] | [#10, #1] | none>   # parents to fixes-close in this commit

GITHUB SYNC — EXECUTION (include when issue is on GitHub project board — omit if none):
- MCP server: user-github (always preferred — see GITHUB TOOLS block)
- owner: mdg-labs
- repo: slugbase
- project: <PROJECT_NUMBER>
- issues: [{ number: 12 }]
- parent (when PARENT header is not "none"):
  - { number: 8 }

GITHUB — EXECUTION (first action, before session memory):
1. Set project Status → "In Progress" for EVERY leaf issue AND parent issue (if listed) via GraphQL updateProjectV2ItemFieldValue
2. If status update fails → blocked; do not proceed
3. FORBIDDEN: Set Status → Done; add comment for verification outcomes; set parent Done before verifier

GITHUB — EXECUTION (pre-handoff, after implementation):
1. Local session memory: set ended + duration
2. Set project Status → "In Review" for leaf issue only via GraphQL updateProjectV2ItemFieldValue
3. Single implementation commit — task files only

Reference: .cursor/skills/orchestrator/github-board.md

SESSION MEMORY:
- Path: /home/michael/projects/slugbase/.cursor/skills/agent-memory/active/<SESSION-ID>.md
- PHASE 1/2/3 after GitHub In Progress; set started at Phase 1

DOC REFERENCE (read these):
- <paths + § from issue description>
- Index: .cursor/skills/orchestrator/doc-index.md

GIT:
- Branch staging; one implementation commit; explicit git add only; never stage `.cursor/skills/agent-memory/**`
- Never push to `main`. When pushing is explicitly requested, target `staging` only.
- Commit subject: `feat(<scope>)[#<leaf>]: <summary>` — leaf number required. No Smart Commit.
- Commit body (GitHub-tracked):
    fixes #<leaf>                    # always
    fixes #<parent>                  # one line per issue in CLOSE_PARENTS (omit when none)
- FORBIDDEN: fixes #<parent> when parent not in CLOSE_PARENTS
- See `07-issue-commit-linking.mdc`.
- Infisical for env when needed (`infisical run --env=dev`)

DB MIGRATIONS — MANDATORY (schema-first; no exceptions):
<copy verbatim DB MIGRATIONS block>

READ / WRITE SCOPE / DO NOT TOUCH / AC / TESTS: <orchestrator fills>

REQUIRED OUTPUT:
1. GitHub In Progress: leaf + parent issues updated (or blocked reason)
2. Session timing: started, ended, duration
3. GitHub In Review confirmation
4. Summary (≤5 bullets)
5. Changed files (absolute paths)
6. Implementation commit: SHA + subject + body (`fixes #<leaf>` + `fixes #<parent>` per CLOSE_PARENTS) + paths
7. Implementation status: complete | blocked | partial (NOT GitHub Done)
8. Blockers or scope deviations
```

---

## Verification agent — Lane S (task verifier on staging)

```text
MODE: plan-file | chat | GitHub
LANE: S
TARGET REPO: /home/michael/projects/slugbase
WORK BRANCH: staging
PLAN FILE: <path or n/a>
SESSION ID: <same as execution>
CLOSE_PARENTS: <same as execution prompt — [#8] | none>

GITHUB SYNC — VERIFIER (include when execution prompt had execution variant):
- MCP server: user-github (always preferred — see GITHUB TOOLS block); owner: mdg-labs; repo: slugbase; project: <PROJECT_NUMBER>
- issues: [{ number: 12 }]
- parent (optional): number if final subtask
- AFTER PASS: MCP add_issue_comment (mandatory clean summary) → GraphQL updateProjectV2ItemFieldValue → Status "Done" for each issue (+ parent if listed)
- AFTER FAIL: MCP add_issue_comment (FAIL detail) → GraphQL updateProjectV2ItemFieldValue → Status "Ready"; do NOT set Done

SESSION MEMORY (local, gitignored):
- FIRST ACTION: read active/<SESSION-ID>.md if it exists
- Missing file → use execution REQUIRED OUTPUT; blocked only if insufficient
- Pre-handoff: set verification ended + duration
- PASS: mandatory GitHub Done comment; optionally delete active or move to local archive/ (never commit)
- FAIL: mandatory GitHub FAIL comment; append VERIFICATION FAILED in active/ (never commit)

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
- All commands via: bash scripts/with-ci-env.sh … (see NODE ENV block; docs/internal/local-development.md)
- lint: bash scripts/with-ci-env.sh pnpm lint (or n/a)
- typecheck: bash scripts/with-ci-env.sh pnpm typecheck (or n/a)
- test: <from plan row Tests column, else doc-index defaults>
Use bash scripts/with-ci-env.sh infisical run --env=dev -- … when env required. Integration tests: bash scripts/with-ci-env.sh pnpm test:integration only (no Infisical wrapper). Stop if any defined check fails.

LAYER 3 — Logic review:
3a. Each acceptance criterion — genuinely implemented?
3b. Doc contract — spec section deviations with file:line + fix hint
3c. Security baseline — sessions (not JWT), no logged secrets, SSRF-safe egress, encrypted at-rest secrets, CSRF (03-security-baseline.mdc)
3c2. Env vars — any new env var fully registered in Infisical + .env.example + schema + docs? (05-env-vars.mdc)
3c3. Issue commit link — subject includes `[#N]` or `[P*-*]`; body includes `fixes #<leaf>` when task is tracked on GitHub; body includes `fixes #<parent>` only for parents in CLOSE_PARENTS; no Smart Commit commands (07-issue-commit-linking.mdc)
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
5. Plan file update + SHA or skipped
6. GitHub sync: issues → Done | Ready + comment (or n/a)
7. Issue list (≤10 bullets)
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
CLOSE_PARENTS: <same as execution prompt — [#8] | none>

GITHUB SYNC — VERIFIER (include when execution prompt had execution variant):
- MCP server: user-github (always preferred — see GITHUB TOOLS block); owner: mdg-labs; repo: slugbase
- Same rules as Lane S verifier: MCP add_issue_comment + GraphQL updateProjectV2ItemFieldValue for Status (Done / Ready)

WORK DEP — MANDATORY (Lane P worktrees have no node_modules):
- Worktrees are bare checkouts — **no `node_modules`** present at branch start
- FIRST action before any verification checks:
    cd <WORKTREE> && bash scripts/with-ci-env.sh pnpm install
- If `pnpm install` fails → blocked; report install error
- After install, confirm node -v via bash scripts/with-ci-env.sh node -v (must be v22.12.0+)

SESSION MEMORY (local, gitignored):
- FIRST ACTION: read active/<SESSION-ID>.md in WORKTREE if it exists
- PASS: mandatory GitHub Done comment; optionally delete active or move to local archive/ (never commit)
- FAIL: mandatory GitHub FAIL comment; append VERIFICATION FAILED in active/ (never commit)
- Do NOT edit PLAN FILE

EXECUTION COMMITS (on task branch):
- task id, implementation commit SHA, branch tip SHA, declared WRITE SCOPE, committed paths

ACCEPTANCE CRITERIA: <verbatim>
DOC REFERENCE: <same as execution>
VERIFICATION: Same Layer 1/2/3 as Lane S task verifier — run in WORKTREE

REQUIRED OUTPUT:
1. Layer 1/2/3 results
2. Overall PASS | FAIL
3. Branch tip SHA for integration
4. GitHub sync results
5. Issue list (≤10 bullets)
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
    git merge --no-ff orchestrator/<TASK-ID> -m "chore(repo): integrate <TASK-ID> (<BATCH_ID>)"
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
PLAN FILE: /home/michael/projects/slugbase/docs/internal/slugbase-development-roadmap.md

TASK OUTCOMES:
- <TASK-ID>: branch-verify PASS, merged | branch-verify FAIL, not merged

CHECKS:
1. Confirm branch verifiers reported GitHub Done comments for integrated tasks
2. Post-merge smoke: bash scripts/with-ci-env.sh pnpm lint, bash scripts/with-ci-env.sh pnpm typecheck (Infisical for env when needed via with-ci-env wrapper)
3. If smoke fails → FAIL batch; do not mark [x]

PLAN FILE:
- Integrated + branch-PASS → [x]; commit plan file
- Branch-FAIL (not merged) → [!] + note; commit plan file

REQUIRED OUTPUT:
1. GitHub Done comment confirmation per integrated task
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
