# PipeWatch Admin Portal — PRD

**Status:** Draft | **Version:** 0.3 | **Author:** MDG Labs | **Date:** June 2026

**Milestone:** MVP (milestone 1) — webhook delivery visualization is required for Cloud ops at launch.

**Related specs:** `docs/internal/PipeWatch_MVP_PRD.md` (product source of truth — wins on conflict)

---

## 1. Purpose

Internal admin portal for PipeWatch **Cloud** — overview of workspaces, installations, plans, and health monitoring for GitHub webhook delivery.

**Cloud-only.** Not part of PipeWatch CE. Never ships in CE Docker images or Compose.

---

## 2. Background / Problem

GitHub delivers webhooks to the central PipeWatch Cloud GitHub App. There is currently no way to monitor:

- The failure rate of webhook delivery
- Deliveries that GitHub **never managed to deliver** (`status_code = 0` — timeout/unreachable), since these never appear in PipeWatch server logs
- How delivery health breaks down per installation/workspace

There is also a general need for an internal admin overview (workspaces, installations, plans), decoupled from the customer-facing product.

---

## 3. Goals

- Visibility into webhook delivery health (overall + per installation/workspace)
- General admin overview of workspaces, installations, and plans
- **No mixing** of admin concerns with core product code/schema that also ships in CE
- Runnable on the existing hosted stack (Fly.io, Neon, Redis, Phase → GHA secrets sync)

---

## 4. Non-Goals

| Item | Rationale |
|---|---|
| CE webhook monitoring | CE self-hosters use GitHub's own **Advanced → Recent Deliveries** UI — sufficient at that scale |
| Webhook proxy (Svix/Hookdeck) | Would branch `apps/api` webhook verification (Cloud proxy sig vs CE GitHub sig) — rejected |
| Product database replication | Admin uses read-only cross-schema queries on `public.*`; no sync job or second database |
| Customer-facing alerting (Slack/email) | Post-MVP per MVP PRD §2; internal ops uses Sentry only in V1 |
| Auto-redelivery of failed webhooks | Deferred to V2 — manual redelivery only in V1 |
| Prometheus/Grafana | Admin portal already needs a UI; DB persistence enables per-installation history without another stack |
| Changes to `packages/db` | `public` schema untouched — CE and product migrations unaffected |

---

## 5. Architecture

### 5.1 High-level

```
GitHub App Hook Deliveries API
         │
         ▼ (poll every 2 min, JWT)
apps/admin  ──► BullMQ (admin-webhook-poll) ──► admin.webhook_deliveries
    │                                              │
    ├── read-only ──► public.workspaces            │
    │                 public.integrations            │
    │                 public.workspace_members       │
    └── serve ──► Admin UI (Vite + React SPA, static assets from Hono)
```

| Layer | Choice |
|---|---|
| App | `apps/admin` — standalone Hono service (JSON API + static SPA + BullMQ worker in one process) |
| Admin UI | **Vite + React + TypeScript** SPA colocated in `apps/admin/web` — API via `fetch` to Hono `/api/*`; production build served as static assets from the same Fly app |
| Admin schema | `packages/db-admin` — `pgSchema('admin')`, own Drizzle Kit migration path |
| Product data | Read-only queries on `public.*` via `@pipewatch/db/schema` imports — no duplication |
| Queue | Same Redis instance as api/worker; queue name `admin-webhook-poll` (kebab-case, matches worker queue style) |
| Deploy | Fly.io `pipewatch-{staging\|prod}-admin` — not in CE image build matrix |

### 5.2 Schema separation (not a separate database)

- New Postgres **schema** `admin` in the existing Cloud Neon database (same `DATABASE_URL`)
- `public` schema remains **unchanged** — no edits to `packages/db`, no CE impact
- `packages/db-admin`:
  - Own Drizzle tables via `pgSchema('admin')`
  - Own `drizzle.config.ts` and `packages/db-admin/drizzle/` migration history
  - Does **not** run through CE API auto-migrate (MVP PRD Decision #36)
  - Cloud pre-deploy: `run-migrate.sh` extended to apply **both** `@pipewatch/db` and `@pipewatch/db-admin` migrations (unpooled `DATABASE_URL_UNPOOLED`)

### 5.3 Dedicated service (not routes in `apps/api`)

- **No** admin code, admin auth, or admin routes in `apps/api` — avoids attack surface in the customer product
- `apps/admin` connects via Drizzle to the same Postgres instance (`admin` schema + read-only `public`)

### 5.4 Dedicated worker loop (not `apps/worker`)

- `apps/worker` is built into the CE image (`build-and-push-ce-image.yml`) — admin job code must not live there
- `apps/admin` registers a small BullMQ worker in the same Node process as the HTTP server
- Repeatable jobs (cron pattern) — no external scheduler

### 5.5 Shared GitHub App JWT

- JWT signing for `GET /app/hook/deliveries` must **not** duplicate a third implementation
- Extract `createAppJwt` from `apps/api/src/services/github/app-auth.ts` into a shared package (e.g. `packages/github-app-auth` or `packages/utils` submodule) consumed by `apps/api`, `apps/worker` (backfill), and `apps/admin`
- Same contract as today: RS256, 9-minute TTL, `jose` + `createPrivateKey`

### 5.6 Rejected alternatives

**Svix / Hookdeck:** Proxy re-signs payloads; would require edition-specific verification in `apps/api`. Rejected.

**Prometheus / Grafana:** Admin portal needs its own UI anyway; `admin.webhook_deliveries` enables per-installation filtering without a third observability stack. Rejected for V1.

---

## 6. Deployment & domains

Aligns with MVP PRD §4.3 naming conventions.

| Service | Staging | Production |
|---|---|---|
| **Admin portal** | `staging-admin.pipewatch.app` | `admin.pipewatch.app` |
| Fly.io app name | `pipewatch-staging-admin` | `pipewatch-prod-admin` |

- **Edition:** `PIPEWATCH_EDITION=cloud` only — admin Fly app is never provisioned for CE
- **Network:** **Cloudflare Access** on `admin.*` / `staging-admin.*` from day one (operator-configured). App-level session auth still required inside the edge gate — belt and suspenders.
- **Not** deployed to Cloudflare Workers — long-running Fly process (BullMQ worker + HTTP). CF Access sits in front of the Fly origin; admin is not an OpenNext Worker.

### 6.1 CI/CD touchpoints

| Artifact | Change |
|---|---|
| `.github/scripts/provision-fly-apps.sh` | Provision `pipewatch-{staging\|prod}-admin` |
| `.github/scripts/sync-secrets.sh` | `admin` service preflight + Fly secret push |
| `packages/config/sync-secrets-manifest.ts` | New `admin` service entry |
| `.github/scripts/run-migrate.sh` | Run `@pipewatch/db-admin db:migrate` after `@pipewatch/db` |
| `.github/workflows/deploy.yml` | Parallel `deploy-admin` job (after migrate) |
| `scripts/validate-sync-secrets-manifest.ts` | Validates new manifest entries |
| MVP PRD §23 env table | Document new Phase/GHA keys |

---

## 7. Data model (`admin` schema)

All migrations via Drizzle Kit only (`15-db-migrations-schema.mdc`). Never hand-write SQL.

### 7.1 `admin.webhook_deliveries`

One row per GitHub hook delivery ingested by the poll job. Name reflects row-level facts, not aggregates.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | Internal row id |
| `github_delivery_id` | `text` NOT NULL | GitHub delivery `id` (text avoids JS int64 precision issues) |
| `github_guid` | `text` NOT NULL | Event guid — dedup across redeliveries |
| `external_installation_id` | `text` NULL | GitHub `installation_id` as string; NULL → orphan bucket in UI |
| `integration_id` | `uuid` NULL | Denormalized FK to `public.integrations.id` when matched |
| `workspace_id` | `uuid` NULL | Denormalized from integration — powers per-workspace dashboards |
| `event` | `text` NOT NULL | GitHub `event` (e.g. `workflow_run`, `workflow_job`) |
| `action` | `text` NULL | GitHub `action` |
| `status_code` | `integer` NOT NULL | Includes `0` (unreachable) |
| `status` | `text` NOT NULL | GitHub human-readable status string |
| `duration` | `real` NULL | Seconds from GitHub |
| `redelivery` | `boolean` NOT NULL DEFAULT false | |
| `delivered_at` | `timestamptz` NOT NULL | From GitHub |
| `polled_at` | `timestamptz` NOT NULL DEFAULT now() | When poll job ingested this row |
| `created_at` | `timestamptz` NOT NULL DEFAULT now() | Row insert time |

**Indexes**

| Index | Purpose |
|---|---|
| `UNIQUE (github_delivery_id)` | Idempotent upsert on poll |
| `(workspace_id, delivered_at DESC)` | Per-workspace dashboards |
| `(external_installation_id, delivered_at DESC)` | Per-installation dashboards |
| `(delivered_at)` | Retention purge |
| Partial: `(status_code, delivered_at DESC) WHERE status_code = 0 OR status_code >= 300` | Unreachable / failure lists |

**Retention:** 45 days. Nightly BullMQ job deletes `WHERE delivered_at < now() - interval '45 days'`. Buffer beyond GitHub's 30-day redelivery window (§12 Risks).

**Installation mapping:** GitHub list endpoint returns `installation_id` on each delivery. Join to `public.integrations` on `external_installation_id = installation_id::text` AND `provider = 'github'`. Do not parse request payloads for V1.

### 7.2 `admin.admin_users`

Platform operators — **not** product `users` or workspace roles.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `email` | `text` NOT NULL UNIQUE | Login identifier |
| `password_hash` | `text` NOT NULL | bcrypt — same cost factor as product auth |
| `role` | `text` NOT NULL | `viewer` \| `operator` \| `platform_admin` |
| `created_at` | `timestamptz` NOT NULL DEFAULT now() |
| `last_login_at` | `timestamptz` NULL | |

**Role names intentionally avoid** workspace role `admin` to prevent confusion with product `owner | admin | member`.

### 7.3 `admin.admin_sessions`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `admin_user_id` | `uuid` NOT NULL FK → `admin_users` ON DELETE CASCADE | |
| `token_hash` | `text` NOT NULL UNIQUE | SHA-256 of session token |
| `expires_at` | `timestamptz` NOT NULL | |
| `created_at` | `timestamptz` NOT NULL DEFAULT now() |

HttpOnly, Secure, SameSite session cookie — separate cookie name from product refresh token (e.g. `pw_admin_session`).

### 7.4 `admin.admin_invites`

Invite-only onboarding after bootstrap — no public sign-up.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `email` | `text` NOT NULL | Invitee email |
| `role` | `text` NOT NULL | `viewer` \| `operator` \| `platform_admin` |
| `token_hash` | `text` NOT NULL UNIQUE | SHA-256 of invite token (token shown once in email) |
| `invited_by` | `uuid` NOT NULL FK → `admin_users` | |
| `expires_at` | `timestamptz` NOT NULL | Default 7 days |
| `accepted_at` | `timestamptz` NULL | |
| `created_at` | `timestamptz` NOT NULL DEFAULT now() |

### 7.5 `admin.audit_events`

Ops audit log for mutating actions (manual redelivery, invite revoke, role changes).

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `admin_user_id` | `uuid` NOT NULL FK → `admin_users` | Who performed the action |
| `action` | `text` NOT NULL | e.g. `webhook.redeliver`, `admin.invite`, `admin.revoke_invite` |
| `target_type` | `text` NOT NULL | e.g. `webhook_delivery`, `admin_invite`, `admin_user` |
| `target_id` | `text` NOT NULL | Target row id or GitHub delivery id |
| `metadata` | `jsonb` NULL | Non-sensitive context (status_code, workspace_id) — no secrets |
| `created_at` | `timestamptz` NOT NULL DEFAULT now() |

**Why this exists:** GitHub's `webhook_deliveries.redelivery` flag only records that GitHub resent an event — not **which operator** triggered it from PipeWatch. `audit_events` answers "who redelivered what, when?" for internal accountability.

---

## 8. Platform auth & roles

Separate identity system in `admin.*` — no reuse of product JWT or workspace membership.

### 8.1 Roles (V1)

| Role | Read dashboards | Read workspace/install/plan metadata | Trigger manual redelivery | Manage admin users |
|---|---|---|---|---|
| `viewer` | ✓ | ✓ | — | — |
| `operator` | ✓ | ✓ | ✓ | — |
| `platform_admin` | ✓ | ✓ | ✓ | ✓ |

### 8.2 Bootstrap (first deploy only)

When `admin.admin_users` is empty on startup:

1. Read `ADMIN_BOOTSTRAP_EMAIL` + `ADMIN_BOOTSTRAP_PASSWORD` from env (Phase / GHA secrets — set before first deploy)
2. Create one `platform_admin` user with bcrypt password hash
3. Refuse bootstrap if any admin user already exists (no replay)

After bootstrap, **remove or rotate** bootstrap password in Phase. No CLI seed script required.

### 8.3 Invite-only onboarding (after bootstrap)

- **No public sign-up** — new operators are added only via invite from an existing `platform_admin`
- `platform_admin` creates invite → signed token → email via **existing SMTP** credentials already in Phase (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` — same as `apps/api`)
- Invitee opens link → sets password → `admin_users` row created → invite marked accepted
- Invite email template: internal ops copy only (not customer i18n catalog)

### 8.4 Login (V1)

- Email + password against `admin.admin_users`
- Session stored in `admin.admin_sessions`; validated on every request
- `ADMIN_SESSION_SECRET` for signing session tokens (separate from `JWT_SECRET` / `JWT_REFRESH_SECRET`)

### 8.5 Read-only `public.*` exposure rules

**Include:** `workspaces` (id, slug, name, plan, `created_at`, `default_retention_days`), `integrations` (id, `workspace_id`, `external_installation_id`, `account_login`, `account_type`, `created_at`), `workspace_members` counts per workspace

**Exclude:** `integrations.access_token`, product refresh tokens, API key hashes, user PII beyond what ops explicitly need, Stripe identifiers in UI unless debugging billing (display `plan` column only in V1)

**No `ENCRYPTION_KEY` required** — admin never decrypts integration tokens in V1.

---

## 9. Webhook delivery monitoring

### 9.1 Poll mechanism

1. **Auth:** Shared `createAppJwt` with `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` (Phase keys `GH_APP_ID`, `GH_APP_PRIVATE_KEY`)
2. **Query:** `GET /app/hook/deliveries?per_page=100` — paginate via `link` response header / `cursor` until exhausted
3. **Schedule:** Repeatable BullMQ job every **2 minutes** on queue `admin-webhook-poll`
4. **Upsert:** Insert or update on `github_delivery_id`; refresh `polled_at`
5. **Scope:** Map `installation_id` → `integrations.external_installation_id` → `workspace_id`
6. **Coverage metric:** UI exposes lag between latest `delivered_at` in GitHub vs latest `polled_at` — surfaces missed deliveries before tuning interval

### 9.2 Outcome classification

| Bucket | Rule | Notes |
|---|---|---|
| Success | `status_code` 200–299 | PipeWatch webhook handler should only return 2xx |
| HTTP failure | `status_code` 300–599 | Misconfig, 4xx/5xx from API |
| Unreachable | `status_code = 0` | Never reached PipeWatch — **not** included in GitHub `?status=failure` filter |

GitHub API classifies success as 200–399 for its own filters; PipeWatch uses the tighter 2xx rule for monitoring because 3xx should not occur on our webhook endpoint.

### 9.3 Manual redelivery (V1)

- `operator` or `platform_admin` triggers `POST /app/hook/deliveries/{id}/attempts` from admin UI
- Confirmation step required — no background auto-redelivery in V1
- GitHub allows redelivery only for deliveries within the last **30 days**
- On success: append `admin.audit_events` row (`action = webhook.redeliver`, actor, delivery id, workspace/installation metadata)

### 9.4 Retention cleanup

- Repeatable job (e.g. daily) on queue `admin-maintenance`
- Deletes `admin.webhook_deliveries` older than 45 days

---

## 10. Alerting (V1)

**Channel:** Sentry only — consistent with MVP PRD §4.2 (`SENTRY_DSN_*` per service).

| Signal | Mechanism |
|---|---|
| Poll job crash | `Sentry.captureException` in BullMQ processor |
| Elevated global failure rate | `Sentry.captureMessage` level `warning` — >5% non-2xx over rolling 15 min |
| Unreachable spike | `Sentry.captureMessage` level `error` — ≥3 deliveries with `status_code = 0` in 15 min (global or per-installation) |

- New Phase/GHA key: `SENTRY_DSN_ADMIN` → runtime `SENTRY_DSN` on admin Fly app
- Thresholds env-configurable: `ADMIN_ALERT_FAILURE_RATE_THRESHOLD`, `ADMIN_ALERT_UNREACHABLE_COUNT`, `ADMIN_ALERT_WINDOW_MINUTES` (defaults: `0.05`, `3`, `15`)
- Use `scrubSentryEvent` from `@pipewatch/utils` — no secrets in breadcrumbs

**Not in V1:** Slack, email, PagerDuty.

---

## 11. Environment variables

Follow `05-env-vars.mdc` when implementing. Admin-specific keys:

| Phase / GHA storage | Runtime (Fly) | Required | Notes |
|---|---|---|---|
| `DATABASE_URL` | `DATABASE_URL` | ✓ | Same Neon instance as api/worker |
| — | `REDIS_URL` | ✓ | Derived at sync: `redis://pipewatch-{staging\|prod}-redis.internal:6379` |
| `GH_APP_ID` | `GITHUB_APP_ID` | ✓ | Poll + redelivery JWT |
| `GH_APP_PRIVATE_KEY` | `GITHUB_APP_PRIVATE_KEY` | ✓ | Poll + redelivery JWT |
| `ADMIN_SESSION_SECRET` | `ADMIN_SESSION_SECRET` | ✓ | Min 32 chars — new Phase key |
| `SENTRY_DSN_ADMIN` | `SENTRY_DSN` | optional | New Sentry project |
| `PIPEWATCH_EDITION` | `PIPEWATCH_EDITION` | ✓ | Always `cloud` for this app |
| `NODE_ENV` | `NODE_ENV` | ✓ | |
| `ADMIN_ALERT_FAILURE_RATE_THRESHOLD` | same | optional | Default `0.05` |
| `ADMIN_ALERT_UNREACHABLE_COUNT` | same | optional | Default `3` |
| `ADMIN_ALERT_WINDOW_MINUTES` | same | optional | Default `15` |
| `ADMIN_POLL_INTERVAL_CRON` | same | optional | Default `*/2 * * * *` |
| `ADMIN_BOOTSTRAP_EMAIL` | same | ✓ (first deploy) | One-time; remove after bootstrap |
| `ADMIN_BOOTSTRAP_PASSWORD` | same | ✓ (first deploy) | One-time; remove after bootstrap |
| `SMTP_HOST` | same | ✓ | Reuse api Postmark SMTP — invite emails |
| `SMTP_PORT` | same | ✓ | |
| `SMTP_USER` | same | ✓ | |
| `SMTP_PASS` | same | ✓ | |
| `SMTP_FROM` | same | ✓ | e.g. `noreply@pipewatch.app` |
| `ADMIN_URL` | same | ✓ | `https://admin.pipewatch.app` (staging: `https://staging-admin.pipewatch.app`) — invite links |

**Not required for admin:** `JWT_SECRET`, `JWT_REFRESH_SECRET`, `GITHUB_WEBHOOK_SECRET`, `ENCRYPTION_KEY`, Stripe keys, OAuth client secrets.

---

## 12. Scope — V1 acceptance criteria

### 12.1 `packages/db-admin`

- [ ] `admin` schema with `webhook_deliveries`, `admin_users`, `admin_sessions`, `admin_invites`, `audit_events`
- [ ] Drizzle Kit migration generated and applied in Cloud deploy pipeline
- [ ] Cross-schema read helpers for `public.integrations` / `public.workspaces` (read-only)

### 12.2 Shared GitHub App JWT package

- [ ] `createAppJwt` extracted; `apps/api` and `apps/worker` migrated to import shared module
- [ ] No behaviour change to existing GitHub App auth flows

### 12.3 `apps/admin` service

- [ ] Hono JSON API + BullMQ workers in one process
- [ ] Vite + React + TypeScript SPA in `apps/admin/web` — dev proxy to Hono; production static build served by Hono
- [ ] `Dockerfile`, `fly.toml`, health endpoint
- [ ] Env validation schema in `@pipewatch/config` (admin-specific fields)
- [ ] Platform auth: bootstrap, login, logout, invite accept, session middleware, role guards
- [ ] Invite flow: create/revoke/resend; SMTP email when configured (same Phase SMTP as api)

### 12.4 Background jobs

- [ ] Repeatable poll job: JWT → paginated delivery fetch → upsert `webhook_deliveries`
- [ ] Repeatable retention job: purge rows older than 45 days
- [ ] Sentry alerts on threshold breach and job failures

### 12.5 Admin API + UI

- [ ] **Webhook delivery visualization (MVP-critical):** time-series failure rate chart, per-installation/workspace breakdown, filterable/sortable delivery table (status, event, delivered_at, installation, workspace), highlight unreachable (`status_code = 0`)
- [ ] **Poll coverage indicator:** max `delivered_at` vs last `polled_at` — surfaces ingest gaps (§9.1, D6)
- [ ] **Workspace overview:** list workspaces with plan, integration count, member count
- [ ] **Installation overview:** integrations with `account_login`, linked workspace, recent delivery health summary
- [ ] **Manual redelivery:** operator-triggered, confirmation required, `audit_events` row on success
- [ ] **Admin user management:** invite list, create invite (`platform_admin` only)
- [ ] Loading skeletons and inline error retry — no blank screens

### 12.6 Hosted deploy

- [ ] `admin` in `sync-secrets-manifest.ts` and `sync-secrets.sh`
- [ ] `deploy-admin` job in `deploy.yml`
- [ ] `provision-fly-apps.sh` creates admin Fly app
- [ ] `run-migrate.sh` runs `db-admin` migrations
- [ ] Phase keys registered: `ADMIN_SESSION_SECRET`, `SENTRY_DSN_ADMIN`, `ADMIN_BOOTSTRAP_*`, `ADMIN_URL`; SMTP keys synced from existing Phase entries

---

## 13. Work breakdown (for GitHub intake)

Use this section with the **github-intake** skill. Create one **Feature (epic)** parent plus child **Tasks**. Milestone: **MVP #1**. Priority/Effort below are intake defaults (§14).

### 13.1 Epic

**Title:** `Feature: PipeWatch Admin Portal (Cloud)`

**Milestone:** MVP #1

**Priority:** High | **Effort:** High (`effort:XL`)

**Goal:** Internal operators can **visualize** GitHub webhook delivery health and browse workspace/installation/plan metadata without touching CE code paths or the customer API.

**Product rules (epic-level):**

- Cloud-only — never in CE image or Compose
- No admin routes in `apps/api`; no admin jobs in `apps/worker`
- No changes to `packages/db` / `public` schema
- Platform roles (`viewer` / `operator` / `platform_admin`) are separate from workspace roles
- Webhook redelivery is manual-only in V1; every redelivery writes `audit_events`
- CF Access on admin subdomain from day one; app auth still required
- Bootstrap once via env; all subsequent operators via invite + SMTP email

### 13.2 Proposed child issues

| # | Proposed title | Domain | Priority | Effort | Depends on | Summary |
|---|---|---|---|---|---|---|
| 1 | `db-admin: admin schema and migrations` | `domain:infrastructure` | High | M | — | `packages/db-admin`, tables §7.1–7.5, Drizzle Kit migrate script |
| 2 | `github-app-auth: extract shared App JWT helper` | `domain:backend` | Medium | S | — | Shared `createAppJwt`; refactor api + worker imports |
| 3 | `admin: Hono API scaffold, Vite React shell, and Fly assets` | `domain:infrastructure` | High | M | 1 | `apps/admin` + `apps/admin/web`, Dockerfile, `fly.toml`, health, env schema |
| 4 | `admin: platform auth, bootstrap, and invites` | `domain:backend` | High | L | 1, 3 | Bootstrap env, login/sessions, invite CRUD, SMTP emails, role middleware |
| 5 | `admin: webhook delivery poll job` | `domain:backend` | High | M | 1, 2, 3 | BullMQ `admin-webhook-poll`, pagination, upsert, installation mapping |
| 6 | `admin: retention cleanup and Sentry alerts` | `domain:backend` | Medium | S | 5 | `admin-maintenance` queue, 45-day purge, threshold alerts §10 |
| 7 | `admin: workspace and installation overview API` | `domain:backend` | Medium | S | 1, 4 | Read-only `public.*` list endpoints with role guard |
| 8 | `admin: webhook health API and manual redelivery` | `domain:backend` | High | M | 4, 5 | Failure rates, delivery list, redelivery + `audit_events` |
| 9 | `admin: React UI — delivery visualization and overview pages` | `domain:frontend` | High | L | 7, 8 | Vite/React SPA: charts, delivery table, overview, redelivery UX |
| 10 | `admin: hosted deploy pipeline and secrets sync` | `domain:infrastructure` | High | M | 3 | Manifest, sync-secrets (incl. SMTP), provision-fly, deploy.yml, run-migrate |

**Effort column:** t-shirt label (`S`/`M`/`L`) — map to org Effort field at intake: S→Low, M→Medium, L→High.

### 13.3 Suggested implementation order

```
1 (db-admin)  ──┬──► 3 (scaffold) ──► 4 (auth) ──► 7 (overview API) ──┐
2 (jwt shared) ─┘                              └──► 8 (webhook API) ──┼──► 9 (UI)
                └──► 5 (poll job) ──► 6 (retention/alerts) ──────────┘
3 ──► 10 (deploy pipeline) — wire after scaffold exists; can land before UI for staging smoke
```

**Parallel lanes after approval:**

- Lane A: `1 → 3 → 4 → 7 → 9` (auth + overview UI path)
- Lane B: `2 → 5 → 6 → 8` (monitoring path) — merge at 8/9
- Lane C: `10` after `3` (infra can proceed in parallel with 4–8)

### 13.4 Per-issue spec refs (for intake AC)

| Issue | Admin PRD sections | MVP PRD refs |
|---|---|---|
| 1 | §7 | §17 (Drizzle), Decision #36 |
| 2 | §5.5 | §4.4 (GitHub App JWT) |
| 3 | §5.1, §6 | §4.3, §4.6 |
| 4 | §8 | §7.1 (auth patterns — separate system) |
| 5 | §9 | §4.4 |
| 6 | §9.4, §10 | §4.2 (Sentry) |
| 7 | §8.5, §12.5 | §5, §6 (`workspaces`, `integrations`) |
| 8 | §9.2, §9.3, §12.5 | §4.4 |
| 9 | §12.5 | — |
| 10 | §6.1, §11 | §10, §22, §23 |

### 13.5 Tests (epic-level expectations)

| Area | Tests |
|---|---|
| `packages/db-admin` | Unit: schema exports; integration: migrate against ephemeral Postgres |
| Shared JWT | Unit: existing `app-auth.test.ts` cases move with module |
| Poll job | Unit: classification logic; integration: mocked GitHub API + DB upsert |
| Auth | Integration: login, session expiry, role 403, invite accept, bootstrap once |
| Overview API | Integration: read-only queries, no token leakage |
| Webhook API | Integration: redelivery writes `audit_events`; mocked GitHub redelivery |
| Admin UI | Component tests for delivery table/chart; manual smoke on staging |
| Deploy manifest | `sync-secrets-manifest.test.ts`, `validate-sync-secrets-manifest.ts` in CI |

**E2e:** Not required for V1 — internal tool; manual smoke on staging after deploy.

---

## 14. Resolved decisions

| # | Topic | Decision |
|---|---|---|
| D1 | Milestone | **MVP #1** — delivery visualization required at Cloud launch |
| D2 | Edge access | **Cloudflare Access** on admin subdomain from day one **plus** app session auth |
| D3 | Operator onboarding | **Env bootstrap** for first `platform_admin` when `admin_users` is empty; **invite-only** thereafter; invite emails via **existing Phase SMTP** (`SMTP_*`) |
| D4 | Admin UI | **Vite + React + TypeScript** SPA in `apps/admin/web` — modern, extensible; Hono serves API + static build on Fly |
| D5 | Redelivery audit | **`admin.audit_events` table** — log who triggered each manual redelivery (GitHub's `redelivery` flag alone is insufficient) |
| D6 | Poll interval | **Fixed 2 minutes** for V1; expose **poll coverage** metric in UI before tuning |
| D7 | Priority / Effort | Set per issue in §13.2; epic **High / XL** |

### 14.1 Operator actions (out of scope for agents)

- Configure Cloudflare Access policy for `admin.pipewatch.app` / `staging-admin.pipewatch.app`
- Set `ADMIN_BOOTSTRAP_*` in Phase before first deploy; remove after bootstrap
- Add `ADMIN_URL`, `ADMIN_SESSION_SECRET`, `SENTRY_DSN_ADMIN` to Phase Staging/Production

---

## 15. Risks

| Risk | Mitigation |
|---|---|
| GitHub Delivery API returns only the most recent ~150–200 entries per poll window | 2-minute poll interval + **full cursor pagination** each run; monitor ingest lag in admin UI |
| `status_code = 0` not returned by `?status=failure` | Poll all deliveries; classify `0` explicitly in application logic |
| High webhook volume exceeds poll capacity | Track `polled_at` vs `delivered_at` delta; alert via Sentry; tune interval (D6) |
| GitHub redelivery window is 30 days | Retention 45 days; manual redelivery UI surfaces age |
| New consumer of `GITHUB_APP_PRIVATE_KEY` | Reuse shared JWT module; never log key; Phase key already exists |
| Cross-schema join drift (`installation_id` not in DB) | Orphan bucket in UI; optional link to GitHub installation URL |
| Role name confusion with workspace `admin` | Platform roles use `platform_admin`, not `admin` |

---

## 16. Future (V2+)

- Auto-redelivery for `status_code = 0` with rate limits and cooldown (operator-configurable)
- Slack/email notification channel for ops (separate from customer alerting roadmap)
- Aggregated rollup table / materialized view if dashboard queries slow down
- Dynamic poll interval based on delivery volume
