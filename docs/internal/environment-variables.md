# Environment variables

Complete reference for every configuration key SlugBase reads from the environment. Values are managed in **Phase** (app `SlugBase`) for operator editing; Phase automatically syncs to **GitHub Actions environments** (`ci`, `staging`, `production`) for CI and deploy. Deploy pipelines push GHA secrets to Fly.io and Cloudflare Workers via `sync-secrets.sh`. See [`.env.example`](../.env.example) for the machine-readable key list (names only, no values).

Product model: [slugbase-mvp-spec.md §15](slugbase-mvp-spec.md). Backend validation: [`packages/backend/src/config/env.schema.ts`](../packages/backend/src/config/env.schema.ts).

---

## At a glance

### Phase app and GHA environments

| Field | Value |
|---|---|
| Tool | **Phase** — operator secrets UI |
| App | `SlugBase` (see [`.phase.json`](../.phase.json)) |
| Phase environments | `Development` · `Staging` · `Production` |
| GHA environments | `ci` · `staging` · `production` |

**Phase ↔ GHA mapping**

| Phase environment | GHA environment | Purpose |
|---|---|---|
| `Development` | _(local only — `phase run`)_ | Local development |
| `Staging` | `staging` | Staging deploy + Fly/Workers runtime |
| `Production` | `production` | Production deploy + Fly/Workers runtime |
| _(CI-only keys in Phase)_ | `ci` | CI-only persistent secrets (ReportPortal, etc.) |

Phase syncs operator edits to GHA automatically. CI jobs and deploy workflows read `${{ secrets.* }}` from the matching GHA environment. Deploy calls `sync-secrets.sh` to push secrets to Fly.io and Cloudflare Workers.

**Local dev**

```bash
phase run -- pnpm dev   # injects Phase Development env — full setup in #475
```

**CI** uses the GHA `ci` environment for CI-only keys (e.g. ReportPortal). Deploy uses `staging` or `production` GHA environments. No Phase CLI in workflows.

### Table legend

Every inventory table uses the same columns:

| Column | Meaning |
|---|---|
| **Cloud** | Needed on managed Fly.io + Cloudflare Workers deployment |
| **CE** | Needed on combined GHCR Docker image |
| **Required** | `Always` · `Cloud` · `Optional` · `Dev only` · `CI only` |
| **Secret** | `Yes` = never commit or log; `No` = safe in client bundles |
| **When set** | `Runtime` (process env at start) · `Build` (Vite/Astro bake-in) · `Both` · `CI` |

> **Build-time warning:** Keys prefixed `VITE_` (web app) or `PUBLIC_` (marketing site) are **inlined into client bundles at build time**. Never put true secrets there — session keys, API secrets, SMTP passwords, Stripe keys, etc. belong in unprefixed runtime keys only.

### Edition selector

| Key | What it does | Cloud | CE | Required | Secret | When set | Example value |
|---|---|---|---|---|---|---|---|
| `SLUGBASE_EDITION` | Edition selector — `ce` (Community Edition combined image) or `cloud` (managed split deploy). Drives edition-specific defaults (#479–#483); supersedes deprecated `SLUGBASE_MODE`. **Cloud staging/production:** set `cloud` in Phase → GHA (`sync-secrets` pushes to Fly API). **CE GHCR/self-host:** baked as `ce` in the combined image Dockerfile. | Yes | Yes | Yes (production); defaults to `ce` in non-production when unset | No | Runtime / Build | `cloud` or `ce` |

> **Preset wiring:** Backend startup applies edition presets before Zod validation. Explicit env values override unset preset keys; values that conflict with the active edition preset are rejected in production and warned in development/test.



---

## Quick start — Cloud

Minimum keys to boot a **managed** deployment (API on Fly.io, web on Cloudflare Workers, marketing on Cloudflare Workers). See [full inventory](#full-inventory) for optional interfaces.

```bash
# Generate secrets once (example — store in Phase, not in shell history)
openssl rand -hex 32   # → SESSION_SECRET
openssl rand -hex 32   # → ENCRYPTION_KEY

# Set in Phase Staging / Production (operator UI or Phase CLI — see #475)
# Keys sync automatically to the matching GHA environment, then to Fly/Workers on deploy.
# Example keys:
SESSION_SECRET=<64-char hex>
ENCRYPTION_KEY=<64-char hex>
DATABASE_URL=postgresql://…
APP_BASE_URL=https://api.example.com
FRONTEND_ORIGIN=https://app.example.com
API_BASE_URL=https://api.example.com
VITE_API_URL=https://api.example.com
PUBLIC_REGISTRATION=true
EMAIL_VERIFICATION_REQUIRED=true
VITE_BILLING_ENABLED=true
# + Stripe, Turnstile, deploy tokens — see Cloud tables below
```

### URL wiring (Cloud)

Three public surfaces must agree on origins:

| Surface | Key | Example (staging) |
|---|---|---|
| Fly.io API | `APP_BASE_URL` | `https://staging-api.slugbase.app` |
| Cloudflare Web Worker | `FRONTEND_ORIGIN` | `https://staging-cloud.slugbase.app` |
| Web Worker SSR (server loaders) | `API_BASE_URL` | `https://staging-api.slugbase.app` |
| Web client build | `VITE_API_URL` | `https://staging-api.slugbase.app` |
| Marketing site CTAs | `PUBLIC_FRONTEND_ORIGIN` | `https://staging-cloud.slugbase.app` |
| Marketing deploy smoke | `MARKETING_ORIGIN` | `https://staging.slugbase.app` |
| Marketing contact form | `PUBLIC_CONTACT_ENDPOINT` | `https://staging-api.slugbase.app/contact` |

Typical Cloud flags: `PUBLIC_REGISTRATION=true`, `EMAIL_VERIFICATION_REQUIRED=true`, `VITE_BILLING_ENABLED=true`, `VITE_MAIL_ADMIN_UI=false`, `VITE_OIDC_ADMIN_UI=false`, `VITE_AI_BYO_CREDENTIAL=false`.

---

## Quick start — CE

Minimum keys for the **combined GHCR image** (API + bundled web on one port). Marketing site is not included in the image.

```bash
# Runtime env (docker compose env_file or -e flags)
SESSION_SECRET=<64-char hex>          # openssl rand -hex 32
ENCRYPTION_KEY=<64-char hex>
DATABASE_URL=postgresql://slugbase:slugbase@postgres:5432/slugbase
APP_BASE_URL=https://bookmarks.example.com
FRONTEND_ORIGIN=https://bookmarks.example.com   # same origin (combined image)
PUBLIC_REGISTRATION=false                       # invite-only default
EMAIL_VERIFICATION_REQUIRED=false               # configurable
# SERVE_WEB_CLIENT=true and WEB_CLIENT_SERVER_BUILD are preset in the Dockerfile

# Image build — hardcoded CE VITE_* (see scripts/CE-vite-build-args.sh)
VITE_BILLING_ENABLED=false
VITE_MAIL_ADMIN_UI=true
VITE_OIDC_ADMIN_UI=true
VITE_AI_BYO_CREDENTIAL=true
# Do not bake VITE_APP_BASE_URL, VITE_UMAMI_*, or VITE_SENTRY_* — set APP_BASE_URL at runtime
# Leave Stripe, Turnstile, Umami, Sentry empty for no-op interfaces
```

Example `docker run` (illustrative — use secrets from your vault, not inline):

```bash
docker run -d \
  --env-file /path/to/slugbase.env \
  -p 3000:3000 \
  ghcr.io/<owner>/slugbase:latest
```

CI GHCR builds do **not** read Phase or GHA runtime secrets. They pass hardcoded CE `VITE_*` values from [`scripts/CE-vite-build-args.sh`](../scripts/CE-vite-build-args.sh) via [`.github/scripts/build-push-ghcr.sh`](../.github/scripts/build-push-ghcr.sh). **`VITE_SENTRY_*`**, **`VITE_UMAMI_*`**, **`VITE_APP_BASE_URL`**, and deprecated pricing keys are never passed — Cloud telemetry and URLs must not be baked into the CE client bundle.

### URL wiring (CE)

| Key | Example |
|---|---|
| `APP_BASE_URL` | `https://bookmarks.example.com` |
| `FRONTEND_ORIGIN` | `https://bookmarks.example.com` |

---

## How keys are consumed

```mermaid
flowchart LR
  subgraph phase [Phase SlugBase app]
    keys[All keys]
  end
  subgraph gha [GHA environments]
    ciEnv[ci]
    stgEnv[staging]
    prodEnv[production]
  end
  subgraph cloud [Cloud runtime]
    fly[Fly.io API]
    webWorker[CF Web Worker]
    mktWorker[CF Marketing Worker]
  end
  subgraph ce [CE]
    dockerBuild[Docker VITE build-args]
    container[Combined container runtime]
  end
  keys -->|auto sync| gha
  ciEnv -->|CI jobs| ciRunner[CI runners]
  stgEnv -->|sync-secrets.sh| cloud
  prodEnv -->|sync-secrets.sh| cloud
  keys -.->|phase run local only| localDev[Local dev]
  dockerBuild --> container
```

| When set | Where | Examples |
|---|---|---|
| **Runtime** | Fly.io API process, CE container, Worker SSR (`process.env`) | `SESSION_SECRET`, `DATABASE_URL`, `STRIPE_SECRET_KEY` |
| **Build** | `pnpm build` for web/marketing; Docker `ARG VITE_*` | `VITE_BILLING_ENABLED`, `PUBLIC_PLAN_PRICE_PERSONAL_MONTHLY` |
| **Both** | Build + SSR fallback | `API_BASE_URL` (runtime Worker), `VITE_API_URL` (SSR fallback only) |
| **CI** | GitHub Actions runner only; never shipped to production runtime | `FLY_API_TOKEN`, `CLOUDFLARE_API_TOKEN`, `SENTRY_AUTH_TOKEN`, `REPORTPORTAL_*` |

---

## Full inventory

### 1. Required secrets and URLs

Every deployment must set these. The API refuses to start in production without valid values ([`env.schema.ts`](../packages/backend/src/config/env.schema.ts)).

| Key | What it does | Cloud | CE | Required | Secret | When set | Example value |
|---|---|---|---|---|---|---|---|
| `SESSION_SECRET` | Signs and verifies server-side session cookies | Yes | Yes | Always | Yes | Runtime | `<openssl rand -hex 32>` (min 32 chars) |
| `ENCRYPTION_KEY` | Encrypts at-rest sensitive values (SMTP, OIDC, MFA secrets) | Yes | Yes | Always | Yes | Runtime | `<openssl rand -hex 32>` (min 32 chars) |
| `DATABASE_URL` | PostgreSQL connection (pooled URL for runtime) | Yes | Yes | Always | Yes | Runtime | `postgresql://user:pass@host:5432/slugbase` |
| `DATABASE_URL_UNPOOLED` | Direct DB URL for migrations / drizzle-kit | Yes | Optional | Optional | Yes | Runtime | Neon direct URL; falls back to `DATABASE_URL` |
| `APP_BASE_URL` | Public HTTPS base URL of the API (links, OIDC callbacks, CORS) | Yes | Yes | Always | No | Runtime | `https://api.example.com` |
| `FRONTEND_ORIGIN` | Public web app origin (CORS allowlist) | Yes | Yes | Always | No | Runtime | `https://app.example.com` |
| `API_BASE_URL` | API origin for Worker SSR loaders, actions, and proxy upstream | Yes | Optional | Cloud | No | Runtime (Worker) | Same as `APP_BASE_URL` on Cloud |
| `VITE_API_URL` | Build-time fallback when `API_BASE_URL` unset at SSR; **not** used for browser `fetch` | Yes | Optional | Cloud | No | Build | Same as `APP_BASE_URL` on Cloud |

**Client API routing (web):** Browser `fetch` always uses same-origin Worker proxy routes (`/auth/*`, `/api/*`, …). SSR loaders and proxy handlers call the NestJS API via `API_BASE_URL` (see `packages/web/app/lib/client-api-path.ts` and `client-api-fetch.ts`). Never read `VITE_API_URL` in UI modules for cross-origin browser requests — session cookies are `SameSite=Lax` on the web origin.
| `MARKETING_ORIGIN` | Public marketing site URL (CI smoke only) | Yes | No | Cloud | No | CI | `https://www.example.com` |

---

### 2. Deployment flags

Control registration, email verification, and how the web UI is served.

| Key | What it does | Cloud | CE | Required | Secret | When set | Example value |
|---|---|---|---|---|---|---|---|
| `PUBLIC_REGISTRATION` | Allow open signup (`POST /auth/register`) | Yes | Yes | Optional | No | Runtime | Cloud: `true`; CE: `false` |
| `EMAIL_VERIFICATION_REQUIRED` | Block login until email verified | Yes | Yes | Optional | No | Runtime | Cloud: `true`; CE: `false` |
| `SERVE_WEB_CLIENT` | Serves bundled RR7 web on same port; **also controls migration dispatch** — `bootstrap()` runs DB migrations only when `true` (CE). Cloud deployments run migrations in CI via the `migrate-staging` / `migrate-production` workflow jobs (non-zero exit blocks deploy). | No | Yes | Optional | No | Runtime | CE image: `true` (preset in Dockerfile) |
| `WEB_CLIENT_SERVER_BUILD` | Path to RR7 server build entry | No | Yes | Optional | No | Runtime | `/app/packages/web/build/server/index.js` |
| `OPENAPI_INTERACTIVE_DOCS` | Scalar UI at `GET /docs` | Yes | Yes | Optional | No | Runtime | `true` (default) |
| `CHALLENGE_DEV_SKIP` | Skip Turnstile verification in non-production | Yes | Yes | Optional | No | Runtime | Unset in prod; `true` in local dev |
| `PORT` | HTTP listen port | Yes | Yes | Optional | No | Runtime | `3000` (default) |
| `NODE_ENV` | Node environment | Yes | Yes | Optional | No | Runtime | Set by platform/image (`production`) |

---

### 3. Shared optional — SMTP, AI, sessions, rate limits

Optional on both deployment shapes. Empty values activate **no-op** interface implementations.

| Key | What it does | Cloud | CE | Required | Secret | When set | Example value |
|---|---|---|---|---|---|---|---|
| `SMTP_HOST` | SMTP server hostname | Optional | Optional | Optional | No | Runtime | `smtp.example.com` |
| `SMTP_PORT` | SMTP port | Optional | Optional | Optional | No | Runtime | `587` (default) |
| `SMTP_SECURE` | Use TLS (`true`/`false`) | Optional | Optional | Optional | No | Runtime | `false` |
| `SMTP_USER` | SMTP auth username | Optional | Optional | Optional | Yes | Runtime | `mailer@example.com` |
| `SMTP_PASS` | SMTP auth password | Optional | Optional | Optional | Yes | Runtime | `<app password>` |
| `SMTP_FROM` | From address for transactional mail | Optional | Optional | Optional | No | Runtime | `SlugBase <noreply@example.com>` |
| `OPENAI_API_KEY` | Deployment-level OpenAI credential | Optional | Optional | Optional | Yes | Runtime | `<OpenAI API key>` |
| `OPENAI_MODEL` | Chat model for AI suggestions | Optional | Optional | Optional | No | Runtime | `gpt-4o-mini` (default) |
| `SESSION_TTL_DAYS` | Session sliding-window TTL (days) | Optional | Optional | Optional | No | Runtime | `30` (default) |
| `SESSION_REMEMBER_TTL_DAYS` | Extended TTL when remember-me checked | Optional | Optional | Optional | No | Runtime | `90` (default) |
| `MFA_TOTP_ISSUER` | Authenticator app issuer label | Optional | Optional | Optional | No | Runtime | `SlugBase` (default) |
| `RATE_LIMIT_LOGIN_MAX` | Max login/register/MFA attempts per IP window | Optional | Optional | Optional | No | Runtime | `10` (default) |
| `RATE_LIMIT_LOGIN_TTL_SECONDS` | Login rate-limit window (seconds) | Optional | Optional | Optional | No | Runtime | `900` (default) |
| `RATE_LIMIT_TOKEN_CREATION_MAX` | Max API token creations per user window | Optional | Optional | Optional | No | Runtime | `20` (default) |
| `RATE_LIMIT_TOKEN_CREATION_TTL_SECONDS` | Token-creation window (seconds) | Optional | Optional | Optional | No | Runtime | `3600` (default) |
| `RATE_LIMIT_EMAIL_VERIFICATION_MAX` | Max verification emails per user window | Optional | Optional | Optional | No | Runtime | `3` (default) |
| `RATE_LIMIT_EMAIL_VERIFICATION_TTL_SECONDS` | Verification-email window (seconds) | Optional | Optional | Optional | No | Runtime | `3600` (default) |

> ****CE note:** SMTP, OIDC, and AI credentials are usually configured via **workspace settings in the UI** (encrypted in DB). Deployment-level `SMTP_*` / `OPENAI_*` are optional fallbacks for operator-managed transport.

---

### 4. Cloud — Stripe and billing (API runtime)

Required for paid entitlements on Cloud. Leave empty on CE (no-op billing grants full entitlements).

| Key | What it does | Cloud | CE | Required | Secret | When set | Example value |
|---|---|---|---|---|---|---|---|
| `STRIPE_SECRET_KEY` | Stripe API secret key | Yes | No | Cloud | Yes | Runtime | `sk_live_…` |
| `STRIPE_WEBHOOK_SECRET` | Webhook signing secret | Yes | No | Cloud | Yes | Runtime | `whsec_…` |
| `STRIPE_PRICE_PERSONAL_MONTHLY` | Stripe price id for Personal plan (monthly) | Yes | No | Cloud | No | Runtime | `price_…` |
| `STRIPE_PRICE_PERSONAL_ANNUAL` | Stripe price id for Personal plan (annual) | Yes | No | Cloud | No | Runtime | `price_…` |
| `STRIPE_PRICE_TEAM_MONTHLY` | Stripe price id for Team plan (monthly) | Yes | No | Cloud | No | Runtime | `price_…` |
| `STRIPE_PRICE_TEAM_ANNUAL` | Stripe price id for Team plan (annual) | Yes | No | Cloud | No | Runtime | `price_…` |
| `STRIPE_PRICE_SUPPORTER` | Stripe price id for one-time supporter purchase | Yes | No | Optional | No | Runtime | `price_…` |
| `SUPPORTER_PROMOTION_END` | ISO-8601 end of supporter offer | Yes | No | Optional | No | Runtime | `2026-12-31T23:59:59Z` |
| `DOWNGRADE_GRACE_PERIOD_DAYS` | Days after period end before overflow archive | Yes | Optional | Optional | No | Runtime | `7` (default) |
| `TURNSTILE_SECRET_KEY` | Turnstile server secret (API + contact) | Yes | No | Optional | Yes | Runtime | `<Turnstile secret>` |
| `OIDC_DEPLOYMENT_PROVIDERS` | JSON array of Cloud OIDC IdP configs (id, name, issuerUrl, clientId, clientSecret, scopes, enabled) | Yes | No | Optional | Yes | Runtime | `[{"id":"google","name":"Google","issuerUrl":"https://accounts.google.com","clientId":"…","clientSecret":"…"}]` |

> ****CE note:** Leave `OIDC_DEPLOYMENT_PROVIDERS` unset so federated providers are configured in workspace settings (DB-sourced). When set (including `[]`), the deployment-config source is active and DB providers are ignored for login.

---

### 5. Cloud — Web client (`VITE_*`)

Baked in at **`pnpm --filter @slugbase/web build`**. Public display config only — never secrets.

| Key | What it does | Cloud | CE | Required | Secret | When set | Example value |
|---|---|---|---|---|---|---|---|
| `VITE_BILLING_ENABLED` | Show billing settings and plan gates | Yes | Build only | Cloud | No | Build | Cloud: `true`; CE: `false` |
| ~~`VITE_PLAN_PRICE_PERSONAL_MONTHLY`~~ | **DEPRECATED** — prices fetched from `GET /pricing/public` | — | — | — | — | — | — |
| ~~`VITE_PLAN_PRICE_PERSONAL_YEARLY`~~ | **DEPRECATED** — prices fetched from `GET /pricing/public` | — | — | — | — | — | — |
| ~~`VITE_PLAN_PRICE_TEAM_SEAT`~~ | **DEPRECATED** — prices fetched from `GET /pricing/public` | — | — | — | — | — | — |
| ~~`VITE_PLAN_PRICE_SUPPORTER`~~ | **DEPRECATED** — prices fetched from `GET /pricing/public` | — | — | — | — | — | — |
| `VITE_SUPPORTER_PROMOTION_END` | Supporter deadline (display/countdown) | Yes | No | Optional | No | Build | `2026-12-31T23:59:59Z` |
| `VITE_TEAM_BASE_SEATS` | Team seats shown in plan table | Yes | No | Optional | No | Build | `5` |
| `VITE_FREE_BOOKMARK_CAP` | Free cap shown in billing meter | Yes | No | Optional | No | Build | `50` |
| `VITE_MAIL_ADMIN_UI` | Show workspace SMTP admin panel | Yes | Build only | Optional | No | Build | Cloud: `false`; CE: `true` |
| `VITE_OIDC_ADMIN_UI` | Show workspace OIDC admin panel | Yes | Build only | Optional | No | Build | Cloud: `false`; CE: `true` |
| `VITE_AI_BYO_CREDENTIAL` | Show full AI credential form (BYO key) | Yes | Build only | Optional | No | Build | Cloud: `false`; CE: `true` |
| `VITE_APP_BASE_URL` | API URL shown in OIDC callback settings | Yes | Build only | Optional | No | Build | `https://api.example.com` |
| `VITE_MARKETING_ORIGIN` | Marketing site origin for absolute legal-page links in the web app; unset hides links (CE) | Yes | Build only | Optional | No | Build | `https://www.example.com` |

---

### 6. Cloud — Marketing site (`PUBLIC_*`)

Baked in at **`pnpm --filter @slugbase/marketing build`**. Not used by the CE combined image unless you deploy marketing separately.

| Key | What it does | Cloud | CE | Required | Secret | When set | Example value |
|---|---|---|---|---|---|---|---|
| `PUBLIC_FRONTEND_ORIGIN` | App URL for sign-in / register CTAs | Yes | No | Cloud | No | Build | `https://app.example.com` |
| `PUBLIC_FORWARDING_DOMAIN` | Forwarding domain shown in demo copy | Yes | No | Optional | No | Build | `go.example.com` |
| `PUBLIC_API_BASE_URL` | API base URL for fetching prices from `GET /pricing/public` | Yes | No | Cloud | No | Build | `https://api.example.com` |
| `PUBLIC_CONTACT_ENDPOINT` | `POST` target for contact form | Yes | No | Cloud | No | Build | `https://api.example.com/contact` |
| `PUBLIC_TURNSTILE_SITE_KEY` | Turnstile site key (contact form) | Yes | No | Optional | No | Build | `<Turnstile site key>` |
| ~~`PUBLIC_PLAN_PRICE_PERSONAL_MONTHLY`~~ | **DEPRECATED** — prices fetched from `GET /pricing/public` (fallback when `PUBLIC_API_BASE_URL` unset) | — | — | — | — | — | — |
| ~~`PUBLIC_PLAN_PRICE_PERSONAL_YEARLY`~~ | **DEPRECATED** — prices fetched from `GET /pricing/public` | — | — | — | — | — | — |
| ~~`PUBLIC_PLAN_PRICE_TEAM_SEAT`~~ | **DEPRECATED** — prices fetched from `GET /pricing/public` | — | — | — | — | — | — |
| ~~`PUBLIC_PLAN_PRICE_TEAM_SEAT_YEARLY`~~ | **DEPRECATED** — prices fetched from `GET /pricing/public` | — | — | — | — | — | — |
| ~~`PUBLIC_PLAN_PRICE_SUPPORTER`~~ | **DEPRECATED** — prices fetched from `GET /pricing/public` | — | — | — | — | — | — |
| `PUBLIC_SUPPORTER_PROMOTION_END` | Supporter deadline on marketing site | Yes | No | Optional | No | Build | `2026-12-31T23:59:59Z` |
| `PUBLIC_TEAM_BASE_SEATS` | Team seats on pricing page | Yes | No | Optional | No | Build | `5` |
| `PUBLIC_FREE_BOOKMARK_CAP` | Free cap on pricing page | Yes | No | Optional | No | Build | `50` |

---

### 7. Analytics and error reporting

Optional on both shapes. Empty = no-op (no tracker, no Sentry init).

| Key | What it does | Cloud | CE | Required | Secret | When set | Example value |
|---|---|---|---|---|---|---|---|
| `UMAMI_HOST` | Umami base URL (server-side events) | Optional | No | Optional | No | Runtime | `https://analytics.example.com` |
| `UMAMI_WEBSITE_ID` | Umami website UUID (API) | Optional | No | Optional | No | Runtime | `<uuid>` |
| `VITE_UMAMI_HOST` | Umami script host (web client) | Optional | No | Optional | No | Build | `https://analytics.example.com` |
| `VITE_UMAMI_WEBSITE_ID` | Umami website UUID (web client) | Optional | No | Optional | No | Build | `<uuid>` |
| `VITE_UMAMI_ALLOWED_ORIGINS` | Extra HTTPS origins allowed for web Umami script (SEC-027) | Optional | No | Optional | No | Build | `https://analytics.example.com` |
| `PUBLIC_UMAMI_HOST` | Umami script host (marketing) | Optional | No | Optional | No | Build | `https://analytics.example.com` |
| `PUBLIC_UMAMI_WEBSITE_ID` | Umami website UUID (marketing) | Optional | No | Optional | No | Build | `<uuid>` |
| `PUBLIC_UMAMI_ALLOWED_ORIGINS` | Extra HTTPS origins allowed for marketing Umami script (SEC-027) | Optional | No | Optional | No | Build | `https://analytics.example.com` |
| `SENTRY_DSN` | Sentry ingest DSN (API) | Optional | No | Optional | Yes | Runtime | `https://…@sentry.io/…` |
| `SENTRY_ENVIRONMENT` | Sentry environment tag override | Optional | No | Optional | No | Runtime | `staging` |
| `SENTRY_RELEASE` | Sentry release / deploy version | Optional | No | Optional | No | Runtime | `slugbase@1.2.3` |
| `SENTRY_TRACES_SAMPLE_RATE` | Sentry trace transaction sample rate (0.0–1.0) | Optional | No | Optional | No | Runtime | `0.1` |
| `SENTRY_PROFILING_SAMPLE_RATE` | Sentry profiling session sample rate (0.0–1.0) | Optional | No | Optional | No | Runtime | `0.1` |
| `SENTRY_LOG_LEVEL` | Sentry SDK log level filter | Optional | No | Optional | No | Runtime | `info` |
| `SENTRY_ENABLE_CONSOLE_LOGGING` | Capture console.log/warn/error as Sentry logs | Optional | No | Optional | No | Runtime | `true` |
| `SENTRY_REPLAY_SAMPLE_RATE` | Server-side Sentry replay sample rate (0.0–1.0) | Optional | No | Optional | No | Runtime | `0.25` |
| `VITE_SENTRY_TRACES_SAMPLE_RATE` | Web client Sentry traces sample rate (0.0–1.0) | Optional | No | Optional | No | Build | `0.1` |
| `VITE_SENTRY_REPLAY_SAMPLE_RATE` | Web client Sentry replay sample rate (0.0–1.0) | Optional | No | Optional | No | Build | `0.25` |
| `VITE_SENTRY_DSN` | Public Sentry DSN (web client) | Optional | No | Optional | No | Build | `https://…@sentry.io/…` |
| `VITE_SENTRY_ENVIRONMENT` | Sentry environment tag for web client (staging / production) — set by CI; falls back to `MODE` | Optional | Build only | Optional | No | Build | `staging` |
| `VITE_SENTRY_RELEASE` | Sentry release tag for web client — set by CI from root `package.json` version | Optional | Build only | Optional | No | Build | `slugbase@0.1.0` |
| `SENTRY_AUTH_TOKEN` | Auth token for source map upload | CI only | CI only | CI only | Yes | CI | `<Sentry auth token>` |
| `SENTRY_ORG` | Sentry org slug (source maps) | CI only | CI only | CI only | No | CI | `my-org` |
| `SENTRY_PROJECT` | Sentry project slug (source maps) | CI only | CI only | CI only | No | CI | `slugbase-web` |

---

### 8. Cloud — CI and deploy

Stored in Phase `Staging` / `Production` (synced to GHA `staging` / `production`). Injected into GitHub Actions deploy jobs and pushed to Fly/Workers via `sync-secrets.sh` — never client bundles unless explicitly listed above.

| Key | What it does | Cloud | CE | Required | Secret | When set | Example value |
|---|---|---|---|---|---|---|---|
| `FLY_API_TOKEN` | Fly.io deploy token for `flyctl deploy` | Yes | No | CI only | Yes | CI | `<Fly deploy token>` |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token for `wrangler deploy` | Yes | No | CI only | Yes | CI | `<CF API token>` |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account id | Yes | No | CI only | No | CI | `<32-char hex id>` |
| `CF_ACCESS_CLIENT_ID` | Cloudflare Access service token id (staging smoke) | Yes | No | CI only | Yes | CI | `<service token id>` |
| `CF_ACCESS_CLIENT_SECRET` | Cloudflare Access service token secret | Yes | No | CI only | Yes | CI | `<service token secret>` |

---

### 9. CE — runtime and image build

**Do not bake Cloud telemetry at image build time.** CE operators and CI must never pass `VITE_SENTRY_*` (or other Cloud-only telemetry keys) as Docker `--build-arg` values. GHCR CI and local/e2e builds share the same hardcoded CE flags in [`scripts/CE-vite-build-args.sh`](../scripts/CE-vite-build-args.sh). Runtime `SENTRY_DSN` on the API container is optional and separate from client build-time keys — leave both empty for a fully no-op error-reporting install (spec §11.7).

| Key | What it does | Cloud | CE | Required | Secret | When set | Example value |
|---|---|---|---|---|---|---|---|
| `SERVE_WEB_CLIENT` | Serve web from API container; controls migration dispatch (true = startup migrations) | No | Yes | Optional | No | Runtime | `true` (Dockerfile preset) |
| `WEB_CLIENT_SERVER_BUILD` | RR7 server entry path | No | Yes | Optional | No | Runtime | `/app/packages/web/build/server/index.js` |
| `VITE_BILLING_ENABLED` | Hide billing UI | No | Build only | Optional | No | Build | `false` |
| `VITE_MAIL_ADMIN_UI` | Show SMTP workspace panel | No | Build only | Optional | No | Build | `true` |
| `VITE_OIDC_ADMIN_UI` | Show OIDC workspace panel | No | Build only | Optional | No | Build | `true` |
| `VITE_AI_BYO_CREDENTIAL` | Show BYO AI credential form | No | Build only | Optional | No | Build | `true` |
| `VITE_APP_BASE_URL` | Public URL for OIDC display | No | Build only | Optional | No | Build | `https://bookmarks.example.com` |
| `VITE_SENTRY_DSN` | Client error reporting — **must remain unset at CE image build** | No | No (build) | No | No | Build | Empty (default; do not bake) |
| `VITE_UMAMI_HOST` | Client analytics | No | Optional | Optional | No | Build | Empty (default) |
| `VITE_UMAMI_WEBSITE_ID` | Client analytics site id | No | Optional | Optional | No | Build | Empty (default) |

All other `VITE_*` pricing keys: deprecated — prices now fetched from `GET /pricing/public` when `API_BASE_URL` is configured. Legacy env vars are still accepted as fallback on CE when the API is unreachable.

---

### 10. Test reporting — ReportPortal

SlugBase publishes unit, integration, and e2e test results to a self-hosted **ReportPortal** instance. Keys are **CI-only** — stored in Phase (synced to GHA `ci` environment), injected on GitHub Actions runners. Vitest and Playwright reporters no-op when `REPORTPORTAL_*` is unset (local dev default).

**Canonical CI target**

| Setting | Value |
|---|---|
| Instance URL | `https://reportportal.mdg-labs.dev` |
| API endpoint | `https://reportportal.mdg-labs.dev/api/v2` (derived by agents — do not put `/api/v2` in `REPORTPORTAL_URL`) |
| Project | `slugbase` |

| Key | What it does | Cloud | CE | Required | Secret | When set | Example value |
|---|---|---|---|---|---|---|---|
| `REPORTPORTAL_URL` | ReportPortal instance base URL (no `/api/v2` suffix) | Yes | No | CI only | No | CI | `https://reportportal.mdg-labs.dev` |
| `REPORTPORTAL_PROJECT` | ReportPortal project name | Yes | No | CI only | No | CI | `slugbase` |
| `REPORTPORTAL_API_KEY` | User API key for launch upload | Yes | No | CI only | Yes | CI | `<ReportPortal user API key>` |

**Phase / GHA `ci` (operator — CI)**

Set `REPORTPORTAL_URL`, `REPORTPORTAL_PROJECT`, and `REPORTPORTAL_API_KEY` in Phase (they sync to the GHA `ci` environment). Generate the API key in ReportPortal under **Profile → API Keys** for a user with access to project `slugbase`. Never commit or log the key.

For local development with ReportPortal uploads, set the same keys in Phase `Development` and run via `phase run` (see #475).

Agent wiring (`@reportportal/agent-js-vitest`, `@reportportal/agent-js-playwright`) lands in #368–#370. See [ReportPortal JavaScript agents](https://reportportal.io/docs/log-data-in-reportportal/test-framework-integration/JavaScript/).

**CI launch grouping:** GitHub Actions starts one shared launch per layer (`SlugBase · Unit · CI #<run>` / `SlugBase · Integration · CI #<run>`) and sets ephemeral `RP_LAUNCH_ID` on the runner before Turbo fan-out. Package reporters attach to that launch (attribute `package` still identifies the workspace package). Not stored in Phase.

**CI summary links:** Launch UUIDs are uploaded as a workflow artifact; the separate `CI · ReportPortal summary` job (no `REPORTPORTAL_API_KEY` in env) writes HTML links to the job summary and PR comment. This avoids GitHub secret masking corrupting UUID substrings in markdown hrefs.

---

## GitHub Actions environments

SlugBase uses three **GitHub Actions environments** as the CI/deploy secret source (populated automatically from Phase):

| GHA environment | Phase source | Used by |
|---|---|---|
| `ci` | CI-only keys in Phase | Parallel CI jobs (`ci.yml`) |
| `staging` | Phase `Staging` | Staging deploy (`deploy.yml`), smoke, sync-secrets |
| `production` | Phase `Production` | Production deploy (`release.yml` → `deploy.yml`), smoke, sync-secrets |

Repository-level secrets are limited to what GitHub requires for its own integration (e.g. `GITHUB_TOKEN`). Application secrets live in Phase and flow through GHA environments — not in repository secrets. Deploy pipelines call `sync-secrets.sh` to push GHA environment values to Fly.io and Cloudflare Workers.

See `docs/internal/ci-cd-example/` for the authoritative sync-secrets workflow and script layout.

---

## Admin portal (`packages/admin` — Cloud Fly app only)

Admin PRD §11.1. Validated in [`packages/admin/src/config/env.schema.ts`](../packages/admin/src/config/env.schema.ts). Runtime on Fly app `slugbase-{staging|production}-admin`. Phase sync manifest maps `SENTRY_DSN_ADMIN` → runtime `SENTRY_DSN`.

| Key | Purpose | Cloud | CE | Required | Secret | When set | Example |
|---|---|---|---|---|---|---|---|
| `DATABASE_URL` | Neon pooled URL (read `public.*`, write `admin.*`) | Yes | No | Always | Yes | Runtime | _(Neon pooled URL)_ |
| `NODE_ENV` | Node environment | Yes | No | Always | No | Runtime | `production` |
| `SLUGBASE_EDITION` | Edition selector — always `cloud` on admin | Yes | No | Always | No | Runtime | `cloud` |
| `PORT` | HTTP listen port | Yes | No | Optional | No | Runtime | `3000` |
| `ADMIN_URL` | Public admin origin (invite links, smoke) | Yes | No | Always | No | Runtime | `https://staging-admin.slugbase.app` |
| `SMTP_HOST` | Invite mail transport host | Yes | No | Always | No | Runtime | _(reuse API SMTP)_ |
| `SMTP_PORT` | SMTP port | Yes | No | Always | No | Runtime | `587` |
| `SMTP_SECURE` | SMTP TLS | Yes | No | Always | No | Runtime | `false` |
| `SMTP_USER` | SMTP username | Yes | No | Always | Yes | Runtime | |
| `SMTP_PASS` | SMTP password | Yes | No | Always | Yes | Runtime | |
| `SMTP_FROM` | SMTP from address | Yes | No | Always | No | Runtime | |
| `ADMIN_SESSION_TTL_DAYS` | Operator session sliding TTL | Yes | No | Optional | No | Runtime | `7` |
| `ADMIN_SNAPSHOT_CRON` | Daily snapshot cron expression | Yes | No | Optional | No | Runtime | `0 2 * * *` |
| `ADMIN_BOOTSTRAP_EMAIL` | First platform admin email (remove after bootstrap) | Yes | No | Cloud | No | Runtime | |
| `ADMIN_BOOTSTRAP_PASSWORD` | First platform admin password (remove after bootstrap) | Yes | No | Cloud | Yes | Runtime | |
| `ADMIN_ALERT_SIGNUP_SPIKE_MULTIPLIER` | Signup spike Sentry warning threshold | Yes | No | Optional | No | Runtime | `3` |
| `SENTRY_DSN` | Error reporting DSN on admin runtime | Yes | No | Optional | Yes | Runtime | _(from `SENTRY_DSN_ADMIN` in Phase)_ |
| `SENTRY_ENVIRONMENT` | Sentry environment tag | Yes | No | Optional | No | Runtime | `staging` |

**Migrate-only (CI):** `DATABASE_URL_UNPOOLED` when set, else `DATABASE_URL` — same pattern as product API.

**Not used on admin:** `SESSION_SECRET`, `ENCRYPTION_KEY`, `STRIPE_*`, OIDC secrets, `FRONTEND_ORIGIN`, `APP_BASE_URL`.

---

## Related docs

- [`.env.example`](../.env.example) — key names only (no values)
- [`local-development.md`](local-development.md) — Node version, Phase local dev (detail in #475)
- [`defaults-and-constants.md`](defaults-and-constants.md) — product constants and Workers custom domains
- [`slugbase-mvp-spec.md` §15](slugbase-mvp-spec.md) — configuration model (deployment vs DB vs user prefs)
- Rule [`.cursor/rules/05-env-vars.mdc`](../.cursor/rules/05-env-vars.mdc) — four-step workflow when adding new keys

---

## Adding a new key

When introducing a new environment variable, complete all four steps in one commit:

1. Set the value in Phase (`Development` for local verification; `Staging` / `Production` for deploy keys)
2. Add the key name to [`.env.example`](../.env.example)
3. Add to [`packages/backend/src/config/env.schema.ts`](../packages/backend/src/config/env.schema.ts) (or client env types if `VITE_*` / `PUBLIC_*`)
4. Add a row to **this document**
