# Granular deployment pipeline refactor — implementation plan

**Status:** Locked (internal)  
**Date:** 2026-06-24  
**Audience:** Engineering + GitHub intake (`github-intake` skill)  
**Spec refs:** spec §14.2, §14.7, §22.5–22.8, §15

---

## GitHub intake — epic draft (copy for `github-intake`)

Use this block when running intake. **Do not create issues until the user approves the structure** (intake skill step 2).

```markdown
## Proposed issue structure

**Feature (epic):** #?? — Granular deployment pipeline and CE image split  
**Domain:** `domain:infrastructure`  
**Milestone:** MVP Alpha (fetch open milestone number before create)  
**Priority:** High · **Effort:** High

**Children:**

| # | Domain | Type | Summary | Depends on |
|---|---|---|---|---|
| #?? | infrastructure | Task | Add Turbo-based deploy target detection script | — |
| #?? | infrastructure | Task | Wire selective deploy jobs and DEPLOYED_STATE | #?? |
| #?? | infrastructure | Task | Add per-surface smoke and production version gate | #?? |
| #?? | infrastructure | Task | Split CE Docker images for api and web | — |
| #?? | infrastructure | Task | Update GHCR build and push for split CE images | #?? |
| #?? | infrastructure | Task | Seed per-package versions and add Changesets | — |
| #?? | infrastructure | Task | Replace prepare-release with Changesets Version PR | #?? |
| #?? | infrastructure | Task | Update release.yml for aggregate release deploy | #??, #?? |
| #?? | infrastructure | Task | Update Sentry release derivation per package | #?? |
| #?? | infrastructure | Task | Update CE e2e for split api and web containers | #??, #?? |
| #?? | operations | Task | Update CE customer docs and compose examples | #??, #?? |
| #?? | docs | Task | Update internal CI and environment variable docs | #??, #?? |

**Suggested implementation order:**  
#?? (detect) → #?? (deploy.yml) → #?? (smoke/gate) in parallel with #?? (split Docker) → #?? (GHCR) → #?? (Changesets seed) → #?? (Version PR) → #?? (release.yml) + #?? (Sentry) → #?? (e2e) → #?? (customer docs) → #?? (internal docs)

**Spec refs:** spec §14.2 (CE packaging), §14.7 (Cloud topology), §22.5–22.8 (CI/CD), §15 (config)

**Product rules (epic):**
- Selective deploy in **staging and production** (not staging-only)
- Per-deployable semver via Changesets — **not** root `package.json` bump for marketing-only work
- Production deploy per surface only when that package version ≥ `1.0.0`
- CE: **split** `slugbase-api` + `slugbase-web` GHCR images (locked — no combined image as default)
- Cloud topology unchanged (API Fly, web/marketing CF Workers) — do **not** combine Cloud
```

---

## Locked decisions

| Decision | Resolution |
|---|---|
| **Deploy scope** | Turbo affected (`--filter=...[REF]`) + package → target mapping; gate jobs in `deploy.yml` with `if:` |
| **Version identity** | Per-deployable `package.json` + **Changesets** (`privatePackages: { version: true, tag: true }`) |
| **Starting versions** | `@slugbase/backend`, `@slugbase/web`, `@slugbase/marketing`, `@slugbase/admin` → **`0.1.0`** |
| **Root `package.json` version** | Workspace metadata only — **not** a release gate |
| **Production gate** | Per-surface: skip production deploy when package version **&lt; `1.0.0`** (staging has no minimum) |
| **CE images** | **Split:** `ghcr.io/mdg-labs/slugbase-api`, `ghcr.io/mdg-labs/slugbase-web` — **retire combined image as default** |
| **CE API runtime** | `SERVE_WEB_CLIENT=false` (same as Cloud API) |
| **GHCR staging tags** | `:dev` per image (push only when that package is in affected set) |
| **GHCR production tags** | `:<package-semver>` (e.g. `:1.0.0`) + `:latest` per image on production push |
| **Git tags** | Changesets format `@slugbase/<pkg>@X.Y.Z` — no collision between packages |
| **GitHub Release** | **One aggregate** draft per Version PR merge — **not** one Release per package tag |
| **Production trigger** | `release: published` only — **not** workflow on every package tag push |
| **Deploy state** | Repo variables `DEPLOYED_STATE_staging` / `DEPLOYED_STATE_production` (JSON per surface) |
| **Draft release title** | Comma-separated package list when ≤3 bumped; else calendar date + detail in body |
| **Shared libs** | `shared-types`, `ui`, `email-templates`, `db-admin` in Changesets `ignore` (stay `0.0.0`) |
| **No `fixed` group** | Backend and web version independently |

---

## Problem → target

### Today

| Area | Behaviour |
|---|---|
| Staging / production deploy | Always deploy api, web, marketing, admin; always migrate both DBs; sync all secrets |
| GHCR | Single combined image `ghcr.io/mdg-labs/slugbase` |
| Versioning | Root `package.json` → `v*` tag → `DEPLOYED_VERSION` |
| CE local/dev | `dev.docker-compose.yml` — one `slugbase` service |
| Customer docs | `slugbase-docs/ce/*` — combined image narrative |

### Target

```mermaid
flowchart TB
  subgraph detect [detect-deploy-targets]
    T[Turbo affected]
    M[Package to target map]
    G[Production ge 1.0.0 gate]
  end

  subgraph cloud [Cloud deploy]
    API[Fly api]
    WEB[CF web]
    MKT[CF marketing]
    ADM[Fly admin]
  end

  subgraph ce [CE GHCR]
    CEAPI[slugbase-api image]
    CEWEB[slugbase-web image]
  end

  subgraph version [Release]
    CS[Changesets Version PR]
    TAG["@slugbase/pkg@X.Y.Z tags"]
    REL[One draft GitHub Release]
  end

  T --> M --> G
  G --> API & WEB & MKT & ADM
  G --> CEAPI & CEWEB
  CS --> TAG --> REL
  REL --> detect
```

Same deployable boundaries on Cloud and CE. Marketing-only change → deploy marketing only; bump `@slugbase/marketing` only; no root version bump.

---

## Package → deploy target mapping

Used by `.github/scripts/detect-deploy-targets.sh` (staging **and** production):

| Path / package | Cloud targets | CE GHCR | Also run |
|---|---|---|---|
| `packages/backend` | api | `push_ghcr_api` | `migrate` |
| `packages/web` | web | `push_ghcr_web` | — |
| `packages/marketing` | marketing | — | — |
| `packages/admin` | admin | — | — |
| `packages/db-admin` | admin | — | `migrate_admin` |
| `packages/shared-types` | api, web, marketing | api, web if consumers build | — |
| `packages/ui` | web, marketing | web if consumer | — |
| `packages/email-templates` | api | api if consumer | — |
| `packages/backend/drizzle/**` | api | api | `migrate` |
| `packages/db-admin/**` migrations | admin | — | `migrate_admin` |
| `Dockerfile.api`, `fly.toml`, api deploy scripts | api | `push_ghcr_api` | — |
| `Dockerfile.web`, web wrangler/deploy scripts | web | `push_ghcr_web` | — |
| `pnpm-lock.yaml`, `turbo.json`, `.nvmrc`, root toolchain | **all** | **both** images | — |

**Conservative overrides (deploy all):** `workflow_dispatch` + `force_full_deploy: true`; missing/invalid `DEPLOYED_STATE`; first run after enablement.

---

## `DEPLOYED_STATE` schema

```json
{
  "api":       { "version": "0.1.0", "sha": "abc1234" },
  "web":       { "version": "0.1.0", "sha": "def5678" },
  "marketing": { "version": "0.1.0", "sha": "ghi9012" },
  "admin":     { "version": "0.1.0", "sha": "jkl3456" },
  "ghcr_api":  { "version": "0.1.0", "sha": "mno7890" },
  "ghcr_web":  { "version": "0.1.0", "sha": "pqr1234" }
}
```

Update a surface entry **only** after that surface’s deploy + smoke succeeded.

---

## Implementation work packages

Each row is one **leaf GitHub issue** (one implementation commit). Fields match [github-intake templates](.cursor/skills/github-intake/templates.md).

---

### WP-1 — Add Turbo-based deploy target detection script

| Field | Value |
|---|---|
| **Domain** | `domain:infrastructure` |
| **Summary** | Add Turbo-based deploy target detection script |
| **Depends on** | — |
| **Spec refs** | spec §22.5 |

**Scope**

- Add `.github/scripts/detect-deploy-targets.sh`
- Inputs: `environment` (`staging` \| `production`), `head_ref`, optional `base_ref`, `force_full_deploy`
- Run `pnpm exec turbo run build --filter=...[base] --dry-run=json` (or `turbo query affected` if adopted)
- Explicit migration detection for `packages/backend/drizzle`, `packages/db-admin`
- Emit GitHub Actions outputs: `deploy_api`, `deploy_web`, `deploy_marketing`, `deploy_admin`, `run_migrate`, `run_migrate_admin`, `push_ghcr_api`, `push_ghcr_web`, `sync_services`
- Production: clear each `deploy_*` when package version &lt; `1.0.0`
- Unit tests: `scripts/detect-deploy-targets.spec.ts` or fixture-based shell tests with mocked turbo JSON

**Files**

```
.github/scripts/detect-deploy-targets.sh
scripts/detect-deploy-targets*.spec.ts  (or vitest.scripts)
```

**Tests**

- `pnpm test:scripts` with fixture diffs (marketing-only, shared-types, lockfile-only, migration-only)

**AC**

- [ ] Marketing-only diff → `deploy_marketing=true`, others false (except shared-lib fan-out rules)
- [ ] Production + backend `0.1.5` → `deploy_api=false` with logged skip reason
- [ ] `force_full_deploy=true` → all deploy flags true

---

### WP-2 — Wire selective deploy jobs and DEPLOYED_STATE

| Field | Value |
|---|---|
| **Domain** | `domain:infrastructure` |
| **Summary** | Wire selective deploy jobs and DEPLOYED_STATE |
| **Depends on** | WP-1 |
| **Spec refs** | spec §22.5, §22.7 |

**Scope**

- Add `detect-deploy-targets` job at start of `.github/workflows/deploy.yml`
- Pass `services: ${{ needs.detect.outputs.sync_services }}` into `sync-secrets.yml` (already supports filter)
- Add `if:` on `migrate`, `migrate-admin`, `deploy-api`, `deploy-web`, `deploy-marketing`, `deploy-admin`
- Create repo variables `DEPLOYED_STATE_staging`, `DEPLOYED_STATE_production` (document in `environment-variables.md`)
- After smoke: script to merge successful surfaces into `DEPLOYED_STATE_<env>` via `gh variable set`
- Staging checkout: `fetch-depth: 2` minimum; production: `fetch-depth: 0`
- `workflow_dispatch` input `force_full_deploy` on `staging.yml` / `release.yml`

**Files**

```
.github/workflows/deploy.yml
.github/workflows/staging.yml
.github/workflows/release.yml
.github/scripts/update-deployed-state.sh
docs/internal/environment-variables.md
```

**Tests**

- Dry-run workflow on `workflow_dispatch` with `force_full_deploy` (manual)
- Unit tests for `update-deployed-state.sh`

**AC**

- [ ] Marketing-only staging push deploys marketing only (job summary lists skipped surfaces)
- [ ] `sync-secrets` receives scoped `services` list
- [ ] `DEPLOYED_STATE` updated per surface on success only

---

### WP-3 — Add per-surface smoke and production version gate

| Field | Value |
|---|---|
| **Domain** | `domain:infrastructure` |
| **Summary** | Add per-surface smoke and production version gate |
| **Depends on** | WP-2 |
| **Spec refs** | spec §22.5 |

**Scope**

- Refactor `.github/scripts/smoke-staging-health.sh` — flags: `--api`, `--web`, `--marketing`, `--admin` (default all when no flags)
- Smoke job `needs` only deployed surfaces; pass flags from `detect-deploy-targets` outputs
- Production version gate lives in WP-1 script; WP-3 verifies integration + job summary messages

**Files**

```
.github/scripts/smoke-staging-health.sh
.github/scripts/smoke-admin-health.sh
.github/workflows/deploy.yml
```

**AC**

- [ ] Marketing-only deploy runs marketing root check only (not blocked on API `/version`)
- [ ] Production skip for `0.1.x` surfaces logged in job summary

---

### WP-4 — Split CE Docker images for api and web

| Field | Value |
|---|---|
| **Domain** | `domain:infrastructure` |
| **Summary** | Split CE Docker images for api and web |
| **Depends on** | — |
| **Spec refs** | spec §14.2 |

**Scope**

- Add `Dockerfile.api` — backend only, `SLUGBASE_EDITION=ce`, `SERVE_WEB_CLIENT=false`
- Add `Dockerfile.web` — web SSR server image (`packages/web/build/server`), CE `VITE_*` via `scripts/self-host-vite-build-args.sh`
- Retire root `Dockerfile` combined build as **default** (delete or rename `Dockerfile.legacy` with removal note in WP-11)
- API image: migrations on bootstrap (existing hosted-off path when `SERVE_WEB_CLIENT=false` — verify CE bootstrap path)
- Document image names: `ghcr.io/mdg-labs/slugbase-api`, `ghcr.io/mdg-labs/slugbase-web`

**Files**

```
Dockerfile.api
Dockerfile.web
Dockerfile                    (remove or deprecate)
packages/backend/             (bootstrap / SERVE_WEB_CLIENT if needed)
```

**Tests**

- Local `docker build -f Dockerfile.api` / `Dockerfile.web` smoke
- `pnpm test:integration` unaffected

**AC**

- [ ] API image exposes `/health` + `/version` on port 3000
- [ ] Web image serves app and `/version` with distinct package semver
- [ ] No `WEB_CLIENT_SERVER_BUILD` mount in API image

---

### WP-5 — Update GHCR build and push for split CE images

| Field | Value |
|---|---|
| **Domain** | `domain:infrastructure` |
| **Summary** | Update GHCR build and push for split CE images |
| **Depends on** | WP-4 |
| **Spec refs** | spec §22.8 |

**Scope**

- Replace `.github/scripts/build-push-ghcr.sh` with split entrypoints or `--target api|web`
- Tag strategy:
  - Staging: `ghcr.io/mdg-labs/slugbase-api:dev`, `ghcr.io/mdg-labs/slugbase-web:dev`
  - Production: `:<version>` from `packages/backend/package.json` / `packages/web/package.json` + `:latest` per image
- Update `.github/workflows/staging.yml` — `push-ghcr-api` / `push-ghcr-web` jobs gated by `detect` outputs (via reusable output or duplicate detect job in staging)
- Update `.github/workflows/release.yml` — same gating
- Stop pushing combined `ghcr.io/mdg-labs/slugbase` except optional one-time deprecation note in docs

**Files**

```
.github/scripts/build-push-ghcr.sh
.github/workflows/staging.yml
.github/workflows/release.yml
```

**AC**

- [ ] Backend-only change pushes `slugbase-api:dev` only on staging
- [ ] Web-only change pushes `slugbase-web:dev` only
- [ ] Production push tags image with package semver

---

### WP-6 — Seed per-package versions and add Changesets

| Field | Value |
|---|---|
| **Domain** | `domain:infrastructure` |
| **Summary** | Seed per-package versions and add Changesets |
| **Depends on** | — |
| **Spec refs** | spec §22.6 |

**Scope**

- Set `version: "0.1.0"` on `packages/backend`, `packages/web`, `packages/marketing`, `packages/admin`
- Add `.changeset/config.json`:

```json
{
  "privatePackages": { "version": true, "tag": true },
  "ignore": [
    "@slugbase/shared-types",
    "@slugbase/ui",
    "@slugbase/email-templates",
    "@slugbase/db-admin"
  ],
  "commit": false,
  "access": "restricted"
}
```

- Add `@changesets/cli` devDependency + root scripts: `changeset`, `version-packages`
- Contributor note in `docs/internal/local-development.md`: changeset required for deployable changes

**Files**

```
.changeset/config.json
packages/backend/package.json
packages/web/package.json
packages/marketing/package.json
packages/admin/package.json
package.json
docs/internal/local-development.md
```

**AC**

- [ ] `pnpm changeset` runs
- [ ] Deployables at `0.1.0`; shared libs at `0.0.0`

---

### WP-7 — Replace prepare-release with Changesets Version PR

| Field | Value |
|---|---|
| **Domain** | `domain:infrastructure` |
| **Summary** | Replace prepare-release with Changesets Version PR |
| **Depends on** | WP-6 |
| **Spec refs** | spec §22.6 |

**Scope**

- Add Changesets GitHub Action on `main` (`.github/workflows/changesets.yml` or extend `main.yml`)
- Version PR: `changeset version` bumps only packages with changesets
- On Version PR merge: `changeset tag` → `@slugbase/<pkg>@X.Y.Z`
- Replace root version check in `.github/workflows/prepare-release.yml`:
  - Remove `MIN_VERSION` on root `package.json`
  - Draft release body = aggregated per-package CHANGELOG sections
  - Title: package list (≤3) or `Release YYYY-MM-DD`
- Retire single root `v*` tag for routine releases

**Files**

```
.github/workflows/main.yml
.github/workflows/prepare-release.yml
.github/workflows/changesets.yml   (new, if split)
```

**AC**

- [ ] Marketing-only changeset → Version PR bumps `@slugbase/marketing` only
- [ ] Per-package git tags created; no `v0.1.0` collision between packages
- [ ] Draft GitHub Release created on Version PR merge path

---

### WP-8 — Update release.yml for aggregate release deploy

| Field | Value |
|---|---|
| **Domain** | `domain:infrastructure` |
| **Summary** | Update release.yml for aggregate release deploy |
| **Depends on** | WP-2, WP-7 |
| **Spec refs** | spec §22.7 |

**Scope**

- Replace `DEPLOYED_VERSION` idempotency with per-surface checks in `DEPLOYED_STATE_production`
- `check-not-deployed` job: skip surfaces already at released version+SHA; allow partial re-run
- `record-deployed-version` → update `DEPLOYED_STATE_production` (deprecate single `DEPLOYED_VERSION` or keep as last aggregate release name only)
- `release: published` remains sole production trigger

**Files**

```
.github/workflows/release.yml
.github/scripts/check-production-deploy-needed.sh
```

**AC**

- [ ] Re-publish same release skips already-deployed surfaces
- [ ] Marketing at `1.0.0` deploys; api at `0.2.0` skipped in production until ≥ `1.0.0`

---

### WP-9 — Update Sentry release derivation per package

| Field | Value |
|---|---|
| **Domain** | `domain:infrastructure` |
| **Summary** | Update Sentry release derivation per package |
| **Depends on** | WP-6 |
| **Spec refs** | spec §22.5, defaults-and-constants.md |

**Scope**

- Update `.github/scripts/derive-sentry-release.sh` — `--package <name>` reads that package’s `package.json`
- Format: `slugbase-api@1.0.0+<short-sha>` / `slugbase-web@1.0.1+<short-sha>`
- Run Sentry upload only when corresponding `deploy_*` is true

**Files**

```
.github/scripts/derive-sentry-release.sh
.github/scripts/sentry-release.sh
.github/workflows/deploy.yml
docs/internal/defaults-and-constants.md
```

**AC**

- [ ] No root `slugbase@0.1.5` Sentry release for marketing-only deploy
- [ ] API deploy uploads API source maps with api package version

---

### WP-10 — Update CE e2e for split api and web containers

| Field | Value |
|---|---|
| **Domain** | `domain:infrastructure` |
| **Summary** | Update CE e2e for split api and web containers |
| **Depends on** | WP-4, WP-5 |
| **Spec refs** | spec §22.4, rule `14-e2e-testing.mdc` |

**Scope**

- Update `scripts/e2e.sh` CE path: build/pull `slugbase-api` + `slugbase-web`, run two containers
- Wire `API_BASE_URL` / `FRONTEND_ORIGIN` for Playwright CE project
- Update `e2e/playwright.config.ts` CE base URLs if needed
- Remove combined `slugbase-e2e:ce` single-container assumption

**Files**

```
scripts/e2e.sh
e2e/playwright.config.ts
e2e/test-results/               (log layout docs)
```

**Tests**

- `pnpm test:e2e --project=ce`

**AC**

- [ ] CE e2e passes with split images
- [ ] Cloud e2e project unchanged

---

### WP-11 — Update CE customer docs and compose examples

| Field | Value |
|---|---|
| **Domain** | `domain:operations` |
| **Summary** | Update CE customer docs and compose examples |
| **Depends on** | WP-4, WP-5 |
| **Spec refs** | spec §14.2 |

**Scope — `slugbase-docs` repo**

| File | Change |
|---|---|
| `ce/quick-start.mdx` | Two services (`api`, `web`); split images; `FRONTEND_ORIGIN` may differ from `APP_BASE_URL`; pin `slugbase-api:1.0.0` + `slugbase-web:1.0.0` |
| `ce/introduction.mdx` | Architecture: api + web containers (not combined) |
| `ce/smtp.mdx`, `ce/oidc.mdx`, `ce/ai-suggestions.mdx` | Compose snippets → env on **api** service |
| `ce/troubleshooting.mdx`, `ce/faq.mdx`, `ce/instance-admin.mdx` | Upgrade path for two images; health checks both |
| `ce/first-workspace-setup.mdx` | Prerequisites: api + web healthy |

**Scope — `slugbase` repo**

| File | Change |
|---|---|
| `README.md` | Split images; link to updated quick start |
| `dev.docker-compose.yml` | Rename/clarify; `api` + `web` services; update ports (e.g. api `3000`, web `3001` or proxy pattern) |
| `docs/internal/environment-variables.md` | CE section: two images; `SERVE_WEB_CLIENT=false` on api |

**Compose target shape** (customer docs + `dev.docker-compose.yml`):

```yaml
services:
  postgres:
    image: postgres:16-alpine
    # …

  api:
    image: ghcr.io/mdg-labs/slugbase-api:1.0.0   # pin semver in production
    environment:
      SLUGBASE_EDITION: ce
      SERVE_WEB_CLIENT: "false"
      APP_BASE_URL: https://app.example.com
      FRONTEND_ORIGIN: https://app.example.com
      DATABASE_URL: postgresql://slugbase:CHANGE_ME@postgres:5432/slugbase
      SESSION_SECRET: …
      ENCRYPTION_KEY: …
    # …

  web:
    image: ghcr.io/mdg-labs/slugbase-web:1.0.0
    depends_on:
      api:
        condition: service_healthy
    environment:
      API_BASE_URL: http://api:3000          # internal; or public URL behind proxy
      # VITE_* baked at image build for CE
    ports:
      - "3000:3000"                          # user-facing; or via reverse proxy
```

Document reverse-proxy pattern (Caddy/Traefik) for single public hostname — operator convenience.

**AC**

- [ ] No “combined image” as recommended path in `ce/quick-start.mdx`
- [ ] All compose examples use `slugbase-api` + `slugbase-web`
- [ ] Upgrade section explains independent image version pins
- [ ] `dev.docker-compose.yml` runs locally against `:dev` tags

---

### WP-12 — Update internal CI and environment variable docs

| Field | Value |
|---|---|
| **Domain** | `domain:docs` |
| **Summary** | Update internal CI and environment variable docs |
| **Depends on** | WP-8, WP-11 |
| **Spec refs** | spec §22 |

**Scope**

- Update `docs/internal/slugbase-mvp-spec.md` §22.5–22.8 (selective deploy, split CE images, Changesets, `DEPLOYED_STATE`)
- Update `docs/internal/engineering-decisions.md` CE packaging note
- Update `docs/internal/defaults-and-constants.md` Sentry + GHCR naming
- Update `.cursor/skills/workspace-notes.md` CI/GHCR bullets
- Roadmap row P1-10 / P6-11 alignment (or Fast-Follow note)

**AC**

- [ ] Spec §22 matches implemented behaviour
- [ ] No doc still mandates combined image as only CE path

---

## Rollout sequence

```text
Phase A (deploy selectivity, no versioning change)
  WP-1 → WP-2 → WP-3
  Validate on staging with force_full_deploy off

Phase B (CE split — can start parallel with Phase A)
  WP-4 → WP-5 → WP-10
  WP-11 after WP-5 (customer docs)

Phase C (versioning + production)
  WP-6 → WP-7 → WP-8 → WP-9
  WP-12 last

Optional follow-up (separate epic): CI paths-ignore for docs-only; Turbo-affected CI on PRs
```

**Migration note for existing CE operators:** document one-time move from `ghcr.io/mdg-labs/slugbase:latest` to pinned `slugbase-api` + `slugbase-web` in `ce/quick-start.mdx` upgrade section. Optional short deprecation: keep combined `:latest` push for one release cycle with callout — **default recommendation: hard cut** once split images ship to avoid three image lines.

---

## Verification checklist (post-epic)

| Scenario | Expected |
|---|---|
| Marketing MDX only → staging | Deploy marketing; skip api/web/admin/GHCR |
| `shared-types` change → staging | Deploy api + web + marketing |
| Backend drizzle only → staging | `migrate` + api deploy (+ ghcr_api if in mapping) |
| Version PR: marketing `0.1.0` → `0.1.1`, production publish | Marketing deploy only; api `0.1.0` production-skipped |
| Version PR: marketing `1.0.0` | Marketing production deploy allowed |
| CE operator compose | `api` + `web` + `postgres` healthy |
| `pnpm test:e2e --project=ce` | Pass |
| `pnpm test:e2e --project=cloud` | Unchanged pass |

---

## Anti-patterns (do not implement)

| Anti-pattern | Why |
|---|---|
| Path filters alone for deploy gating | Misses `shared-types` / `ui` consumers |
| Root `package.json` as release gate | Marketing/blog forces product version bump |
| Combined Cloud image | Breaks Workers edge topology |
| Per-package GitHub Release per tag | Clutters releases; races with `release: published` |
| `fixed` Changesets group for backend+web | Defeats independent versioning |
| Combined CE image as long-term default | Recreates version/tag coupling |
| Advance full `DEPLOYED_STATE` on partial smoke failure | Drift between recorded and live state |

---

## Appendix — research summary (condensed)

- **Turbo affected** is the standard deploy-scope tool in pnpm monorepos ([Turborepo CI](https://turborepo.dev/docs/crafting-your-repository/constructing-ci)).
- **Changesets** supports private apps without npm publish ([versioning apps](https://github.com/changesets/changesets/blob/main/docs/versioning-apps.md)).
- **Path filters** (`dorny/paths-filter`) supplement docs-only CI skips only.
- Per-package tags `@slugbase/pkg@X.Y.Z` do not collide; avoid shared `vX.Y.Z` tags for routine releases.

---

## Related files (inventory)

**CI/CD (`slugbase`)**

```
.github/workflows/deploy.yml
.github/workflows/staging.yml
.github/workflows/release.yml
.github/workflows/main.yml
.github/workflows/prepare-release.yml
.github/scripts/detect-deploy-targets.sh      (WP-1)
.github/scripts/build-push-ghcr.sh
.github/scripts/smoke-staging-health.sh
.github/scripts/derive-sentry-release.sh
Dockerfile / Dockerfile.api / Dockerfile.web
scripts/e2e.sh
dev.docker-compose.yml
```

**Customer docs (`slugbase-docs`)**

```
ce/quick-start.mdx
ce/introduction.mdx
ce/smtp.mdx
ce/oidc.mdx
ce/ai-suggestions.mdx
ce/troubleshooting.mdx
ce/faq.mdx
ce/instance-admin.mdx
ce/first-workspace-setup.mdx
```
