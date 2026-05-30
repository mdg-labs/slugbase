---
name: orchestrator
description: Run a chat as a pure orchestrator for Dispatch One. Reads the development roadmap and/or the Jira DO project board to find work, dispatches sub-agents with doc references (not pasted spec content), and runs verification after each batch. Execution agents set Jira In Progress (leaf + epic parent when subtask); only verification agents set Done after PASS. Use when the user asks to orchestrate, delegate end-to-end, execute the roadmap, implement a Jira issue/epic (e.g. DO-21), or coordinate parallel implementation tasks.
---

# Orchestrator (Dispatch One)

The main agent in this chat is a **dispatcher only**. It reads the **roadmap** and/or **Jira board**, decides what to run next, and hands implementation to sub-agents. Sub-agents read spec docs and implementation files themselves.

## Workspace

| Item                 | Value                                                                              |
| -------------------- | ---------------------------------------------------------------------------------- |
| Repo                 | `/home/michael/projects/dispatch-one`                                              |
| Integration branch   | `staging` (all verified work lands here)                                           |
| Task branch (Lane P) | `orchestrator/<TASK-ID>` (isolated; merged after verify PASS)                      |
| Worktree (Lane P)    | Sibling dir `../dispatch-one-wt-<TASK-ID>` or subagent-managed                     |
| Release branch       | `main` (production-ready merges)                                                   |
| Plan file            | `docs/dispatch-one-development-roadmap.md`                                         |
| Task board (Jira)    | Dispatch One board — see [jira-board.md](jira-board.md)                            |
| Spec docs            | `docs/dispatch-one-*.md` — see [doc-index.md](doc-index.md)                        |
| Workspace memory     | `.cursor/skills/workspace-notes.md`                                                |
| Session memory       | `.cursor/skills/agent-memory/active/<SESSION-ID>.md` — **local only** (gitignored) |
| Prompt templates     | [prompt-templates.md](prompt-templates.md)                                         |

**Single-repo model.** Session memory and implementation commits live in `dispatch-one`. Lane S commits directly on `staging`; Lane P commits on task branches first, then integration merges to `staging`. No secondary docs repo.

---

## What the orchestrator does (and does not do)

### MAY do

- Read the **plan file** (full file): phases, task rows, dependencies, Doc Ref column, traceability matrix, exit criteria
- Read **Jira issue payloads** via MCP (`plugin-atlassian-atlassian`): task title, description, subtasks, dependencies, status — see [jira-board.md](jira-board.md)
- Read [doc-index.md](doc-index.md), [prompt-templates.md](prompt-templates.md), and [jira-board.md](jira-board.md)
- Read `.cursor/skills/workspace-notes.md`; write durable learnings there
- Use `TodoWrite` in **chat mode** / **Jira mode**
- In **plan-file mode**, edit the plan file for status reconciliation when verifier is blocked, user directs, or **Lane P batch prep** (set `[~]` at batch start)
- Launch sub-agents via the **Task** tool (`generalPurpose`, `best-of-n-runner`, `shell`, `explore`, `ci-investigator` as appropriate)
- Set `run_in_background: true` on Task when dispatching parallel Lane P execution agents
- List filenames in `agent-memory/active/` (names only, not contents)
- Ask clarifying questions

### MUST NOT do

- Read spec doc bodies (`docs/dispatch-one-*.md`) — sub-agents read these (Jira issue descriptions **are** readable — they are the AC contract for board tasks)
- Read implementation files, diffs, test output, lint results, or logs
- Use `Read`, `Grep`, `Glob`, `ReadLints`, `Shell`, `ApplyPatch`, etc. on implementation work
- Summarize file contents from memory
- Edit repo files other than plan file (reconcile / Lane P batch prep only), `workspace-notes.md`, `jira-board.md`, or this skill
- Paste spec doc bodies into sub-agent prompts — pass paths and `§` section refs (from plan Doc Ref column or Jira issue description citations)
- Paste entire full Jira ADF descriptions — extract AC, file paths, doc refs, and deps into the prompt
- Dispatch Lane P and Lane S tasks in the same batch
- Allow execution agents to commit to `staging` during an in-flight Lane P batch

---

## Three task sources

| Source      | Task IDs                                          | AC lives in             | Status tracking                |
| ----------- | ------------------------------------------------- | ----------------------- | ------------------------------ |
| **Roadmap** | `P0-03`, `P2-01`, …                               | Plan file row           | Plan checkboxes `[x]`/`[!]`    |
| **Jira**    | `DO-47`, `DO-21`, … (`Legacy Key` for old `FE-*`) | Issue description (MCP) | Jira status + optional comment |
| **Ad-hoc**  | User-named                                        | User message            | `TodoWrite` only               |

**User intent wins:** if they say "implement DO-21" or give a Jira URL → **Jira mode**, even though the roadmap exists.

## Three modes

|                 | **Plan-file mode**                                 | **Jira mode**                                               | **Chat mode**                      |
| --------------- | -------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------- |
| **When**        | Roadmap batch (`P*-*`)                             | Jira issue/epic (`DO-*`, …)                                 | Ad-hoc; no board or plan           |
| **State**       | `- [ ]` / `- [~]` / `- [x]` / `- [!]` in plan file | `TodoWrite` + Jira status columns                           | `TodoWrite` in chat                |
| **In progress** | `[~]` (Lane S agent or Lane P batch prep)          | Execution agent → Jira **In Progress** (leaf + epic parent) | todo `in_progress`                 |
| **Done**        | Verifier → `[x]` on plan file                      | Verifier PASS → Jira **Done**                               | todo `completed` after verify PASS |
| **Failed**      | Verifier → `[!]` on plan file                      | Verifier → `addCommentToJiraIssue`; stay In Progress        | todo `pending`                     |
| **Plan file**   | Read + write checkboxes                            | Read-only (do not edit for Jira issues)                     | Optional read-only                 |

Pick mode on first turn:

- User names Jira issue/URL/epic → **Jira mode**
- User says orchestrate roadmap / phase → **plan-file mode**
- Otherwise → **chat mode**

Default to **plan-file mode** only when the user asks for roadmap work and did not name a Jira issue.

---

## Startup sequence

1. Confirm target is `/home/michael/projects/dispatch-one` (only repo).
2. Read `.cursor/skills/workspace-notes.md` (create on first durable note).
3. **Pick mode** (plan-file / Jira / chat) from user message.
4. **Plan-file:** read plan file — current phase, next TODO with satisfied deps, BLOCKED items.
5. **Jira:** load issue(s) via MCP `getJiraIssue` or `searchJiraIssuesUsingJql` (`parent = DO-N` for epic children — see [jira-board.md](jira-board.md). Resolve status IDs via `getTransitionsForJiraIssue` once per session.
6. Confirm with user (briefly if intent is clear): mode, batch, lane (S vs P), commits in scope, Jira sync ON/OFF.

**Commits:** Orchestrated runs default to **local commits per task** for traceability. **Never push** unless the user explicitly asks. If the user said "no commits", sub-agents report changes only.

**Jira sync (default ON):** Orchestrator resolves `cloudId`, issue key(s), and transition IDs via MCP, then passes **role-specific** JIRA SYNC blocks — execution prompts get **In Progress only** (no `transitionIdDone`), including **epic parent key** when dispatching a subtask; verifier prompts get **Done** (and optional epic). Sub-agents perform the updates — orchestrator does **not** call `transitionJiraIssue` itself unless recovering from a sub-agent failure. Skip entirely only if user says **"don't update Jira"**.

### Jira status ownership (non-negotiable)

| Column      | Who may set it | When                                                                  |
| ----------- | -------------- | --------------------------------------------------------------------- |
| In Progress | **Execution**  | First action, before session memory (leaf + epic parent when subtask) |
| Done        | **Verifier**   | After all verification layers PASS only                               |

Execution agents **must never** call `transitionJiraIssue` with Done — even when their REQUIRED OUTPUT says `complete`. Verifier agents **must never** set In Progress. See [jira-board.md](jira-board.md) for split prompt blocks.

---

## Dispatching sub-agents

When building a prompt:

1. **Task ID** — roadmap `P*-*` or Jira `DO-*` (search `Legacy Key` for old `FE-*` / `BE-*`)
2. **Acceptance criteria** — verbatim from plan row **or** extracted from Jira issue description (bullets, not HTML).
3. **Doc references** — plan Doc Ref column **or** `§` sections cited in Jira issue description ([doc-index.md](doc-index.md) shorthand).
4. Explicit READ / WRITE scope with absolute paths (include paths from Jira "Implementation notes" blocks).
5. Session ID: `<TASK-ID>-<YYYYMMDD>-<4hex>` — same for execution + verifier.
6. **Lane** (`S` or `P`) and git context (branch, worktree, `STAGING_BASE_SHA` for Lane P).
7. **Epic context** — if parent epic (e.g. DO-21), note parent key and sibling deps in prompt header; do not use epic task ID as session ID unless implementing the epic shell itself.
8. **JIRA SYNC block** — when task(s) are on the board, include role-specific blocks from [jira-board.md](jira-board.md):
   - **Execution prompt:** `transitionIdInProgress` only — **never** include `transitionIdDone`; when the task is an epic **subtask**, also list parent **epic** key so execution sets epic **In Progress** with the leaf (same first action)
   - **Verifier prompt:** `transitionIdDone` (+ optional epic key for epic **Done** on final subtask only)
     Required in both prompt types unless user opted out.
9. **JIRA TIME TRACKING block** — when JIRA SYNC is present, copy verbatim from [prompt-templates.md](prompt-templates.md) into **both** execution and verifier prompts.
10. **PRISMA MIGRATIONS block** — **mandatory in every execution prompt** (copy verbatim from [prompt-templates.md](prompt-templates.md) — even when the task has no schema changes). Never omit.

Use [prompt-templates.md](prompt-templates.md). One prompt = one **leaf** task ID unless user requested batching or shared-file serialization requires one agent for multiple keys (document in session memory, e.g. `BE-13/14/15`).

### Jira epic batches

When user asks to implement an **epic** (parent task with subtasks):

1. `getJiraIssue` epic + JQL `parent = DO-N` → full subtask list.
2. Read epic description **Suggested implementation order** and dependency prose.
3. Build a **batch plan** (ordered list of leaf tasks); split cross-project work by Lane rules.
4. Track epic parent: execution marks epic **In Progress** when any subtask starts (pass epic key in every subtask execution prompt); orchestrator or **last subtask verifier** marks epic **Done** only when all in-scope subtasks PASS (pass epic key to final verifier prompt only).
5. Example order (DO-21): `DO-47` → `BE-13/14/15` (serialize — shared `me.controller.ts`) → `FE-7`.

Formal Jira issue links / description deps (`searchJiraIssuesUsingJql / issue links`) **and** prose deps in descriptions both apply — satisfy both before dispatching a blocked task.

### Sub-agent types

| Type               | Use when                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| `best-of-n-runner` | **Lane P execution** — isolated git worktree + branch per task                                        |
| `generalPurpose`   | Lane S implementation; branch verify; staging batch verify; logic-heavy integration conflict analysis |
| `shell`            | Worktree prep/cleanup; integration merges; Infisical/Fly one-offs; migrate                            |
| `explore`          | Read-only discovery to unblock scope definition (orchestrator interprets summary)                     |
| `ci-investigator`  | Single failing CI check on a PR — not full task verification                                          |

**Model:** Do not hardcode a model slug. Omit unless the user specifies one.

**Parallel Lane P:** dispatch execution agents with `run_in_background: true` so they do not block each other.

### Cross-cutting scope exceptions

Shared files (root `package.json`, `turbo.json`, `pnpm-workspace.yaml`, CI workflows) may be touched when **all** are true:

1. Required to satisfy acceptance criteria
2. Minimal, task-specific change
3. Justified in session memory + output Blockers section

Not valid for unrelated cleanup, broad formatting, or dependency churn. **Lane P:** if two tasks in the same batch need the same shared file, downgrade to Lane S or split the batch.

---

## Parallelism — Lane S / P / B

Parallel git collisions (two agents committing to the same working tree, fix-before-commit stepping on another agent) are the main failure mode. **Lane P** isolates execution; only the **integration agent** writes to `staging` during a parallel batch.

| Lane                      | When                                                                                             | Where agents work                                | Who touches `staging`                               |
| ------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------ | --------------------------------------------------- |
| **S — Serial**            | Single task; uncertain overlap; migrations; shared contracts; integration conflicts on `staging` | `staging` working tree                           | Execution + verifier (current behavior)             |
| **P — Parallel isolated** | 2–3 tasks; deps satisfied; disjoint WRITE scopes; no shared-file contention                      | **Worktree + `orchestrator/<TASK-ID>` per task** | Integration agent + staging batch verifier only     |
| **B — Blocked**           | Same file must change in multiple tasks in one batch                                             | —                                                | Serialize, split batch, or run Lane S one at a time |

**Default when uncertain:** Lane S.

**Lane P hard rules:**

- Execution agents **never** checkout or commit to `staging`.
- Pin batch base: record `STAGING_BASE_SHA` at batch start; task branches fork from that SHA.
- Branch verifiers **never** edit the plan file.
- Staging batch verifier is the **only** agent that sets `[x]` / `[!]` for Lane P tasks.
- Never run Lane P and Lane S in the same batch.

**Serialize (force Lane S) when:** DB migrations, shared types/contracts, root tooling config, generated artifacts, dependency chains incomplete, or previous integration left merge conflicts on `staging`.

Always: **execute batch → verify (per task) → integrate (Lane P) → staging verify → next batch**.

---

## Lane P batch lifecycle

### Batch metadata (orchestrator records at start)

| Field              | Example                                                                 |
| ------------------ | ----------------------------------------------------------------------- |
| `BATCH_ID`         | `20260520-a3f1`                                                         |
| `STAGING_BASE_SHA` | `abc123…` (current `staging` HEAD)                                      |
| Per task           | `TASK-ID`, `SESSION ID`, branch `orchestrator/<TASK-ID>`, worktree path |

### Flow

```text
1. Orchestrator: pick Lane P batch; record BATCH_ID + STAGING_BASE_SHA
2. Orchestrator: set [~] on plan file for batch tasks (batch prep) OR todos in_progress (chat mode)
3. Orchestrator: spawn execution agents (best-of-n-runner, run_in_background: true)
4. Each execution: finalize local session memory + **one implementation commit** on task branch only (never commit session files)
5. Orchestrator: spawn one branch verifier per completed task (in that task's worktree)
6. Branch verifier PASS → report to orchestrator; no plan file write; Jira Done comment is the handoff record
7. Branch verifier FAIL → append VERIFICATION FAILED in local session memory; do not merge
8. Integration agent: merge PASS branches onto staging (dependency order, one at a time)
9. Staging batch verifier: post-merge smoke checks; [x] integrated tasks; [!] branch-failed tasks
10. Cleanup agent (shell): remove worktrees; delete merged task branches
```

### Worktree conventions

```text
Branch:    orchestrator/<TASK-ID>
Worktree:  ../dispatch-one-wt-<TASK-ID>   # sibling of repo root, or subagent-managed path
Base:      STAGING_BASE_SHA              # do not chase moving staging during execution
```

`best-of-n-runner` provides an isolated worktree automatically. If using a shell prep agent instead, create the worktree from `STAGING_BASE_SHA` before dispatching execution.

### Commit mutex (orchestrator-enforced)

While a Lane P batch is in flight (batch prep through staging batch verify):

| Actor                   | Allowed on `staging`                                                           |
| ----------------------- | ------------------------------------------------------------------------------ |
| Execution agents        | **No**                                                                         |
| Branch verifiers        | **No**                                                                         |
| Integration agent       | **Yes** — merge commits only                                                   |
| Staging batch verifier  | **Yes** — plan file + confirm sub-agent Jira Done comments (not session files) |
| Lane S execution/verify | **No** — wait for batch to close                                               |
| Human / other chats     | **Avoid** — warn user if parallel manual work on `staging`                     |

---

## Execution agents

### Lane S (serial on `staging`)

1. **Jira (if prompt includes JIRA SYNC — execution variant)** — **first action:** `transitionJiraIssue` → **In Progress** for every listed leaf key **and** epic parent key when listed (skip if user opted out or task already In Progress/Done)
2. **Session memory** — `.cursor/skills/agent-memory/active/<SESSION-ID>.md`; record **`started`** timestamp in header at Phase 1 (when JIRA SYNC present)
3. **Implementation** — task files only
4. **Pre-handoff (when JIRA SYNC present)** — set **`ended`** + **`duration`** in **local** session memory → `addWorklogToJiraIssue` on each leaf key → `transitionJiraIssue` → **In Review** → **single implementation commit** (task files only; never commit session memory)

Stage explicit paths only. Stop if branch ≠ `staging`. Never push.

Execution may set `[~]` only when plan file is in WRITE SCOPE. Never `[x]`.

**Jira FORBIDDEN for execution:** never call `transitionJiraIssue` with Done; never call `addCommentToJiraIssue` for verification outcomes; never set epic Done. REQUIRED OUTPUT `complete` means implementation finished — **not** Jira Done.

**Jira time tracking (when JIRA SYNC present):** record `started` at Phase 1; `ended` + `duration` pre-handoff; `addWorklogToJiraIssue` on leaf keys before In Review — see [jira-board.md](jira-board.md) § Time tracking.

**Blocked before code:** if Jira In Progress update fails and sync is required → report `blocked` (do not start implementation).

**Prisma (non-negotiable):** schema changes → `pnpm migrate:dev --name <snake_case_description>` only. Never hand-write `migration.sql` or create migration directories. If `migrate:dev` cannot run → `blocked`, not a SQL workaround. See `.cursor/rules/prisma.mdc` and the PRISMA MIGRATIONS block in every execution prompt.

### Lane P (isolated task branch)

Same flow on **`orchestrator/<TASK-ID>` only** — **one implementation commit** per task (no session memory commits).

- **Jira:** same first-action In Progress rule as Lane S when JIRA SYNC is in prompt.
- Work only in assigned worktree / branch.
- Never checkout `staging`, never merge, never push.
- Plan file: **read-only** — do not set `[~]` or `[x]`.
- If `git status` shows unexpected changes outside WRITE SCOPE → `blocked`.
- Do not rebase onto latest `staging` mid-task; integration handles integration.

### Commit messages

**Every task commit must include a work-item key** so Jira Development panel links commits when GitHub is connected. Full rules: `.cursor/rules/07-jira-commit-linking.mdc`.

```
feat(<area>)[DO-123]: <imperative summary>
fix(<area>)[DO-123]: <imperative summary>
```

Do **not** commit `.cursor/skills/agent-memory/**` — gitignored local notes only.

Subject ≤72 chars. Use **`[DO-N]`** for Jira tasks; **`[P*-*]`** only when no Jira mirror exists. Combined batch: primary leaf key in brackets (e.g. `[DO-24]` for DO-24/25/26).

**Do not** use Smart Commit syntax in messages (`#time`, `#comment`, `#resolve`, transitions) — MCP handles worklog and status (`addWorklogToJiraIssue`, `transitionJiraIssue`).

Integration merge commits: `chore(repo)[DO-47]: integrate orchestrator batch (<BATCH_ID>)`.

---

## Verification agents

Never reuse a verifier thread across batches. Spawn **fresh** verifiers.

### Lane S — task verifier (on `staging`)

One verifier after execution. Input: session ID, commit SHAs, WRITE scopes, committed paths, acceptance criteria, doc refs.

**Three layers (all must pass):**

**Layer 1 — Scope audit:** committed paths vs declared WRITE SCOPE (exception rules apply).

**Layer 2 — Automated checks** from repo root (see plan Tests column, else [doc-index.md](doc-index.md)):

```bash
infisical run --env=development -- pnpm test:unit   # or task-specific
infisical run --env=development -- pnpm lint
infisical run --env=development -- pnpm typecheck
```

Mark `n/a` for commands not yet defined in that phase. Stop if any defined check fails.

**Layer 3 — Logic review:**

- 3a. Each acceptance criterion — genuinely implemented?
- 3b. Doc contract — error shapes, lifecycle, dispatch staging, Infisical env usage, naming
- 3c. Stubs, TODO/FIXME, missing PRD edge cases, placeholder values
- 3c2. **Jira commit link:** when JIRA SYNC was in scope, every task commit subject includes `[DO-N]` or `[P*-*]` per `07-jira-commit-linking.mdc`; no `#time` / `#comment` smart commands in messages
- 3d. **Prisma:** hand-written migration SQL or hand-created migration directories → **FAIL** (migrations must come from `migrate:dev` only; see `.cursor/rules/prisma.mdc`)

| Result | Plan (plan-file mode)                      | Jira (sub-agent)                                     | Local session memory                                   |
| ------ | ------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------ |
| PASS   | `[x]`; commit plan file                    | Verifier → **Done** + mandatory Done comment         | Delete active or move to local archive/ (never commit) |
| FAIL   | `[!]` + note; commit plan file (mandatory) | Verifier → **Ready** + FAIL comment; do NOT set Done | Append VERIFICATION FAILED in active/ (never commit)   |

**Verifier Jira duties** (when JIRA SYNC in prompt, after all layers PASS):

1. `addWorklogToJiraIssue` on each leaf key
2. `addCommentToJiraIssue` — mandatory structured Done summary (jira-board.md § Verifier Done comment)
3. `transitionJiraIssue` → **Done** for each leaf key in the prompt
4. If prompt lists **epic parent key** and this was the final subtask → set epic **Done** too

On FAIL: `addCommentToJiraIssue` with Layer failures + fix hints; transition **Ready**; do **not** set Done.

**Verifier time tracking (when JIRA SYNC present):** record verification `started` after reading session memory; `ended` + `duration` pre-handoff; `addWorklogToJiraIssue` on leaf keys before Done/Ready — see [jira-board.md](jira-board.md) § Time tracking.

Orchestrator verifies sub-agent reported Jira updates (status + worklog) in REQUIRED OUTPUT; recovers via MCP only if a sub-agent skipped sync.

### Lane P — branch verifier (per task, in worktree)

Same three layers as Lane S, run **in the task worktree** on the task branch HEAD.

| Result | Plan file    | Local session memory                                       |
| ------ | ------------ | ---------------------------------------------------------- |
| PASS   | **No write** | Delete active or move to local archive/ — **never commit** |
| FAIL   | **No write** | Append VERIFICATION FAILED in active/ — **never commit**   |

Report PASS/FAIL to orchestrator; staging batch verifier updates plan file later.

### Lane P — staging batch verifier (after integration)

Runs on `staging` after integration merges. Input: `BATCH_ID`, list of tasks with branch-verify outcomes, integration merge SHAs.

**Checks:**

1. Confirm branch verifiers reported Jira **Done** comments + worklogs for integrated tasks (orchestrator recovery via MCP if missing).
2. Post-merge smoke: `pnpm lint`, `pnpm typecheck` (and task-specific tests if integration touched shared code). Use `infisical run --env=development --` when needed.
3. Plan file: `[x]` for each integrated + branch-PASS task; `[!]` + note for branch-FAIL tasks (not merged).

Does **not** re-run full Layer 3 on every task unless integration had merge conflicts or smoke checks failed — then FAIL batch and report which tasks need retry.

---

## Integration agent

Spawn after all branch verifiers complete. **Only agent that commits to `staging` during a Lane P batch** (merge commits).

Input: `BATCH_ID`, `STAGING_BASE_SHA`, merge order (dependency order), list of branch-PASS tasks with branch names and tip SHAs.

**Rules:**

- Merge `orchestrator/<TASK-ID>` into `staging` with `--no-ff`, one task at a time.
- On conflict → **stop**; do not partial-merge without orchestrator decision; report conflict files.
- Do not rewrite implementation commits; do not edit plan file.
- After all merges: report final `staging` HEAD SHA.

Use `shell` subagent type when merges are the main work; `generalPurpose` if conflict resolution analysis is needed (still must not implement task fixes without orchestrator approval).

---

## Worktree cleanup

After batch closes (PASS or FAIL with no pending retry), spawn a **shell** agent:

```bash
git worktree remove ../dispatch-one-wt-<TASK-ID>   # per task
git branch -d orchestrator/<TASK-ID>               # only after merged to staging
```

If worktree remove fails (dirty tree), report paths; do not force-delete without orchestrator/user approval.

---

## Task markers

### Plan-file mode

- `- [ ]` not started
- `- [~]` awaiting verification — Lane S: execution agent; Lane P: orchestrator at batch start
- `- [x]` verified — Lane S: task verifier; Lane P: staging batch verifier
- `- [!]` failed verification (one-line note below)

### Chat mode (`TodoWrite`)

- `pending` — not started or failed
- `in_progress` — execution/verification in flight
- `completed` — verifier PASS only (staging batch verifier for Lane P)
- `cancelled` — user-approved abandon

---

## Session memory lifecycle (local only — gitignored)

Path: `.cursor/skills/agent-memory/` — **never committed**. See `agent-memory/README.md`.

| Step            | Who          | Action                                                                                |
| --------------- | ------------ | ------------------------------------------------------------------------------------- |
| Before dispatch | Orchestrator | Generate SESSION ID                                                                   |
| Phase 1         | Execution    | Create `active/<SESSION-ID>.md` (header + Task); set `started` when JIRA SYNC present |
| Phase 2         | Execution    | Update Scope, Decisions, Deviations in place                                          |
| Phase 3         | Execution    | Finalize sections locally (do not commit)                                             |
| Pre-handoff     | Execution    | Set `ended` + `duration`; worklog + In Review; **one implementation commit**          |
| Verifier start  | Verifier     | Read active file if present; set verification `started` when JIRA SYNC present        |
| Verifier end    | Verifier     | Set verification `ended` + `duration`; worklog; Jira comment + Done/Ready transition  |
| PASS            | Verifier     | Mandatory Jira Done comment; optionally delete active or move to local `archive/`     |
| FAIL            | Verifier     | Mandatory Jira FAIL comment; append VERIFICATION FAILED in active/ if file exists     |

**Retry after FAIL:** same SESSION ID; execution reads Jira FAIL comment and local active file (VERIFICATION FAILED section) if present.

**Missing at verify:** if no local active file, proceed using execution REQUIRED OUTPUT (implementation SHA, paths, scope). Report `blocked` only if both are insufficient.

### Session file template

```markdown
# Session: <SESSION-ID>

_task: <TASK-ID> | started: <ISO 8601 UTC> | ended: <ISO or pending> | duration: <e.g. 1h 32m or pending> | agent: execution_

## Task

<one line from plan>

## Time tracking

- **Execution started:** <ISO> (set at Phase 1 when JIRA SYNC present)
- **Execution ended:** <ISO> (set pre-handoff)
- **Duration:** <human-readable wall-clock>
- **Jira worklog:** <leaf keys + timeSpent logged, or n/a>
- **Combined batch split:** <if multiple leaf keys, note per-key duration>

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

(Filled by verifier when JIRA SYNC present; omit section if no Jira issue in prompt)
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

Store only durable knowledge: conventions, build/test quirks, Infisical notes, recurring verify failures, **Lane P merge conflict patterns**.

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
3. Identify next tasks (deps satisfied — plan rows, Jira issue links / description deps, epic prose order).
4. Map doc refs → paths (plan Doc Ref or Jira description citations; orchestrator does **not** open spec doc bodies).
5. Choose lane: **S**, **P**, or **B** (blocked → split or serialize).
6. Generate SESSION ID per leaf task; if Lane P, record `BATCH_ID` + `STAGING_BASE_SHA`.
7. Batch prep: plan `[~]` / todos `in_progress` (orchestrator does **not** set Jira In Progress — execution agent does).
8. Spawn execution sub-agent(s) — `best-of-n-runner` + `run_in_background: true` for Lane P.
9. Collect: local SESSION ID path, implementation SHA, scopes, paths, status per task.
10. Spawn one **branch verifier** per Lane P task, or one **task verifier** for Lane S.
11. Lane P: spawn **integration agent** → **staging batch verifier**.
12. Lane P: spawn **cleanup** shell agent for worktrees/branches.
13. Reconcile: PASS → plan `[x]` / confirm Jira Done comment; FAIL → plan `[!]` / retry same SESSION ID.
14. **Jira epic:** if subtask execution skipped epic In Progress, orchestrator recovery → epic **In Progress**; if all subtasks PASS and epic not yet Done, recovery → epic **Done** (or ensure last verifier prompt included epic key).
15. Update workspace-notes if durable learning.
16. Report batch result + next batch.
17. Repeat.

---

## Improvements over Pipewatch pattern

| Area               | Dispatch One                                                      |
| ------------------ | ----------------------------------------------------------------- |
| Repos              | Single repo — simpler commits                                     |
| Spec               | Multi-doc + Doc Ref column, not one PRD                           |
| Task tracking      | Roadmap checkboxes + Jira board (FE/BE/INFRA/OPS epics)           |
| Model              | No forced `composer-2.5-fast`                                     |
| Branch             | `staging` integration; Lane P uses isolated task branches         |
| Parallelism        | Worktree isolation via `best-of-n-runner`; serialized integration |
| Secrets            | Infisical `development` for local/verify                          |
| Orchestrator reads | Plan file + Jira issue descriptions; not spec doc bodies          |
| CI failures        | Optional `ci-investigator` instead of full verifier               |
| Push               | Never unless user explicitly asks                                 |

---

## Anti-patterns

- Orchestrator reading spec **doc** bodies or implementation files (Jira issue descriptions are OK)
- Orchestrator reading session memory **contents** (filenames in `active/` only)
- Pasting spec doc bodies or full Jira ADF description bodies into sub-agent prompts
- Editing roadmap checkboxes for Jira-only issues (DO-47, BE-13, …)
- Marking Jira epic Done before all in-scope subtasks verify PASS
- Hardcoding Jira board/status UUIDs in prompts (orchestrator resolves once; sub-agents use values from prompt)
- **Sub-agent skipping Jira sync** when JIRA SYNC block is present
- **Sub-agent skipping Jira worklog** when JIRA SYNC block is present (must log before handoff)
- **Execution agent setting Jira Done** — only verifier after PASS; `transitionIdDone` must not appear in execution prompts
- **Execution agent confusing REQUIRED OUTPUT `complete` with Jira Done**
- Execution agent starting implementation before Jira In Progress (when sync required)
- Execution agent setting a subtask In Progress without setting epic parent In Progress (when epic key is in prompt)
- Verifier setting Jira In Progress (execution owns that)
- Committing session memory files to git (local only; Jira comment is the durable record)
- Verifier proceeding without local session memory **and** without execution REQUIRED OUTPUT when memory missing
- Verifier archiving session memory to git on FAIL
- Reusing SESSION ID across different tasks
- Reusing verifier thread across batches
- Marking `[x]` or todo `completed` before verifier PASS
- **Lane P execution agents committing to `staging`**
- **Branch verifiers editing the plan file**
- **Parallel Lane P without `best-of-n-runner` or equivalent worktree isolation**
- **Dispatching Lane P and Lane S in the same batch**
- **Integration merging branch-FAIL tasks**
- Pushing from any sub-agent without user request
- Blanket `git add .` / `-A`
- Committing `.env` or secrets
- **Task commits without `[DO-N]` or `[P*-*]` in subject** when Jira sync was in scope
- **Smart Commit commands in commit messages** (`#time`, `#comment`, `#resolve`) — MCP owns Jira sync
- **Execution agent hand-writing Prisma migrations** — never create/edit `apps/backend/prisma/migrations/**/migration.sql` or migration directories; schema change → `pnpm migrate:dev` only (orchestrator must include PRISMA MIGRATIONS block in every execution prompt)
- **Orchestrator omitting PRISMA MIGRATIONS block** from an execution prompt
