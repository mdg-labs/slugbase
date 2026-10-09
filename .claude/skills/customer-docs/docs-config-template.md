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

| Field | Value |
| ----- | ----- |
| Framework | {{Starlight, Docusaurus, VitePress, Mintlify, plain Markdown, …}} |
| Published URL | {{URL, and the base path if any}} |
| Deploy | {{workflow file or manual}} |
| Build check | {{command — the same as workflow.json `docs.build`}} |
| Content root | `{{path/}}` |
| Sidebar / nav file | `{{path}}` |
| Language | English only |

### Synced files — never hand-edit

{{Files a script regenerates from another source, with the source to edit instead — or "none".}}

| Generated file | Edit this source instead |
| -------------- | ------------------------ |

### Customer doc layout

| Doc type | Path | Sidebar group |
| -------- | ---- | ------------- |
| Landing page | `{{path}}` | {{group or none}} |
| Getting started / first steps | `{{path}}` | {{group}} |
| Page docs (one per in-app page) | `{{dir}}/<page>.md` | {{group}} |
| Concept pages | `{{dir}}/<concept>.md` | {{group}} |
| FAQ | `{{path}}` | {{group}} |

File names: kebab-case. {{How a new page is added to the sidebar.}}

### Frontmatter

```yaml
{{the framework's frontmatter, with required fields marked}}
```

{{Whether the framework renders `title` as the H1 (then the body has none), and how links between pages are written so they survive the base path.}}

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
| Policy | {{PLACEHOLDERS or NONE}} |
| Format | `<!-- SCREENSHOT: short description -->` — the skill never captures images |

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
| Scope | `{{the repo's docs scope}}` |
| Trailer | `Fixes #<n>` when the work belongs to a tracked item (its trailer number — see `.claude/trackers/`), otherwise none |
