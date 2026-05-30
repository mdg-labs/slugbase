# Dispatch One — Workspace Notes

Durable project memory for orchestrator and sub-agents. Transient task notes belong in local session memory (gitignored), not here.

## Session memory — local + Jira handoff (DO-204)

`.cursor/skills/agent-memory/` is **gitignored**. Execution/verifier agents write session files locally during a run; **never commit** them. Verifier → **Done** posts a structured summary via `addCommentToJiraIssue` on the leaf issue; **Ready** (FAIL) posts layer failures. One implementation commit per task. See orchestrator SKILL.md + jira-board.md § Verifier Done comment.
_added: 2026-05-26_

## Jira Depends link type (2026-05-24)

Site link type **Depends**: outward `depends on`, inward `is required by` (id `10006`). MCP: `inwardIssue` = prerequisite, `outwardIssue` = dependent. JQL: `issue in linkedIssues("DO-N", "depends on")`. Legacy **Blocks** links from migration remain valid; use Depends for new links.
_added: 2026-05-24_

## Worker ESLint extends path

Use relative `extends: ['../../packages/config/eslint/nest.cjs']` in app `.eslintrc.cjs` — package-name shorthand `@dispatch-one/config/eslint/nest` does not resolve under ESLint 8. Same for `tsconfig.json` `extends`: use relative paths (e.g. `../config/tsconfig/node.json`) — IDE/tsserver does not resolve package.json exports in extends.
_added: 2026-05-20_

## Mapbox Directions routing (P4-02r)

MVP routing uses the Mapbox Directions API server-side (`MAPBOX_SECRET_KEY` in Infisical). Local dev defaults to `ROUTING_MOCK=true` (120s straight-line mock). Mapbox account needs a **Directions-only** secret token — no tiles/datasets setup required. `MapboxRoutingClient` lives in `apps/backend/src/common/routing/`.
_added: 2026-05-21_

## OSRM Docker image (local compose) — removed P4-02r

Self-hosted OSRM was removed from Docker Compose and Fly (`infra/fly-osrm/` deleted). Historical note: Docker Hub `osrmbackend/osrm-backend:v5.27.1` was not pullable; GHCR mirror was used when OSRM was local.
_added: 2026-05-20_

## Parallel agent scope leaks (pre–Lane P)

Before Lane P worktree isolation, parallel agents on `staging` could collide on commits. Use **Lane P** (`best-of-n-runner` + integration) for parallel batches. Legacy note: memory commits from parallel agents may include files from another task — verifier scores implementation commits for Layer 1; fix forward, do not rewrite history.
_added: 2026-05-20 | updated: 2026-05-20_

## Lane P parallel batches

Parallel tasks use `orchestrator/<TASK-ID>` branches in isolated worktrees (`best-of-n-runner`). Execution never commits to `staging`; integration merges after branch verify PASS. Plan file `[x]`/`[!]` only via staging batch verifier. Default to Lane S when scopes overlap or migrations touch shared schema.
_added: 2026-05-20_

## t0ggles epic batches (FE-8 pattern)

Epics are parent issues with cross-project children (Frontend + Backend). Read epic description for suggested order; use JQL `parent = DO-N` for child list. Serialize when children share files (e.g. DO-24/25/26 → one agent on `me.controller.ts`). **Execution agents** → Jira In Progress on leaf **and** epic parent when a child starts; **In Review** before verifier handoff; **verifiers** → Done after PASS. Epic Done on last child verifier or orchestrator recovery. See `.cursor/skills/orchestrator/jira-board.md`.
_added: 2026-05-22_

## Prisma migrations — never hand-write (BE-19 incident)

Execution agents must **never** create `apps/backend/prisma/migrations/**` by hand. Workflow: edit `schema.prisma` → `infisical run --env=development -- pnpm migrate:dev --name <snake_case_description>` → commit schema + generated migration together. Hand timestamps (e.g. `20260522120000`) are a red flag. Orchestrator includes PRISMA MIGRATIONS block in every execution prompt; verifiers FAIL Layer 3d on hand-written SQL.
_added: 2026-05-22_

## H-06 blocks P0-16

P0-16 branch-protection AC requires `gh api …/branches/{main,staging}/protection` → 200. Until H-06 completes (OIDC + branch rules), re-verify P0-16 only — do not re-implement dependabot/ad slot.
_added: 2026-05-20_

## CI Infisical OIDC — secrets vs variables

Workflow must use `secrets.INFISICAL_OIDC_IDENTITY_ID` and `secrets.INFISICAL_DOMAIN` if configured under GitHub **Settings → Secrets and variables → Actions → Secrets**. `vars.*` reads **Variables** tab only (repo API `actions/variables`); empty vars → action error "Missing identity ID". Infisical identity ID is public — repo variable or inline YAML is also valid.
_added: 2026-05-20_

## CI layout (self-hosted)

Single `ci` job: lint → typecheck → unit → data → Infisical OIDC → one build → integration → audit. Fast-fail skips secrets/build when cheap checks fail. Postgres/Redis service containers attach to the whole job.
_added: 2026-05-20_

## CI Docker cleanup (self-hosted)

`.github/scripts/ci-docker-cleanup.sh` runs with `if: always()` after the CI job. Prunes stopped containers, unused networks/volumes, and build cache older than 7d. Does not stop running containers — keep dev compose off CI runner hosts or use separate runners.
_added: 2026-05-20_

## Web Cloudflare adapter

Replaced deprecated `@cloudflare/next-on-pages` (miniflare 3 / undici 5) with `@opennextjs/cloudflare` + wrangler 4. Deploy build: `pnpm --filter @dispatch-one/web run pages:build`.
_added: 2026-05-20_

## Web build under Infisical development

Infisical `development` injects `NODE_ENV=development`, which breaks Next.js production build prerender. CI sets `NODE_ENV=production` on the build step; locally use `env NODE_ENV=production` when running build through Infisical.
_added: 2026-05-20_

## CI integration tests — shared Postgres/Redis

Root `test:integration` runs backend then worker sequentially (`pnpm --filter … && …`), not `turbo run test:integration` in parallel. Both share CI Postgres/Redis; worker `flushdb()` + backend e2e `deleteMany()` races caused login P2003 FK errors and pub/sub timeouts when turbo ran them together.
_added: 2026-05-20_

## Canonical naming: dispatch-one (repo, npm, Fly)

Single naming convention across the monorepo:

| Surface                 | Pattern                        | Example                                        |
| ----------------------- | ------------------------------ | ---------------------------------------------- |
| Git repo / root package | `dispatch-one`                 | `package.json` `"name": "dispatch-one"`        |
| pnpm workspace scope    | `@dispatch-one/*`              | `@dispatch-one/backend`, `@dispatch-one/web`   |
| Fly apps                | `dispatch-one-{env}-{service}` | `dispatch-one-staging-backend`                 |
| Infisical project       | `dispatch-one`                 | CI `project-slug: dispatch-one`                |
| Tolgee project          | `dispatch-one`                 | `TOLGEE_API_*` in Infisical                    |
| Sentry projects         | `dispatch-one-{app}`           | `dispatch-one-backend`, `-worker`, `-frontend` |

**Not** the legacy inverted npm scope (removed in DO-148/DO-149) or legacy external slug `one-dispatch` (removed in DO-150).
_added: 2026-05-20 | updated: 2026-05-25 (DO-150)_

## App naming convention: dispatch-one-_ (not one-dispatch-_) — superseded

See **Canonical naming** above. Fly apps use `dispatch-one-{env}-{service}` (e.g. `dispatch-one-staging-backend`).
The original spec said `one-dispatch-*` but staging apps were created with `dispatch-one-*`.
Architecture §3, H-03, H-04, P0-11, P0-12, P9-00 all updated to match.
Redis is Fly-hosted (`dispatch-one-staging-redis`), not Upstash — see `infra/fly-redis/fly.toml`.
_added: 2026-05-20_

## Staging deploy in ci-cd.yml (not workflow_run) — updated DO-201

`deploy-staging.yml` + `workflow_run` never fired: GitHub only registers workflows on **default branch** (`main`); deploy file existed on `staging` only. Staging deploy uses `needs: ci` + `needs: e2e` jobs in `ci-cd.yml` gated with `if: push && ref == staging`. The three legacy files (`ci.yml`, `prepare-release.yml`, `deploy-production.yml`) were consolidated into `.github/workflows/ci-cd.yml` in DO-199/DO-201. The new file covers all triggers: PR CI, staging deploy, prepare release, and production deploy.
_added: 2026-05-20 | updated: 2026-05-26 (DO-201/DO-202)_

## ci-cd.yml consolidation (DO-199/DO-201/DO-202)

Three legacy workflow files (`ci.yml`, `prepare-release.yml`, `deploy-production.yml`) replaced by a single `.github/workflows/ci-cd.yml`. Key additions in the consolidation: (1) **deployment gatekeeper jobs** (`deployment-staging-start/finish`, `deployment-production-start/finish`) emit GitHub Deployment records via `chrnorm/deployment-action` — GitHub-for-Atlassian links each deploy to all `DO-*` issues in the commit range; (2) **`.jira/config.yml`** maps `staging`/`production` to Jira environment types (must be on `main` branch to activate); (3) **Node 24 action runtime** — all GitHub-owned and third-party actions bumped to Node 24-compatible versions (`checkout@v6`, `setup-node@v6`, `upload-artifact@v6`, `download-artifact@v8`, `pnpm/action-setup` v6.0.8, `Infisical/secrets-action` v1.0.16); app `node-version: 22` unchanged. Self-hosted runners confirmed at 2.334.0 (≥ 2.327.1 required).
_added: 2026-05-26 (DO-202)_

## Lane P merge — P7-06 + P7-12 i18n

Integrating `orchestrator/P7-12` after P7-06 on `staging` conflicts in `.tolgee/keys.json` and `apps/web/src/i18n/request.ts`. Resolution: keep **both** `personnel` and `alliance` namespaces (additive merge, no key overlap).
_added: 2026-05-21_

## Fly Dockerfiles — workspace package COPY

When backend/worker add a `workspace:*` dependency under `packages/*`, both `apps/backend/Dockerfile` and `apps/worker/Dockerfile` need fetch+build COPY for that package (same pattern as `utils`, `types`, `data`, `config`). CI `pnpm build` uses full checkout; Fly remote build only sees what Dockerfiles COPY — missing package → TS2307 at `nest build` (e.g. `@dispatch-one/email-templates` in run 26278109294).
_added: 2026-05-22_

## IncidentCard onDispatch vs onSelect split (FE-74)

`IncidentCard` and `IncidentAccordionItem` carry two separate callbacks: `onSelect` (toggle — second click collapses) and `onDispatch` (always-expand — no toggle). `ActiveIncidentsPanel` wires `onSelect={handleSelectIncident}` for card-body clicks and `onDispatch={setSelectedIncidentId}` for the DISPATCH ▸ button. Map marker / alliance help link paths call `setSelectedIncidentId` directly and bypass the toggle entirely. Any future interaction that must always-expand (without risk of collapsing) should use `onDispatch`.
_added: 2026-05-24_

## Incident card timer labels (FE-34)

When `workStartedAt` is set (all units ON*SCENE), countdown math is work completion (`workStartedAt + workDurationS`). UI must use work/completion copy (`incident.card.workEyebrow`, `incident.panel.workCriticalBanner`) — not escalation labels. Reaction escalation (`reactEscalatesAt`) applies only when zero vehicles ON_SCENE (impl-spec §4.5). Bootstrap exposes `reactEscalatesAt` but web store does not yet — separate task if pre-scene reaction timer is needed.
\_added: 2026-05-22*

## Worker MAPBOX boot gate (FE-50)

Worker `env.schema` must not require `MAPBOX_SECRET_KEY` at boot when `ROUTING_MOCK=false` — missing Fly/Infisical sync on the **worker** app crashes the process before spawn ticks run. Geocoding/routing clients should short-circuit to coordinate fallback when the key is absent; backend may still require the key for its own Mapbox clients. Operator: sync `MAPBOX_SECRET_KEY` to `dispatch-one-staging-worker` for real addresses.
_added: 2026-05-22_

## RETURNING map markers (FE-49)

Map `geojson.ts` interpolates RETURNING correctly when the store has return-leg data. Live bug was state-sync: `VEHICLE_STATUS_CHANGED` lacked `returnRouteGeometry`; `INCIDENT_COMPLETED` dropped dispatch rows before the returning event; bootstrap only loaded ACTIVE-incident dispatches. Fix: inline return fields on returning WS events, retain in-progress return dispatches on incident end, bootstrap OR-query for `RETURNING` + `returnedAt IS NULL`.
_added: 2026-05-22_

## FE-59 Lane P — disk full + subagent interrupts

Parallel BE-31/FE-61 worktrees each run full CI (duplicate node*modules/build). Disk hit 100% → commits failed mid-flight; resume agents in existing worktrees succeeded after cleanup. Prefer Lane S for epic tails when disk tight; prune old `~/.cursor/worktrees/*`before Lane P batches. FE-61 agent initially touched`DispatchVehiclePicker.tsx` (FE-60) — scope revert required.
\_added: 2026-05-22\*

## GameGateway unit spec constructor drift

When adding a new constructor-injected service to `GameGateway`, update `game.gateway.spec.ts` `beforeEach` mocks in the **same order** as the gateway constructor (e.g. `RequestAllianceHelpService` between `confirmDispatch` and `recallVehicle`). Missing mocks shift args and fail with wrong-type errors — full `pnpm test:unit --filter @dispatch-one/backend` catches this even when task WRITE scope is dispatch-only.
_added: 2026-05-20_

## E2E CI — managed local stack (P8-01)

Full Playwright suite runs in `ci.yml` job `e2e` (not against staging). Stack unchanged (ephemeral postgres/redis + docker backend/worker + production web). CI optimization: `ci` packs build outputs → `e2e` restores (skip redundant Turbo/`next build`); `build-staging` packs → `deploy-web` restores before `pages:build` only.
_added: 2026-05-23_
