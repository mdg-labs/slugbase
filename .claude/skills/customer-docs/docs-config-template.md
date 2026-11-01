# Customer docs config — {{PRODUCT_NAME}}

Configuration for the `customer-docs` skill in this repo, written by its bootstrap mode and owned by the repo — the skill itself is vendored and never edited here. Edit this file when the docs site or the app layout changes. Paths are relative to the repo root.

## Product

| Field | Value |
| ----- | ----- |
| Product name | {{PRODUCT_NAME}} |
| Core use case | {{one sentence: what it does for whom}} |
| Audience | {{who reads the docs and what they already know — technical or not}} |
| Deployment model | {{how the product is offered (self-hosted, hosted, both) — docs never hint at an edition that does not exist}} |
| Accounts and roles | {{sign-up model; roles and what each may do, or "no roles"}} |
| Behaviour source of truth | {{the spec docs (see CLAUDE.md `### Design docs`), then app code. Never document behaviour that is in neither.}} |

## Docs site

The content is published by a site that is built elsewhere and owns its framework, sidebar and navigation. This repo holds only the content and its contract (doc 09 §3.5), so no framework, base URL, deploy or sidebar setting is recorded here, and the skill never writes one.

| Field | Value |
| ----- | ----- |
| Content root | `docs/user` |
| Build check | `pnpm docs:check` (the same command as `.claude/workflow.json` `docs.build`) |
| Language | English only |
| Other roots | `docs/self-hosting/` and `docs/releases/` are outside the content root; the skill neither writes nor reports on them |

### Synced files — never hand-edit

{{Files a script regenerates from another source, with the source to edit instead — or "none".}}

| Generated file | Edit this source instead |
| -------------- | ------------------------ |

### Customer doc layout

A page that uses a component (`Callout`, `EditionBadge`, `Screenshot` and the rest of the allow-list) is an `.mdx` file; any other page is `.md`. The route is the path below the content root without the extension, so the choice does not change it.

| Doc type | Path | Folder |
| -------- | ---- | ------ |
| Landing page | `docs/user/index.md` | content root |
| Getting started / first steps | `docs/user/getting-started.mdx` | content root |
| Page docs (one per in-app page) | `docs/user/<page>.mdx` | {{folder, or the content root}} |
| Concept pages | `docs/user/concepts/<concept>.md` | `concepts/` |
| FAQ | `docs/user/faq.md` | content root |

File names: kebab-case. The first path segment is never `cloud`, `self-hosting` or `releases`, in any case. A new page needs no navigation entry: the site orders pages by the `order` field.

### Frontmatter

```yaml
title: "Page title"     # required
description: "One line" # required
edition: both           # required: ce, cloud or both
since: 1.0.0            # optional: the first version that has it
order: 10               # optional: an integer
```

No other field is allowed. {{Whether the site renders `title` as the H1 (then the body has none, as the templates assume) — ask the maintainer, because doc 09 §3.5 does not say.}} Links between pages are relative file paths (`../concepts/slugs.md`) or `/docs/...` routes; the skill never writes a base path or a root-absolute link outside `/docs/`.

## App page inventory

| Field | Value |
| ----- | ----- |
| App | `{{path}}` ({{framework}}) |
| Routes dir | `{{path/}}` — {{which route groups are signed-in vs public}} |
| Navigation source | `{{path}}` |
| UI labels | `{{path}}` — quote labels from here, never invent them |
| Feature components | `{{path}}/<feature>/` |

### Route → doc map

| Route | Page (UI title) | Doc path |
| ----- | --------------- | -------- |

Re-scan the routes dir on every run: a route without a row here is a new page (missing doc).

## Screenshots

| Field | Value |
| ----- | ----- |
| Policy | PLACEHOLDERS |
| Format | `<Screenshot alt="short description" />` without a `src`, in an `.mdx` page — the skill never captures images, and never writes an HTML comment, which the docs contract refuses |

## Glossary (internal term → customer term)

One customer term per concept across all pages. Extend this table (after approval) when a new term appears; ask the user when a mapping is unclear.

| Internal / code term | Customer-facing term |
| -------------------- | -------------------- |

## Coverage tracking

File: `.claude/customer-docs/coverage.md` (created on the first approved write; table format in the skill).

## Commits

| Field | Value |
| ----- | ----- |
| Subject | `docs(<scope>): <summary>` |
| Scope | `docs` |
| Trailer | `Fixes #<n>` when the work belongs to a tracked item (its trailer number — see `.claude/trackers/`), otherwise none |
