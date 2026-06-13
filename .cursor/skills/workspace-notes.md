# SlugBase — Workspace Notes

Durable project memory for orchestrator and sub-agents. Transient task notes belong in local session memory (gitignored), not here.

## Node.js local environment (2026-06-02)

Repo pins **Node 22.12.0** (`.nvmrc`, `.node-version`) — matches CI. `engines.node` is `>=22.12.0` (24 LTS OK). Cursor agent shells default to **Node 20** under `.cursor-server/`; causes Astro/marketing failures and Turbo cache false passes. **Mandatory for agents:** `bash scripts/with-ci-env.sh pnpm …` or `source scripts/ci-env.sh` before any pnpm/turbo. `preinstall` runs `scripts/check-node-version.mjs`. See `docs/local-development.md`.
_added: 2026-06-02_

## Git branches — development on staging (2026-05-31)

**`staging`** = development integration branch (Lane S commits, Lane P merges). **`main`** = protected production branch on GitHub — agents never push to `main`. SB-3 scaffold cherry-picked onto `staging` as `778368d` after branch realignment.
_added: 2026-05-31_

## Jira SB project — live constants (verified 2026-05-31)

Site: `mdg-labs.atlassian.net` · cloudId: `mdg-labs.atlassian.net` (hostname shorthand)
Transitions: Backlog `11` · Ready `2` · In Progress `21` · In Review `31` · Done `41` · Paused `4` · Cancelled `3`
Domain field: `customfield_10081` → Frontend `10092` · Backend `10093` · Infra `10094` · Ops `10095`
Roadmap ID: `customfield_10082` · Legacy Key: `customfield_10083` (unused on greenfield SB)
Fix versions: `MVP Alpha` · `Public Launch v1.0.0`
Depends link type id: `10006` (outward: `depends on`, inward: `is required by`)
Probe issue SB-1 was created to resolve transitions — it can be deleted or left as a backlog item.
_added: 2026-05-31_

## Session memory — local + Jira handoff

`.cursor/skills/agent-memory/` is **gitignored**. Execution/verifier agents write session files locally during a run; **never commit** them. Verifier → **Done** posts a structured summary via `addCommentToJiraIssue` on the leaf issue; **Ready** (FAIL) posts layer failures. One implementation commit per task. See orchestrator SKILL.md + jira-board.md § Verifier Done comment.
_added: 2026-05-31_

## Jira Depends link type

Site link type **Depends**: outward `depends on`, inward `is required by` (id `10006`). MCP: `inwardIssue` = prerequisite, `outwardIssue` = dependent. JQL: `issue in linkedIssues("SB-N", "depends on")`.
_added: 2026-05-31_

## Security model — server-side sessions only (spec §5.3, decision #9)

SlugBase uses **server-side sessions**, not JWT access + refresh. Never introduce JWT cookies, `localStorage` token storage, or refresh-token rotation. Active-workspace selection lives in the session (spec §4.3). Personal API tokens are long-lived, hashed, bypass MFA. All mutations are CSRF-protected except the explicit allowlist in spec §5.8.
_added: 2026-05-31_

## CORS — enabled via FRONTEND_ORIGIN (SB-176, 2026-06-10)

Backend enables CORS via `app.enableCors()` in `main.ts` using `FRONTEND_ORIGIN` from `ConfigService` with `credentials: true`. Enabled unconditionally (harmless for self-hosted same-origin). No wildcards, no reflection. Hosted architecture requires this: web on CF Workers, API on Fly.io (different origins). Spec §14.7, §5.8.
_added: 2026-06-10_

## Workspace list API — includes role (SB-177, 2026-06-10)

`GET /workspaces` returns `WorkspaceListItemResponse[]` with `role: "OWNER" | "ADMIN" | "MEMBER"` via `listWorkspaceItemsForUser()` which joins workspace + membership tables. `WorkspaceRecord` (internal type) remains unchanged. Frontend `WorkspaceSwitcherPanel` consumes `role` directly. Spec §4.3.
_added: 2026-06-10_

## No deployment-mode branches (spec §15, §1)

Never introduce `isCloud`, `SLUGBASE_MODE`, or any deployment-mode conditional in application logic. Differences between hosted and self-hosted are expressed via (a) the entitlements engine (spec §11.5) and (b) interface implementation selection. Verifier Layer 3e fails on any deployment-mode branch found in committed code.
_added: 2026-05-31_

## Marketing staging smoke — root URL only (2026-06-02)

SB-125: Do **not** add a dedicated Cloudflare Worker or `/health`/`/version` on marketing. Staging smoke should assert **HTTP 200 on `MARKETING_ORIGIN` (site root)** only; API/Web keep `/health` + `/version`. CI failure was **302** on `/health`, not missing static files.
_added: 2026-06-02_

## CI/CD pipeline (split + gated 2026-06-10)

Three workflow files (split from monolith by SB-174, gated by SB-175):
- `.github/workflows/ci.yml` — CI checks (lint, typecheck, tests, build, integration, audit) + calls `deploy-staging.yml` via `workflow_call` when CI passes on push to staging. Concurrency: never cancel (required PR check).
- `.github/workflows/deploy-staging.yml` — Reusable workflow (`on: workflow_call`). Staging deploy (build, migrate, deploy API/web/marketing, smoke). No own trigger — called from `ci.yml`. Concurrency: cancel in-progress.
- `.github/workflows/deploy-production.yml` — Production deploy (same pattern + GHCR release image + version record). Trigger: release published. Concurrency: never cancel.

GitHub-hosted runners (`ubuntu-latest`). Strict dependency chains: `build-server → migrate → deploy-fly` (API track), `build-web → deploy-web + deploy-marketing` (web/marketing track). No `if:` conditions in staging jobs; production keeps `if:` for `should_deploy` output access.
CI gates staging deploy via `workflow_call` — deploy only fires after CI passes. Same branch resolution (no `main` dependency). PRs to staging trigger only CI (deploy skipped by `if:` conditional).
Secrets: Infisical OIDC via `Infisical/secrets-action` — only two GHA secrets: `INFISICAL_DOMAIN` + `INFISICAL_OIDC_IDENTITY_ID`.
Branch protection: job names preserved from original monolith — existing rules apply unchanged.
Spec: §22. Resolved decision #35.
_added: 2026-05-31_ | _updated: 2026-06-10_

## pnpm test:integration — NEVER wrap with infisical (2026-06-01)

`pnpm test:integration` must be run **without** `infisical run --env=dev --` (avoids overriding test env). Backend deployment booleans in `env.schema.ts` use `envBoolean()` / `optionalEnvBoolean()` so Infisical `"false"` is not misread as true (fixed 2026-06-02; formerly `z.coerce.boolean()` on `PUBLIC_REGISTRATION`, `EMAIL_VERIFICATION_REQUIRED`, `SMTP_SECURE`, `CHALLENGE_DEV_SKIP`). Rule: `06-local-ci-before-commit.mdc`.
_added: 2026-06-01_

## Database migrations — split dispatch (SB-173, 2026-06-10)

Migrations are split by deployment topology via `SERVE_WEB_CLIENT` flag:
- **Hosted** (`SERVE_WEB_CLIENT=false`): migrations run in CI via `migrate-staging` / `migrate-production` jobs (`drizzle-kit migrate`). Non-zero exit blocks deploy. `bootstrap()` skips `runMigrations()`.
- **Self-hosted** (`SERVE_WEB_CLIENT=true`, Dockerfile preset): migrations run on **API bootstrap** before `app.listen()`. Single container, no race.
`DATABASE_URL_UNPOOLED` is preferred when set (`resolveMigrationDatabaseUrl`). Local/operator manual apply: `pnpm db:migrate`.
Staging smoke (`.github/scripts/smoke-staging-health.sh`) sends Cloudflare Access service-token headers when `CF_ACCESS_CLIENT_ID` + `CF_ACCESS_CLIENT_SECRET` are set in Infisical `staging`.
_added: 2026-06-01_ | _updated: 2026-06-10_

## i18n — repo JSON (2026-06-08)

**Decision:** Repo JSON (`packages/*/i18n/locales/{en,de}.json`) is the sole source of truth. Web uses **react-i18next** with static resources; marketing uses native `t(locale, key)`. CI: `pnpm i18n:validate` (locale parity + key references) + `i18n:check:hardcoded`. Future TMS is additive — same JSON files.
_added: 2026-06-08_

## Design system + UI prototype (2026-05-31)

`docs/design-prototype/V1/` = **visual/interaction source of truth**; MVP spec = **product source of truth** (spec wins on conflict). Spec §23 documents it; §23.2 maps screens→files, §23.4 lists divergences, §23.5 lists under-built v1 features. Rule: `11-design-system.mdc`.
Tokens (`colors_and_type.css`): accent periwinkle `#7782f7`, dark-first, IBM Plex Sans/Mono, 4px spacing, semantic success/warn/danger. Consume token vars — never hard-code.
**Spec-wins divergences:** paid tier = "Personal" (not "Pro"); Free cap = 50 (not 100); no folder cap; API tokens not plan-gated; no custom-domain entitlement v1; no workspace-id-in-URL v1; prices/seats/`cloud.slugbase.app` are config-driven.
Prototype is React-via-CDN/Babel/localStorage/mock data — demonstrates design only, not the build target. Re-implement against repo JSON catalog (no copying English strings).
_added: 2026-05-31_

## Stack decisions (settled 2026-05-31 — spec §19, decisions #37–#50)

| Concern | Choice |
|---|---|
| Language | TypeScript (strict, no `any`) |
| Backend | NestJS (DI hosts the config-selected external interfaces) |
| Web client | React Router v7 (framework mode) — CF Workers (hosted) + Node (self-host image) |
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

## Infisical env slugs: `dev`, `staging`, `prod` (2026-05-31, updated 2026-05-31)

Infisical environment slugs are **`dev`**, **`staging`**, **`prod`** — NOT `development`, `staging`, `production`. Using the long form returns 404. Applies to:
- Local CLI: `infisical run --env=dev -- <cmd>` and `infisical secrets set ... --env=dev`
- CI workflow (`ci-cd.yml`): `env-slug: dev` for the CI/checks job; `env-slug: staging` for staging deploy; `env-slug: prod` for production deploy
_added: 2026-05-31_

## Confirmed tooling decisions (2026-05-31)

| Concern | Tool | Notes |
|---|---|---|
| Secrets management | **Infisical** | Infisical Cloud (EU) — `https://eu.infisical.com`; project slug `slugbase-cloud`; envs `dev` / `staging` / `prod`; all keys at **environment root** (no subfolders); local `infisical run --env=dev -- <cmd>`; CI OIDC via `Infisical/secrets-action` — **single** machine identity (`INFISICAL_OIDC_IDENTITY_ID`), project-scoped read-only. **Phase CLI not used.** |
| Translations | **repo JSON** | v1: en + de (spec §17); react-i18next (web) + native `t()` (marketing); CI `pnpm i18n:validate` |

Rules touched: `00-project.mdc` (tech-stack + tooling), `05-env-vars.mdc` (Infisical project + workflow), `10-i18n.mdc` (repo-JSON workflow).
_added: 2026-05-31_

## Hosted infrastructure topology (2026-05-31)

| Layer | Platform | Region |
|---|---|---|
| Web client (frontend) | **Cloudflare Workers** | Global edge |
| API / back-end | **Fly.io** app — `fra` | Frankfurt, DE |
| Database | **Neon Postgres** — `aws-eu-central-1` | Frankfurt, DE (same AWS zone as Fly `fra`) |
| Marketing site | **Cloudflare Workers** | Global edge; separately built — spec §19 |

Fly.io `fra` chosen over Railway because Railway's only EU region (Amsterdam) has no collocated Neon Postgres region → cross-region DB latency on every query.
Self-hosted: combined container image, unaffected by hosted topology.
Key env vars: `APP_BASE_URL` = Fly.io app domain (or custom), `FRONTEND_ORIGIN` = CF Workers domain.
**App naming** (decision #51): `slugbase-<env>-<app>` — Fly.io app + CF Worker script names. Set: `slugbase-staging-api` (Fly), `slugbase-staging-web` (CF), `slugbase-staging-marketing` (CF), `slugbase-production-api` (Fly), `slugbase-production-web` (CF), `slugbase-production-marketing` (CF). `<env>` matches Infisical env (`staging`/`production`); **no `development` deployment** (local dev only). These are platform identifiers, not public hostnames. Self-hosted GHCR image is exempt. **No Fly/CF apps exist yet — created during infra setup.**
Fly scaling: `slugbase-staging-api` **scaled to zero** (`auto_stop_machines`, `min_machines_running = 0`; cold-start on request) — current cost posture. `slugbase-production-api` stays warm (`min_machines_running ≥ 1`). CF Workers (`web`/`marketing`) scale to zero natively.
Spec: §14.7, resolved decisions 31–32, 51.
_added: 2026-05-31_

## Lane P branch-merge no-op pattern (2026-06-09)

SB-161 branch `orchestrator/SB-161` pointed at the staging base SHA with no implementation commits — the execution agent likely committed to a different worktree path than the branch tracked. The branch verifier verified worktree files (which were correct) but the git branch had zero diff from base. Integration agent detected the no-op and skipped. Recovery: re-ran as Lane S on staging. **Orchestrator should verify `git log orchestrator/<TASK-ID> --not staging` shows at least one commit before dispatching branch verifiers.** Also affects Lane S when agents commit in worktree paths — the commit lands on a detached HEAD and must be cherry-picked onto `staging`.
_added: 2026-06-09_

## Model hallucination — verifier sub-agent wrote to unrelated path (2026-06-10)

The #315 branch verifier (`generalPurpose` subagent `3f9c15eb-60d2-4c95-909a-d8e82f0a005f`) completed verification correctly (Layer 1/2/3 all PASS, GitHub Done comment posted, status set to Done) but then hallucinated and attempted to write `/home/michael/PycharmProjects/ai-proxy/proxy-server/package.json` — a completely unrelated Electron HTTP proxy project. The file didn't exist on disk (path doesn't exist). The verifier prompt should be tightened with a hard block on path escape: add "DO NOT write files outside TARGET REPO or WORKTREE" to verifier prompts.
_added: 2026-06-10_

## Allure test reporting (#359 epic, 2026-06-13)

Unit, integration, and e2e tests write Allure JSON under `allure-results/`. Local viewing: `npx allure serve allure-results`. CI publishes to GitHub Pages via `ci.yml` and `e2e.yml` (no env vars). ReportPortal removed in #364.
_added: 2026-06-13_

## Infisical secrets delete — use --type (2026-06-13)

`infisical secrets get KEY` without `--type` merges layers and can false-positive "present" after shared secrets are deleted. For existence/delete checks use `--type=shared` and `--type=personal` separately. Delete shared: `infisical secrets delete KEY --env=ENV --type=shared`.
_added: 2026-06-13_

## localStorage view-mode pollution in BookmarkListPage tests (2026-06-09)

BookmarkListPage tests share a jsdom environment. Prior tests that set `view: "table"` write to `localStorage`, which persists into subsequent tests expecting grid view. **Fix:** add `localStorage.clear()` in `beforeEach`. The `ECONNREFUSED 127.0.0.1:3000` warning in the test output is pre-existing and unrelated.
_added: 2026-06-09_
