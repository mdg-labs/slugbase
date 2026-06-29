# Orchestrator — Sub-agent prompt templates

Copy and fill. Sub-agents do not see the orchestrator chat.

When an issue is tracked on Linear (SlugBase team), orchestrator includes **role-specific** LINEAR SYNC blocks (see [linear-board.md](linear-board.md)):

- **Execution prompts:** state → In Progress on leaf + parent (when subtask); **no state → Done** — verifier only; pass `CLOSE_PARENTS` for epic commit close
- **Verifier prompts:** on PASS → state → Done; on FAIL → state → Ready; **mandatory structured comment**

Sub-agents perform Linear state updates — not the orchestrator.

**Every execution and verifier prompt** must include the **LINEAR TOOLS** block below — copy verbatim. Defines which tool (Linear MCP vs GitHub read-only) to use for each operation.

**Every execution and verifier prompt** must include the **NODE ENV** block below — copy verbatim even when the task has no pnpm commands (verifiers always run checks).

**Every execution and verifier prompt** must include the **SCOPED CI GATE** block below — copy verbatim.

**Every execution prompt** (Lane S, Lane P, chat) **must** include the **DB MIGRATIONS** block below — copy verbatim even when the task has no schema changes.

---

## LINEAR TOOLS — sub-agents (mandatory in every LINEAR SYNC prompt)

Copy this block into **every** execution and verifier prompt that has a LINEAR SYNC section.

```text
LINEAR TOOLS — MANDATORY (Linear MCP primary; GitHub read-only for mirror):
- MCP server: plugin-linear-linear (always preferred for issue tracking)
- Team: SlugBase | Issue key: SB-N
- Create/update issue: save_issue (team: "SlugBase" on create; id: "SB-N" on update)
- Set workflow state: save_issue { id: "SB-N", state: "In Progress" | "In Review" | "Done" | "Ready" }
  - State names are exact — use "In Progress" not in_progress
- Read issue + relations: get_issue { id: "SB-N", includeRelations: true }
- Search/list: list_issues { team: "SlugBase", query, state, label }
- Comments: list_comments { issueId: "SB-N" } → find GitHub-linked thread → save_comment { parentId: "<thread-id>", body: "..." }
  - Reply on the synced GitHub thread — do NOT post top-level issueId comments when the thread exists
  - Fallback (sync pending): save_comment { issueId: "SB-N", body: "..." }
- Sub-issues: save_issue { parentId: "<parent-uuid-or-SB-N>" }
- Blocking: save_issue { blockedBy: ["SB-N"] }
- Synced GitHub #: get_issue links/attachments after create, or user-github issue_read when #N known

GITHUB READ-ONLY (synced mirror — mdg-labs/slugbase):
- MCP server: user-github — issue_read, search_issues only when Linear attachment has #N
- Dependabot alerts: gh api REST (no Linear equivalent)

FORBIDDEN:
- GraphQL updateProjectV2ItemFieldValue (GitHub Project board deprecated)
- gh project item-list, addProjectV2ItemById
- Setting GitHub issue state (open/closed) directly
- Issue keys in commit subject ([SB-N], [#N]) — body only per 07-issue-commit-linking.mdc
- Reference: .cursor/skills/orchestrator/linear-board.md
```

---

## NODE ENV — sub-agents (mandatory before any pnpm/turbo)

Copy into **every execution and verifier** prompt. Prevents Cursor agent shells (Node 20) from breaking Astro/marketing and misleading Turbo cache.

```text
NODE ENV (mandatory — run from TARGET REPO before any pnpm/turbo/phase command):
- Pin: .nvmrc = 22.12.0 (matches CI); engines >=22.12.0
- Wrapper (preferred): bash scripts/with-ci-env.sh <command> [args…]
- Examples:
    bash scripts/with-ci-env.sh pnpm lint
    bash scripts/with-ci-env.sh pnpm typecheck
    bash scripts/with-ci-env.sh pnpm test:unit
    bash scripts/with-ci-env.sh pnpm build
    bash scripts/with-ci-env.sh pnpm test:integration   # NO phase wrapper on integration
    bash scripts/with-ci-env.sh pnpm i18n:validate
- Alternative: source scripts/ci-env.sh once per shell, then run commands
- Sanity: bash scripts/with-ci-env.sh node -v  → must be v22.12.0+
- Docs: docs/internal/local-development.md
- FORBIDDEN: bare pnpm/turbo from agent shell without with-ci-env (Node 20 false passes / Astro failures)
```

---

## SCOPED CI GATE — sub-agents (mandatory in every execution and verifier prompt)

Copy into **every orchestrator execution and verifier** prompt. **Not** for direct/interactive agent commits. Full rules: `.cursor/rules/06-local-ci-before-commit.mdc`.

```text
SCOPED CI GATE — ORCHESTRATOR SUB-AGENTS ONLY (commit + verify; NOT pre-push):
- Derive --filter from WRITE SCOPE (execution) or committed paths (verifier)
- Path → filter mapping:
    packages/backend/       → @slugbase/backend
    packages/web/           → @slugbase/web
    packages/marketing/     → @slugbase/marketing
    packages/ui/            → @slugbase/ui
    packages/shared-types/  → @slugbase/shared-types
    packages/db-admin/      → @slugbase/db-admin
    packages/admin/         → @slugbase/admin
    packages/email-templates/ → @slugbase/email-templates
- Filter suffix rules:
    App/package-only change → --filter @slugbase/<pkg>
    Contract package (shared-types, ui) → --filter @slugbase/<pkg>...  (downstream consumers)
    Multiple packages in one task → repeat per package or union filters
- Commands (all via bash scripts/with-ci-env.sh):
    bash scripts/with-ci-env.sh pnpm turbo run lint typecheck test:unit build --filter=@slugbase/<pkg>
    # integration only when that package defines test:integration and task warrants it:
    bash scripts/with-ci-env.sh pnpm turbo run test:integration --filter=@slugbase/backend
- Root-level extras (not turbo-filtered):
    Locale JSON touched → pnpm i18n:validate (+ pnpm i18n:codegen if en key set changed)
    Marketing blog content → pnpm blog:validate
- Use bash scripts/with-ci-env.sh phase run -- … when env required. Integration: NO Phase wrapper.
- FORBIDDEN at commit/verify time:
    Full workspace gate (pnpm lint / typecheck / test:unit / build without --filter)
- Full gate runs ONLY when prompt includes PUSH PREP block or user explicitly requested push
- Direct/interactive agents (user says commit and push without orchestrator): skip this block; full gate once before push only
- Reference: .cursor/rules/06-local-ci-before-commit.mdc
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
CLOSE_PARENTS: linear=[SB-8] github=[8] | linear=[SB-10, SB-1] github=[10, 1] | none

LINEAR SYNC — EXECUTION (include when issue is on SlugBase team — omit if none):
- MCP server: plugin-linear-linear (see LINEAR TOOLS block)
- team: SlugBase
- issues:
  - linear: SB-12
    github: 12
  - linear: SB-8          # parent when subtask
    github: 8
- FIRST ACTION: save_issue state → "In Progress" for EVERY listed issue (leaf + parent) BEFORE session memory
- LAST ACTIONS (in order): state → "In Review" (leaf only) → single implementation commit
- FORBIDDEN: state → Done; verifier comments; parent Done
- COMMIT SUBJECT: key-free — feat(<scope>): <summary> only; NO [SB-N] or [#N] in subject
- COMMIT BODY: fixes SB-<leaf> + fixes #<leaf> always; add parent lines per CLOSE_PARENTS (both keys)
- Reference: .cursor/skills/orchestrator/linear-board.md

SESSION MEMORY:
- Path: /home/michael/projects/slugbase/.cursor/skills/agent-memory/active/<SESSION-ID>.md
- After Linear In Progress (if LINEAR SYNC present): PHASE 1 create file; header + Task; set started: <ISO 8601 UTC>
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
- Commit subject: `feat(<scope>): <summary>` — key-free; `[P*-*]` only for roadmap-only tasks. Subject ≤72 chars.
- Commit body (Linear-tracked):
    fixes SB-<leaf>
    fixes #<leaf>
    fixes SB-<parent>              # per CLOSE_PARENTS linear list
    fixes #<parent>                # per CLOSE_PARENTS github list
- FORBIDDEN: parent fixes when parent not in CLOSE_PARENTS; issue keys in subject
- No Smart Commit commands. See `07-issue-commit-linking.mdc`.

PRE-COMMIT — SCOPED CI (mandatory before implementation commit):
- Map staged paths → @slugbase/<pkg> filter(s); see SCOPED CI GATE block
- Run scoped gate; on failure → blocked, no commit
- Do NOT run full workspace gate

SECRETS / COMMANDS:
- Local tests/dev that need env: use Phase (`phase run -- <cmd>`); see `05-env-vars.mdc`
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
1. Linear In Progress confirmation (leaf + parent issues updated, or skipped + why)
2. Session timing: started, ended, duration
3. Summary (≤5 bullets)
4. Changed files (absolute paths)
5. Implementation commit: SHA + subject + body (`fixes SB-<leaf>` + `fixes #<leaf>` + parent lines per CLOSE_PARENTS) + committed paths (or "no commit" + why)
6. Plan checkbox: `[~]` only if PLAN FILE in WRITE SCOPE; never `[x]`
7. Implementation status: complete | blocked | partial + reason (NOT Linear Done — verifier sets that)
8. Blockers or scope deviations
```

---

## Execution agent — Lane P (parallel isolated, plan-file mode)

Use subagent type **`best-of-n-runner`**. Orchestrator sets **`run_in_background: true`** when dispatching multiple Lane P tasks — **max 3 concurrent** sub-agents on this host (Ubuntu 26.04 LTS desktop).

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
CLOSE_PARENTS: linear=[SB-8] github=[8] | linear=[SB-10, SB-1] github=[10, 1] | none

LINEAR SYNC — EXECUTION (include when issue is on SlugBase team — omit if none):
- Same block as Lane S execution template (state → In Progress only — no Done; parent when subtask)
- FIRST ACTION: save_issue state → "In Progress" for each leaf issue AND parent issue BEFORE session memory

WORK DEP — MANDATORY (Lane P worktrees have no node_modules):
- Worktrees are bare checkouts — **no `node_modules`** present at branch start
- FIRST action after Linear In Progress (before session memory and implementation code):
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
- Commit subject: `feat(<scope>): <summary>` — key-free. Subject ≤72 chars.
- Commit body (Linear-tracked):
    fixes SB-<leaf>
    fixes #<leaf>
    fixes SB-<parent>              # per CLOSE_PARENTS
    fixes #<parent>                # per CLOSE_PARENTS
- FORBIDDEN: parent fixes when parent not in CLOSE_PARENTS; issue keys in subject
- See `07-issue-commit-linking.mdc`.

PRE-COMMIT — SCOPED CI (mandatory before implementation commit):
- Map staged paths → @slugbase/<pkg> filter(s); see SCOPED CI GATE block
- Run scoped gate; on failure → blocked, no commit
- Do NOT run full workspace gate

PLAN FILE: READ ONLY. Do not set `[~]`, `[x]`, or `[!]`.

SECRETS / COMMANDS:
- Local tests/dev that need env: use Phase (`phase run -- <cmd>`); see `05-env-vars.mdc`
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
1. Linear In Progress confirmation
2. Session timing
3. Summary (≤5 bullets)
4. Worktree path + branch name
5. Changed files (absolute paths)
6. Implementation commit: SHA + subject + body (`fixes SB-<leaf>` + `fixes #<leaf>` + parent lines per CLOSE_PARENTS) + committed paths
7. Implementation status: complete | blocked | partial (NOT Linear Done)
8. Blockers or scope deviations
```

---

## Execution agent (chat mode)

Same as Lane S except: no plan checkbox update; TASK from orchestrator todo; acceptance criteria copied into prompt. **Must include the DB MIGRATIONS — MANDATORY block** and **SCOPED CI GATE block** in every chat-mode execution prompt.

---

## Execution agent — Linear mode (Lane S on staging)

Use when the user names a Linear issue (`SB-12`), GitHub issue (`#12`), URL, or parent/child.

```text
MODE: Linear
LANE: S
TARGET REPO: /home/michael/projects/slugbase
WORK BRANCH: staging
LINEAR KEY: <e.g. SB-12>
GITHUB NUMBER: <e.g. 12 — synced mirror>
SESSION ID: SB-<ISSUE-NUMBER>-<YYYYMMDD>-<4hex>
PARENT: linear=SB-8 github=8 | none
CLOSE_PARENTS: linear=[SB-8] github=[8] | linear=[SB-10, SB-1] github=[10, 1] | none

LINEAR SYNC — EXECUTION (include when issue is on SlugBase team — omit if none):
- MCP server: plugin-linear-linear (see LINEAR TOOLS block)
- team: SlugBase
- issues:
  - linear: SB-12
    github: 12
  - linear: SB-8          # when PARENT is not none
    github: 8

LINEAR — EXECUTION (first action, before session memory):
1. save_issue state → "In Progress" for EVERY leaf AND parent (if listed)
2. If state update fails → blocked; do not proceed
3. FORBIDDEN: state → Done; verifier comments; parent Done before verifier

LINEAR — EXECUTION (pre-handoff, after implementation):
1. Local session memory: set ended + duration
2. save_issue state → "In Review" for leaf only
3. Single implementation commit — task files only; keys in body only

Reference: .cursor/skills/orchestrator/linear-board.md

SESSION MEMORY:
- Path: /home/michael/projects/slugbase/.cursor/skills/agent-memory/active/<SESSION-ID>.md
- PHASE 1/2/3 after Linear In Progress; set started at Phase 1

DOC REFERENCE (read these):
- <paths + § from issue description>
- Index: .cursor/skills/orchestrator/doc-index.md

GIT:
- Branch staging; one implementation commit; explicit git add only; never stage `.cursor/skills/agent-memory/**`
- Never push to `main`. When pushing is explicitly requested, target `staging` only.
- Commit subject: `feat(<scope>): <summary>` — key-free. No Smart Commit.
- Commit body (Linear-tracked):
    fixes SB-<leaf>
    fixes #<leaf>
    fixes SB-<parent>              # per CLOSE_PARENTS
    fixes #<parent>                # per CLOSE_PARENTS
- FORBIDDEN: parent fixes when parent not in CLOSE_PARENTS; issue keys in subject
- See `07-issue-commit-linking.mdc`.
- Phase for env when needed (`phase run --`)

PRE-COMMIT — SCOPED CI (mandatory before implementation commit):
- Map staged paths → @slugbase/<pkg> filter(s); see SCOPED CI GATE block
- Run scoped gate; on failure → blocked, no commit
- Do NOT run full workspace gate

DB MIGRATIONS — MANDATORY (schema-first; no exceptions):
<copy verbatim DB MIGRATIONS block>

READ / WRITE SCOPE / DO NOT TOUCH / AC / TESTS: <orchestrator fills>

REQUIRED OUTPUT:
1. Linear In Progress: leaf + parent issues updated (or blocked reason)
2. Session timing: started, ended, duration
3. Linear In Review confirmation
4. Summary (≤5 bullets)
5. Changed files (absolute paths)
6. Implementation commit: SHA + subject + body (`fixes SB-<leaf>` + `fixes #<leaf>` + parent lines per CLOSE_PARENTS) + paths
7. Implementation status: complete | blocked | partial (NOT Linear Done)
8. Blockers or scope deviations
```

---

## Verification agent — Lane S (task verifier on staging)

```text
MODE: plan-file | chat | Linear
LANE: S
TARGET REPO: /home/michael/projects/slugbase
WORK BRANCH: staging
PLAN FILE: <path or n/a>
SESSION ID: <same as execution>
CLOSE_PARENTS: <same as execution prompt — linear=[SB-8] github=[8] | none>

LINEAR SYNC — VERIFIER (include when execution prompt had execution variant):
- MCP server: plugin-linear-linear (see LINEAR TOOLS block); team: SlugBase
- issues:
  - linear: SB-12
    github: 12
  - linear: SB-8          # parent if final subtask
    github: 8
- AFTER PASS: list_comments → save_comment reply on GitHub-linked thread (mandatory) → save_issue state → "Done" for each issue (+ parent if listed)
- AFTER FAIL: list_comments → save_comment reply (FAIL detail) → state → "Ready"; do NOT set Done
- Layer 3c3: subject key-free; body has fixes SB-<leaf> AND fixes #<leaf>; parent lines per CLOSE_PARENTS only

SESSION MEMORY (local, gitignored):
- FIRST ACTION: read active/<SESSION-ID>.md if it exists
- Missing file → use execution REQUIRED OUTPUT; blocked only if insufficient
- Pre-handoff: set verification ended + duration
- PASS: mandatory Linear Done comment; optionally delete active or move to local archive/ (never commit)
- FAIL: mandatory Linear FAIL comment; append VERIFICATION FAILED in active/ (never commit)

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

LAYER 2 — Scoped automated checks (committed paths only):
- Derive filter(s) from committed paths; same rules as SCOPED CI GATE block
- All commands via: bash scripts/with-ci-env.sh … (see NODE ENV block; docs/internal/local-development.md)
- Example: bash scripts/with-ci-env.sh pnpm turbo run lint typecheck test:unit build --filter=@slugbase/<pkg>
- test: <from plan row Tests column, else doc-index scoped defaults>
- Use bash scripts/with-ci-env.sh phase run -- … when env required. Integration: bash scripts/with-ci-env.sh pnpm turbo run test:integration --filter=@slugbase/<pkg> only (no Phase wrapper). Stop if any defined check fails.
- FORBIDDEN: full workspace gate (full gate is pre-push only per 06-local-ci-before-commit.mdc)

LAYER 3 — Logic review:
3a. Each acceptance criterion — genuinely implemented?
3b. Doc contract — spec section deviations with file:line + fix hint
3c. Security baseline — sessions (not JWT), no logged secrets, SSRF-safe egress, encrypted at-rest secrets, CSRF (03-security-baseline.mdc)
3c2. Env vars — any new env var fully registered in Phase + .env.example + schema + docs? (05-env-vars.mdc)
3c3. Issue commit link — subject key-free (`[P*-*]` only for roadmap-only); body includes `fixes SB-<leaf>` AND `fixes #<leaf>` when Linear-tracked; parent lines only per CLOSE_PARENTS; no issue keys in subject (07-issue-commit-linking.mdc)
3c4. Linear state only — agents must never set GitHub issue state (open/closed); status via save_issue state; verifying code that closes GitHub issues directly → **FAIL**
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
6. Linear sync: issues → Done | Ready + comment (or n/a)
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
CLOSE_PARENTS: <same as execution prompt — linear=[SB-8] github=[8] | none>

LINEAR SYNC — VERIFIER (include when execution prompt had execution variant):
- MCP server: plugin-linear-linear (see LINEAR TOOLS block); team: SlugBase
- Same rules as Lane S verifier: list_comments → save_comment reply on GitHub-linked thread + save_issue state (Done / Ready)

WORK DEP — MANDATORY (Lane P worktrees have no node_modules):
- Worktrees are bare checkouts — **no `node_modules`** present at branch start
- FIRST action before any verification checks:
    cd <WORKTREE> && bash scripts/with-ci-env.sh pnpm install
- If `pnpm install` fails → blocked; report install error
- After install, confirm node -v via bash scripts/with-ci-env.sh node -v (must be v22.12.0+)

SESSION MEMORY (local, gitignored):
- FIRST ACTION: read active/<SESSION-ID>.md in WORKTREE if it exists
- PASS: mandatory Linear Done comment; optionally delete active or move to local archive/ (never commit)
- FAIL: mandatory Linear FAIL comment; append VERIFICATION FAILED in active/ (never commit)
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
4. Linear sync results
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
1. Confirm branch verifiers reported Linear Done comments for integrated tasks
2. Post-merge scoped smoke: union of @slugbase/<pkg> filters for all packages touched by integrated tasks — e.g. bash scripts/with-ci-env.sh pnpm turbo run lint typecheck --filter=@slugbase/<pkg> per package (Phase for env when needed via with-ci-env wrapper). NOT full workspace gate.
3. If smoke fails → FAIL batch; do not mark [x]

PLAN FILE:
- Integrated + branch-PASS → [x]; commit plan file
- Branch-FAIL (not merged) → [!] + note; commit plan file

REQUIRED OUTPUT:
1. Linear Done comment confirmation per integrated task
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

---

## Push prep — when user requests push

Include this block when the orchestrator or user explicitly requests `git push`. The pushing agent (not the orchestrator) runs the full gate.

```text
PUSH PREP — BEFORE git push (staging only; never main per 01-git-workflow.mdc):

1. VERSION BUMPS (when deploy surfaces changed since upstream):
   pnpm bump:versions
   git add packages/*/package.json && git commit -m "chore(repo)[#N]: bump versions for push"
   See .cursor/rules/15-deploy-version-bumps.mdc

2. FULL CI GATE (mandatory):
    bash scripts/with-ci-env.sh pnpm lint && \
    bash scripts/with-ci-env.sh pnpm typecheck && \
    bash scripts/with-ci-env.sh pnpm test:unit && \
    bash scripts/with-ci-env.sh pnpm build && \
    bash scripts/with-ci-env.sh pnpm test:integration && \
    bash scripts/with-ci-env.sh pnpm audit --audit-level=high
   - On failure → do not push; fix and rerun from the start
   - On success → report "full gate passed" then push
   - Integration tests: NO Phase wrapper (with-ci-env.sh only)

3. Pre-push hook validates version bumps automatically (or run pnpm check:push-version-bumps manually)
```
