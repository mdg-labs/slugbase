# SlugBase Admin Portal — PRD

**Status:** Draft | **Version:** 0.1 | **Author:** MDG Labs | **Date:** June 2026

**Milestone:** Fast-Follow (post–v1 launch) — replaces direct-database operator access for hosted Cloud ops.

**Related specs:** `docs/internal/slugbase-mvp-spec.md` (product source of truth — wins on conflict) · `docs/internal/engineering-decisions.md` · `docs/internal/slugbase-development-roadmap.md` (P5-06 aggregate-stats endpoint)

---

## 1. Purpose

Internal admin portal for SlugBase **hosted (Cloud)** — read-only visibility into accounts, workspaces, plans, and product-usage statistics for the SlugBase operator.

**Hosted-only.** Not part of the self-hosted combined image or GHCR publish matrix. Never ships to self-hosters.

---

## 2. Background / Problem

At v1 launch, hosted operations rely on **direct database access** plus the **secret-protected aggregate-statistics endpoint** (spec §10.2, §18; roadmap P5-06). That works for launch but does not scale operationally:

- No browsable workspace or account directory without writing SQL
- No time-series view of signups, plan mix, or product usage
- No role-gated, auditable surface for multiple operators
- Direct DB access bypasses access logging and couples ops to schema knowledge

There is a general need for an internal admin overview (accounts, workspaces, plans, usage aggregates), **decoupled from the customer-facing product** and **without modifying product schema or code paths that ship in self-hosted**.

This PRD defines that portal. It deliberately excludes PipeWatch-style external polling (GitHub webhooks, third-party delivery APIs, etc.) — SlugBase has no equivalent hosted-ingest pipeline to monitor in V1.

---

## 3. Goals

- Operator visibility into **account** and **workspace** statistics (counts, plan mix, growth trends)
- **Product-usage aggregates** (bookmarks, members, billing state summaries) without PII-heavy exports
- **No mixing** of operator-admin concerns with core product code/schema that also ships in self-hosted
- Runnable on the existing hosted stack (Fly.io API region, Neon Postgres, Phase secrets, Cloudflare edge)
- **Read-only** on all `public.*` product data in V1 — operator actions limited to platform-admin identity management

---

## 4. Non-Goals

| Item | Rationale |
|---|---|
| Self-hosted operator portal | Self-hosted uses the **instance-wide admin flag** on product accounts (spec §10.2); no second surface |
| Admin routes in `packages/backend` | Customer API attack surface must not include operator tooling; `packages/backend/src/admin` today is **workspace settings** (SMTP, AI) — not this portal |
| Product database replication | Admin uses read-only cross-schema queries on `public.*`; no sync job or second database |
| Mutating product data (suspend user, change plan, impersonate) | V1 is observability-only on product entities; avoids accidental core-product impact |
| Customer-facing alerting (Slack/email to users) | Out of scope; internal ops uses Sentry only in V1 |
| Prometheus/Grafana as primary UI | Admin portal needs a UI; optional `admin.daily_snapshots` enables history without another stack |
| Changes to `packages/backend` product schema | `public` schema untouched — self-hosted migrations unaffected |
| Stripe Dashboard replacement | V1 may **link out** to Stripe for payment detail; no in-app charge/refund flows |
| i18n for admin UI | Internal English-only copy; not part of product locale catalogs |
| P5-06 removal | Aggregate-stats endpoint **remains** for machine-readable external monitoring; admin portal is the human operator surface |

---

## 5. Architecture

### 5.1 High-level

```
packages/admin  ──► in-process nightly job ──► admin.daily_snapshots
    │
    ├── read-only ──► public.user_accounts
    │                 public.workspaces
    │                 public.workspace_members
    │                 public.bookmarks
    │                 public.billing_webhook_events (counts only)
    │                 … (aggregates, no secret columns)
    │
    └── serve ──► Admin UI (Vite + React SPA, static assets from Hono)
```

| Layer | Choice |
|---|---|
| App | `packages/admin` — standalone **Hono** service (JSON API + static SPA + in-process scheduler in one process) |
| Admin UI | **Vite + React + TypeScript** SPA colocated in `packages/admin/web` — API via `fetch` to Hono `/api/*`; production build served as static assets from the same Fly app |
| Admin schema | `packages/db-admin` — `pgSchema('admin')`, own Drizzle Kit migration path |
| Product data | Read-only queries on `public.*` via schema imports from `packages/backend` (or a thin `packages/db-readonly` re-export) — no duplication |
| Background work | **In-process** repeatable jobs (same posture as spec §22.10 — no Redis/BullMQ) |
| Deploy | Fly.io `slugbase-{staging\|production}-admin` — **not** in self-host GHCR image build |

### 5.2 Schema separation (not a separate database)

- New Postgres **schema** `admin` in the existing Cloud Neon database (same `DATABASE_URL` as `packages/backend`)
- `public` schema remains **unchanged** — no edits to product Drizzle tables, no self-host impact
- `packages/db-admin`:
  - Own Drizzle tables via `pgSchema('admin')`
  - Own `drizzle.config.ts` and `packages/db-admin/drizzle/` migration history
  - Does **not** run through self-host API auto-migrate on startup (spec §14.3 product path)
  - Hosted admin pre-deploy: CI migration step applies `@slugbase/db-admin` migrations **before** admin Fly deploy (unpooled `DATABASE_URL` or Neon unpooled equivalent)

### 5.3 Dedicated service (not routes in `packages/backend`)

- **No** operator portal code, operator auth, or operator routes in `packages/backend` — avoids attack surface in the customer API and keeps self-host image lean
- `packages/admin` connects via Drizzle to the same Postgres instance (`admin` schema + read-only `public`)
- The existing P5-06 aggregate-stats endpoint may remain a **single JSON blob** endpoint on the API for automation; it is not extended with directory/list APIs in V1

### 5.4 Dedicated process (not embedded in self-host image)

- The self-host combined container image (`packages/backend` + `packages/web`) must **never** include `packages/admin` or `packages/db-admin` runtime code
- `packages/admin` is a separate Fly app with its own `Dockerfile` and `fly.toml`
- Nightly snapshot rollup runs inside the admin process — no shared worker service (SlugBase has no `apps/worker`)

### 5.5 Rejected alternatives

**Admin module inside NestJS backend:** Would ship operator routes in the same deployable as customer API; increases attack surface and tempts self-host inclusion. Rejected.

**Prometheus / Grafana only:** Operators still need workspace/account directory views and drill-down; metrics alone do not replace SQL exploration. Rejected for V1.

**Second database / read replica:** Operational overhead; cross-schema read on Neon is sufficient at expected scale. Rejected for V1.

**Reuse product sessions / instance-admin flag:** Product `is_instance_admin` is a **self-hosted deployment concept** (spec §10.2); hosted operator identity must be separate. Rejected.

---

## 6. Deployment & domains

Aligns with spec §14.7 naming conventions (decision #51).

| Service | Staging | Production |
|---|---|---|
| **Admin portal** | `staging-admin.slugbase.app` (illustrative) | `admin.slugbase.app` (illustrative) |
| Fly.io app name | `slugbase-staging-admin` | `slugbase-production-admin` |

- **Deployment shape:** Hosted Cloud **only** — admin Fly app is never provisioned for self-hosted installs
- **Network:** **Cloudflare Access** on `admin.*` / `staging-admin.*` from day one (operator-configured). App-level session auth still required inside the edge gate — belt and suspenders.
- **Not** deployed to Cloudflare Workers — long-running Fly process (HTTP + in-process scheduler). CF Access sits in front of the Fly origin.

### 6.1 CI/CD touchpoints

| Artifact | Change |
|---|---|
| `.github/scripts/provision-fly-apps.sh` (or equivalent) | Provision `slugbase-{staging\|production}-admin` |
| Phase / deploy secret sync | `admin` service preflight + Fly secret push |
| `.github/workflows/deploy-staging.yml` | Parallel `deploy-admin-staging` job (after `db-admin` migrate) |
| `.github/workflows/deploy-production.yml` | Parallel `deploy-admin-production` job (after migrate) |
| Admin migrate script | Run `@slugbase/db-admin db:migrate` — **separate** from product API boot migrate |
| `docs/internal/environment-variables.md` | Document new Phase keys |

---

## 7. Data model (`admin` schema)

All migrations via Drizzle Kit only. Never hand-write migration directories.

### 7.1 `admin.daily_snapshots`

One row per **calendar day** (UTC) of rolled-up platform metrics. Powers time-series charts without hammering live aggregates on every page load.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `snapshot_date` | `date` NOT NULL | UTC date bucket |
| `total_accounts` | `integer` NOT NULL | |
| `new_accounts` | `integer` NOT NULL | Created that day |
| `verified_accounts` | `integer` NOT NULL | Cumulative verified email |
| `mfa_enrolled_accounts` | `integer` NOT NULL | Cumulative MFA enrolled |
| `total_workspaces` | `integer` NOT NULL | |
| `new_workspaces` | `integer` NOT NULL | Created that day |
| `workspaces_by_plan` | `jsonb` NOT NULL | e.g. `{ "free": 120, "personal": 45, "team": 12 }` |
| `total_bookmarks` | `integer` NOT NULL | Excludes `plan_archived` |
| `plan_archived_bookmarks` | `integer` NOT NULL | Downgrade overflow |
| `total_memberships` | `integer` NOT NULL | `workspace_members` rows |
| `active_subscriptions` | `integer` NOT NULL | Workspaces with paid `billing_status` |
| `computed_at` | `timestamptz` NOT NULL DEFAULT now() | When rollup job finished |

**Indexes**

| Index | Purpose |
|---|---|
| `UNIQUE (snapshot_date)` | Idempotent daily upsert |
| `(snapshot_date DESC)` | Chart queries |

**Retention:** 400 days. Monthly purge job deletes older rows.

### 7.2 `admin.admin_users`

Platform operators — **not** product `user_accounts` or workspace roles.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `email` | `text` NOT NULL UNIQUE | Login identifier |
| `password_hash` | `text` NOT NULL | **argon2id** — same parameters as product auth (spec §5.4) |
| `role` | `text` NOT NULL | `viewer` \| `operator` \| `platform_admin` |
| `created_at` | `timestamptz` NOT NULL DEFAULT now() |
| `last_login_at` | `timestamptz` NULL | |

**Role names intentionally avoid** workspace role `admin` and product term **member** in operator role names — use `platform_admin`, not `admin`.

### 7.3 `admin.admin_sessions`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `admin_user_id` | `uuid` NOT NULL FK → `admin_users` ON DELETE CASCADE | |
| `token_hash` | `text` NOT NULL UNIQUE | SHA-256 of session token |
| `expires_at` | `timestamptz` NOT NULL | |
| `created_at` | `timestamptz` NOT NULL DEFAULT now() |

HttpOnly, Secure, SameSite session cookie — separate cookie name from product session (e.g. `sb_admin_session`).

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

Ops audit log for **platform-admin mutating actions** (invite create/revoke, role changes). V1 has no product-data mutations to audit.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `admin_user_id` | `uuid` NOT NULL FK → `admin_users` | Who performed the action |
| `action` | `text` NOT NULL | e.g. `admin.invite`, `admin.revoke_invite`, `admin.role_change` |
| `target_type` | `text` NOT NULL | e.g. `admin_invite`, `admin_user` |
| `target_id` | `text` NOT NULL | Target row id |
| `metadata` | `jsonb` NULL | Non-sensitive context — no secrets |
| `created_at` | `timestamptz` NOT NULL DEFAULT now() |

---

## 8. Platform auth & roles

Separate identity system in `admin.*` — no reuse of product sessions, API tokens, or workspace membership.

### 8.1 Roles (V1)

| Role | Read dashboards & directories | Export aggregate CSV | Manage admin users |
|---|---|---|---|
| `viewer` | ✓ | — | — |
| `operator` | ✓ | ✓ | — |
| `platform_admin` | ✓ | ✓ | ✓ |

V1 has no product-side operator actions (no account suspension, plan override, or impersonation).

### 8.2 Bootstrap (first deploy only)

When `admin.admin_users` is empty on startup:

1. Read `ADMIN_BOOTSTRAP_EMAIL` + `ADMIN_BOOTSTRAP_PASSWORD` from Phase (set before first deploy)
2. Create one `platform_admin` user with argon2id password hash
3. Refuse bootstrap if any admin user already exists (no replay) — stale `ADMIN_BOOTSTRAP_*` env vars are ignored when users already exist

After bootstrap, **removing or rotating** bootstrap credentials in Phase/Fly is **recommended hygiene** (reduces credential exposure) but **not required for the app to boot**. No CLI seed script required.

### 8.3 Invite-only onboarding (after bootstrap)

- **No public sign-up** — new operators are added only via invite from an existing `platform_admin`
- `platform_admin` creates invite → signed token → email via **existing hosted SMTP** credentials (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` — same as `packages/backend`)
- Invitee opens link → sets password → `admin_users` row created → invite marked accepted
- Invite email template: internal ops copy only (not product i18n catalog)

### 8.4 Login (V1)

- Email + password against `admin.admin_users`
- Session stored in `admin.admin_sessions`; validated on every request
- `ADMIN_SESSION_SECRET` for signing session tokens (separate from `SESSION_SECRET`)

### 8.5 Read-only `public.*` exposure rules

**Include (aggregates & directory metadata):**

| Entity | Fields safe for operator UI |
|---|---|
| `user_accounts` | `id`, `email`, `name`, `created_at`, `email_verified`, `mfa_state`, `language`, `ai_opt_out` |
| `workspaces` | `id`, `name`, `slug`, `plan`, `plan_seats`, `billing_status`, `billing_period_end`, `permanent_personal`, `created_at` |
| `workspace_members` | counts per workspace; role distribution |
| `bookmarks` | counts per workspace; `plan_archived` count; aggregate `access_count` (slug usage) |
| `folders`, `tags`, `teams` | counts per workspace |
| `workspace_invitations` | pending count per workspace |
| `billing_webhook_events` | processed count / recent failure count (no payload bodies) |
| `sessions` | **active session count only** — no token hashes, no session payload |

**Exclude:** `password_hash`, `mfa_totp_secret_encrypted`, MFA backup codes, API token hashes, OIDC client secrets, encrypted settings values, `billing_customer_id` / `billing_subscription_id` in UI unless debugging billing (display `plan` + `billing_status` only in V1), raw webhook payloads, `ENCRYPTION_KEY` usage.

**No `ENCRYPTION_KEY` required** — admin never decrypts product secrets in V1.

**PII posture:** Email addresses are shown to authenticated operators behind CF Access — acceptable for internal ops; no bulk export of full account lists in V1 except optional CSV of aggregate metrics (not per-user export).

---

## 9. Statistics & dashboards

All metrics are derived from **Postgres read queries** and optional `admin.daily_snapshots` — no external API polling.

### 9.1 Live overview (home)

| Metric | Source |
|---|---|
| Total accounts / workspaces | `COUNT(*)` on `user_accounts`, `workspaces` |
| Signups last 7 / 30 days | `user_accounts.created_at` |
| Plan distribution | `GROUP BY workspaces.plan` |
| Paid vs free workspaces | `plan` + `billing_status` |
| Total bookmarks (active) | `bookmarks` where `plan_archived = false` |
| Plan-archived bookmarks | downgrade overflow indicator |
| MFA adoption rate | `mfa_state` on accounts |
| Email verification rate | `email_verified` on accounts |

### 9.2 Account directory

Sortable, paginated table:

- Email, name, created_at, verified, MFA state, workspace membership count
- Drill-down: list workspaces the account belongs to (role per workspace)
- **No** password reset, impersonation, or delete actions in V1

### 9.3 Workspace directory

Sortable, paginated table:

- Name, slug, plan, billing status, member count, bookmark count (active + archived), created_at
- Drill-down: member list (account email + role), bookmark cap utilization for Free workspaces (count / 50)

### 9.4 Usage & growth charts

Time-series from `admin.daily_snapshots`:

- New accounts / workspaces per day
- Plan mix over time (`workspaces_by_plan` JSON)
- Total bookmarks trend
- Active subscriptions trend

**Snapshot job:** In-process cron (default `0 2 * * *` UTC) computes prior-day rollup; upsert on `snapshot_date`.

### 9.5 Billing summary (read-only)

- Count workspaces by `plan` and `billing_status`
- Team workspaces: seat utilization (`member count` vs `plan_seats`)
- Link to Stripe Dashboard for payment detail (external) — no Stripe API writes from admin

### 9.6 Coexistence with P5-06 aggregate-stats endpoint

| Surface | Audience | Purpose |
|---|---|---|
| P5-06 on `packages/backend` | Automation / uptime monitors | Single JSON aggregate blob, shared-secret auth |
| Admin portal | Human operators | Directory, drill-down, charts, invite management |

Implementing the admin portal does **not** remove P5-06. Optionally, the portal may display the same aggregate numbers for consistency, fetched via internal query — not by calling the API endpoint with the shared secret from the browser.

---

## 10. Alerting (V1)

**Channel:** Sentry only — consistent with spec §18 / error-reporting interface posture.

| Signal | Mechanism |
|---|---|
| Snapshot job crash | `Sentry.captureException` in job handler |
| Admin API unhandled errors | Sentry middleware |
| Abnormal signup spike (optional) | `Sentry.captureMessage` level `warning` — configurable threshold vs 7-day baseline |

- New Phase key: `SENTRY_DSN_ADMIN` → runtime `SENTRY_DSN` on admin Fly app
- Thresholds env-configurable: `ADMIN_ALERT_SIGNUP_SPIKE_MULTIPLIER` (default `3`)
- Scrub secrets from events — same redaction rules as product (`03-security-baseline.mdc`)

**Not in V1:** Slack, email, PagerDuty to operators.

---

## 11. Environment variables

Follow `05-env-vars.mdc` when implementing. Admin-specific keys:

| Phase storage | Runtime (Fly) | Required | Notes |
|---|---|---|---|
| `DATABASE_URL` | `DATABASE_URL` | ✓ | Same Neon instance as API |
| `ADMIN_SESSION_SECRET` | `ADMIN_SESSION_SECRET` | ✓ | Min 32 chars — new Phase key |
| `SENTRY_DSN_ADMIN` | `SENTRY_DSN` | optional | New Sentry project |
| `NODE_ENV` | `NODE_ENV` | ✓ | |
| `ADMIN_SNAPSHOT_CRON` | same | optional | Default `0 2 * * *` |
| `ADMIN_BOOTSTRAP_EMAIL` | same | ✓ (first deploy only) | Required when `admin_users` is empty; optional afterward |
| `ADMIN_BOOTSTRAP_PASSWORD` | same | ✓ (first deploy only) | Required when `admin_users` is empty; optional afterward |
| `SMTP_HOST` | same | ✓ | Reuse hosted SMTP — invite emails |
| `SMTP_PORT` | same | ✓ | |
| `SMTP_USER` | same | ✓ | |
| `SMTP_PASS` | same | ✓ | |
| `SMTP_FROM` | same | ✓ | e.g. `noreply@slugbase.app` |
| `ADMIN_URL` | same | ✓ | `https://admin.slugbase.app` (staging: `https://staging-admin.slugbase.app`) — invite links |
| `ADMIN_ALERT_SIGNUP_SPIKE_MULTIPLIER` | same | optional | Default `3` |

**Not required for admin:** `SESSION_SECRET`, `ENCRYPTION_KEY`, `STRIPE_*`, OIDC client secrets, Turnstile keys, product `FRONTEND_ORIGIN`.

---

## 12. Scope — V1 acceptance criteria

### 12.1 `packages/db-admin`

- [ ] `admin` schema with `daily_snapshots`, `admin_users`, `admin_sessions`, `admin_invites`, `audit_events`
- [ ] Drizzle Kit migration generated and applied in hosted admin deploy pipeline
- [ ] Cross-schema read helpers for `public.*` (read-only, column allowlist per §8.5)

### 12.2 `packages/admin` service

- [ ] Hono JSON API + in-process scheduler in one process
- [ ] Vite + React + TypeScript SPA in `packages/admin/web` — dev proxy to Hono; production static build served by Hono
- [ ] `Dockerfile`, `fly.toml`, health endpoint
- [ ] Env validation schema (Zod, admin-specific fields)
- [ ] Platform auth: bootstrap, login, logout, invite accept, session middleware, role guards
- [ ] Invite flow: create/revoke/resend; SMTP email when configured

### 12.3 Background jobs

- [ ] Daily snapshot rollup → upsert `daily_snapshots`
- [ ] Monthly retention purge on snapshots older than 400 days
- [ ] Sentry reporting on job failures

### 12.4 Admin API + UI

- [ ] **Overview dashboard:** live totals + 7/30-day signup counts + plan distribution
- [ ] **Growth charts:** time-series from `daily_snapshots`
- [ ] **Account directory:** paginated list + workspace membership drill-down
- [ ] **Workspace directory:** paginated list + member list + bookmark cap meter for Free
- [ ] **Billing summary:** plan/status breakdown; external Stripe link placeholder
- [ ] **Admin user management:** invite list, create invite (`platform_admin` only)
- [ ] Loading skeletons and inline error retry — no blank screens
- [ ] English-only internal copy; SlugBase design tokens for visual consistency (optional parity with `packages/ui` tokens)

### 12.5 Hosted deploy

- [ ] Admin Fly app provisioned staging + production
- [ ] Phase keys registered and synced to Fly
- [ ] `deploy-admin` jobs in staging + production workflows
- [ ] `db-admin` migrate step before admin deploy
- [ ] Self-host GHCR image build **excludes** `packages/admin` and `packages/db-admin`

### 12.6 Product isolation verification

- [ ] No new routes under `packages/backend` for operator directory/list APIs
- [ ] No changes to product Drizzle schemas in `packages/backend/src/db/schema`
- [ ] CI assertion: self-host image Dockerfile does not `COPY` admin package

---

## 13. Work breakdown (for GitHub intake)

Use this section with the **github-intake** skill. Create one **Feature (epic)** parent plus child **Tasks**. Milestone: **Fast-Follow #1** (post–v1 launch). Priority/Effort below are intake defaults.

### 13.1 Epic

**Title:** `Feature: SlugBase Admin Portal (Hosted)`

**Milestone:** Fast-Follow #1

**Priority:** High | **Effort:** High (`effort:XL`)

**Goal:** Internal operators can **browse** account and workspace statistics and usage trends on hosted Cloud without direct database access, without touching self-hosted code paths or product schema.

**Product rules (epic-level):**

- Hosted-only — never in self-host GHCR image
- No operator routes in `packages/backend`; workspace `AdminModule` (SMTP/AI settings) is unrelated
- No changes to `packages/backend` product schema / `public` tables
- Platform roles (`viewer` / `operator` / `platform_admin`) are separate from workspace roles (`owner` / `admin` / `member`)
- V1 is read-only on all product entities
- CF Access on admin subdomain from day one; app auth still required
- Bootstrap once via env; all subsequent operators via invite + SMTP email
- P5-06 aggregate-stats endpoint remains for automation

### 13.2 Proposed child issues

| # | Proposed title | Domain | Priority | Effort | Depends on | Summary |
|---|---|---|---|---|---|---|
| 1 | `db-admin: admin schema and migrations` | `domain:infra` | High | M | — | `packages/db-admin`, tables §7.1–7.5, Drizzle Kit migrate script |
| 2 | `admin: Hono API scaffold, Vite React shell, and Fly assets` | `domain:infra` | High | M | 1 | `packages/admin` + `packages/admin/web`, Dockerfile, `fly.toml`, health, env schema |
| 3 | `admin: platform auth, bootstrap, and invites` | `domain:backend` | High | L | 1, 2 | Bootstrap env, login/sessions, invite CRUD, SMTP emails, role middleware |
| 4 | `admin: read-only product aggregate queries` | `domain:backend` | High | M | 1, 3 | Cross-schema helpers with column allowlist §8.5 |
| 5 | `admin: daily snapshot rollup job` | `domain:backend` | Medium | S | 1, 4 | In-process cron, upsert `daily_snapshots`, retention purge |
| 6 | `admin: overview and directory API` | `domain:backend` | High | M | 4, 5 | Overview, account list, workspace list, drill-down endpoints |
| 7 | `admin: React UI — dashboards and directories` | `domain:frontend` | High | L | 6 | Charts, tables, drill-down, admin user management UI |
| 8 | `admin: hosted deploy pipeline and Phase wiring` | `domain:infra` | High | M | 2 | Fly provision, deploy jobs, migrate step, self-host exclusion check |

**Effort column:** t-shirt label (`S`/`M`/`L`) — map to org Effort field at intake.

### 13.3 Suggested implementation order

```
1 (db-admin) ──┬──► 2 (scaffold) ──► 3 (auth) ──► 4 (read queries) ──┬──► 6 (API) ──► 7 (UI)
               │                              └──► 5 (snapshots) ─────┘
               └──► 8 (deploy) — wire after scaffold; staging smoke before UI complete
```

**Parallel lanes after approval:**

- Lane A: `1 → 2 → 3 → 4 → 6 → 7` (auth + UI path)
- Lane B: `5` after `4` (rollup job)
- Lane C: `8` after `2` (infra in parallel with 3–7)

### 13.4 Per-issue spec refs (for intake AC)

| Issue | Admin PRD sections | MVP spec refs |
|---|---|---|
| 1 | §7 | §16 (data model), §19 (Drizzle) |
| 2 | §5.1, §6 | §14.7, §19 |
| 3 | §8 | §5.4 (argon2id), §10.2 |
| 4 | §8.5, §9 | §16 |
| 5 | §7.1, §9.4, §10 | §22.10 (in-process jobs) |
| 6 | §9.1–9.5, §12.4 | §12 (plans), §10.2 |
| 7 | §12.4 | §23 (tokens, optional) |
| 8 | §6.1, §11, §12.5–12.6 | §14.7, §22 |

### 13.5 Tests (epic-level expectations)

| Area | Tests |
|---|---|
| `packages/db-admin` | Unit: schema exports; integration: migrate against ephemeral Postgres |
| Read-only queries | Integration: allowlist enforced; no password/token columns in results |
| Snapshot job | Unit: rollup math; integration: upsert idempotency on `snapshot_date` |
| Auth | Integration: login, session expiry, role 403, invite accept, bootstrap once |
| Directory API | Integration: pagination, drill-down joins, no secret leakage |
| Admin UI | Component tests for tables/charts; manual smoke on staging |
| Deploy | CI check: self-host Dockerfile excludes admin package |

**E2e:** Not required for V1 — internal tool; manual smoke on staging after deploy.

---

## 14. Resolved decisions

| # | Topic | Decision |
|---|---|---|
| D1 | Milestone | **Fast-Follow #1** — after v1 launch; replaces direct DB ops for hosted |
| D2 | Edge access | **Cloudflare Access** on admin subdomain from day one **plus** app session auth |
| D3 | Operator onboarding | **Env bootstrap** for first `platform_admin` when `admin_users` is empty; **invite-only** thereafter; invite emails via **hosted SMTP** (`SMTP_*`) |
| D4 | Admin UI | **Vite + React + TypeScript** SPA in `packages/admin/web` — Hono serves API + static build on Fly |
| D5 | Product mutations | **None in V1** — read-only on `public.*`; audit log covers platform-admin actions only |
| D6 | Historical metrics | **`admin.daily_snapshots`** nightly rollup — no Redis/external queue |
| D7 | Framework | **Hono** for admin service (standalone, not NestJS) — keeps customer API surface isolated |
| D8 | P5-06 | **Retained** — machine-readable aggregate endpoint stays on API for monitors |
| D9 | Priority / Effort | Epic **High / XL**; per-issue effort in §13.2 |

### 14.1 Operator actions (out of scope for agents)

- Configure Cloudflare Access policy for `admin.slugbase.app` / `staging-admin.slugbase.app`
- Set `ADMIN_BOOTSTRAP_*` in Phase before first deploy; remove when convenient (recommended hygiene, not a boot requirement)
- Add `ADMIN_URL`, `ADMIN_SESSION_SECRET`, `SENTRY_DSN_ADMIN` to Phase staging/production
- Create Sentry project for admin service

---

## 15. Risks

| Risk | Mitigation |
|---|---|
| Cross-schema queries slow at scale | `daily_snapshots` for charts; paginated directory APIs; indexes on product tables already exist |
| Accidental product schema coupling | `packages/db-admin` only; read helpers use explicit column allowlist; CI grep guard |
| Operator confuses workspace `admin` role with `platform_admin` | Distinct naming; UI subtitle "Platform operator — not workspace admin" |
| Self-host image accidentally includes admin | Separate Dockerfile; CI `COPY` guard in §12.6 |
| PII exposure via directory | CF Access + platform auth; no public routes; no per-user CSV export in V1 |
| Snapshot job misses a day | Upsert allows backfill run; chart shows gap if `computed_at` stale |
| SMTP misconfigured blocks invites | Bootstrap env creates first admin; document manual SQL fallback for emergencies only |

---

## 16. Future (V2+)

- Operator actions on product data (support-mediated account recovery triggers, read-only impersonation) — each requires spec amendment
- Slack/email notification channel for ops alerts
- Stripe API read integration (subscription detail in-app, still no writes)
- Materialized views if directory queries exceed comfortable latency
- MFA for platform operators (TOTP on `admin_users`)
- Per-workspace audit log viewer (read-only cross-schema) for support — entitlement-sensitive
