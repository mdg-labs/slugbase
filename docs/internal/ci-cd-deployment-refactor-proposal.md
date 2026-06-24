# CI/CD deploy pipeline refactor — proposal

**Status:** Shipped (epic **#548**); intake complete 2026-06-24  
**Date:** 2026-06-24  
**Audience:** Engineering  
**Spec refs:** spec §22.4–22.8, §14.2, §14.7

---

## Summary

Replace fragile turbo/path/`DEPLOYED_STATE` deploy detection with a **live `/version` probe gate**: deploy a surface when `semver_gt(V_intended, V_live)`. Production deploys on **`push` → `main`** after CI (not `release: published`). Consolidate automation under **`scripts/ci/`**; delete **`.github/scripts/`**. **`e2e.yml` unchanged.**

---

## Locked decisions

| Topic | Decision |
|---|---|
| **Deploy gate** | `deploy(S) = semver_gt(V_intended, V_live)` — `V_intended` from `package.json` at deploy ref; `V_live` from `GET {origin}/version` |
| **Self-heal** | If live lags intended (failed prior deploy), **redeploy without a new version bump** on the next push — no git diff gate |
| **No `DEPLOYED_STATE`** | Repo variables and `update-deployed-state` job **removed**; live endpoints are authoritative |
| **Production trigger** | `push` → `main` after CI — **not** `release: published` |
| **Production semver floor** | Deploy only if `V_intended >= 1.0.0` and `semver_gt(V_intended, V_live)` |
| **Staging probes** | **Always** send Cloudflare Access service-token headers (`CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`) |
| **403 on staging** | **Fail plan** — never treat as bootstrap `0.0.0` |
| **First deploy / unreachable** | After retries: connection refused, NXDOMAIN, 404, 502, timeout → `V_live = 0.0.0` → deploy if intended passes gates |
| **Deployed but `/version` down** | After retries on a surface that was in the deploy plan previously → **fail plan** (not bootstrap) |
| **`/version` parity** | All four surfaces expose dedicated `GET /version` (`VersionResponseSchema`); `/health` is health-only |
| **Admin** | Add `GET /version` (only missing surface) |
| **Marketing** | `packages/marketing/src/pages/version.ts` exists — smoke/plan use `/version`, not site root only |
| **Scripts** | All GHA deploy automation in **`scripts/ci/`** only; delete **`.github/scripts/`** |
| **GitHub Releases** | Aggregate draft, **API + Web only**; title `SlugBase API {x} · Web {y}`; **does not gate deploy** |
| **`prepare-release` trigger** | After **`deploy-production` succeeds** for api and/or web (`deployed_api` / `deployed_web` outputs) |
| **Root `package.json` version** | Workspace metadata only — not synced; **`version-check.yml` removed** (#553) |
| **Manual deploy** | `workflow_dispatch`: `deploy_mode=manual` skips live compare; `auto` uses live probes |
| **CI before deploy** | Always, including production and manual runs |
| **`e2e.yml`** | **Out of scope** — no changes |

---

## Deploy surfaces

| Surface | Package | Origin (GHA) | `/version` |
|---|---|---|---|
| API (+ migrate) | `@slugbase/backend` | `APP_BASE_URL` | Yes |
| Web | `@slugbase/web` | `FRONTEND_ORIGIN` | Yes |
| Marketing | `@slugbase/marketing` | `MARKETING_ORIGIN` | Yes (prerendered) |
| Admin (+ admin migrate) | `@slugbase/admin` | `ADMIN_URL` | **Add** |

Shared libs (`shared-types`, `ui`, `email-templates`, `db-admin`) are not deploy targets.

---

## Pipeline flows

### Triggers

| Event | CI | Deploy |
|---|---|---|
| PR → `staging` | Yes | No |
| Push → `staging` | Yes | Staging |
| Push → `main` | Yes | Production (plan may skip all surfaces) |
| `workflow_dispatch` | Yes on `git_ref` | Staging or production |

### Staging (`staging.yml`)

```text
ci → deploy(staging) → smoke
```

Plan job: `environment: staging`, probe `/version` with **CF Access headers**, backoff retries.

### Production (`main.yml`)

```text
push main
  ├─ ci
  ├─ changesets          (Version PR / tag-packages)
  ├─ deploy(production)  (needs ci — live probes, bootstrap 0.0.0)
  │    └─ GHCR api/web   (same plan outputs)
  └─ prepare-release     (needs changesets + deploy; if published ∧ deploy succeeded for api/web)
```

`prepare-release` and deploy run in parallel only where `needs` allow; **draft release waits for successful api/web deploy**.

### `deploy.yml` (reusable)

```text
plan (live probes) → sync-secrets → migrate* → deploy* → smoke
```

Plan job **must** set `environment: ${{ inputs.environment }}` for correct URLs/secrets. CF Access env vars passed **only when `environment=staging`**.

**Delete:** `release.yml`, `update-deployed-state` job, `detect-ghcr-targets` duplicate jobs (GHCR predicates from plan outputs).

### Deploy plan (`scripts/ci/resolve-deploy-plan.mjs`)

**Inputs:** `environment`, `deployMode`, `git_ref`, probe origins, CF Access creds (staging), manual overrides.

**Outputs:** `deploy_*`, `run_migrate*`, `push_ghcr_*`, `sync_services`, `deployed_api`, `deployed_web` (post-smoke success flags for release), `skip_reasons[]`.

**Tests:** `scripts/ci/resolve-deploy-plan.spec.ts` + `scripts/ci/probe-version.spec.ts` (unit-test probe classification with mocked fetch).

**Delete:** `detect-deploy-targets.mjs`, `check-production-deploy-needed.mjs`, `update-deployed-state.mjs`, all turbo/path logic.

### What does **not** gate deploy

Path changes, lockfile-only edits, workflow edits, shared-lib changes — **without** `semver_gt(intended, live)` after probe.

---

## GitHub Releases (comms only)

- **Trigger:** `changesets.published` ∧ production deploy succeeded for api and/or web.
- **Skip** when Version PR bumps only marketing/admin.
- **Title:** `SlugBase API {backendVer} · Web {webVer}` — always both from `package.json` at release commit.
- **Body:** changelog sections only for backend/web if in `published-packages`.
- **Tag:** `release-YYYY-MM-DD[*]` — not a deploy identity.
- Per-package git tags from `changeset tag` remain for audit/rollback refs.
- `createGithubReleases: false` on changesets action (unchanged).

---

## First production cutover

Today only **staging** is live. Production probes will bootstrap (`V_live = 0.0.0`). First Version PR with `backend`/`web` ≥ `1.0.0` deploys those surfaces without seeding repo variables. Marketing/admin deploy when `V_intended >= 1.0.0` and live is behind.

---

## Script layout

| Location | Contents |
|---|---|
| `scripts/ci/` | `resolve-deploy-plan.mjs`, `probe-version.mjs`, `create-draft-release.mjs`, `derive-sentry-release.mjs`, platform bash (`deploy-fly.sh`, `sync-secrets.sh`, smoke, GHCR, migrate, …) |
| `scripts/` | Local dev, e2e, i18n, validation (`with-ci-env.sh`, reportportal, …) |
| `.github/workflows/` | YAML + composite actions only |
| `.github/scripts/` | **Delete** after migration |

Workflows call `node scripts/ci/…` or `bash scripts/ci/…` directly — **no bash→Node wrappers**.

---

## Current problems (why refactor)

1. Turbo `--filter=...[REF]` in detect jobs **without `pnpm install`** → silent empty deploy plans.
2. Turbo + path rules + `DEPLOYED_STATE` — three conflicting signals.
3. `release.yml` deploys production **without CI**.
4. Split-brain: logic in `scripts/*.mjs`, entrypoints in `.github/scripts/*.sh`.
5. `version-check.yml` enforces root version equality — conflicts with per-package semver.
6. `DEPLOYED_STATE` update job can fail after successful deploy → drift.

---

## Success criteria

- [x] Staging plan sends CF Access headers; 403 fails plan.
- [x] `semver_gt(intended, live)` gates staging and production; self-heal when live lags.
- [x] First prod deploy bootstraps unreachable surfaces as `0.0.0`.
- [x] Production on `main` after CI; `release.yml` deleted.
- [x] Admin `GET /version`; smoke checks `/version` on all four surfaces.
- [x] `prepare-release` runs only after api/web production deploy succeeds.
- [x] No turbo/path/`DEPLOYED_STATE` in plan path; deploy plan uses `scripts/ci/resolve-deploy-plan.mjs`.
- [x] `version-check.yml` removed; PR CI no longer enforces root version equality (#553).
- [x] `e2e.yml` untouched.

---

## GitHub issues (intake complete — epic shipped)

**Epic:** [#548 — CI/CD deploy pipeline refactor (live /version gate)](https://github.com/mdg-labs/slugbase/issues/548)

| Issue | Summary | Status |
|---|---|---|
| [#549](https://github.com/mdg-labs/slugbase/issues/549) | Add deploy plan core (`scripts/ci/`) and refactor `deploy.yml` | Shipped |
| [#550](https://github.com/mdg-labs/slugbase/issues/550) | Refactor `staging.yml` for live-version deploy gate | Shipped |
| [#551](https://github.com/mdg-labs/slugbase/issues/551) | Refactor `main.yml` and `prepare-release.yml`; delete `release.yml` | Shipped |
| [#552](https://github.com/mdg-labs/slugbase/issues/552) | Add admin `/version` and align smoke with four-surface probes | Shipped |
| [#553](https://github.com/mdg-labs/slugbase/issues/553) | Remove root version-check and update CI/CD docs | Shipped |

**Related (Done on board — do not enrich):** #532 granular deployment epic and children.

**Out of scope (unchanged):** `e2e.yml` — Playwright e2e on staging→main PRs only; not part of deploy refactor.

---

## References to retire

| Artifact | Action |
|---|---|
| `.github/scripts/*` | Delete (migrated to `scripts/ci/`) |
| `.github/workflows/release.yml` | Delete |
| `scripts/detect-deploy-targets.mjs` | Delete |
| `scripts/check-production-deploy-needed.mjs` | Delete |
| `scripts/update-deployed-state.mjs` | Delete |
| `DEPLOYED_STATE_*` / `DEPLOYED_VERSION` vars | Deleted (live `/version` is authoritative) |
| `docs/internal/granular-deployment-recommendations.md` | Retired — superseded by this doc (file absent) |
| `.github/workflows/version-check.yml` | Deleted (#553) |
