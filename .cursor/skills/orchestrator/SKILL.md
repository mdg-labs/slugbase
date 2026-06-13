---
name: orchestrator
description: Run a chat as a pure orchestrator for SlugBase. Reads the development roadmap and/or the GitHub Issues board to find work, dispatches sub-agents with doc references (not pasted spec content), and runs verification after each batch. Execution agents set board Status to In Progress (leaf + epic parent when subtask); only verification agents set board Status to Done after PASS. Use when the user asks to orchestrate, delegate end-to-end, execute the roadmap, implement a GitHub issue/epic (e.g. #12), or coordinate parallel implementation tasks.
---

# Orchestrator (SlugBase)

The main agent in this chat is a **dispatcher only**. It reads the **roadmap** and/or **GitHub board**, decides what to run next, and hands implementation to sub-agents. Sub-agents read spec docs and implementation files themselves.

## Workspace

| Item | Value |
|---|---|
| Repo | `/home/michael/projects/slugbase` |
| Integration branch | `staging` (all verified work lands here) |
| Production branch | `main` — **protected on GitHub**; no development; **never push** from agents |
| Task branch (Lane P) | `orchestrator/<TASK-ID>` (isolated; merged after verify PASS) |
| Worktree (Lane P) | Sibling dir `../slugbase-wt-<TASK-ID>` or subagent-managed |
| Plan file | `docs/internal/slugbase-development-roadmap.md` |
| Task board (GitHub) | GitHub Issues — see [github-board.md](github-board.md) |
| Spec docs | `docs/internal/slugbase-*.md` — see [doc-index.md](doc-index.md) |
| Workspace memory | `.cursor/skills/workspace-notes.md` |
| Session memory | `.cursor/skills/agent-memory/active/<SESSION-ID>.md` — **local only** (gitignored) |
| Prompt templates | [prompt-templates.md](prompt-templates.md) |

**Single-repo model.** Session memory and implementation commits live in `slugbase`. Lane S commits directly on **`staging`**; Lane P commits on task branches first, then integration merges to **`staging`**. **`main` is off-limits** for development and pushes.

---

## What the orchestrator does (and does not do)

### MAY do

- Read the **plan file** (full file): phases, task rows, dependencies, Doc Ref column, traceability matrix, exit criteria
- Read **GitHub issue payloads** via MCP (`user-github`): title, body, labels, sub-issues, state — see [github-board.md](github-board.md)
- Read [doc-index.md](doc-index.md), [prompt-templates.md](prompt-templates.md), and [github-board.md](github-board.md)
- Read `.cursor/skills/workspace-notes.md`; write durable learnings there
- Use `TodoWrite` in **chat mode** / **GitHub mode**
- In **plan-file mode**, edit the plan file for status reconciliation or **Lane P batch prep** (`[~]` at batch start)
- Launch sub-agents via the **Task** tool (`generalPurpose`, `best-of-n-runner`, `shell`, `explore`, `ci-investigator`)
- Set `run_in_background: true` on Task when dispatching parallel Lane P execution agents
- List filenames in `agent-memory/active/` (names only, not contents)
- Ask clarifying questions

### MUST NOT do

- Read spec doc bodies (`docs/internal/slugbase-*.md`) — sub-agents read these (GitHub issue bodies **are** readable — they are the AC contract for board tasks)
- Read implementation files, diffs, test output, lint results, or logs
- Use `Read`, `Grep`, `Glob`, `ReadLints`, `Shell`, `ApplyPatch`, etc. on implementation work
- Summarize file contents from memory
- Edit repo files other than plan file, `workspace-notes.md`, `github-board.md`, or this skill
- Paste spec doc bodies into sub-agent prompts — pass paths and `§` section refs
- Paste entire issue bodies — extract AC, file paths, doc refs, and deps
- Dispatch Lane P and Lane S tasks in the same batch
- Allow execution agents to commit to **`staging`** during an in-flight Lane P batch (integration agent only — merge commits)

---

## Three task sources

| Source | Task IDs | AC lives in | Status tracking |
|---|---|---|---|
| **Roadmap** | `P1-03`, `P2-01`, … | Plan file row | Plan checkboxes `[x]`/`[!]` |
| **GitHub Issues** | `#12`, `#8`, … | Issue body (MCP) | Board Status + comment |
| **Ad-hoc** | User-named | User message | `TodoWrite` only |

**User intent wins:** if they say "implement #12" or give a GitHub issue URL → **GitHub mode**, even though the roadmap exists.

## Three modes

|| **Plan-file mode** | **GitHub mode** | **Chat mode** |
|---|---|---|---|
| **When** | Roadmap batch (`P*-*`) | GitHub issue/epic (`#N`) | Ad-hoc; no board or plan |
| **State** | `- [ ]` / `- [~]` / `- [x]` / `- [!]` in plan file | `TodoWrite` + Board Status | `TodoWrite` in chat |
| **In progress** | `[~]` (Lane S agent or Lane P batch prep) | Execution agent → board Status **In Progress** | todo `in_progress` |
| **Done** | Verifier → `[x]` on plan file | Verifier PASS → board Status Done + comment | todo `completed` after verify PASS |
| **Failed** | Verifier → `[!]` on plan file | Verifier → add FAIL comment; board Status Ready | todo `pending` |

Pick mode on first turn:

- User names GitHub issue/URL/epic → **GitHub mode**
- User says orchestrate roadmap / phase → **plan-file mode**
- Otherwise → **chat mode**

Default to **plan-file mode** only when the user asks for roadmap work and did not name a GitHub issue.

---

## Startup sequence

1. Confirm target is `/home/michael/projects/slugbase` (only repo).
2. Read `.cursor/skills/workspace-notes.md` (create on first durable note).
3. **Pick mode** (plan-file / GitHub / chat) from user message.
4. **Plan-file:** read plan file — current phase, next TODO with satisfied deps, BLOCKED items.
5. **GitHub:** load issue(s) via MCP `issue_read` (method: `get`) or `search_issues` / `list_issues`. For sub-issues, use `issue_read` (method: `get_sub_issues`). For labels, use `issue_read` (method: `get_labels`).
6. Confirm with user (briefly if intent is clear): mode, batch, lane (S vs P), commits in scope, GitHub sync ON/OFF.

**Commits:** Orchestrated runs default to **local commits per task** on **`staging`** (Lane S) or task branches (Lane P). **Never push** unless the user explicitly asks — and **never push to `main`**.

**GitHub sync (default ON):** Orchestrator resolves issue number(s) and label set via MCP, then passes **role-specific** GITHUB SYNC blocks — execution prompts get **In Progress label only** (board Status only); verifier prompts set Status **Done**. Sub-agents perform the updates — orchestrator does **not** call `issue_write` itself unless recovering from a sub-agent failure. Skip only if user says **"don't update GitHub issues"**.

### GitHub status ownership (non-negotiable)

| Column | Who may set it | When |
|---|---|---|
| **In Progress** (Status) | **Execution** | First action, before session memory (leaf + epic parent when subtask) |
| **Done** (Status) | **Verifier** | After all verification layers PASS (board Status only; issue state is never modified) |

---

## Dispatching sub-agents

When building a prompt:

1. **Task ID** — roadmap `P*-*` or GitHub `#N`
2. **Acceptance criteria** — verbatim from plan row **or** extracted from issue body (bullets, not HTML)
3. **Doc references** — plan Doc Ref column **or** `§` sections cited in issue body ([doc-index.md](doc-index.md) shorthand)
4. Explicit READ / WRITE scope with absolute paths
5. Session ID: `<TASK-ID>-<YYYYMMDD>-<4hex>` — same for execution + verifier
6. **Lane** (`S` or `P`) and git context (branch, worktree, `STAGING_BASE_SHA` for Lane P)
7. **Epic context** — if parent epic (e.g. #8), note `PARENT` issue number, sibling deps, and computed `CLOSE_PARENTS` in prompt header (see § GitHub epic batches)
8. **GITHUB TOOLS block** — **mandatory in every GITHUB SYNC prompt** (copy verbatim from [prompt-templates.md](prompt-templates.md)) — tells sub-agents which tool (MCP vs CLI) to use for each operation
9. **GITHUB SYNC block** — when task(s) are on the board, include role-specific blocks from [github-board.md](github-board.md):
   - **Execution prompt:** Set project Status → "In Progress" via GraphQL `updateProjectV2ItemFieldValue` — **never** set Done; when subtask, also list parent epic issue number
   - **Verifier prompt:** Set project Status → "Done" via GraphQL `updateProjectV2ItemFieldValue` (+ optional epic Done for final subtask); post mandatory comment via MCP `add_issue_comment`
10. **DB MIGRATIONS block** — **mandatory in every execution prompt** (copy verbatim from [prompt-templates.md](prompt-templates.md) even when the task has no schema changes)

One prompt = one **leaf** task ID unless user requested batching or shared-file serialization requires it.

### GitHub epic batches

When user asks to implement an **epic** (parent issue with sub-issues):

1. `issue_read` on epic + `issue_read` (method: `get_sub_issues`) → full sub-issue list.
2. Read epic body **Suggested implementation order** and dependency prose.
3. Build a **batch plan** (ordered list of leaf tasks); split cross-domain work by Lane rules.
4. Track epic parent: execution adds **In Progress** label to epic when any subtask starts; orchestrator or **last subtask verifier** sets epic board Status to Done only when all in-scope subtasks PASS.
5. **Compute `CLOSE_PARENTS`** before each leaf dispatch and pass to execution + verifier prompts:

   - **In-scope siblings** = sub-issues in the current epic/batch plan (or all open children if user said "implement #8 epic" without narrowing).
   - For leaf `L` with parent chain `P1 → P2 → … → Pn`, include `Pi` in `CLOSE_PARENTS` when every other in-scope sibling of `L` under `Pi` is already **board Done** (or not in the remaining batch).
   - Pass `CLOSE_PARENTS: [#P, …]` or `none` — execution agents must not guess.

   ```text
   # Example: #1 Auth epic; #13 is last UI child (#10) but #1 still has open branches
   CLOSE_PARENTS: [#10]

   # Later: last remaining child under #1
   CLOSE_PARENTS: [#1]
   ```

### Sub-agent types

| Type | Use when |
|---|---|
| `best-of-n-runner` | **Lane P execution** — isolated git worktree + branch per task |
| `generalPurpose` | Lane S implementation; branch verify; staging batch verify; integration conflict analysis |
| `shell` | Worktree prep/cleanup; integration merges; one-offs |
| `explore` | Read-only discovery to unblock scope definition |
| `ci-investigator` | Single failing CI check on a PR |

**Model:** Do not hardcode a model slug. Omit unless the user specifies one.

**Parallel Lane P:** dispatch execution agents with `run_in_background: true`.

### Cross-cutting scope exceptions

Shared files (`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, CI workflows) may be touched when **all** are true:

1. Required to satisfy acceptance criteria
2. Minimal, task-specific change
3. Justified in session memory + output Blockers section

Not valid for unrelated cleanup, broad formatting, or dependency churn. **Lane P:** if two tasks in the same batch need the same shared file, downgrade to Lane S or split the batch.

---

## Parallelism — Lane S / P / B

| Lane | When | Where agents work | Who touches `staging` |
|---|---|---|---|
| **S — Serial** | Single task; uncertain overlap; migrations; shared contracts; integration conflicts | `staging` working tree | Execution + verifier |
| **P — Parallel isolated** | 2–3 tasks; deps satisfied; disjoint WRITE scopes; no shared-file contention | **Worktree + `orchestrator/<TASK-ID>` per task** | Integration agent + batch verifier only |
| **B — Blocked** | Same file must change in multiple tasks in one batch | — | Serialize, split batch, or run Lane S one at a time |

**Default when uncertain:** Lane S.

**Lane P hard rules:**

- Execution agents **never** checkout or commit to **`staging`** during Lane P execution (task branches only).
- Pin batch base: record `STAGING_BASE_SHA` at batch start (**current `staging` HEAD**); task branches fork from that SHA.
- Branch verifiers **never** edit the plan file.
- Batch verifier is the **only** agent that sets `[x]` / `[!]` for Lane P tasks.
- Never run Lane P and Lane S in the same batch.

**Serialize (force Lane S) when:** DB migrations, shared types/contracts, root tooling config, generated artifacts, dependency chains incomplete, or previous integration left merge conflicts.

Always: **execute batch → verify (per task) → integrate (Lane P) → batch verify → next batch**.

---

## Lane P batch lifecycle

### Batch metadata (orchestrator records at start)

| Field | Example |
|---|---|
| `BATCH_ID` | `20260531-a3f1` |
| `STAGING_BASE_SHA` | `abc123…` (current **`staging`** HEAD) |
| Per task | `TASK-ID`, `SESSION ID`, branch `orchestrator/<TASK-ID>`, worktree path |

### Flow

```text
1. Orchestrator: pick Lane P batch; record BATCH_ID + STAGING_BASE_SHA
2. Orchestrator: set [~] on plan file for batch tasks OR todos in_progress (chat mode)
3. Orchestrator: spawn execution agents (best-of-n-runner, run_in_background: true)
4. Each execution: finalize local session memory + one implementation commit on task branch only
5. Orchestrator: spawn one branch verifier per completed task (in that task's worktree)
6. Branch verifier PASS → report to orchestrator; no plan file write; board Status Done is the handoff record
7. Branch verifier FAIL → append VERIFICATION FAILED in local session memory; do not merge
8. Integration agent: merge PASS branches onto **`staging`** (dependency order, one at a time)
9. Batch verifier: post-merge smoke checks; [x] integrated tasks; [!] branch-failed tasks
10. Cleanup agent (shell): remove worktrees; delete merged task branches
```

### Worktree conventions

```text
Branch:    orchestrator/<TASK-ID>
Worktree:  ../slugbase-wt-<TASK-ID>   # sibling of repo root, or subagent-managed path
Base:      STAGING_BASE_SHA           # do not chase moving staging during execution
```

**No `node_modules` in worktrees.** Git worktrees are bare checkouts — they start without `node_modules`. The sub-agent (execution or verifier) **must** run `pnpm install` as the very first action after GitHub issue In Progress (execution) or before verification checks (verifier). This is enforced by the WORK DEP block in the Lane P prompt templates. The install step is the sub-agent's responsibility, not the orchestrator's.

---

## Execution agents

### Lane S (serial on `staging`)

1. **GitHub (first action when GITHUB SYNC present):** `issue_write` (method: `update`) → add **In Progress** label for every listed leaf issue **and** epic parent issue
2. **Session memory** — create `active/<SESSION-ID>.md`; record `started` timestamp
3. **Implementation** — task files only
4. **Pre-handoff** — set `ended` + `duration`; `add_issue_comment` on each leaf issue; set board Status to 'In Review' for each leaf issue → **single implementation commit** (task files only; never commit session memory)

Never push to **`main`**. When pushing is explicitly requested, target **`staging`** only. Stage explicit paths only. Stop if branch ≠ **`staging`**.

Execution may set `[~]` only when plan file is in WRITE SCOPE. Never `[x]`.

**GitHub FORBIDDEN for execution:** never set GitHub issue state (open/closed); never `add_issue_comment` for verification outcomes; never set epic Done — board Status only.

### Lane P (isolated task branch)

Same flow on **`orchestrator/<TASK-ID>` only** — one implementation commit per task.

- Work only in assigned worktree / branch.
- Never checkout **`staging`**, never merge, never push (during Lane P execution).
- Plan file: **read-only**.
- If `git status` shows unexpected changes outside WRITE SCOPE → `blocked`.

### Commit messages

Every task commit must include `[#N]` or `[P*-*]` — see `.cursor/rules/07-issue-commit-linking.mdc`.

```
feat(auth)[#12]: implement server-side session store with configurable TTL
fix(go)[#31]: handle missing slug gracefully in redirect endpoint
```

**Epic subtasks:** subject uses **leaf** number only (`[#<leaf>]`). Commit body always includes `fixes #<leaf>`. Add `fixes #<parent>` (one line per parent) **only** for issues listed in `CLOSE_PARENTS` from the orchestrator prompt — never on intermediate subtasks.

```text
# Intermediate subtask under epic #8
fixes #11

# Final in-scope child of epic #8
fixes #12
fixes #8
```

Do **not** commit `.cursor/skills/agent-memory/**` — gitignored local notes only.

---

## Verification agents

Never reuse a verifier thread across batches. Spawn **fresh** verifiers.

### Lane S — task verifier (on `staging`)

One verifier after execution. Input: session ID, commit SHAs, WRITE scopes, committed paths, acceptance criteria, doc refs.

**Three layers (all must pass):**

**Layer 1 — Scope audit:** committed paths vs declared WRITE SCOPE.

**Layer 2 — Automated checks** from repo root (see plan Tests column, else [doc-index.md](doc-index.md)):

```bash
pnpm lint        # or n/a
pnpm typecheck   # or n/a
pnpm test:unit   # or n/a
```

Mark `n/a` for commands not yet defined. Stop if any defined check fails. Use Infisical (`infisical run --env=dev`) when env required.

**Layer 3 — Logic review:**

- 3a. Each acceptance criterion — genuinely implemented?
- 3b. Doc contract — spec `§` deviations with file:line + fix hint
- 3c. Security baseline — server-side sessions (not JWT), no logged secrets, SSRF-safe egress, encrypted at-rest secrets, CSRF exempt list not widened; no deployment-mode branches (03-security-baseline.mdc)
- 3c2. Env vars — any new var fully registered (Infisical + .env.example + schema + docs)? (05-env-vars.mdc)
- 3c3. GitHub commit link — subject includes `[#N]` or `[P*-*]`; body includes `fixes #<leaf>` when task is tracked on GitHub; body includes `fixes #<parent>` only for parents in `CLOSE_PARENTS`; no unrelated issue references (07-issue-commit-linking.mdc)
- 3c4. Board Status only — agents must never set GitHub issue state (open/closed); all status management must be via project board Status (In Progress / In Review / Done / Ready); verifying code or comments that call `issue_state`, `close()`, `reopen()` on GitHub issues → **FAIL**
- 3d. DB migrations — hand-written migration SQL or hand-created migration directories → **FAIL**
- 3e. Stubs, TODO/FIXME, placeholder values, `isCloud`/deployment-mode branches → **FAIL**

| Result | Plan (plan-file mode) | GitHub (sub-agent) | Local session memory |
|---|---|---|---|
| PASS | `[x]`; commit plan file | Verifier → mandatory PASS comment + board Status Done | Delete active or move to local archive/ (never commit) |
| FAIL | `[!]` + note; commit plan file | Verifier → add FAIL comment; board Status Ready; do NOT set Done | Append VERIFICATION FAILED in active/ (never commit) |

---

## Integration agent

Spawn after all branch verifiers complete. Only agent that commits to **`staging`** during a Lane P batch (merge commits).

Merge `orchestrator/<TASK-ID>` into **`staging`** with `--no-ff`, one task at a time. On conflict → **stop**; report conflict files. Never push to **`main`**.

---

## Worktree cleanup

After batch closes, spawn a **shell** agent:

```bash
git worktree remove ../slugbase-wt-<TASK-ID>   # per task
git branch -d orchestrator/<TASK-ID>           # only after merged to staging
```

---

## Task markers

### Plan-file mode

- `- [ ]` not started
- `- [~]` awaiting verification — Lane S: execution agent; Lane P: orchestrator at batch start
- `- [x]` verified — Lane S: task verifier; Lane P: batch verifier
- `- [!]` failed verification (one-line note below)

### Chat mode (`TodoWrite`)

- `pending` — not started or failed
- `in_progress` — execution/verification in flight
- `completed` — verifier PASS only
- `cancelled` — user-approved abandon

---

## Session memory lifecycle (local only — gitignored)

Path: `.cursor/skills/agent-memory/` — **never committed**.

| Step | Who | Action |
|---|---|---|
| Before dispatch | Orchestrator | Generate SESSION ID |
| Phase 1 | Execution | Create `active/<SESSION-ID>.md`; header + Task; set `started` when GITHUB SYNC present |
| Phase 2 | Execution | Update Scope, Decisions, Deviations in place |
| Phase 3 | Execution | Finalize sections locally (do not commit) |
| Pre-handoff | Execution | Set `ended` + `duration`; set Status **In Review**; **one implementation commit** |
| Verifier start | Verifier | Read active file if present; set verification `started` when GITHUB SYNC present |
| Verifier end | Verifier | Set verification `ended` + `duration`; set board Status Done/Ready; mandatory comment |
| PASS | Verifier | Mandatory PASS comment + board Status Done; optionally delete active or move to local `archive/` |
| FAIL | Verifier | Mandatory FAIL comment; append VERIFICATION FAILED in active/ if file exists |

**Retry after FAIL:** same SESSION ID; execution reads FAIL comment and local active file.

### Session file template

```markdown
# Session: <SESSION-ID>

_task: <TASK-ID> | started: <ISO 8601 UTC> | ended: <ISO or pending> | duration: <e.g. 1h 32m or pending> | agent: execution_

## Task

<one line from plan>

## Timing

- **Execution started:** <ISO>
- **Execution ended:** <ISO>
- **Duration:** <human-readable>

## Scope

### Files read

- <path> — <why>

### Files modified

- <path> — <what>

## Implementation decisions

- <decision> or none

## Doc deviations or open questions

- <item> or none

## Notes for verifier

- <note> or none

## Verification timing

_verification started: <ISO> | ended: <ISO> | duration: <human>_
```

### Verifier failure append

```markdown
## VERIFICATION FAILED — <ISO>

_agent: verification_

### Issues found

- <file>:<line> — <problem> — fix hint: <expected per doc/AC>

### Layers failed

- Layer 1: PASS | FAIL
- Layer 2: PASS | FAIL
- Layer 3: PASS | FAIL
```

---

## Workspace memory

Path: `.cursor/skills/workspace-notes.md`

Store only durable knowledge: conventions, build/test quirks, Infisical/env notes, recurring verify failures, Lane P merge conflict patterns.

```markdown
## <topic>

<2-4 lines>
_added: YYYY-MM-DD_
```

Orchestrator may read/write. Sub-agents may read; write only if task WRITE SCOPE includes it.

---

## Minimal run loop

1. Read workspace-notes; pick mode (plan-file / GitHub / chat).
2. **Plan-file:** read plan file, next TODO. **GitHub:** load issue/epic/sub-issues via MCP.
3. Identify next tasks (deps satisfied — plan rows, GitHub issue links, epic prose order).
4. Map doc refs → paths (plan Doc Ref or issue body `§` citations; orchestrator does **not** open spec doc bodies).
5. Choose lane: **S**, **P**, or **B** (blocked → split or serialize).
6. Generate SESSION ID per leaf task; if Lane P, record `BATCH_ID` + `STAGING_BASE_SHA`.
7. Batch prep: plan `[~]` / todos `in_progress` (orchestrator does **not** set GitHub In Progress — execution agent does).
8. Spawn execution sub-agent(s) — `best-of-n-runner` + `run_in_background: true` for Lane P.
9. Collect: local SESSION ID path, implementation SHA, scopes, paths, status per task.
10. Spawn one **branch verifier** per Lane P task, or one **task verifier** for Lane S.
11. Lane P: spawn **integration agent** → **batch verifier**.
12. Lane P: spawn **cleanup** shell agent for worktrees/branches.
13. Reconcile: PASS → plan `[x]` / confirm board Status Done comment; FAIL → plan `[!]` / retry same SESSION ID.
14. **GitHub epic:** if subtask execution skipped epic In Progress, orchestrator recovery → epic **In Progress** label; if all subtasks PASS and epic not yet closed, recovery → set epic Done (board Status); or ensure last verifier prompt included epic issue number.
15. Update workspace-notes if durable learning.
16. Report batch result + next batch.
17. Repeat.

---

## Anti-patterns

- Orchestrator reading spec **doc** bodies or implementation files (GitHub issue bodies are OK)
- Orchestrator reading session memory **contents** (filenames in `active/` only)
- Pasting spec doc bodies or full issue bodies into sub-agent prompts
- Editing roadmap checkboxes for GitHub-only issues (#N)
- Setting epic to Done (board Status) before all in-scope subtasks verify PASS
- **Sub-agent skipping GitHub sync** when GITHUB SYNC block is present
- **Agent setting GitHub issue state (open/closed)** — board Status only; never modify GitHub issue state
- **Execution agent confusing REQUIRED OUTPUT `complete` with board Status Done**
- Execution agent starting implementation before adding In Progress label (when sync required)
- Execution agent adding In Progress label to a subtask without adding it to epic parent
- Verifier adding In Progress label (execution owns that)
- Committing session memory files to git (local only; GitHub comment is the durable record)
- Verifier proceeding without local session memory **and** without execution REQUIRED OUTPUT
- Reusing SESSION ID across different tasks
- Reusing verifier thread across batches
- Marking `[x]` or todo `completed` before verifier PASS
- **Lane P execution agents committing to `staging`** (during execution — integration agent merges only)
- **Pushing to `main`** on GitHub — forbidden for all agents
- **Lane S work on any branch other than `staging`**
- **Branch verifiers editing the plan file**
- **Parallel Lane P without `best-of-n-runner` or equivalent worktree isolation**
- **Dispatching Lane P and Lane S in the same batch**
- **Integration merging branch-FAIL tasks**
- Pushing from any sub-agent without user request
- Blanket `git add .` / `-A`
- Committing `.env` or secrets
- **Task commits without `[#N]` or `[P*-*]` in subject** when GitHub sync was in scope
- **`fixes #<epic>` on non-final subtask** — premature epic auto-close on `main`
- **Omitting `fixes #<parent>` when `CLOSE_PARENTS` lists the parent** — epic stays open after release
- **Execution agent hand-writing DB migrations** — schema change → migration CLI only (see DB MIGRATIONS block in every execution prompt)
- **Orchestrator omitting DB MIGRATIONS block** from an execution prompt
- **Deployment-mode branches in code** — `isCloud`, `SLUGBASE_MODE` checks are forbidden; use entitlements engine (spec §15)
