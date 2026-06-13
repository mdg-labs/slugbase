# SlugBase public documentation (source)

Customer and operator documentation for [Documentation.AI](https://documentation.ai). **This directory in the SlugBase monorepo is the source of truth** for publishable docs. Content is authored as MDX here and synced to [`mdg-labs/slugbase-docs`](https://github.com/mdg-labs/slugbase-docs) on push to `main` (see [#396](https://github.com/mdg-labs/slugbase/issues/396)).

**To publish:** merge your branch to **`slugbase` `main`**. CI mirrors this tree to `slugbase-docs` `main`; Documentation.AI rebuilds from that repo. There is no publish path from `staging` or open PRs.

**Live site:** [docs.slugbase.app](https://docs.slugbase.app) (after Documentation.AI build). **Do not edit `slugbase-docs` directly** — the next sync overwrites it. Source of truth is always this directory in `mdg-labs/slugbase`. Operator setup and verification: [`docs/internal/sync-docs-public-runbook.md`](../internal/sync-docs-public-runbook.md), [`docs/internal/documentation-ai-publish-verification.md`](../internal/documentation-ai-publish-verification.md).

**Engineering docs** (spec, roadmap, design prototype, agent rules) live under [`docs/internal/`](../internal/) and are **never** synced.

---

## Publish mirror

Everything under `docs/public/` in this repo is copied **flat** to the `slugbase-docs` repository root on sync. Paths must match 1:1.

```text
slugbase/docs/public/              slugbase-docs/ (repo root)
├── documentation.json        →    documentation.json
├── README.md                 →    README.md
├── selfhosted/               →    selfhosted/
│   ├── *.mdx                 →    │   ├── *.mdx
│   └── api-reference/        →    │   └── api-reference/
│       └── *.yaml            →    │       └── *.yaml
├── cloud/                    →    cloud/
│   ├── *.mdx                 →    │   ├── *.mdx
│   └── api-reference/        →    │   └── api-reference/
│       └── *.yaml            →    │       └── *.yaml
├── assets/                   →    assets/
└── scripts/                  →    scripts/
```

Published URL paths mirror file paths: `selfhosted/quick-start.mdx` → `/selfhosted/quick-start` (no `.mdx` in the URL).

Sync is **one-way**: `slugbase` `main` → `slugbase-docs` `main` only.

Full contract: GitHub [#392](https://github.com/mdg-labs/slugbase/issues/392).

---

## Authoring workflow

1. Add or edit an `.mdx` page under `docs/public/` (see [MDX pages](#mdx-pages) below).
2. Register the page in `documentation.json` navigation (`path` entry in the correct product → tab → group).
3. Run `pnpm validate:docs-public` from the repo root.
4. Merge to `main`; CI sync publishes to Documentation.AI.

Cursor rule for agents: [`.cursor/rules/documentation.ai.mdc`](../../.cursor/rules/documentation.ai.mdc) (applies to `docs/public/**/*.mdx`).

---

## MDX pages

Every page **must** begin with YAML frontmatter:

```yaml
---
title: "Introduction to self-hosted SlugBase"
description: "What SlugBase is, how self-hosted differs from cloud, and how these guides are written."
---
```

| Rule | Detail |
|------|--------|
| `title` | Required. Becomes the page H1 and browser title. |
| `description` | Required. Used for SEO and previews. |
| Body headings | Start with `##` (H2). H1 is generated from frontmatter. |
| Filenames | Lowercase with hyphens: `quick-start.mdx`, not `QuickStart.mdx`. |
| Internal links | Root-absolute: `[Quick start](/selfhosted/quick-start)` — not `../` relative paths. |
| Images | Root-absolute: `![alt text](/assets/intro-hero.png)` |

Use Documentation.AI components (`<Callout>`, `<Steps>`, `<Tabs>`, etc.) per the cursor rule and [Documentation.AI docs](https://documentation.ai/docs/write-and-publish/code-editor).

### Product vocabulary (spec §3)

Public docs use SlugBase product terms: **workspace** (not organization), **folder** (not collection), **pinned** (not favorites), **slug**, **forwarding** / **go**. If content is for developers building SlugBase, it belongs in `docs/internal/`.

---

## documentation.json

`documentation.json` controls site name, branding colours, navbar links, default route, and sidebar navigation. It lives at `docs/public/documentation.json` (source) and the `slugbase-docs` repo root (publish).

### Required top-level keys

| Key | Purpose |
|-----|---------|
| `name` | Site name (browser title, previews) |
| `navigation` | Full sidebar structure (see below) |

Common optional keys: `title`, `template` (`classic` / `atlas`), `initialRoute`, `colors`, `navbar`, `logo-dark`, `logo-light`, `favicon`, `scripts`, `integrations`.

### Navigation model

Documentation.AI organises nav as **Dimensions → Views → Content**:

1. **Dimension** — SlugBase uses `navigation.products` (Self-hosted, Cloud)
2. **View** — tabs within a product (`Guides`, `API`)
3. **Content** — `groups` containing `pages`, or OpenAPI via group-level `openapi`

Each container uses **exactly one** child type (`groups`, `pages`, or `dropdowns`).

### Adding a new page

**Both** steps are required:

1. Create `docs/public/{product}/{page}.mdx` with `title` and `description` frontmatter.
2. Add a page entry in the correct chain:

```json
{
  "title": "Quick start",
  "path": "selfhosted/quick-start",
  "icon": "zap"
}
```

| `documentation.json` | File on disk |
|------------------------|--------------|
| `"path": "selfhosted/quick-start"` | `selfhosted/quick-start.mdx` |
| `"path": "cloud/billing"` | `cloud/billing.mdx` |

- `path` — relative to repo root, **no** `.mdx` suffix; must match the file on disk.
- `title` — sidebar label (can differ from frontmatter `title`).
- `icon` — optional Lucide icon name.
- `href` — external links only (use instead of `path`).

`initialRoute` sets the default page when visiting `/` (path without `.mdx`, e.g. `selfhosted/introduction`). It must resolve to an existing `.mdx` file.

### OpenAPI / API tabs

OpenAPI specs live beside product guides:

| Product | Spec path |
|---------|-----------|
| Self-hosted | `selfhosted/api-reference/selfhosted-openapi.yaml` |
| Cloud | `cloud/api-reference/cloud-openapi.yaml` |

Reference from a nav **group**:

```json
{
  "group": "REST API",
  "openapi": "selfhosted/api-reference/selfhosted-openapi.yaml",
  "pages": []
}
```

Documentation.AI generates API reference pages from the spec. Manual MDX API pages are optional.

---

## Validation

From the repo root:

```bash
pnpm validate:docs-public
```

The validator checks **only** `docs/public/` (not `docs/internal/`):

- Every `*.mdx` has `title` and `description` frontmatter
- Every `path` in `documentation.json` resolves to a matching `.mdx` file
- Every `openapi` path resolves to an existing file
- MDX filenames use lowercase-with-hyphens
- `documentation.json` is valid JSON with required keys `name` and `navigation`

CI runs this check when `docs/public/**` changes.

---

## References

- Parent epic [#392](https://github.com/mdg-labs/slugbase/issues/392) — full publish contract
- [Documentation.AI code editor](https://documentation.ai/docs/write-and-publish/code-editor)
- [Site configuration](https://documentation.ai/docs/customize/site-configuration)
- [documentation.json schema](https://dashboard.documentation.ai/documentation.json)
