# SlugBase — Linear board reference

Orchestrator and **sub-agents** use this when a prompt includes a **LINEAR SYNC** block.

## Project

| Field | Value |
|---|---|
| Team | **SlugBase** |
| Issue key | `SB-N` (e.g. `SB-42`) |
| Linear URL | `https://linear.app/<workspace>/issue/SB-N` |
| MCP server | `plugin-linear-linear` |
| GitHub sync | Two-way: `mdg-labs/slugbase` ↔ SlugBase team |
| GitHub issue URL | `https://github.com/mdg-labs/slugbase/issues/N` |
| GitHub MCP (read-only) | `user-github` — synced mirror, Dependabot |
| Auto-close (GitHub) | `fixes #N` in commit **body** on merge to `main` |
| Auto-close (Linear) | `fixes SB-N` in commit **body** per commit-linking webhook |

## Operator setup (prerequisites)

Complete before agents rely on this workflow:

1. **Two-way sync** — `mdg-labs/slugbase` ↔ SlugBase team (Linear → Settings → Integrations → GitHub → GitHub Issues Sync).
2. **Commit linking** — Enable "Link commits to issues with magic words" in Linear GitHub settings; add the Push-events webhook to GitHub (Payload URL + Secret from Linear).
3. **PR/commit automations** — SlugBase team → Workflows & automations: align with staging verify (`Done`) vs `main` release (`Closed`). Consider branch-specific rules for `staging` vs `main`.
4. **GitHub Autolink** (optional) — Autolink `SB-<num>` → `https://linear.app/<workspace>/issue/SB-<num>` in PR descriptions.

**Validate once:** Create a test issue, verify GitHub mirror `#N` appears, push a commit with `fixes SB-N` + `fixes #N` in the body, confirm Linear links and GitHub Development panel links without prematurely closing the GitHub issue before `main`.

## Tool selection policy

**Linear MCP is the default** for issue tracking. Use GitHub MCP only for synced read, Dependabot, or when Linear attachment lacks the mirror `#N` yet.

### Operation → tool mapping

| Operation | Tool | Why |
|---|---|---|
| **Create issue** | Linear `save_issue` | Linear-first; two-way sync creates GitHub mirror |
| **Update issue** (title, description, labels, priority) | Linear `save_issue` (with `id`) | Primary tracker |
| **Set workflow state** | Linear `save_issue` (`state`) | e.g. `"In Progress"`, `"Done"` — exact name match |
| **Read issue** | Linear `get_issue` | `includeRelations: true` for parent/children/blocking |
| **Search/list issues** | Linear `list_issues` | `query`, `team`, `state`, `label` filters |
| **Add comment** | Linear `save_comment` | Verifier PASS/FAIL; syncs to GitHub synced thread |
| **Sub-issues** | Linear `save_issue` (`parentId`) | Epic hierarchy |
| **Blocking deps** | Linear `save_issue` (`blockedBy` / `blocks`) | Native relations |
| **Read synced GitHub #** | Linear `get_issue` links/attachments | After sync settles; or `user-github` `issue_read` |
| **Fetch Dependabot alerts** | CLI `gh api` (REST) | No Linear equivalent |
| **GitHub issue read** | MCP `issue_read` | When mirror `#N` known; sub-issue enumeration on GitHub side if needed |

### Forbidden

- **GraphQL `updateProjectV2ItemFieldValue`** — GitHub Project board is deprecated for agent workflow; do not set project 2 Status.
- **`gh project item-list`**, **`addProjectV2ItemById`** — obsolete for day-to-day tracking.
- **Setting GitHub issue state** (`open`/`closed`) directly — driven by `fixes #N` on `main` only.
- **Issue keys in commit subjects** — keys go in commit **body** only (see rule `07-issue-commit-linking.mdc`).

## Workflow states

```
Backlog → Ready → In Progress → In Review → Done → Closed
                        ↓
                   Canceled / Duplicate
```

| State | Who sets it | When | Notes |
|---|---|---|---|
| Backlog | Default | Unrefined / deferred | — |
| Ready | intake / triage / orchestrator / user | Fully specified | Orchestrator picks from here |
| In Progress | **Execution agent** | First action, before session memory | — |
| In Review | **Execution agent** | Last action before verifier handoff | — |
| Done | **Verifier** | After all layers PASS | GitHub mirror may still be `open` until `main` |
| Closed | Sync / automations | When `fixes` lines land on `main` | Agents do not set Closed during verify |
| Canceled | Orchestrator / user | Permanently declined | — |

Set state via Linear MCP:

```text
CallMcpTool save_issue: { id: "SB-12", state: "In Progress" }
```

State names are **exact** — use `"In Progress"` not `in_progress`.

### Failure path

Verifier FAIL → `save_issue` state **Ready** + `save_comment` with layer failures.

## Two status systems (Linear vs GitHub issue state)

| System | Authority | Values |
|---|---|---|
| **Linear workflow state** | Day-to-day tracking | Backlog … Closed |
| **GitHub issue state** | Release only | `open` / `closed` via `fixes #N` on `main` |

**Blocking dependencies:** A task blocked by `SB-325` / `#325` is **unblocked** when the blocking issue's Linear state is **Done** or **Closed** — not when GitHub issue state alone is `closed`.

## Domain labels

One domain label per issue (syncs to GitHub when two-way sync is on):

| Label | Scope |
|---|---|
| `domain:frontend` | Web client, React, UI, command palette, dashboard, i18n |
| `domain:backend` | API, auth, sessions, bookmarks/slugs/folders/tags/workspaces, entitlements, billing, admin |
| `domain:infrastructure` | Database, container, CI/CD, TLS/proxy, deployment, monitoring |
| `domain:operations` | Launch, marketing site, docs, billing operations, self-hosted runbooks |
| `regression` | Bug that reappeared after a Done/Closed fix — alongside a `domain:*` label |

## Issue types (Linear)

Map intake work to Linear issue structure:

| Work | Linear pattern |
|---|---|
| Epic parent (2+ tasks) | Parent issue + `parentId` on children |
| Feature leaf / Task | Standard issue |
| Bug | Standard issue + Bug-oriented labels |
| Chore / DX / spike | Standard issue |

Use `priority` on `save_issue`: `0` None, `1` Urgent, `2` High, `3` Normal, `4` Low.

## Required fields — every new issue

| Field | How to set |
|---|---|
| **Team** | `team: "SlugBase"` on create |
| **Domain label** | `labels: ["domain:backend"]` |
| **Priority** | `priority: 2` (or per intake logic) |
| **Assignee** | `assignee: "me"` |
| **Description** | Markdown per [linear-intake/templates.md](../linear-intake/templates.md) |

After create, poll `get_issue` until synced GitHub `#N` appears in links/attachments; record both keys in the issue description header.

## Status sync — sub-agent duties (mandatory)

Skip only when user said **"don't update Linear"** or prompt has no LINEAR SYNC block.

### Execution agent — first action (before session memory)

```text
save_issue: { id: "SB-<leaf>", state: "In Progress" }
save_issue: { id: "SB-<parent>", state: "In Progress" }   # when parent listed
```

- Combined batch: **In Progress** on every listed issue (leaf + parent).
- If already In Progress or Done, continue (idempotent).
- If state update fails → `blocked`; do not start implementation.

### Execution agent — last actions (before verifier handoff)

```text
1. Session memory (local): set ended + duration in header
2. save_issue state → "In Review" for each LEAF only (parent stays In Progress unless implementing parent itself)
3. Single implementation commit — task files only; keys in BODY only:
   fixes SB-<leaf>
   fixes #<leaf>
   (+ fixes SB-<parent> / fixes #<parent> per CLOSE_PARENTS)
```

### Verifier — after all layers PASS

```text
1. save_comment — mandatory clean summary (see § Verifier Done comment)
2. save_issue state → "Done" for each leaf (+ parent if final child)
```

### Verifier — on FAIL

```text
save_issue state → "Ready" for each leaf
save_comment with FAIL template
Do NOT set Done
```

## Verifier Done comment (mandatory on PASS)

Post via `save_comment` on each **leaf** Linear issue before setting Done.

```markdown
**Verified** `abc1234`

Server-side session store with configurable TTL. DB-backed sessions, HTTP-only cookie, individual revocation, double-submit CSRF with §5.8 exempt allowlist.

AC met:
- Session create/revoke round-trips correctly
- CSRF rejects missing token on mutations; allowlisted endpoints exempt
- Configurable TTL defaults per spec §3

Lint, typecheck, unit tests pass. No deviations.
```

### Comment rules

1. **First line:** `**Verified** <sha>`
2. Brief summary — 2–3 sentences max
3. **AC checklist** — which criteria were met
4. **No session IDs** or sub-agent identifiers
5. **Omit empty sections**

## Verifier FAIL comment (mandatory on FAIL)

```markdown
**Verification failed**

Layer 1 (scope): PASS
Layer 2 (automated): FAIL — typecheck error in `session.service.ts:42`
Layer 3 (logic): PASS

`session.service.ts:42` — fix suggestion per AC.
```

## LINEAR SYNC blocks (orchestrator copies into prompts)

Two variants — **never tell execution agents to set Done**.

### Execution variant

```text
LINEAR SYNC — EXECUTION (mandatory unless user opted out):
- MCP server: plugin-linear-linear
- team: SlugBase
- issues:
  - linear: SB-12          # leaf
    github: 12              # synced mirror (Development panel + fixes #N)
  - linear: SB-8           # parent (when leaf is sub-issue)
    github: 8
- CLOSE_PARENTS: linear=[SB-8] github=[8] | none
- FIRST ACTION: save_issue state → "In Progress" for EVERY listed issue (leaf + parent) BEFORE session memory
- LAST ACTIONS (in order): local session memory ended/duration → state → "In Review" (leaf only) → single implementation commit (no session files)
- COMMIT SUBJECT: key-free — <type>(<scope>): <summary> only; NO [SB-N] or [#N] in subject
- COMMIT BODY: fixes SB-<leaf> + fixes #<leaf> always; add parent fixes lines per CLOSE_PARENTS (both linear and github keys); FORBIDDEN: parent fixes not in CLOSE_PARENTS
- FORBIDDEN: state → Done; verifier comments; committing session memory files
- Reference: .cursor/skills/orchestrator/linear-board.md
```

### Verifier variant

```text
LINEAR SYNC — VERIFIER (mandatory unless user opted out):
- MCP server: plugin-linear-linear
- team: SlugBase
- issues:
  - linear: SB-12
    github: 12
  - linear: SB-8           # parent — Done only if final child
    github: 8
- CLOSE_PARENTS: linear=[SB-8] github=[8] | none
- PRE-HANDOFF: local session memory verification ended/duration
- AFTER PASS: save_comment (mandatory) → state → "Done" for leaf (+ parent if final child)
- AFTER FAIL: save_comment (FAIL template) → state → "Ready"; do NOT set Done
- Layer 3c3: verify commit body has fixes SB-<leaf> AND fixes #<leaf>; subject must NOT contain issue keys
- Reference: .cursor/skills/orchestrator/linear-board.md
```

## Issue lookup (orchestrator)

| User says | Tool |
|---|---|
| `SB-12`, Linear URL | Linear `get_issue` (`id: "SB-12"`) |
| `#12`, GitHub URL | Linear `list_issues` (`query: "#12"`) or GitHub `issue_read` then cross-ref |
| Set state | Linear `save_issue` (`state`) |
| Sub-issues | Linear `get_issue` (`includeRelations: true`) |
| By domain | Linear `list_issues` (`label: "domain:backend"`) |
| Dependencies | Linear `get_issue` blockedBy / blocking relations |

## Epic pattern

SlugBase uses **parent + sub-issues** via `parentId`:

```text
SB-1 (epic — Auth system)
├── SB-10 (Auth UI)
│   ├── SB-11 (auth shell + sign-in)   ← leaf
│   ├── SB-12 (MFA challenge)          ← leaf
│   └── SB-13 (register + verify)      ← leaf
├── SB-20 (Session store)              ← atomic leaf
└── SB-21 (CSRF bypass)                ← atomic leaf
```

- Implement **leaf** issues; pass `SB-N` + `#N` to execution + verifier prompts.
- Parent **In Progress**: when any child starts.
- Parent **Done**: last leaf verifier marks intermediate + top parent Done.

### Commit close (body only)

```text
feat(auth): add MFA challenge screen

fixes SB-12
fixes #12
fixes SB-8
fixes #8
```

Orchestrator computes `CLOSE_PARENTS: linear=[SB-8] github=[8] | none` — execution agents must not guess.

## MCP tools by role

| Tool | Orchestrator | Execution | Verifier |
|---|---|---|---|
| `list_issues` | Find work | — | — |
| `get_issue` | Load AC / relations | — | — |
| `save_issue` | Intake creates; recovery | Set state | Set state |
| `save_comment` | — | — | PASS + FAIL |
| `list_comments` | Check prior failures | — | — |
| `issue_read` (GitHub) | Read mirror when needed | — | — |

## Synced GitHub number resolution

After `save_issue` create, poll until mirror exists:

```text
get_issue: { id: "SB-N", includeRelations: false }
→ inspect links / attachments / description for github.com/mdg-labs/slugbase/issues/<N>
```

If sync is slow, retry once; handoff may note "GitHub # pending sync".

## Standard queries

```text
# By domain
list_issues: { team: "SlugBase", label: "domain:backend", state: "Ready" }

# By keyword
list_issues: { team: "SlugBase", query: "csrf" }

# Child issues of parent
get_issue: { id: "SB-1", includeRelations: true }

# Check verification failures
list_comments: { issueId: "SB-12" }
# Inspect for "Verification failed"
```
