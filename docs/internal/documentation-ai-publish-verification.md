# Documentation.AI publish verification — operator handoff

End-to-end verification checklist for [#397](https://github.com/mdg-labs/slugbase/issues/397) (parent [#392](https://github.com/mdg-labs/slugbase/issues/392)).

**Status (2026-06-13):** **Blocked for automated pipeline** — `SLUGBASE_DOCS_DEPLOY_KEY` is not configured on `mdg-labs/slugbase`, and the sync workflow (`.github/workflows/sync-docs-public.yml`) is on `staging` only (not yet on `main`). Live site smoke tests against the **existing** Documentation.AI deployment are **partial PASS** (see below).

| Layer | Result | Notes |
|---|---|---|
| Local `docs/public/` structure + validation | **PASS** | `pnpm validate:docs-public` OK |
| Workflow YAML review | **PASS** | On `staging`; triggers on `main` path filter `docs/public/**` |
| GitHub secret `SLUGBASE_DOCS_DEPLOY_KEY` | **BLOCKED** | Not present (only Infisical OIDC secrets on repo) |
| CI sync run (`slugbase` → `slugbase-docs`) | **BLOCKED** | Workflow not on `main`; secret missing |
| `slugbase-docs` repo structure (API inspect) | **PASS** | Root layout matches contract; 41 MDX files |
| Documentation.AI dashboard build | **BLOCKED** | Requires operator browser access |
| Live site smoke (`docs.slugbase.app`) | **PARTIAL** | Pages load; `/assets/logo.svg` 404; API tab path TBD |

**Known public docs URL:** [https://docs.slugbase.app](https://docs.slugbase.app) (linked from `docs/public/cloud/support.mdx`).

---

## Pre-flight checklist (operator)

Complete in order after [#396](https://github.com/mdg-labs/slugbase/issues/396) merges to `main`.

### 1. GitHub secret and deploy key

- [ ] Generate ed25519 deploy key pair (see [sync-docs-public-runbook.md](./sync-docs-public-runbook.md#one-time-setup-operator))
- [ ] Add **public** key to `mdg-labs/slugbase-docs` deploy keys (**Allow write access**)
- [ ] Add **private** key as `SLUGBASE_DOCS_DEPLOY_KEY` on `mdg-labs/slugbase` Actions secrets
- [ ] Confirm: `gh secret list --repo mdg-labs/slugbase | rg SLUGBASE_DOCS_DEPLOY_KEY`

### 2. Merge publish workflow to `main`

- [ ] `sync-docs-public.yml` present on `slugbase` `main`
- [ ] Trigger: push to `main` with `docs/public/**` changes

### 3. Repo structure (`slugbase-docs` after sync)

- [ ] `documentation.json` at repo root (not in a subfolder)
- [ ] `selfhosted/` and `cloud/` MDX folders present
- [ ] `selfhosted/api-reference/selfhosted-openapi.yaml` present
- [ ] `cloud/api-reference/cloud-openapi.yaml` present
- [ ] `assets/` and `scripts/` present
- [ ] `documentation.json` `scripts` paths resolve:
  - `scripts/cookie-consent.bundle.js`
  - `scripts/umami-analytics.js`

### 4. Documentation.AI dashboard

- [ ] Connected repo: `mdg-labs/slugbase-docs`
- [ ] Branch: `main`
- [ ] Project root: repository root (not a subfolder)
- [ ] Build succeeds after sync push (zero errors in build log)
- [ ] `documentation.json` and MDX parse without errors
- [ ] `initialRoute` (`selfhosted/introduction`) loads at site root

### 5. Live site smoke tests

Base URL: **https://docs.slugbase.app**

- [ ] Product switcher: **Self-hosted** and **Cloud** dimensions work
- [ ] Guides tab: sidebar groups match `documentation.json` nav
- [ ] API tab: OpenAPI-generated pages render for both products
- [ ] At least one image loads (CDN logos in `documentation.json` or `/assets/…` if served)
- [ ] Internal link navigation works (root-absolute paths, e.g. `/selfhosted/quick-start`)

### 6. End-to-end publish test

- [ ] Trivial MDX edit under `docs/public/` → merge to `slugbase` `main`
- [ ] **Actions → Sync Public Docs** succeeds on `mdg-labs/slugbase`
- [ ] New commit on `slugbase-docs` `main` references source SHA
- [ ] Documentation.AI rebuild completes
- [ ] Live site reflects the edit within build window

### 7. Handoff docs

- [ ] `slugbase-docs` README (from `docs/public/README.md`) states source of truth is `mdg-labs/slugbase` `docs/public/`
- [ ] This file updated with final PASS/FAIL and verification date

---

## What was verified locally (agent, 2026-06-13)

### `docs/public/` tree (source of truth)

| Check | Result |
|---|---|
| `documentation.json` at `docs/public/documentation.json` | PASS |
| `selfhosted/` MDX pages | PASS (27 pages) |
| `cloud/` MDX pages | PASS (14 pages) |
| `selfhosted/api-reference/selfhosted-openapi.yaml` | PASS |
| `cloud/api-reference/cloud-openapi.yaml` | PASS |
| `assets/` (SVG icons) | PASS |
| `scripts/` (`cookie-consent.bundle.js`, `umami-analytics.js`, vendors) | PASS |
| `pnpm validate:docs-public` | PASS |
| `initialRoute`: `selfhosted/introduction` → file exists | PASS |

### Workflow YAML (`.github/workflows/sync-docs-public.yml`)

| Check | Result |
|---|---|
| Flat `rsync --delete` mirror to `slugbase-docs` root | PASS |
| Fails fast when `SLUGBASE_DOCS_DEPLOY_KEY` empty | PASS |
| SSH deploy via `webfactory/ssh-agent` | PASS |
| Idempotent skip when no diff | PASS |
| Trigger: `main` + `docs/public/**` path filter | PASS |

### `slugbase-docs` remote (GitHub API, no clone)

Inspected `mdg-labs/slugbase-docs` `main` without assuming CI sync ran.

| Check | Result |
|---|---|
| `documentation.json` at repo root | PASS (12 503 bytes; local 12 497) |
| `selfhosted/`, `cloud/`, `assets/`, `scripts/` trees | PASS |
| OpenAPI YAMLs present | PASS |
| MDX file count | PASS (41; matches local) |
| Latest commit message references CI sync | **NO** — last commit 2026-05-11, manual docs edit |

### Live site HTTP smoke (existing publish)

| URL | HTTP | Notes |
|---|---|---|
| `https://docs.slugbase.app/` | 200 | HTML references `selfhosted/introduction` |
| `https://docs.slugbase.app/selfhosted/introduction` | 200 | Self-hosted intro loads |
| `https://docs.slugbase.app/selfhosted/quick-start` | 200 | Internal guide path |
| `https://docs.slugbase.app/cloud/introduction` | 200 | Cloud product |
| `https://docs.slugbase.app/assets/logo.svg` | **404** | Repo has file; DA may not expose `/assets/` the same way |
| `documentation.json` blob CDN logo URL | 200 | Hosted on `blob-cdn.documentation.ai` |

HTML body of live pages includes **Self-hosted**, **Cloud**, **Introduction**, **Quick start**, and **REST API** strings — product switcher and nav appear present. API tab rendering and sidebar group parity require manual browser confirmation.

---

## Operator steps remaining

1. **Configure `SLUGBASE_DOCS_DEPLOY_KEY`** — follow [sync-docs-public-runbook.md § One-time setup](./sync-docs-public-runbook.md#one-time-setup-operator).
2. **Promote workflow to `main`** — merge `staging` (includes [#396](https://github.com/mdg-labs/slugbase/issues/396) sync workflow) via release path.
3. **Run first automated sync** — merge any `docs/public/**` change to `main` (or no-op if trees already match); confirm Actions run and `slugbase-docs` commit.
4. **Documentation.AI dashboard** — confirm connected repo/branch/root; watch build log for zero errors after sync push.
5. **Complete §5 live smoke tests** in a browser (product switcher, API tabs, internal links, assets).
6. **Run §6 end-to-end publish test** — trivial MDX edit through to live site.
7. **Update this file** — change status to **Complete**, tick all boxes, add verification date and operator initials.

---

## Documentation.AI dashboard config (expected)

| Setting | Value |
|---|---|
| Git provider | GitHub |
| Repository | `mdg-labs/slugbase-docs` |
| Branch | `main` |
| Root directory | `/` (repository root) |
| Config file | `documentation.json` (repo root) |

Do not edit `slugbase-docs` directly for content — changes are overwritten on the next CI sync from `mdg-labs/slugbase` `docs/public/`.

---

## Related

- [sync-docs-public-runbook.md](./sync-docs-public-runbook.md)
- [docs/public/README.md](../public/README.md)
- Issues: [#392](https://github.com/mdg-labs/slugbase/issues/392), [#396](https://github.com/mdg-labs/slugbase/issues/396), [#397](https://github.com/mdg-labs/slugbase/issues/397)
