---
name: orchestrator
description: Run a chat as a pure orchestrator for SlugBase. Reads the development roadmap and/or the Jira SB project board to find work, dispatches sub-agents with doc references (not pasted spec content), and runs verification after each batch. Execution agents set Jira In Progress (leaf + epic parent when subtask); only verification agents set Done after PASS. Use when the user asks to orchestrate, delegate end-to-end, execute the roadmap, implement a Jira issue/epic (e.g. SB-12), or coordinate parallel implementation tasks.
---

# Orchestrator (SlugBase)

The main agent in this chat is a **dispatcher only**. It reads the **roadmap** and/or **Jira board**, decides what to run next, and hands implementation to sub-agents. Sub-agents read spec docs and implementation files themselves.

## Workspace

| Item | Value |
|---|---|
| Repo | `/home/michael/projects/slugbase` |
| Integration branch | `staging` (all verified work lands here) |
| Production branch | `main` — **protected on GitHub**; no development; **never push** from agents |
| Task branch (Lane P) | `orchestrator/<TASK-ID>` (isolated; merged after verify PASS) |
| Worktree (Lane P) | Sibling dir `../slugbase-wt-<TASK-ID>` or subagent-managed |
| Plan file | `docs/slugbase-development-roadmap.md` |
| Task board (Jira) | SlugBase board — see [jira-board.md](jira-board.md) |
| Spec docs | `docs/slugbase-*.md` — see [doc-index.md](doc-index.md) |
| Workspace memory | `.cursor/skills/workspace-notes.md` |
| Session memory | `.cursor/skills/agent-memory/active/<SESSION-ID>.md` — **local only** (gitignored) |
| Prompt templates | [prompt-templates.md](prompt-templates.md) |

**Single-repo model.** Session memory and implementation commits live in `slugbase`. Lane S commits directly on **`staging`**; Lane P commits on task branches first, then integration merges to **`staging`**. **`main` is off-limits** for development and pushes.

---

## What the orchestrator does (and does not do)

### MAY do

- Read the **plan file** (full file): phases, task rows, dependencies, Doc Ref column, traceability matrix, exit criteria
- Read **Jira issue payloads** via MCP (`plugin-atlassian-atlassian`): task title, description, subtasks, dependencies, status — see [jira-board.md](jira-board.md)
- Read [doc-index.md](doc-index.md), [prompt-templates.md](prompt-templates.md), and [jira-board.md](jira-board.md)
- Read `.cursor/skills/workspace-notes.md`; write durable learnings there
- Use `TodoWrite` in **chat mode** / **Jira mode**
- In **plan-file mode**, edit the plan file for status reconciliation or **Lane P batch prep** (`[~]` at batch start)
- Launch sub-agents via the **Task** tool (`generalPurpose`, `best-of-n-runner`, `shell`, `explore`, `ci-investigator`)
- Set `run_in_background: true` on Task when dispatching parallel Lane P execution agents
- List filenames in `agent-memory/active/` (names only, not contents)
- Ask clarifying questions

### MUST NOT do

- Read spec doc bodies (`docs/slugbase-*.md`) — sub-agents read these (Jira issue descriptions **are** readable — they are the AC contract for board tasks)
- Read implementation files, diffs, test output, lint results, or logs
- Use `Read`, `Grep`, `Glob`, `ReadLints`, `Shell`, `ApplyPatch`, etc. on implementation work
- Summarize file contents from memory
- Edit repo files other than plan file, `workspace-notes.md`, `jira-board.md`, or this skill
- Paste spec doc bodies into sub-agent prompts — pass paths and `§` section refs
- Paste entire full Jira ADF description bodies — extract AC, file paths, doc refs, and deps
- Dispatch Lane P and Lane S tasks in the same batch
- Allow execution agents to commit to **`staging`** during an in-flight Lane P batch (integration agent only — merge commits)

---

## Three task sources

| Source | Task IDs | AC lives in | Status tracking |
|---|---|---|---|
| **Roadmap** | `P1-03`, `P2-01`, … | Plan file row | Plan checkboxes `[x]`/`[!]` |
| **Jira** | `SB-12`, `SB-8`, … | Issue description (MCP) | Jira status + optional comment |
| **Ad-hoc** | User-named | User message | `TodoWrite` only |

**User intent wins:** if they say "implement SB-12" or give a Jira URL → **Jira mode**, even though the roadmap exists.

## Three modes

| | **Plan-file mode** | **Jira mode** | **Chat mode** |
|---|---|---|---|
| **When** | Roadmap batch (`P*-*`) | Jira issue/epic (`SB-*`) | Ad-hoc; no board or plan |
| **State** | `- [ ]` / `- [~]` / `- [x]` / `- [!]` in plan file | `TodoWrite` + Jira status | `TodoWrite` in chat |
| **In progress** | `[~]` (Lane S agent or Lane P batch prep) | Execution agent → Jira **In Progress** | todo `in_progress` |
| **Done** | Verifier → `[x]` on plan file | Verifier PASS → Jira **Done** | todo `completed` after verify PASS |
| **Failed** | Verifier → `[!]` on plan file | Verifier → `addCommentToJiraIssue`; stay In Progress | todo `pending` |

Pick mode on first turn:

- User names Jira issue/URL/epic → **Jira mode**
- User says orchestrate roadmap / phase → **plan-file mode**
- Otherwise → **chat mode**

Default to **plan-file mode** only when the user asks for roadmap work and did not name a Jira issue.

---

## Startup sequence

1. Confirm target is `/home/michael/projects/slugbase` (only repo).
2. Read `.cursor/skills/workspace-notes.md` (create on first durable note).
3. **Pick mode** (plan-file / Jira / chat) from user message.
4. **Plan-file:** read plan file — current phase, next TODO with satisfied deps, BLOCKED items.
5. **Jira:** load issue(s) via MCP `getJiraIssue` or `searchJiraIssuesUsingJql` (`parent = SB-N` for epic children). Resolve transition IDs via `getTransitionsForJiraIssue` once per session.
6. Confirm with user (briefly if intent is clear): mode, batch, lane (S vs P), commits in scope, Jira sync ON/OFF.

**Commits:** Orchestrated runs default to **local commits per task** on **`staging`** (Lane S) or task branches (Lane P). **Never push** unless the user explicitly asks — and **never push to `main`**.

**Jira sync (default ON):** Orchestrator resolves `cloudId`, issue key(s), and transition IDs via MCP, then passes **role-specific** JIRA SYNC blocks — execution prompts get **In Progress only** (no `transitionIdDone`); verifier prompts get **Done**. Sub-agents perform the updates — orchestrator does **not** call `transitionJiraIssue` itself unless recovering from a sub-agent failure. Skip only if user says **"don't update Jira"**.

### Jira status ownership (non-negotiable)

| Column | Who may set it | When |
|---|---|---|
| In Progress | **Execution** | First action, before session memory (leaf + epic parent when subtask) |
| Done | **Verifier** | After all verification layers PASS only |

---

## Dispatching sub-agents

When building a prompt:

1. **Task ID** — roadmap `P*-*` or Jira `SB-*`
2. **Acceptance criteria** — verbatim from plan row **or** extracted from Jira issue description (bullets, not HTML)
3. **Doc references** — plan Doc Ref column **or** `§` sections cited in Jira issue description ([doc-index.md](doc-index.md) shorthand)
4. Explicit READ / WRITE scope with absolute paths
5. Session ID: `<TASK-ID>-<YYYYMMDD>-<4hex>` — same for execution + verifier
6. **Lane** (`S` or `P`) and git context (branch, worktree, `STAGING_BASE_SHA` for Lane P)
7. **Epic context** — if parent epic (e.g. SB-8), note parent key and sibling deps in prompt header
8. **JIRA SYNC block** — when task(s) are on the board, include role-specific blocks from [jira-board.md](jira-board.md):
   - **Execution prompt:** `transitionIdInProgress: 21` only — **never** include `transitionIdDone`; when subtask, also list parent epic key
   - **Verifier prompt:** `transitionIdDone: 41` (+ optional epic key for final subtask)
9. **JIRA TIME TRACKING block** — copy verbatim from [prompt-templates.md](prompt-templates.md) into both execution and verifier prompts when JIRA SYNC is present
10. **DB MIGRATIONS block** — **mandatory in every execution prompt** (copy verbatim from [prompt-templates.md](prompt-templates.md) even when the task has no schema changes)

One prompt = one **leaf** task ID unless user requested batching or shared-file serialization requires it.

### Jira epic batches

When user asks to implement an **epic** (parent task with subtasks):

1. `getJiraIssue` epic + JQL `parent = SB-N` → full subtask list.
2. Read epic description **Suggested implementation order** and dependency prose.
3. Build a **batch plan** (ordered list of leaf tasks); split cross-domain work by Lane rules.
4. Track epic parent: execution marks epic **In Progress** when any subtask starts; orchestrator or **last subtask verifier** marks epic **Done** only when all in-scope subtasks PASS.

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
6. Branch verifier PASS → report to orchestrator; no plan file write; Jira Done comment is the handoff record
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

---

## Execution agents

### Lane S (serial on `staging`)

1. **Jira (first action when JIRA SYNC present):** `transitionJiraIssue` → **In Progress** for every listed leaf key **and** epic parent key
2. **Session memory** — create `active/<SESSION-ID>.md`; record `started` timestamp
3. **Implementation** — task files only
4. **Pre-handoff** — set `ended` + `duration`; `addWorklogToJiraIssue` on each leaf key; `transitionJiraIssue` → **In Review** → **single implementation commit** (task files only; never commit session memory)

Never push to **`main`**. When pushing is explicitly requested, target **`staging`** only. Stage explicit paths only. Stop if branch ≠ **`staging`**.

Execution may set `[~]` only when plan file is in WRITE SCOPE. Never `[x]`.

**Jira FORBIDDEN for execution:** never call `transitionJiraIssue` with Done; never call `addCommentToJiraIssue` for verification outcomes; never set epic Done.

### Lane P (isolated task branch)

Same flow on **`orchestrator/<TASK-ID>` only** — one implementation commit per task.

- Work only in assigned worktree / branch.
- Never checkout **`staging`**, never merge, never push (during Lane P execution).
- Plan file: **read-only**.
- If `git status` shows unexpected changes outside WRITE SCOPE → `blocked`.

### Commit messages

Every task commit must include `[SB-N]` or `[P*-*]` — see `.cursor/rules/07-jira-commit-linking.mdc`.

```
feat(auth)[SB-12]: implement server-side session store with configurable TTL
fix(go)[SB-31]: handle missing slug gracefully in redirect endpoint
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
- 3c3. Jira commit link — subject includes `[SB-N]` or `[P*-*]`; no Smart Commit commands (07-jira-commit-linking.mdc)
- 3d. DB migrations — hand-written migration SQL or hand-created migration directories → **FAIL**
- 3e. Stubs, TODO/FIXME, placeholder values, `isCloud`/deployment-mode branches → **FAIL**

| Result | Plan (plan-file mode) | Jira (sub-agent) | Local session memory |
|---|---|---|---|
| PASS | `[x]`; commit plan file | Verifier → **Done** + mandatory Done comment | Delete active or move to local archive/ (never commit) |
| FAIL | `[!]` + note; commit plan file | Verifier → **Ready** + FAIL comment; do NOT set Done | Append VERIFICATION FAILED in active/ (never commit) |

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
| Phase 1 | Execution | Create `active/<SESSION-ID>.md`; header + Task; set `started` when JIRA SYNC present |
| Phase 2 | Execution | Update Scope, Decisions, Deviations in place |
| Phase 3 | Execution | Finalize sections locally (do not commit) |
| Pre-handoff | Execution | Set `ended` + `duration`; worklog + In Review; **one implementation commit** |
| Verifier start | Verifier | Read active file if present; set verification `started` when JIRA SYNC present |
| Verifier end | Verifier | Set verification `ended` + `duration`; worklog; Jira comment + Done/Ready transition |
| PASS | Verifier | Mandatory Jira Done comment; optionally delete active or move to local `archive/` |
| FAIL | Verifier | Mandatory Jira FAIL comment; append VERIFICATION FAILED in active/ if file exists |

**Retry after FAIL:** same SESSION ID; execution reads Jira FAIL comment and local active file.

### Session file template

```markdown
# Session: <SESSION-ID>

_task: <TASK-ID> | started: <ISO 8601 UTC> | ended: <ISO or pending> | duration: <e.g. 1h 32m or pending> | agent: execution_

## Task

<one line from plan>

## Time tracking

- **Execution started:** <ISO>
- **Execution ended:** <ISO>
- **Duration:** <human-readable>
- **Jira worklog:** <leaf keys + timeSpent logged, or n/a>

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

_verification started: <ISO> | ended: <ISO> | duration: <human> | Jira worklog: <keys or n/a>_
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

1. Read workspace-notes; pick mode (plan-file / Jira / chat).
2. **Plan-file:** read plan file, next TODO. **Jira:** load issue/epic/children via MCP.
3. Identify next tasks (deps satisfied — plan rows, Jira issue links, epic prose order).
4. Map doc refs → paths (plan Doc Ref or Jira description `§` citations; orchestrator does **not** open spec doc bodies).
5. Choose lane: **S**, **P**, or **B** (blocked → split or serialize).
6. Generate SESSION ID per leaf task; if Lane P, record `BATCH_ID` + `STAGING_BASE_SHA`.
7. Batch prep: plan `[~]` / todos `in_progress` (orchestrator does **not** set Jira In Progress — execution agent does).
8. Spawn execution sub-agent(s) — `best-of-n-runner` + `run_in_background: true` for Lane P.
9. Collect: local SESSION ID path, implementation SHA, scopes, paths, status per task.
10. Spawn one **branch verifier** per Lane P task, or one **task verifier** for Lane S.
11. Lane P: spawn **integration agent** → **batch verifier**.
12. Lane P: spawn **cleanup** shell agent for worktrees/branches.
13. Reconcile: PASS → plan `[x]` / confirm Jira Done comment; FAIL → plan `[!]` / retry same SESSION ID.
14. **Jira epic:** if subtask execution skipped epic In Progress, orchestrator recovery → epic **In Progress**; if all subtasks PASS and epic not yet Done, recovery → epic **Done** (or ensure last verifier prompt included epic key).
15. Update workspace-notes if durable learning.
16. Report batch result + next batch.
17. Repeat.

---

## Anti-patterns

- Orchestrator reading spec **doc** bodies or implementation files (Jira issue descriptions are OK)
- Orchestrator reading session memory **contents** (filenames in `active/` only)
- Pasting spec doc bodies or full Jira ADF descriptions into sub-agent prompts
- Editing roadmap checkboxes for Jira-only issues (SB-N)
- Marking Jira epic Done before all in-scope subtasks verify PASS
- **Sub-agent skipping Jira sync** when JIRA SYNC block is present
- **Sub-agent skipping Jira worklog** when JIRA SYNC block is present
- **Execution agent setting Jira Done** — only verifier after PASS
- **Execution agent confusing REQUIRED OUTPUT `complete` with Jira Done**
- Execution agent starting implementation before Jira In Progress (when sync required)
- Execution agent setting a subtask In Progress without setting epic parent In Progress
- Verifier setting Jira In Progress (execution owns that)
- Committing session memory files to git (local only; Jira comment is the durable record)
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
- **Task commits without `[SB-N]` or `[P*-*]` in subject** when Jira sync was in scope
- **Smart Commit commands in commit messages** (`#time`, `#comment`, `#resolve`) — MCP owns Jira sync
- **Execution agent hand-writing DB migrations** — schema change → migration CLI only (see DB MIGRATIONS block in every execution prompt)
- **Orchestrator omitting DB MIGRATIONS block** from an execution prompt
- **Deployment-mode branches in code** — `isCloud`, `SLUGBASE_MODE` checks are forbidden; use entitlements engine (spec §15)
