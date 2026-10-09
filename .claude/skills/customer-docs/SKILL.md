---
name: customer-docs
description: Write and maintain a product's end-user documentation — one doc page per in-app page, a getting-started guide, a landing page, concept pages and an FAQ — on the repo's docs site. English only. Proposal first; writes only after explicit approval. Bootstraps its per-repo config on first run. Use when the user asks to write customer docs, document page X, create a getting started guide, update user documentation, check docs coverage, or run a full docs pass on the app.
argument-hint: '[full pass | <route or page> | update]'
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
  - Edit
  - Write
  - AskUserQuestion
---

# Customer docs

Write and maintain **end-user documentation** for the application in this
repo: one doc page per in-app page, plus a getting-started guide, a landing
page, concept pages and an FAQ. Language: **English only**.

The skill is generic. Everything about this repo's docs site lives in a
repo-owned config that the skill bootstraps on first run.

## Files

| What | Path |
| ---- | ---- |
| This skill (vendored — never edit here) | `.claude/skills/customer-docs/SKILL.md` |
| Style rules | `.claude/skills/customer-docs/style-guide.md` |
| Templates | `.claude/skills/customer-docs/page-doc-template.md`, `getting-started-template.md`, `landing-page-template.md`, `docs-config-template.md` |
| Repo config + glossary (repo-owned) | `.claude/customer-docs/docs-config.md` |
| Coverage inventory (repo-owned, created on the first approved write) | `.claude/customer-docs/coverage.md` |
| Spec docs | CLAUDE.md `### Design docs` |
| Build check | `docs-config.md` § Docs site, the same as `.claude/workflow.json` `docs.build` |

Never hand-edit a file `docs-config.md` § Synced files lists: edit its
source and run the sync instead.

## Modes

| Mode | User says | Action |
| ---- | --------- | ------ |
| **0 — Bootstrap** | First run, or `.claude/customer-docs/docs-config.md` missing | Interactive setup — no doc writes until the config exists |
| **1 — Full pass** | "write all docs", "document the app", "full docs pass" | Inventory → proposal → write batch by batch |
| **2 — Single page** | "document the settings page", "write docs for /billing" | Scoped inventory → outline → write one page |
| **3 — Update / drift** | "update docs", "check docs coverage", "sync docs" | Diff routes against coverage → propose → execute |

Mode 0 applies whenever the config is missing. Otherwise infer the mode from
the request. When it is ambiguous, use Mode 3 if `coverage.md` exists, and
Mode 1 if it doesn't.

## Mode 0 — Bootstrap

**No customer doc is written until the config exists.**

1. **Scan read-only.** Find the docs site: framework config, content root,
   sidebar file, deploy workflow. Also find the app's routes dir, navigation
   source and UI label files, and the spec docs CLAUDE.md maps.
2. **Propose the filled config.** Render `docs-config-template.md` with what
   you found. Each value you could not determine becomes an explicit
   question, never a guess. Cover:
   - Product: use case, audience, deployment model, accounts and roles
   - screenshot policy
   - the doc layout
3. **Ask the questions** with `AskUserQuestion`, at most four at a time.
4. **Write the config on approval.** On "approve", write
   `.claude/customer-docs/docs-config.md`. Coverage starts on the first
   approved docs write.
5. **Offer the next step:** Mode 1, Mode 2 or Mode 3.

**Re-bootstrap** (the config exists and the user asks to refresh it): show a
change plan and patch only the named fields. Never overwrite glossary rows or
the route map without confirmation.

## Approval gate (mandatory — no exceptions)

**Phase 1 — investigate and propose only.** Nothing is written in this phase:
no doc pages, no sidebar edits, no synced-file sources, no `coverage.md`, no
glossary changes.

**Phase 2 — writes**, only after the user explicitly approves the proposal
(**approve**, **yes write them**, **go ahead**, **LGTM**).

| Rule | Detail |
| ---- | ------ |
| Always propose first | Full pass, single page, drift check — every run that writes docs |
| Never skip Phase 1 | Even if the user said "write all docs" upfront |
| Wait for reply | End Phase 1 with *"Approve to write these docs (or tell me what to change)."* |
| Re-propose after edits | The user asks for changes → updated proposal; no writes until approved again |
| Sub-agents | A parent agent never writes docs while customer-docs is waiting for approval or still running |

## Mode 1 — Full docs pass

### Phase 1 — Inventory and proposal

1. **Read the guides:** `docs-config.md`, [style-guide.md](style-guide.md),
   and `coverage.md` if it exists.
2. **Inventory pages read-only.** Read every route in the routes dir, the
   navigation source, and each feature's components (buttons, forms,
   dialogs, table columns, empty states). Take every label from the UI label
   files.
3. **Read the spec.** Read the matching spec sections and do not invent
   behaviour.
4. **Check the existing site:** its content root and sidebar. Link to pages
   that already cover something instead of repeating them.
5. **Post the proposal** (format below) and **stop**.

### Phase 2 — Write

1. **Write pages batch by batch.** Use [page-doc-template.md](page-doc-template.md),
   [getting-started-template.md](getting-started-template.md) and, for the
   front page and product overview, [landing-page-template.md](landing-page-template.md).
   Put each page at the path `docs-config.md` § Route → doc map gives it,
   with its frontmatter.
2. **Add sidebar entries** for each new page.
3. **Run the build check.** On failure, fix the docs; never touch app code.
4. **Update `coverage.md`:** route → doc path → last-synced SHA → status.
5. **Add new terms** to `docs-config.md` § Glossary.
6. **Report the handoff.**

### Proposal format

```markdown
## Proposed customer docs — {product}

**Mode:** full pass
**Routes scanned:** {routes dir} ({N} pages)

| Doc path | Title | Source (route · component) | Priority | Type |
| -------- | ----- | -------------------------- | -------- | ---- |
| {path} | {title} | {route · components dir} | P0 | page doc |

**Sidebar changes:** {file} — add {N} entries under {groups}
**Glossary additions:** {internal term → customer term, or "none"}
**Open questions:** {flows that could not be verified read-only — or "none"}

---
**Approve to write these docs** (or tell me what to change).
```

## Mode 2 — Single page

The same flow as Mode 1, scoped to one route or feature, using the route →
doc map. Phase 1 may be a **short outline** instead of a table: purpose, key
actions, fields, related pages, open questions. It still ends with the
approval ask, and nothing is written before approval.

## Mode 3 — Update / drift check

### Phase 1 — Diff and proposal

1. **Read** `docs-config.md` and `coverage.md`.
2. **Diff the routes dir against coverage:**
   - **New pages:** routes with no row (missing).
   - **Removed pages:** rows whose route no longer exists (stale).
   - **Changed pages:** run
     `git log --oneline <last-synced SHA>..HEAD -- <route> <its components> <label files>`
     and read the diff read-only.
3. **Flag doc text that contradicts the current spec**, for example a renamed
   setting or a removed option.
4. **Post the drift proposal** and **stop**.

```markdown
## Docs drift report — {date}

| Route | Doc path | Status | Action |
| ----- | -------- | ------ | ------ |
| {route} | {path} | changed ({old sha} → {new sha}) | update |
| {route} | — | missing | create |
| {route} | {path} | route removed | remove |

**Open questions:** {any — or "none"}

---
**Approve to apply these doc changes** (or tell me what to change).
```

### Phase 2 — Execute

1. **Update or create pages,** and adjust the sidebar.
2. **Run the build check.**
3. **Refresh the SHAs** in `coverage.md`.
4. **Remove pages** whose route is gone: delete the doc and its sidebar entry,
   unless the user asks to keep a redirect note.

## Coverage inventory

File: `.claude/customer-docs/coverage.md`

```markdown
# Docs coverage

| Route | Doc path | Status | Last-synced SHA | Notes |
| ----- | -------- | ------ | --------------- | ----- |
| `/settings/profile` | docs/guide/profile.md | current | abc1234 | |
```

**Status values:** `current` · `stale` · `missing`. The SHA is the commit at
which the doc was last checked against the route's source.

## Content quality (summary)

Full rules: [style-guide.md](style-guide.md). Enforce them on every write.

- **Task-oriented:** every page doc answers **what can I do here, and how**.
- **Voice:** second person, present tense, imperative steps, short sentences,
  English only.
- **Page structure:** purpose → prerequisites → steps per key action → field
  table → troubleshooting → related pages.
- **Getting started:** the happy path from first sign-in to the first success
  moment, in ten steps or fewer. Link to page docs for detail.
- **No internal jargon:** use the glossary, and ask the user when a mapping is
  unclear.
- **No invention:** never invent features, labels or behaviour. Unverified
  flows go under **Open questions**.
- **Never include** secrets, real tokens, internal URLs, or routes meant only
  for integrators.

## Commits

- **Subject:** `docs(<scope>): <summary>`, with the scope `docs-config.md` §
  Commits names.
- **Trailer:** when the work belongs to a tracked item, the body ends with
  `Fixes #<n>`, where `<n>` is the item's trailer number. On Kaneo that is
  the GitHub mirror, resolved read-only (`.claude/trackers/kaneo.md`).
  Otherwise there is no trailer.
- **Never in the message:** a tracker-internal id, or any attribution line.
- **Staging:** explicit paths only, no `git add .` / `-A`.
- **Pushing:** never unless the user asks.
- **Gate:** docs-only changes run the build check instead of the app's test
  suite.

## Parent agents: do not take over customer-docs

If customer-docs runs as a sub-agent, the parent must not write doc files
while it may still be running. Wait for its completion notification. To
replace it: stop it first (`TaskStop`), check what it wrote, then re-dispatch.

## Handoff template

```markdown
## Customer docs — {MODE}

### Written
- {doc paths}
- Sidebar: {file} — {summary}
- Build: {command} — {pass/fail}

### Coverage
- {N} current · {N} updated · {N} new

### Open questions
- {items needing product input — or "none"}

### Suggested review order
1. Getting started / first steps
2. {P0 pages}
3. {remaining pages}

### Next
- "update docs" — drift check (Mode 3)
- "document {page}" — single page (Mode 2)
```

## Forbidden

- **Writing before approval:** any doc, sidebar, synced-file source, coverage
  or glossary write before the written proposal is explicitly approved.
- **Skipping the proposal,** or moving to Phase 2 in the same turn as
  Phase 1.
- **Hand-editing a synced file.**
- **Wrong deployment model:** describing a way the product is offered that
  `docs-config.md` § Product does not name.
- **Linking internal docs:** linking hand-written customer pages to internal
  specs, roadmaps or checklists.
- **Touching app code:** application code is read-only.
- **Fabrication:** invented behaviour, UI labels or screenshots, or capturing
  screenshots.
- **Internal details:** exposing internal table or column names, code
  identifiers, env var names (outside an install guide), secrets or internal
  URLs.
- **Unsafe git:** `git add .`, pushing without an explicit request, or a
  tracker-internal id in a commit.
