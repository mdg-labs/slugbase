---
name: write-customer-docs
description: >-
  Author or refresh SlugBase customer and operator documentation in the
  slugbase-docs repo as MDX for Documentation.AI. Use when the user invokes
  /write-customer-docs, asks to write customer docs, operator guides, public
  documentation, MDX pages, documentation.json navigation, or refresh customer
  docs content. Explicit invocation only — not auto-loaded.
disable-model-invocation: true
---

# Write customer docs (SlugBase)

Author **customer and operator** documentation published via [Documentation.AI](https://documentation.ai). Source lives in the **[`mdg-labs/slugbase-docs`](https://github.com/mdg-labs/slugbase-docs)** repository (repo root).

**Authoring guide:** `slugbase-docs/README.md` · **MDX format rule:** `slugbase-docs/.cursor/rules/documentation.ai.mdc` · **Parent epic:** GitHub #392 · **Spec boundary:** spec §2.4 · **Vocabulary:** spec §3

## Workspace layout (two repos)

Customer docs work spans **two sibling repositories** opened together in Cursor:

| Workspace folder | GitHub repo | Role |
|---|---|---|
| `slugbase/` | [`mdg-labs/slugbase`](https://github.com/mdg-labs/slugbase) | App monorepo — routes, UI copy, engineering spec (`slugbase/docs/internal/`), agent rules/skills (`slugbase/.cursor/`) |
| `slugbase-docs/` | [`mdg-labs/slugbase-docs`](https://github.com/mdg-labs/slugbase-docs) | Customer/operator MDX — **edit here for public docs** |

**Open:** [`slugbase/slugbase.code-workspace`](../../../slugbase.code-workspace) from the monorepo checkout. The workspace expects a sibling `slugbase-docs` checkout at `../slugbase-docs`.

**Path convention:** paths in this skill are **workspace-relative** from the multi-root workspace (prefix `slugbase/` or `slugbase-docs/`). When a tool's cwd is a single repo root, drop the matching prefix.

**Git:** commit MDX and `documentation.json` changes in **`slugbase-docs`** only. Discovery reads from **`slugbase`**; do not recreate `slugbase/docs/public/` in the monorepo.

## When to use

| User intent | Scope |
|---|---|
| `/write-customer-docs` with no args | Full greenfield corpus (both products) — start with discovery + IA proposal |
| "Write self-hosted quick start" | One product or one nav group |
| "Refresh the bookmarks guide" | Single-page maintenance |
| "Propose doc structure for cloud billing" | IA proposal only — stop before bulk writing unless asked |

**Ask before drafting** when the target audience (end user vs operator), product dimension (cloud vs self-hosted), or entitlement-gated feature scope is unclear.

## Hard rules

1. **English only** for customer MDX — German (`de.json`) is for the web app UI, not public docs (spec §17). Never author German MDX.
2. **Never guess product behaviour** — discover from routes, UI copy, and spec before drafting.
3. **Never edit `slugbase/docs/internal/`** as part of customer doc work — cite spec sections; do not copy engineering docs into public pages.
4. **Never commit secrets** — use placeholders in examples.
5. **Defer MDX format details** to `slugbase-docs/.cursor/rules/documentation.ai.mdc` — this skill covers workflow, IA, tone, and discovery.
6. **Both steps to add a page:** create `.mdx` under `slugbase-docs/` **and** register `path` in `slugbase-docs/documentation.json` (see `slugbase-docs/README.md`).
7. **Edit `slugbase-docs/` only** for publishable content — never recreate `slugbase/docs/public/` in the monorepo.

## Reference files (read as needed)

| File | Use when |
|---|---|
| [discovery-sources.md](discovery-sources.md) | Before any draft — ordered read list for greenfield and maintenance |
| [information-architecture.md](information-architecture.md) | Planning nav groups, page inventory, cloud vs self-hosted split |
| [page-templates.md](page-templates.md) | Choosing page type and filling skeletons |
| [screenshot-placeholders.md](screenshot-placeholders.md) | Adding visual placeholders before real screenshots exist |
| [tone-and-vocabulary.md](tone-and-vocabulary.md) | Voice, spec §3 terms, audience framing |
| [examples.md](examples.md) | Good vs bad excerpts before writing |

## Workflow

```
- [ ] Phase 1: Scope
- [ ] Phase 2: Discovery
- [ ] Phase 3: IA proposal (bulk work only)
- [ ] Phase 4: Draft MDX
- [ ] Phase 5: Wire navigation
- [ ] Phase 6: Summarise changes
```

### Phase 1 — Scope

Confirm with the user (or infer from the request):

| Dimension | Options |
|---|---|
| **Breadth** | Full corpus · one product (`cloud` / `selfhosted`) · one nav group · single page refresh |
| **Mode** | **Greenfield** — no MDX for this area yet · **Maintenance** — existing MDX to update or extend |
| **Audience** | End user (bookmarks, slugs, palette) · workspace admin · instance operator (self-hosted install, SMTP, OIDC) |

Record scope in chat before discovery.

### Phase 2 — Discovery

Follow the ordered read list in [discovery-sources.md](discovery-sources.md).

**Greenfield (0 MDX):** Read all discovery sources for the in-scope features. Build a behaviour notes table: feature → route → UI labels → spec section → entitlement gates.

**Maintenance:** Diff existing MDX + `documentation.json` against current routes, `en.json` keys, and relevant spec sections. List stale, missing, and incorrect pages before editing.

**Stop and ask** if behaviour is undefined in spec and not observable in the app.

### Phase 3 — IA proposal

Required before bulk writing (more than one new page). Skip for single-page refresh.

Produce a page inventory table (template in [information-architecture.md](information-architecture.md)):

| Column | Purpose |
|---|---|
| `path` | `documentation.json` path without `.mdx` (e.g. `selfhosted/quick-start`) |
| `title` | Frontmatter title |
| `type` | how-to · concept · operator-runbook · troubleshooting · reference |
| `audience` | end-user · workspace-admin · operator |
| `product` | `selfhosted` · `cloud` · both (prefer separate pages when behaviour diverges) |
| `prerequisites` | Pages or setup steps readers need first |

Present the table to the user for approval before Phase 4.

### Phase 4 — Draft

For each page:

1. Pick a template from [page-templates.md](page-templates.md).
2. Apply voice and vocabulary from [tone-and-vocabulary.md](tone-and-vocabulary.md).
3. Write **task-oriented English** — one primary concept per page.
4. Use self-contained `##` sections (retrieval-friendly for Documentation.AI search).
5. Insert screenshot placeholders per [screenshot-placeholders.md](screenshot-placeholders.md) where visuals help.
6. Use Documentation.AI components per `slugbase-docs/.cursor/rules/documentation.ai.mdc`.

**Body structure defaults:**

- Lead with outcome ("After this guide, you will…").
- Prerequisites before steps.
- Verification step at the end of procedures.
- Troubleshooting section for how-to and runbook pages.

### Phase 5 — Wire navigation

1. Add or update `path` entries in `slugbase-docs/documentation.json` under the correct product → tab → group chain.
2. Push to `slugbase-docs` `main` (or open a PR) — Documentation.AI validates on build.

### Phase 6 — Summarise

Report:

- Pages created or updated (paths)
- Navigation changes in `documentation.json`
- Screenshot placeholders added (for follow-up capture via DA web editor)
- Open questions or spec gaps found during discovery

## Maintenance mode checklist

When refreshing existing MDX:

- [ ] Re-read discovery sources for changed routes or copy
- [ ] Compare page claims against spec § relevant sections
- [ ] Check entitlement-gated UI (settings nav visibility, billing panels) still matches
- [ ] Update internal links if paths moved
- [ ] Confirm Documentation.AI build passes after push

## Out of scope

- Editing `slugbase-docs/.cursor/rules/documentation.ai.mdc` (owned by #408)
- Engineering docs in `slugbase/docs/internal/`
- German public documentation
- OpenAPI spec authoring (separate API reference work under #392 children)

## Quick commands

```bash
# Multi-root workspace (slugbase.code-workspace) — paths from workspace root

# Search UI copy by prefix (slugbase monorepo)
rg '"bookmarks\.' slugbase/packages/web/app/i18n/locales/en.json

# List app routes
cat slugbase/packages/web/app/routes.ts

# List customer MDX (slugbase-docs repo)
ls slugbase-docs/selfhosted slugbase-docs/cloud

# Git status per repo
git -C slugbase status
git -C slugbase-docs status
```
