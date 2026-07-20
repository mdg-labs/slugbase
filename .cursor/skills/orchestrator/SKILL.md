---
name: orchestrator
description: Run a chat as a pure orchestrator for SlugBase. Reads the development roadmap and/or Linear (SlugBase team) to find work, dispatches sub-agents with doc references (not pasted spec content), and runs verification after each batch. Sends a session-end Slack DM to the operator when the run completes (see slack-session-end.md). Execution agents set Linear state to In Progress (leaf + epic parent when subtask); only verification agents set state to Done after PASS. Use when the user asks to orchestrate, delegate end-to-end, execute the roadmap, implement a Linear/GitHub issue (e.g. SB-12 / #12), or coordinate parallel implementation tasks.
---

# Orchestrator (SlugBase)

The main agent in this chat is a **dispatcher only**. It reads the **roadmap** and/or **Linear board**, decides what to run next, and hands implementation to sub-agents. Sub-agents read spec docs and implementation files themselves.

## Workspace

| Item | Value |
|---|---|
| Repo | `/home/michael/projects/slugbase` |
| Integration branch | `staging` (all verified work lands here) |
| Production branch | `main` — **protected on GitHub**; no development; **never push** from agents |
| Task branch (Lane P) | `orchestrator/<TASK-ID>` (isolated; merged after verify PASS) |
| Worktree (Lane P) | Sibling dir `../slugbase-wt-<TASK-ID>` or subagent-managed |
| Plan file | `docs/internal/slugbase-development-roadmap.md` |
| Task board (Linear) | SlugBase team (`SB-N`) — see [linear-board.md](linear-board.md) |
| Spec docs | `docs/internal/slugbase-*.md` — see [doc-index.md](doc-index.md) |
| Workspace memory | `.cursor/skills/workspace-notes.md` |
| Session memory | `.cursor/skills/agent-memory/active/<SESSION-ID>.md` — **local only** (gitignored) |
| Prompt templates | [prompt-templates.md](prompt-templates.md) |
| Slack session-end | [slack-session-end.md](slack-session-end.md) |

**Single-repo model.** Session memory and implementation commits live in `slugbase`. Lane S commits directly on **`staging`**; Lane P commits on task branches first, then integration merges to **`staging`**. **`main` is off-limits** for development and pushes.

---

## What the orchestrator does (and does not do)

### MAY do

- Read the **plan file** (full file): phases, task rows, dependencies, Doc Ref column, traceability matrix, exit criteria
- Read **Linear issue payloads** via MCP (`plugin-linear-linear`): title, description, relations, state — see [linear-board.md](linear-board.md)
- Read [doc-index.md](doc-index.md), [prompt-templates.md](prompt-templates.md), [linear-board.md](linear-board.md), and [slack-session-end.md](slack-session-end.md)
- Call Slack MCP (`plugin-slack-slack`) for **session-end DM** only — recipient resolution and send rules in [slack-session-end.md](slack-session-end.md)
- Read `.cursor/skills/workspace-notes.md`; write durable learnings there
- Use `TodoWrite` in **chat mode** / **Linear mode**
- In **plan-file mode**, edit the plan file for status reconciliation or **Lane P batch prep** (`[~]` at batch start)
- Launch sub-agents via the **Task** tool (`generalPurpose`, `best-of-n-runner`, `shell`, `explore`, `ci-investigator`)
- Set `run_in_background: true` on Task when dispatching parallel Lane P execution agents (max **3** concurrent on this host)
- List filenames in `agent-memory/active/` (names only, not contents)
- Ask clarifying questions

### MUST NOT do

- Read spec doc bodies (`docs/internal/slugbase-*.md`) — sub-agents read these (GitHub issue bodies **are** readable — they are the AC contract for board tasks)
- Read implementation files, diffs, test output, lint results, or logs
- Use `Read`, `Grep`, `Glob`, `ReadLints`, `Shell`, `ApplyPatch`, etc. on implementation work
- Summarize file contents from memory
- Edit repo files other than plan file, `workspace-notes.md`, `linear-board.md`, or this skill
- Paste spec doc bodies into sub-agent prompts — pass paths and `§` section refs
- Paste entire issue bodies — extract AC, file paths, doc refs, and deps
- Dispatch Lane P and Lane S tasks in the same batch
- Allow execution agents to commit to **`staging`** during an in-flight Lane P batch (integration agent only — merge commits)
- DM the Slack MCP authenticated user (`U0BB4FVDUNR` / `cursor@mdg-labs.dev`) as the notification recipient — always DM the **operator** per [slack-session-end.md](slack-session-end.md)

---

## Three task sources

| Source | Task IDs | AC lives in | Status tracking |
|---|---|---|---|
| **Roadmap** | `P1-03`, `P2-01`, … | Plan file row | Plan checkboxes `[x]`/`[!]` |
| **Linear Issues** | `SB-12`, `#12`, … | Issue description (Linear MCP) | Linear state + comment |
| **Ad-hoc** | User-named | User message | `TodoWrite` only |

**User intent wins:** if they say "implement SB-12", "#12", or give a Linear/GitHub issue URL → **Linear mode**, even though the roadmap exists.

## Three modes

|| **Plan-file mode** | **Linear mode** | **Chat mode** |
|---|---|---|
| **When** | Roadmap batch (`P*-*`) | Linear issue/epic (`SB-N` / `#N`) | Ad-hoc; no board or plan |
| **State** | `- [ ]` / `- [~]` / `- [x]` / `- [!]` in plan file | `TodoWrite` + Linear state | `TodoWrite` in chat |
| **In progress** | `[~]` (Lane S agent or Lane P batch prep) | Execution agent → Linear **In Progress** | todo `in_progress` |
| **Done** | Verifier → `[x]` on plan file | Verifier PASS → Linear **Done** + comment | todo `completed` after verify PASS |
| **Failed** | Verifier → `[!]` on plan file | Verifier → FAIL comment; Linear **Ready** | todo `pending` |

Pick mode on first turn:

- User names Linear issue (`SB-N`), GitHub issue (`#N`), URL, or epic → **Linear mode**
- User says orchestrate roadmap / phase → **plan-file mode**
- Otherwise → **chat mode**

Default to **plan-file mode** only when the user asks for roadmap work and did not name a tracker issue.

---

## Startup sequence

1. Confirm target is `/home/michael/projects/slugbase` (only repo).
2. Read `.cursor/skills/workspace-notes.md` (create on first durable note).
3. **Pick mode** (plan-file / Linear / chat) from user message.
4. **Plan-file:** read plan file — current phase, next TODO with satisfied deps, BLOCKED items.
5. **Linear:** load issue(s) via MCP `get_issue` / `list_issues`. For sub-issues, `get_issue` with `includeRelations: true`. Resolve synced GitHub `#N` from attachments when needed.
6. Confirm with user (briefly if intent is clear): mode, batch, lane (S vs P), commits in scope, Linear sync ON/OFF.
7. **Slack session-end:** note run override if user said `slack to <email>` or `slack to <user_id>`; skip entirely if user said `no slack` / `skip slack`. Otherwise default recipient from [slack-session-end.md](slack-session-end.md).

**Commits:** Orchestrated runs default to **local commits per task** on **`staging`** (Lane S) or task branches (Lane P). Each **orchestrator execution** commit is preceded by a **scoped CI gate** on touched packages only — not the full workspace gate. **Never push** unless the user explicitly asks — and **never push to `main`**. When pushing is requested, the pushing agent runs the **full CI gate** once before push (direct commit-and-push skips scoped gate; see `06-local-ci-before-commit.mdc`).

**Linear sync (default ON):** Orchestrator resolves `SB-N` + synced `#N`, then passes **role-specific** LINEAR SYNC blocks — execution prompts get **In Progress** only; verifier prompts set **Done**. Sub-agents perform updates — orchestrator does **not** call `save_issue` itself unless recovering from failure. Skip only if user says **"don't update Linear"**.

### Linear state ownership (non-negotiable)

| State | Who may set it | When |
|---|---|---|
| **In Progress** | **Execution** | First action, before session memory (leaf + epic parent when subtask) |
| **Done** | **Verifier** | After all verification layers PASS (Linear state only; GitHub issue state is never modified directly) |

---

## Dispatching sub-agents

When building a prompt:

1. **Task ID** — roadmap `P*-*` or Linear `SB-N` (+ synced `#N`)
2. **Acceptance criteria** — verbatim from plan row **or** extracted from issue body (bullets, not HTML)
3. **Doc references** — plan Doc Ref column **or** `§` sections cited in issue body ([doc-index.md](doc-index.md) shorthand)
4. Explicit READ / WRITE scope with absolute paths
5. Session ID: `<TASK-ID>-<YYYYMMDD>-<4hex>` — same for execution + verifier
6. **Lane** (`S` or `P`) and git context (branch, worktree, `STAGING_BASE_SHA` for Lane P)
7. **Epic context** — if parent epic (e.g. SB-8 / #8), note `PARENT`, sibling deps, and computed `CLOSE_PARENTS: linear=[…] github=[…]` (see § Linear epic batches)
8. **LINEAR TOOLS block** — **mandatory in every LINEAR SYNC prompt** (copy verbatim from [prompt-templates.md](prompt-templates.md))
9. **LINEAR SYNC block** — when task(s) are on SlugBase team, include role-specific blocks from [linear-board.md](linear-board.md):
   - **Execution prompt:** `save_issue` state → "In Progress" — **never** Done; when subtask, also list parent epic
   - **Verifier prompt:** state → "Done" (+ parent if final subtask); `save_comment` mandatory — **reply** on the GitHub-linked thread (`parentId`), not a new top-level comment
10. **DB MIGRATIONS block** — **mandatory in every execution prompt** (copy verbatim from [prompt-templates.md](prompt-templates.md) even when the task has no schema changes)
11. **SCOPED CI GATE block** — **mandatory in every execution and verifier prompt** (copy verbatim from [prompt-templates.md](prompt-templates.md))
12. **PLAN FILE GUARD block** — **mandatory** when the plan file is in WRITE SCOPE (execution) or for **every** verifier / batch verifier in plan-file mode (copy verbatim from [prompt-templates.md](prompt-templates.md) — fill `AUTHORIZED_TASK_ID`)

One prompt = one **leaf** task ID unless user requested batching or shared-file serialization requires it.

### Plan file — orchestrator pre-verifier gate

Before dispatching any **verifier** or **batch verifier** that will commit plan status:

1. Note `PLAN_FILE_PATH` (roadmap or initiative plan, e.g. `open-core-refactor-plan.md`).
2. Sub-agents run `git status` + `git diff` on that path (PLAN FILE GUARD) — orchestrator should **assume** dirty is possible.
3. If operator/orchestrator has **uncommitted** `[x]` / `[cancelled]` rows for tasks **other than** the leaf being verified → **commit a reconciliation chore first** (`chore(plan): reconcile TASK-… status`) **or** pass `PLAN_FILE_DIRTY: preserve` and instruct verifier **not** to commit plan (orchestrator commits after reconcile).
4. **Never** dispatch a verifier with only "mark TASK-N verified" and no PLAN FILE GUARD — that caused status-table regressions (see workspace-notes).

### Linear epic batches

When user asks to implement an **epic** (parent issue with sub-issues):

1. `get_issue` on epic with `includeRelations: true` → full sub-issue list.
2. Read epic description **Suggested implementation order** and dependency prose.
3. Build a **batch plan** (ordered list of leaf tasks); split cross-domain work by Lane rules.
4. Track epic parent: execution sets parent **In Progress** when any subtask starts; **last subtask verifier** sets parent **Done** when all in-scope subtasks PASS.
5. **Compute `CLOSE_PARENTS`** before each leaf dispatch:

   - **In-scope siblings** = sub-issues in the current epic/batch plan.
   - For leaf `L` with parent chain `P1 → P2 → … → Pn`, include `Pi` in `CLOSE_PARENTS` when every other in-scope sibling under `Pi` has Linear state **Done** or **Closed**.
   - Pass `CLOSE_PARENTS: linear=[SB-P, …] github=[#P, …]` or `none` — execution agents must not guess.

   ```text
   # Example: SB-1 epic; SB-13 is last UI child (SB-10) but SB-1 still has open branches
   CLOSE_PARENTS: linear=[SB-10] github=[10]

   # Later: last remaining child under SB-1
   CLOSE_PARENTS: linear=[SB-1] github=[1]
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

**Parallel Lane P:** dispatch execution agents with `run_in_background: true` — **max 3 concurrent sub-agents** on this host (Ubuntu 26.04 LTS desktop; see workspace-notes).

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
| **P — Parallel isolated** | 2–3 tasks (hard cap: **3 concurrent sub-agents**); deps satisfied; disjoint WRITE scopes; no shared-file contention | **Worktree + `orchestrator/<TASK-ID>` per task** | Integration agent + batch verifier only |
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
6. Branch verifier PASS → report to orchestrator; no plan file write; Linear Done is the handoff record
7. Branch verifier FAIL → append VERIFICATION FAILED in local session memory; do not merge
8. Integration agent: merge PASS branches onto **`staging`** (dependency order, one at a time)
9. Batch verifier: post-merge **scoped** smoke on union of packages touched by integrated tasks (not full workspace gate); [x] integrated tasks; [!] branch-failed tasks
10. Cleanup agent (shell): remove worktrees; delete merged task branches
```

### Worktree conventions

```text
Branch:    orchestrator/<TASK-ID>
Worktree:  ../slugbase-wt-<TASK-ID>   # sibling of repo root, or subagent-managed path
Base:      STAGING_BASE_SHA           # do not chase moving staging during execution
```

**No `node_modules` in worktrees.** Git worktrees are bare checkouts — they start without `node_modules`. The sub-agent (execution or verifier) **must** run `pnpm install` as the very first action after Linear In Progress (execution) or before verification checks (verifier). This is enforced by the WORK DEP block in the Lane P prompt templates. The install step is the sub-agent's responsibility, not the orchestrator's.

---

## Execution agents

### Lane S (serial on `staging`)

1. **Linear (first action when LINEAR SYNC present):** `save_issue` state → **"In Progress"** for every listed leaf issue **and** epic parent issue
2. **Session memory** — create `active/<SESSION-ID>.md`; record `started` timestamp
3. **Implementation** — task files only
4. **Pre-commit — scoped CI gate** — map staged paths → `@slugbase/<pkg>` filter(s) per `06-local-ci-before-commit.mdc`; run scoped gate via `with-ci-env.sh`; on failure → blocked, no commit. **Do not** run full workspace gate.
5. **Pre-handoff** — set `ended` + `duration`; `save_issue` state → **"In Review"** for each leaf issue → **single implementation commit** (task files only; keys in body only; never commit session memory)

Never push to **`main`**. When pushing is explicitly requested, target **`staging`** only. Stage explicit paths only. Stop if branch ≠ **`staging`**.

Execution may set `[~]` only when plan file is in WRITE SCOPE. Never `[x]`.

**Linear FORBIDDEN for execution:** never set GitHub issue state (open/closed); never `save_comment` for verification outcomes; never set epic Done — verifier only.

### Lane P (isolated task branch)

Same flow on **`orchestrator/<TASK-ID>` only** — one implementation commit per task.

- Work only in assigned worktree / branch.
- Never checkout **`staging`**, never merge, never push (during Lane P execution).
- Plan file: **read-only**.
- If `git status` shows unexpected changes outside WRITE SCOPE → `blocked`.
- **Pre-commit — scoped CI gate** (same rules as Lane S step 4) before implementation commit.

### Commit messages

Every task commit: **key-free subject**; dual `fixes` lines in body — see `.cursor/rules/07-issue-commit-linking.mdc`.

```
feat(auth): implement server-side session store with configurable TTL

fixes SB-12
fixes #612
```

**Epic subtasks:** body always includes `fixes SB-<leaf>` + `fixes #<leaf>`. Add parent lines **only** for issues in `CLOSE_PARENTS`.

```text
# Intermediate subtask under epic SB-8 / #8
fixes SB-11
fixes #11

# Final in-scope child of epic SB-8 / #8
fixes SB-12
fixes #12
fixes SB-8
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

**Layer 2 — Scoped automated checks** derived from **committed paths** (see plan Tests column, else [doc-index.md](doc-index.md); full rules in `06-local-ci-before-commit.mdc`):

```bash
bash scripts/with-ci-env.sh pnpm turbo run lint typecheck test:unit build --filter=@slugbase/<pkg>
# integration only when that package defines test:integration and the task warrants it:
bash scripts/with-ci-env.sh pnpm turbo run test:integration --filter=@slugbase/backend
```

Map committed paths → `@slugbase/<pkg>` filter(s). Contract packages (`shared-types`, `ui`) use `...` suffix. Mark `n/a` for commands not yet defined. Stop if any defined check fails. Use Phase (`phase run --`) when env required (via `with-ci-env.sh`). **Do not** run the full workspace gate — full gate is pre-push only.

**Layer 3 — Logic review:**

- 3a. Each acceptance criterion — genuinely implemented?
- 3b. Doc contract — spec `§` deviations with file:line + fix hint
- 3c. Security baseline — server-side sessions (not JWT), no logged secrets, SSRF-safe egress, encrypted at-rest secrets, CSRF exempt list not widened; no deployment-mode branches (03-security-baseline.mdc)
- 3c2. Env vars — any new var fully registered (Phase + .env.example + schema + docs)? (05-env-vars.mdc)
- 3c3. Issue commit link — subject key-free (`[P*-*]` roadmap-only); body includes `fixes SB-<leaf>` AND `fixes #<leaf>` when Linear-tracked; parent lines only per `CLOSE_PARENTS` (07-issue-commit-linking.mdc)
- 3c4. Linear state only — agents must never set GitHub issue state (open/closed); status via `save_issue` state; verifying code that closes GitHub issues directly → **FAIL**
- 3d. DB migrations — hand-written migration SQL or hand-created migration directories → **FAIL**
- 3e. Stubs, TODO/FIXME, placeholder values, `isCloud`/deployment-mode branches → **FAIL**
- 3c5. Plan file integrity — PLAN FILE GUARD; plan commit that changes rows outside the verified task, or commit while `PLAN_FILE_BLOCKED`, or `git restore` on plan file → **FAIL**

| Result | Plan (plan-file mode) | GitHub (sub-agent) | Local session memory |
|---|---|---|---|
| PASS | `[x]` on **that task row only**; commit plan if not BLOCKED | Verifier → mandatory PASS comment (GitHub-thread reply) + Linear Done | Delete active or move to local archive/ (never commit) |
| FAIL | `[!]` on **that task row only**; commit plan if not BLOCKED | Verifier → FAIL comment (GitHub-thread reply); Linear Ready; do NOT set Done | Append VERIFICATION FAILED in active/ (never commit) |
| BLOCKED (dirty plan) | **No plan commit** — orchestrator reconciles | n/a or comment only if sync ON | Report `PLAN_FILE_BLOCKED` |

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
| Phase 1 | Execution | Create `active/<SESSION-ID>.md`; header + Task; set `started` when LINEAR SYNC present |
| Phase 2 | Execution | Update Scope, Decisions, Deviations in place |
| Phase 3 | Execution | Finalize sections locally (do not commit) |
| Pre-handoff | Execution | Set `ended` + `duration`; set Status **In Review**; **one implementation commit** |
| Verifier start | Verifier | Read active file if present; set verification `started` when LINEAR SYNC present |
| Verifier end | Verifier | Set verification `ended` + `duration`; set Linear state Done/Ready; mandatory comment (reply on GitHub-linked thread) |
| PASS | Verifier | Mandatory PASS comment as thread reply + Linear Done; optionally delete active or move to local `archive/` |
| FAIL | Verifier | Mandatory FAIL comment as thread reply; append VERIFICATION FAILED in active/ if file exists |

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

Store only durable knowledge: conventions, build/test quirks, Phase/env notes, recurring verify failures, Lane P merge conflict patterns.

```markdown
## <topic>

<2-4 lines>
_added: YYYY-MM-DD_
```

Orchestrator may read/write. Sub-agents may read; write only if task WRITE SCOPE includes it.

---

## Minimal run loop

1. Read workspace-notes; pick mode (plan-file / Linear / chat).
2. **Plan-file:** read plan file, next TODO. **Linear:** load issue/epic/sub-issues via MCP.
3. Identify next tasks (deps satisfied — plan rows, Linear blockedBy, epic prose order).
4. Map doc refs → paths (plan Doc Ref or issue body `§` citations; orchestrator does **not** open spec doc bodies).
5. Choose lane: **S**, **P**, or **B** (blocked → split or serialize).
6. Generate SESSION ID per leaf task; if Lane P, record `BATCH_ID` + `STAGING_BASE_SHA`.
7. Batch prep: plan `[~]` / todos `in_progress` (orchestrator does **not** set Linear In Progress — execution agent does).
8. Spawn execution sub-agent(s) — `best-of-n-runner` + `run_in_background: true` for Lane P (max **3** concurrent).
9. Collect: local SESSION ID path, implementation SHA, scopes, paths, status per task.
10. Spawn one **branch verifier** per Lane P task, or one **task verifier** for Lane S.
11. Lane P: spawn **integration agent** → **batch verifier**.
12. Lane P: spawn **cleanup** shell agent for worktrees/branches.
13. Reconcile: PASS → plan `[x]` / confirm Linear Done comment; FAIL → plan `[!]` / retry same SESSION ID.
14. **Linear epic:** if subtask execution skipped epic In Progress, orchestrator recovery → epic **In Progress**; if all subtasks PASS and epic not yet Done, recovery → set epic Done; or ensure last verifier prompt included epic keys.
15. Update workspace-notes if durable learning.
16. Report batch result + next batch.
17. Repeat until no further batches (scope done, blocked, or user stop).
18. **Session-end Slack DM** — when the run loop exits (step 17 does not continue), send operator notification per [slack-session-end.md](slack-session-end.md) unless skipped at startup. Confirm in chat with permalink or `SLACK_DM: SKIPPED (reason)`.

---

## Session-end Slack DM

Send **once** when the orchestrator run loop exits (all planned work done, hard block, or user scope satisfied — not after every batch while auto-continuing). Use MCP `plugin-slack-slack` → `slack_send_message`. Recipient resolution: [slack-session-end.md](slack-session-end.md).

**Message template** (fill placeholders; omit empty sections):

```markdown
**SlugBase orchestrator — run complete**

- **Mode:** <plan-file | Linear | chat>
- **Scope:** <e.g. P1-03–P1-05 | #12 epic | ad-hoc task list>
- **Lane:** <S | P | mixed across batches>
- **Result:** <N passed · M failed · K blocked>

**Tasks**
<one line per task: TASK-ID or #N — PASS | FAIL | blocked — one-line summary>

**Next**
<recommended next batch, retry, or "none — scope complete">

**Notes**
<optional: integration conflicts, durable workspace-notes updates, operator action needed>
```

After send, confirm in chat: `Slack DM sent to <operator display name> (from cursor@mdg-labs.dev)` + message permalink from MCP response.

---

## Anti-patterns

- Orchestrator reading spec **doc** bodies or implementation files (GitHub issue bodies are OK)
- Orchestrator reading session memory **contents** (filenames in `active/` only)
- Pasting spec doc bodies or full issue bodies into sub-agent prompts
- Editing roadmap checkboxes for GitHub-only issues (#N)
- Setting epic to Done before all in-scope subtasks verify PASS
- **Sub-agent skipping Linear sync** when LINEAR SYNC block is present
- **Agent setting GitHub issue state (open/closed)** — Linear state only; never modify GitHub issue state directly
- **Execution agent confusing REQUIRED OUTPUT `complete` with Linear Done**
- Execution agent starting implementation before setting In Progress (when sync required)
- Execution agent setting In Progress on subtask without parent
- Verifier setting In Progress (execution owns that)
- Committing session memory files to git (local only; Linear thread reply is the durable record)
- **Top-level Linear comments when a GitHub-linked thread exists** — use `list_comments` + `save_comment` with `parentId` so comments sync to the mirrored GitHub issue thread (see [linear-board.md](linear-board.md) § Comment threading)
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
- **Task commits missing body `fixes SB-N` + `fixes #N`** when Linear sync was in scope
- **Issue keys in commit subject** when Linear sync was in scope
- **Parent `fixes` lines on non-final subtask** — premature epic auto-close on `main`
- **Omitting parent `fixes` when `CLOSE_PARENTS` lists the parent** — epic stays open after release
- **Execution agent hand-writing DB migrations** — schema change → migration CLI only (see DB MIGRATIONS block in every execution prompt)
- **Orchestrator omitting DB MIGRATIONS block** from an execution prompt
- **Deployment-mode branches in code** — `isCloud`, `SLUGBASE_MODE` checks are forbidden; use entitlements engine (spec §15)
- **Session-end Slack DM to service account** — recipient must be the operator (`U0ARDEK75UJ` by default), never `U0BB4FVDUNR`
- **Skipping session-end Slack without reason** — only when user said `no slack` / `skip slack`, or recipient unresolved per [slack-session-end.md](slack-session-end.md)
- **Running full CI gate before every task commit** — use scoped gate at commit/verify; full gate only before push
- **Pushing without running full CI gate first** — mandatory pre-push per `06-local-ci-before-commit.mdc`
- **Running scoped gate with no `--filter`** — accidental full workspace run
- **Orchestrator omitting SCOPED CI GATE block** from an execution or verifier prompt
- **Orchestrator omitting PLAN FILE GUARD** from a verifier / batch-verifier prompt in plan-file mode
- **Verifier committing plan file from stale HEAD** while working tree has other uncommitted `[x]` rows — use PLAN FILE GUARD; BLOCKED if dirty outside authorized row
- **Verifier rewriting or reverting task status rows** it did not verify (e.g. `[x]`→`[ ]` on TASK-007–011) — immediate FAIL Layer 3c5
- **`git checkout --` / `git restore` on plan file** to "fix" a bad commit — forbidden; orchestrator reconciles from operator snapshot
