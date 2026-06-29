# SlugBase — Workspace Notes

Durable project memory for orchestrator and sub-agents. Transient task notes belong in local session memory (gitignored), not here.

## Node.js local environment (2026-06-02)

Repo pins **Node 22.12.0** (`.nvmrc`, `.node-version`) — matches CI. `engines.node` is `>=22.12.0` (24 LTS OK). Cursor agent shells default to **Node 20** under `.cursor-server/`; causes Astro/marketing failures and Turbo cache false passes. **Mandatory for agents:** `bash scripts/with-ci-env.sh pnpm …` or `source scripts/ci-env.sh` before any pnpm/turbo. `preinstall` runs `scripts/check-node-version.mjs`. See `docs/internal/local-development.md`.
_added: 2026-06-02_

## Git branches — development on staging (2026-05-31)

**`staging`** = development integration branch (Lane S commits, Lane P merges). **`main`** = protected production branch on GitHub — agents never push to `main`. SB-3 scaffold cherry-picked onto `staging` as `778368d` after branch realignment.
_added: 2026-05-31_

## Linear + GitHub issue tracking (2026-06-29)

**Linear** SlugBase team (`SB-N`) is the primary tracker. GitHub `mdg-labs/slugbase` issues mirror via two-way sync. Agents set Linear workflow state (not GitHub Projects board). Commits: key-free subject; body `fixes SB-N` + `fixes #N`. See `linear-board.md`, `07-issue-commit-linking.mdc`.
_added: 2026-06-29_

## Session memory — local + Linear handoff

`.cursor/skills/agent-memory/` is **gitignored**. Verifier → **Done** posts via Linear `save_comment` on the leaf issue; **Ready** on FAIL. One implementation commit per task. See orchestrator SKILL.md + linear-board.md.
_added: 2026-06-29_

## Jira SB project — deprecated (historical)

Jira constants below are **obsolete** — migrated to Linear. Kept for archaeology only.

## Jira Depends link type

Site link type **Depends**: outward `depends on`, inward `is required by` (id `10006`). MCP: `inwardIssue` = prerequisite, `outwardIssue` = dependent. JQL: `issue in linkedIssues("SB-N", "depends on")`.
_added: 2026-05-31_

## Security model — server-side sessions only (spec §5.3, decision #9)

SlugBase uses **server-side sessions**, not JWT access + refresh. Never introduce JWT cookies, `localStorage` token storage, or refresh-token rotation. Active-workspace selection lives in the session (spec §4.3). Personal API tokens are long-lived, hashed, bypass MFA. All mutations are CSRF-protected except the explicit allowlist in spec §5.8.
_added: 2026-05-31_

## CORS — FRONTEND_ORIGIN + MARKETING_ORIGIN (#498, 2026-06-22)

Backend enables CORS via `app.enableCors()` in `main.ts` using `resolveCorsOrigins()` — `[FRONTEND_ORIGIN, MARKETING_ORIGIN?]` from `ConfigService` with `credentials: true`. `MARKETING_ORIGIN` optional (CE/self-host); required on Cloud so marketing site can `fetch` `GET /pricing/public` at runtime. No wildcards, no reflection. Hosted: web CF Workers + marketing CF Workers + API Fly.io = three origins. Spec §12.1, §14.7, §5.8; issue #310.
_added: 2026-06-10_ | _updated: 2026-06-22_

## Workspace list API — includes role (SB-177, 2026-06-10)

`GET /workspaces` returns `WorkspaceListItemResponse[]` with `role: "OWNER" | "ADMIN" | "MEMBER"` via `listWorkspaceItemsForUser()` which joins workspace + membership tables. `WorkspaceRecord` (internal type) remains unchanged. Frontend `WorkspaceSwitcherPanel` consumes `role` directly. Spec §4.3.
_added: 2026-06-10_

## No deployment-mode branches (spec §15, §1)

Never introduce `isCloud`, `SLUGBASE_MODE`, or any deployment-mode conditional in application logic. Differences between hosted and self-hosted are expressed via (a) the entitlements engine (spec §11.5) and (b) interface implementation selection. Verifier Layer 3e fails on any deployment-mode branch found in committed code.
_added: 2026-05-31_

## Admin bootstrap env — optional after first user (#499, 2026-06-22)

`ADMIN_BOOTSTRAP_EMAIL` / `ADMIN_BOOTSTRAP_PASSWORD` are **optional at startup** once `admin_users` exists. `bootstrap.service.ts` returns silently when users exist (stale Fly secrets tolerated); fails fast only when DB is empty and creds missing. Removing bootstrap secrets from Phase/Fly is **recommended hygiene**, not a runtime requirement (admin PRD §8.2). Prior deadlock: schema required creds in production while service threw if creds present after bootstrap → 502 before `listen()`.
_added: 2026-06-22_

## Marketing staging smoke — root URL only (2026-06-02)

SB-125: Do **not** add a dedicated Cloudflare Worker or `/health`/`/version` on marketing. Staging smoke should assert **HTTP 200 on `MARKETING_ORIGIN` (site root)** only; API/Web keep `/health` + `/version`. CI failure was **302** on `/health`, not missing static files.
_added: 2026-06-02_

## CI/CD pipeline — PipeWatch pattern + selective deploy (#470 epic, #532 epic, 2026-06-24)

**Entry points:** `pr.yml` (PRs + version-check), `staging.yml` (CI → selective deploy + GHCR `:dev`), `main.yml` (CI → production deploy + draft release), `release.yml` (production on release published).

**Reusable workflows:** `ci.yml` (parallel lint/typecheck/unit/build/integration/audit/reportportal-summary; GHA `ci` env; Turborepo cache in setup action); `deploy.yml` (live `/version` probe gate via `resolve-deploy-plan.mjs` → sync-secrets → migrate ∥ sentry → selective api/web/marketing/admin → smoke); `sync-secrets.yml` (GHA → Fly + CF); `prepare-release.yml` (draft GitHub Release after api/web prod deploy).

**Versioning:** Manual `package.json` bumps per deployable (`pnpm bump:versions` locally); pre-push hook enforces bumps before push to `staging`/`main`. Shared libs stay `0.0.0` — consumer bumps required. Production deploy skips surfaces with package semver &lt; `1.0.0`.

**CE GHCR:** split `ghcr.io/mdg-labs/slugbase-api` + `slugbase-web` (not a single combined image). API runs `SERVE_WEB_CLIENT=false`.

Monolith `deploy-staging.yml` / `deploy-production.yml` removed. Secrets: Phase → GHA (automatic); platform runtime via `sync-secrets.sh`. Reference: `docs/internal/ci-cd-example/`, `docs/internal/granular-deployment-recommendations.md`. Spec §22; decision #34 → Phase.
_added: 2026-06-20_ | _updated: 2026-06-24_

## pnpm test:integration — NEVER wrap with phase (2026-06-01)

`pnpm test:integration` must be run **without** `phase run --` (avoids overriding test env). Backend deployment booleans in `env.schema.ts` use `envBoolean()` / `optionalEnvBoolean()` so Phase string `"false"` is not misread as true (fixed 2026-06-02; formerly `z.coerce.boolean()` on `PUBLIC_REGISTRATION`, `EMAIL_VERIFICATION_REQUIRED`, `SMTP_SECURE`, `CHALLENGE_DEV_SKIP`). Rule: `06-local-ci-before-commit.mdc`.
_added: 2026-06-01_

## Database migrations — split dispatch (SB-173, 2026-06-10)

Migrations are split by deployment topology via `SERVE_WEB_CLIENT` flag:
- **Hosted** (`SERVE_WEB_CLIENT=false`): migrations run in CI via `migrate-staging` / `migrate-production` jobs (`drizzle-kit migrate`). Non-zero exit blocks deploy. `bootstrap()` skips `runMigrations()`.
- **Self-hosted** (`SERVE_WEB_CLIENT=true`, Dockerfile preset): migrations run on **API bootstrap** before `app.listen()`. Single container, no race.
`DATABASE_URL_UNPOOLED` is preferred when set (`resolveMigrationDatabaseUrl`). Local/operator manual apply: `pnpm db:migrate`.
Staging smoke (`.github/scripts/smoke-staging-health.sh`) sends Cloudflare Access service-token headers when `CF_ACCESS_CLIENT_ID` + `CF_ACCESS_CLIENT_SECRET` are set in the GHA `staging` environment.
_added: 2026-06-01_ | _updated: 2026-06-10_

## i18n — repo JSON (2026-06-08)

**Decision:** Repo JSON (`packages/*/i18n/locales/{en,de}.json`) is the sole source of truth. Web uses **react-i18next** with static resources; marketing uses native `t(locale, key)`. CI: `pnpm i18n:validate` (locale parity + key references) + `i18n:check:hardcoded`. Future TMS is additive — same JSON files.
_added: 2026-06-08_

## Design system + UI prototype (2026-05-31)

`docs/internal/design-prototype/V1/` = **visual/interaction source of truth**; MVP spec = **product source of truth** (spec wins on conflict). Spec §23 documents it; §23.2 maps screens→files, §23.4 lists divergences, §23.5 lists under-built v1 features. Rule: `11-design-system.mdc`.
Tokens (`colors_and_type.css`): accent periwinkle `#7782f7`, dark-first, IBM Plex Sans/Mono, 4px spacing, semantic success/warn/danger. Consume token vars — never hard-code.
**Spec-wins divergences:** paid tier = "Personal" (not "Pro"); Free cap = 50 (not 100); no folder cap; API tokens not plan-gated; no custom-domain entitlement v1; no workspace-id-in-URL v1; prices/seats/`cloud.slugbase.app` are config-driven.
Prototype is React-via-CDN/Babel/localStorage/mock data — demonstrates design only, not the build target. Re-implement against repo JSON catalog (no copying English strings).
_added: 2026-05-31_

## Stack decisions (settled 2026-05-31 — spec §19, decisions #37–#50)

| Concern | Choice |
|---|---|
| Language | TypeScript (strict, no `any`) |
| Backend | NestJS (DI hosts the config-selected external interfaces) |
| Web client | React Router v7 (framework mode) — CF Workers (hosted) + Node (`slugbase-web` GHCR image) |
| Marketing | Astro (static) on CF Workers |
| Persistence | Drizzle ORM + Drizzle Kit; PostgreSQL-only at v1 (Neon hosted + self-host Postgres); SQLite self-host deferred |
| Contracts/validation | Zod + ts-rest (in `shared-types`) → OpenAPI |
| UI | Tailwind (token-bridged) + Radix + cmdk |
| Tests | Vitest + Supertest (unit/integration) + Playwright (e2e, CI only) |
| Build | Turborepo over the pnpm workspace |
| Sessions | DB-backed server-side (no Redis) |
| Security | argon2id · otplib TOTP · double-submit CSRF |
| AI provider (v1) | OpenAI behind the AI interface |
| Packages | `backend` · `web` · `marketing` · `shared-types` · `ui` · `docs` |

DB migrations: **Drizzle Kit** (`drizzle-kit generate` to create, `drizzle-kit migrate` to apply) — one forward-only history; never hand-write SQL or use `drizzle-kit push`. Rules/skills updated to match: `00-project.mdc`, `06-local-ci-before-commit.mdc`, `10-i18n.mdc`, `11-design-system.mdc`, orchestrator `doc-index.md` + `prompt-templates.md` + `SKILL.md`.
_added: 2026-05-31_

## Phase environments: `Development`, `Staging`, `Production` (2026-06-20)

Phase environment names are **`Development`**, **`Staging`**, **`Production`** — linked via `.phase.json` to the `SlugBase` app. Applies to:
- Local CLI: `phase run -- <cmd>` and `phase secrets create|update … --env Development`
- GHA: `ci`, `staging`, `production` environments (Phase Console syncs operator edits from `Staging` / `Production`)
_added: 2026-05-31_ | _updated: 2026-06-20_

## Confirmed tooling decisions (2026-05-31, updated 2026-06-20)

| Concern | Tool | Notes |
|---|---|---|
| Secrets management | **Phase** | Phase Console — `SlugBase` app (`.phase.json`); envs `Development` / `Staging` / `Production`; all keys at **root path** (`/`); local `phase run -- <cmd>`; CI/deploy read GHA environment secrets — **no Phase CLI in workflows**. Operator syncs `Staging` / `Production` via Phase Console → GHA automatically. |
| Translations | **repo JSON** | v1: en + de (spec §17); react-i18next (web) + native `t()` (marketing); CI `pnpm i18n:validate` |

Rules touched: `00-project.mdc` (tech-stack + tooling), `05-env-vars.mdc` (Phase project + workflow), `10-i18n.mdc` (repo-JSON workflow).
_added: 2026-05-31_

## Hosted infrastructure topology (2026-05-31)

| Layer | Platform | Region |
|---|---|---|
| Web client (frontend) | **Cloudflare Workers** | Global edge |
| API / back-end | **Fly.io** app — `fra` | Frankfurt, DE |
| Database | **Neon Postgres** — `aws-eu-central-1` | Frankfurt, DE (same AWS zone as Fly `fra`) |
| Marketing site | **Cloudflare Workers** | Global edge; separately built — spec §19 |

Fly.io `fra` chosen over Railway because Railway's only EU region (Amsterdam) has no collocated Neon Postgres region → cross-region DB latency on every query.
Self-hosted: split GHCR images (`slugbase-api` + `slugbase-web`); unaffected by hosted topology.
Key env vars: `APP_BASE_URL` = Fly.io app domain (or custom), `FRONTEND_ORIGIN` = CF Workers domain.
**App naming** (decision #51): `slugbase-<env>-<app>` — Fly.io app + CF Worker script names. Set: `slugbase-staging-api` (Fly), `slugbase-staging-web` (CF), `slugbase-staging-marketing` (CF), `slugbase-production-api` (Fly), `slugbase-production-web` (CF), `slugbase-production-marketing` (CF). `<env>` matches GHA deploy environment (`staging`/`production`); **no `development` deployment** (local dev only). These are platform identifiers, not public hostnames. Self-hosted GHCR image is exempt. **No Fly/CF apps exist yet — created during infra setup.**
Fly scaling: `slugbase-staging-api` **scaled to zero** (`auto_stop_machines`, `min_machines_running = 0`; cold-start on request) — current cost posture. `slugbase-production-api` stays warm (`min_machines_running ≥ 1`). CF Workers (`web`/`marketing`) scale to zero natively.
Spec: §14.7, resolved decisions 31–32, 51.
_added: 2026-05-31_

## Lane P worktree cleanup — sandbox (2026-06-29)

`git worktree remove` for paths under `~/.cursor/worktrees/` may fail in the default agent sandbox (`Keine Berechtigung`). Branches can still be deleted with `git branch -d orchestrator/<TASK-ID>`. **Cleanup shell agents:** request `all` permissions for `git worktree remove` and `rm -rf` on orphan dirs, or operator removes `~/.cursor/worktrees/<id>/` manually.
_added: 2026-06-29_

## Lane P branch-merge no-op pattern (2026-06-09)

SB-161 branch `orchestrator/SB-161` pointed at the staging base SHA with no implementation commits — the execution agent likely committed to a different worktree path than the branch tracked. The branch verifier verified worktree files (which were correct) but the git branch had zero diff from base. Integration agent detected the no-op and skipped. Recovery: re-ran as Lane S on staging. **Orchestrator should verify `git log orchestrator/<TASK-ID> --not staging` shows at least one commit before dispatching branch verifiers.** Also affects Lane S when agents commit in worktree paths — the commit lands on a detached HEAD and must be cherry-picked onto `staging`.
_added: 2026-06-09_

## Model hallucination — verifier sub-agent wrote to unrelated path (2026-06-10)

The #315 branch verifier (`generalPurpose` subagent `3f9c15eb-60d2-4c95-909a-d8e82f0a005f`) completed verification correctly (Layer 1/2/3 all PASS, GitHub Done comment posted, status set to Done) but then hallucinated and attempted to write `/home/michael/PycharmProjects/ai-proxy/proxy-server/package.json` — a completely unrelated Electron HTTP proxy project. The file didn't exist on disk (path doesn't exist). The verifier prompt should be tightened with a hard block on path escape: add "DO NOT write files outside TARGET REPO or WORKTREE" to verifier prompts.
_added: 2026-06-10_

## E2E CI — isolated test env (2026-06-13, updated 2026-06-20)

`e2e.yml` mirrors `scripts/e2e.sh`: API/container start with explicit test env only (`SLUGBASE_E2E_MODE`, hardcoded session/encryption keys, localhost URLs, `PUBLIC_REGISTRATION=true`). **Hosted** also runs `pnpm --filter @slugbase/backend db:migrate` before API start (hosted API skips bootstrap migrations when `SERVE_WEB_CLIENT=false`). Playwright steps use pinned `DATABASE_URL` + e2e base URLs so GHA staging secrets do not reach tests. CI Playwright uses `scripts/e2e-ci-playwright.sh` (process substitution + summary parse) — `pnpm | tee` could exit 0 while the log shows `N failed`.
_added: 2026-06-13_ | _updated: 2026-06-20_

## ReportPortal test reporting (#366 epic, 2026-06-13)

Unit, integration, and e2e tests publish launches to self-hosted ReportPortal when `REPORTPORTAL_URL`, `REPORTPORTAL_PROJECT`, and `REPORTPORTAL_API_KEY` are set (CI via GHA `ci` environment). Wiring: `scripts/reportportal-vitest.ts`, `scripts/reportportal-playwright.ts`, `scripts/reportportal-ci-summary.sh` (CI job summary + PR comments from `reportportal_launch_url=` stdout). Reporters no-op locally when env is incomplete. Allure + gh-pages test reports removed in #371.
_added: 2026-06-13_

## Orchestrator — host environment & parallelism (2026-06-23)

Development runs on **Ubuntu 26.04 LTS desktop** (native — not WSL). **Lane P parallelism is allowed:** dispatch up to **3** parallel execution sub-agents per batch (`run_in_background: true`); never exceed 3 concurrent sub-agents on this machine. Lane P still requires `best-of-n-runner` worktree isolation per task.
_added: 2026-06-23_ | _supersedes: 2026-06-15 WSL serialize-CI note_

## localStorage view-mode pollution in BookmarkListPage tests (2026-06-09)

BookmarkListPage tests share a jsdom environment. Prior tests that set `view: "table"` write to `localStorage`, which persists into subsequent tests expecting grid view. **Fix:** add `localStorage.clear()` in `beforeEach`. The `ECONNREFUSED 127.0.0.1:3000` warning in the test output is pre-existing and unrelated.
_added: 2026-06-09_
