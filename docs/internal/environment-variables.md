# Environment variables

Complete reference for configuration keys across the open-core split: **slugbase** (public CE), **commerce** (private billing library), and **slugbase-cloud** (private Cloud deploy). Values are managed in **Phase** (app `SlugBase`) for operator editing; Phase automatically syncs to **GitHub Actions environments** (`ci`, `staging`, `production`) for CI and deploy. Cloud runtime env is configured in **Coolify** (operators mirror Phase values). See [`.env.example`](../.env.example) (CE), [`commerce/.env.example`](../../commerce/.env.example), and [`slugbase-cloud/.env.example`](../../slugbase-cloud/.env.example) for machine-readable key lists (names only, no values).

Product model: [slugbase-mvp-spec.md §15](slugbase-mvp-spec.md). CE backend validation: [`packages/backend/src/config/env.schema.ts`](../packages/backend/src/config/env.schema.ts). Commerce: [`commerce/packages/commerce-core/src/config/env.schema.ts`](../../commerce/packages/commerce-core/src/config/env.schema.ts). Cloud billing: [`slugbase-cloud/packages/slugbase-billing/src/config/env.schema.ts`](../../slugbase-cloud/packages/slugbase-billing/src/config/env.schema.ts).

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
| `Staging` | `staging` | Staging deploy + Coolify runtime (via operator UI) |
| `Production` | `production` | Production deploy + Coolify runtime (via operator UI) |
| _(CI-only keys in Phase)_ | `ci` | CI-only persistent secrets |

Phase syncs operator edits to GHA automatically. CI jobs and deploy workflows read `${{ secrets.* }}` from the matching GHA environment. Runtime secrets for Cloud apps are set in Coolify.

**Local dev**

```bash
phase run -- pnpm dev   # injects Phase Development env — full setup in #475
```

**CI** uses the GHA `ci` environment for CI-only keys. Deploy uses `staging` or `production` GHA environments. No Phase CLI in workflows.

### Table legend

Every inventory table uses the same columns:

| Column | Meaning |
|---|---|
| **CE** | Needed on public CE GHCR images (`slugbase-api` / `slugbase-web`) |
| **commerce** | Read by `@mdg-labs/commerce-core` (seller profile, VAT, invoice prefix) on Cloud deploy |
| **slugbase-cloud** | Needed on private Cloud Coolify containers (`cloud-api`, marketing, admin) |
| **Required** | `Always` · `Cloud` · `Optional` · `Dev only` · `CI only` |
| **Secret** | `Yes` = never commit or log; `No` = safe in client bundles |
| **When set** | `Runtime` (process env at start) · `Build` (Vite/Astro bake-in) · `Both` · `CI` |

> **Build-time warning:** Keys prefixed `VITE_` (web app) or `PUBLIC_` (marketing site) are **inlined into client bundles at build time**. Never put true secrets there — session keys, API secrets, SMTP passwords, Mollie keys, etc. belong in unprefixed runtime keys only.

### Edition selector

| Key | What it does | CE | commerce | slugbase-cloud | Required | Secret | When set | Example value |
|---|---|---|---|---|---|---|---|---|
| `SLUGBASE_EDITION` | Edition selector — `ce` (Community Edition split images) or `cloud` (managed split deploy). Drives edition-specific defaults (#479–#483); supersedes deprecated `SLUGBASE_MODE`. **Cloud:** set `cloud` on Coolify app containers. **CE GHCR/self-host:** set `ce` on the **api** container (`Dockerfile.api` preset). | Yes (api) | — | Yes | Yes (production); defaults to `ce` in non-production when unset | No | Runtime / Build | `cloud` or `ce` |

> **Preset wiring:** Backend startup applies edition presets before Zod validation. Explicit env values override unset preset keys; values that conflict with the active edition preset are rejected in production and warned in development/test.



---

## Quick start — Cloud

Minimum keys to boot a **managed** deployment (four Coolify containers). See [full inventory](#full-inventory) for optional interfaces.

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
# + Mollie, Altcha, commerce seller profile, deploy tokens — see Cloud tables below
```

### URL wiring (Cloud)

Three public surfaces must agree on origins. **Deploy plan probes and smoke** resolve these from [`scripts/ci/deploy-probe-origins.mjs`](../scripts/ci/deploy-probe-origins.mjs) when GHA `vars` / `secrets` are unset; Phase and Coolify runtime config should match the same hostnames.

| Surface | Key | Staging | Production |
|---|---|---|---|
| API | `APP_BASE_URL` | `https://staging-api.slugbase.app` | `https://api.slugbase.app` |
| Web app | `FRONTEND_ORIGIN` | `https://staging-cloud.slugbase.app` | `https://cloud.slugbase.app` |
| Web SSR (server loaders) | `API_BASE_URL` | `https://staging-api.slugbase.app` | `https://api.slugbase.app` |
| Web client build | `VITE_API_URL` | `https://staging-api.slugbase.app` | `https://api.slugbase.app` |
| Marketing site CTAs | `PUBLIC_FRONTEND_ORIGIN` | `https://staging-cloud.slugbase.app` | `https://cloud.slugbase.app` |
| Marketing deploy smoke | `MARKETING_ORIGIN` | `https://staging.slugbase.app` | `https://slugbase.app` |
| Admin portal (smoke, invites) | `ADMIN_URL` | `https://staging-admin.slugbase.app` | `https://admin.slugbase.app` |
| Marketing contact form | `PUBLIC_CONTACT_ENDPOINT` | `https://staging-api.slugbase.app/contact` | `https://api.slugbase.app/contact` |

Typical Cloud flags: `PUBLIC_REGISTRATION=true`, `EMAIL_VERIFICATION_REQUIRED=true`, `VITE_BILLING_ENABLED=true`, `VITE_MAIL_ADMIN_UI=false`, `VITE_OIDC_ADMIN_UI=false`, `VITE_AI_BYO_CREDENTIAL=false`.

---

## Quick start — CE

Minimum keys for the **split CE GHCR images** (`ghcr.io/mdg-labs/slugbase-api` + `ghcr.io/mdg-labs/slugbase-web`). The API container holds secrets, database access, and operator integrations; the web container serves the SSR client and calls the API. Marketing site is not included in either image.

```bash
# api service — runtime env (docker compose env_file or -e flags)
SLUGBASE_EDITION=ce
SERVE_WEB_CLIENT=false
SESSION_SECRET=<64-char hex>          # openssl rand -hex 32
ENCRYPTION_KEY=<64-char hex>
DATABASE_URL=postgresql://slugbase:slugbase@postgres:5432/slugbase
APP_BASE_URL=https://bookmarks.example.com
FRONTEND_ORIGIN=https://bookmarks.example.com   # user-facing origin (web); may match APP_BASE_URL behind one hostname
PUBLIC_REGISTRATION=false                       # invite-only default
EMAIL_VERIFICATION_REQUIRED=false               # configurable
# SMTP_*, OIDC_{SLUG}_*, OPENAI_* — api service only

# web service — runtime env
API_BASE_URL=http://api:3000                    # internal compose hostname; or public API URL behind proxy

# web image build — hardcoded CE VITE_* (see scripts/CE-vite-build-args.sh)
VITE_BILLING_ENABLED=false
VITE_MAIL_ADMIN_UI=false
VITE_OIDC_ADMIN_UI=false
VITE_AI_BYO_CREDENTIAL=false
# Do not bake VITE_APP_BASE_URL, VITE_UMAMI_*, or VITE_SENTRY_* — set APP_BASE_URL at runtime on api
# Leave Mollie, Altcha, Umami, Sentry empty for no-op interfaces
```

Example compose services (illustrative — pin semver tags in production):

```yaml
services:
  api:
    image: ghcr.io/mdg-labs/slugbase-api:1.0.0
    env_file: /path/to/slugbase.env
    environment:
      SERVE_WEB_CLIENT: "false"
  web:
    image: ghcr.io/mdg-labs/slugbase-web:1.0.0
    environment:
      API_BASE_URL: http://api:3000
    ports:
      - "3000:3000"
```

CI GHCR builds do **not** read Phase or GHA runtime secrets. The **web** image build passes hardcoded CE `VITE_*` values from [`scripts/CE-vite-build-args.sh`](../scripts/CE-vite-build-args.sh) via [`scripts/ci/build-push-ghcr.sh`](../scripts/ci/build-push-ghcr.sh). **`VITE_SENTRY_*`**, **`VITE_UMAMI_*`**, **`VITE_APP_BASE_URL`**, and deprecated pricing keys are never passed — Cloud telemetry and URLs must not be baked into the CE client bundle.

Staging tags: `slugbase-api:dev` and `slugbase-web:dev` (pushed when the live `/version` probe plan flags `push_ghcr_*`). Production tags: `release-YYYY-MM-DD` and `:latest` per image on `release: published` only — surfaces below `1.0.0` are skipped. **No GHCR push on `main` push.**

### URL wiring (CE)

| Key | Service | Example |
|---|---|---|
| `APP_BASE_URL` | api | `https://bookmarks.example.com` |
| `FRONTEND_ORIGIN` | api | `https://bookmarks.example.com` (CORS — match the hostname users open) |
| `API_BASE_URL` | web | `http://api:3000` (internal) or `https://api.bookmarks.example.com` (split public hostnames) |

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
    apiBuild[API image build]
    webBuild[Web VITE build-args]
    apiContainer[slugbase-api runtime]
    webContainer[slugbase-web runtime]
  end
  keys -->|auto sync| gha
  ciEnv -->|CI jobs| ciRunner[CI runners]
  stgEnv -->|deploy.yml| cloud
  prodEnv -->|deploy.yml| cloud
  keys -.->|phase run local only| localDev[Local dev]
  apiBuild --> apiContainer
  webBuild --> webContainer
  webContainer -->|API_BASE_URL| apiContainer
```

| When set | Where | Examples |
|---|---|---|
| **Runtime** | Coolify API/web/admin containers, CE api/web containers (`process.env`) | `SESSION_SECRET`, `DATABASE_URL`, `API_BASE_URL` (web), `MOLLIE_API_KEY` |
| **Build** | `pnpm build` for web/marketing; Docker `ARG VITE_*` | `VITE_BILLING_ENABLED`, `PUBLIC_PLAN_PRICE_PERSONAL_MONTHLY` |
| **Both** | Build + SSR fallback | `API_BASE_URL` (runtime web container), `VITE_API_URL` (SSR fallback only) |
| **CI** | GitHub Actions runner only; never shipped to production runtime | `REGISTRY_*`, `COOLIFY_DEPLOY_*`, `SENTRY_AUTH_TOKEN`, `PANGOLIN_*` |

---

## Full inventory

### 1. Required secrets and URLs

Every deployment must set these. The API refuses to start in production without valid values ([`env.schema.ts`](../packages/backend/src/config/env.schema.ts)).

| Key | What it does | Cloud | CE | Required | Secret | When set | Example value |
|---|---|---|---|---|---|---|---|
| `SESSION_SECRET` | Signs and verifies server-side session cookies | Yes | Yes | Always | Yes | Runtime | `<openssl rand -hex 32>` (min 32 chars) |
| `ENCRYPTION_KEY` | Encrypts at-rest sensitive DB values (e.g. MFA secrets) | Yes | Yes | Always | Yes | Runtime | `<openssl rand -hex 32>` (min 32 chars) |
| `DATABASE_URL` | PostgreSQL connection (pooled URL for runtime) | Yes | Yes | Always | Yes | Runtime | `postgresql://user:pass@host:5432/slugbase` |
| `DATABASE_URL_UNPOOLED` | Direct DB URL for migrations / drizzle-kit | Yes | Optional | Optional | Yes | Runtime | Neon direct URL; falls back to `DATABASE_URL` |
| `APP_BASE_URL` | Public HTTPS base URL of the API (links, OIDC callbacks, CORS) | Yes | Yes | Always | No | Runtime | `https://api.example.com` |
| `FRONTEND_ORIGIN` | Public web app origin (CORS allowlist) | Yes | Yes | Always | No | Runtime | `https://app.example.com` |
| `API_BASE_URL` | API origin for Worker SSR loaders, actions, and proxy upstream | Yes | Optional | Cloud | No | Runtime (Worker) | Same as `APP_BASE_URL` on Cloud |
| `VITE_API_URL` | Build-time fallback when `API_BASE_URL` unset at SSR; **not** used for browser `fetch` | Yes | Optional | Cloud | No | Build | Same as `APP_BASE_URL` on Cloud |

**Client API routing (web):** Browser `fetch` always uses same-origin Worker proxy routes (`/auth/*`, `/api/*`, …). SSR loaders and proxy handlers call the NestJS API via `API_BASE_URL` (see `packages/web/app/lib/client-api-path.ts` and `client-api-fetch.ts`). Never read `VITE_API_URL` in UI modules for cross-origin browser requests — session cookies are `SameSite=Lax` on the web origin.
| `MARKETING_ORIGIN` | Public marketing site origin (API CORS allowlist + deploy smoke) | Yes | No | Cloud | No | Runtime | `https://www.example.com` |

---

### 2. Deployment flags

Control registration, email verification, and how the web UI is served.

| Key | What it does | Cloud | CE | Required | Secret | When set | Example value |
|---|---|---|---|---|---|---|---|
| `PUBLIC_REGISTRATION` | Allow open signup (`POST /auth/register`) | Yes | Yes | Optional | No | Runtime | Cloud: `true`; CE: `false` |
| `EMAIL_VERIFICATION_REQUIRED` | Block login until email verified | Yes | Yes | Optional | No | Runtime | Cloud: `true`; CE: `false` |
| `SERVE_WEB_CLIENT` | Serves bundled RR7 web on same port (legacy combined image only). On split CE, set **`false`** on the api container; web runs in `slugbase-web`. **Also controls migration dispatch** — `bootstrap()` runs DB migrations when enabled on CE api startup. Cloud deployments run migrations in CI via the `migrate-staging` / `migrate-production` workflow jobs (non-zero exit blocks deploy). | No | Yes (api) | Optional | No | Runtime | Split CE api: `false`; legacy combined: `true` |
| `WEB_CLIENT_SERVER_BUILD` | Path to RR7 server build entry (legacy combined image only) | No | Yes (combined) | Optional | No | Runtime | `/app/packages/web/build/server/index.js` |
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

> **Operator-managed credentials (CE and Cloud):** SMTP (`SMTP_*`), AI (`OPENAI_*`), and OIDC providers (`OIDC_{SLUG}_*`) are configured exclusively via deployment environment variables on both editions. Workspace admin UI does not store transport, AI, or OIDC credentials.

#### Per-provider OIDC (`OIDC_{SLUG}_*`)

Each federated identity provider is configured with a slug (e.g. `google`, `github`). Replace `{SLUG}` with an uppercase slug in env var names (e.g. `google` → `OIDC_google_CLIENT_ID`). A provider is active when the required trio (`CLIENT_ID`, `CLIENT_SECRET`, `ISSUER_URL`) is present and `OIDC_{SLUG}_ENABLED` is not `false`.

| Key pattern | What it does | Cloud | CE | Required | Secret | When set | Example value |
|---|---|---|---|---|---|---|---|
| `OIDC_{SLUG}_CLIENT_ID` | OIDC client id | Optional | Optional | Per provider | No | Runtime | `…apps.googleusercontent.com` |
| `OIDC_{SLUG}_CLIENT_SECRET` | OIDC client secret | Optional | Optional | Per provider | Yes | Runtime | `<client secret>` |
| `OIDC_{SLUG}_ISSUER_URL` | OIDC issuer / discovery URL | Optional | Optional | Per provider | No | Runtime | `https://accounts.google.com` |
| `OIDC_{SLUG}_NAME` | Display name in login UI | Optional | Optional | Optional | No | Runtime | `Google` (default: title-case slug) |
| `OIDC_{SLUG}_SCOPES` | Space-separated OIDC scopes | Optional | Optional | Optional | No | Runtime | `openid email profile` (default) |
| `OIDC_{SLUG}_ENABLED` | Enable this provider | Optional | Optional | Optional | No | Runtime | `true` (default when required trio present) |

Example (Google):

```bash
OIDC_google_CLIENT_ID=…
OIDC_google_CLIENT_SECRET=…
OIDC_google_ISSUER_URL=https://accounts.google.com
OIDC_google_NAME=Google
```

---

### 4. Cloud billing — Mollie and plan amounts (`slugbase-cloud`)

Required for paid entitlements on Cloud. Leave empty on CE (no-op billing grants full entitlements). Mollie keys and plan amounts are validated in [`slugbase-billing` env schema](../../slugbase-cloud/packages/slugbase-billing/src/config/env.schema.ts).

| Key | What it does | CE | commerce | slugbase-cloud | Required | Secret | When set | Example value |
|---|---|---|---|---|---|---|---|---|
| `MOLLIE_API_KEY` | Mollie API key | — | — | Yes | Cloud | Yes | Runtime | `test_…` / `live_…` |
| `MOLLIE_WEBHOOK_SECRET` | Mollie webhook signing secret | — | — | Yes | Cloud | Yes | Runtime | `<webhook secret>` |
| `MOLLIE_PROFILE_ID` | Mollie website profile id | — | — | Yes | Optional | No | Runtime | `pfl_…` |
| `BILLING_CURRENCY` | ISO currency for plan amounts | — | Yes | Yes | Optional | No | Runtime | `eur` (default) |
| `BILLING_PLAN_PERSONAL_MONTHLY_AMOUNT` | Personal plan net amount (cents) | — | — | Yes | Cloud | No | Runtime | `499` |
| `BILLING_PLAN_PERSONAL_ANNUAL_AMOUNT` | Personal annual net amount (cents) | — | — | Yes | Cloud | No | Runtime | `4990` |
| `BILLING_PLAN_TEAM_MONTHLY_AMOUNT` | Team plan net amount per seat (cents) | — | — | Yes | Cloud | No | Runtime | `999` |
| `BILLING_PLAN_TEAM_ANNUAL_AMOUNT` | Team annual net amount per seat (cents) | — | — | Yes | Cloud | No | Runtime | `9990` |
| `BILLING_PLAN_SUPPORTER_AMOUNT` | One-time supporter net amount (cents) | — | — | Optional | No | Runtime | `2500` |
| `SUPPORTER_PROMOTION_END` | ISO-8601 end of supporter offer | Yes | — | Yes | Optional | No | Runtime | `2026-12-31T23:59:59Z` |
| `DOWNGRADE_GRACE_PERIOD_DAYS` | Days after period end before overflow archive | Yes | — | Yes | Optional | No | Runtime | `7` (default) |

### 4b. Commerce seller profile (`commerce` + Cloud deploy runtime)

Invoice seller block and VAT mode — validated in [`commerce-core` env schema](../../commerce/packages/commerce-core/src/config/env.schema.ts). Set on Cloud API runtime alongside Mollie keys.

| Key | What it does | CE | commerce | slugbase-cloud | Required | Secret | When set | Example value |
|---|---|---|---|---|---|---|---|---|
| `BILLING_SELLER_LEGAL_NAME` | Seller legal name on invoices | — | Yes | Yes (runtime) | Cloud | No | Runtime | `MDG Labs GmbH` |
| `BILLING_SELLER_ADDRESS_LINE1` | Seller address line 1 | — | Yes | Yes (runtime) | Cloud | No | Runtime | `Example Str. 1` |
| `BILLING_SELLER_ADDRESS_LINE2` | Seller address line 2 | — | Yes | Optional | Optional | No | Runtime | `c/o …` |
| `BILLING_SELLER_POSTAL_CODE` | Seller postal code | — | Yes | Yes (runtime) | Cloud | No | Runtime | `10115` |
| `BILLING_SELLER_CITY` | Seller city | — | Yes | Yes (runtime) | Cloud | No | Runtime | `Berlin` |
| `BILLING_SELLER_COUNTRY` | Seller country (ISO 3166-1 alpha-2) | — | Yes | Yes (runtime) | Cloud | No | Runtime | `DE` |
| `BILLING_SELLER_VAT_ID` | Seller VAT id (when applicable) | — | Yes | Optional | Optional | No | Runtime | `DE…` |
| `BILLING_SELLER_EMAIL` | Seller contact email on invoices | — | Yes | Optional | Optional | No | Runtime | `billing@example.com` |
| `BILLING_VAT_MODE` | `kleinunternehmer` (default) or `standard` | — | Yes | Yes (runtime) | Optional | No | Runtime | `kleinunternehmer` |
| `BILLING_INVOICE_PREFIX` | Invoice number prefix | — | Yes | Yes (runtime) | Optional | No | Runtime | `SB` (default) |

### 4c. Bot protection — Altcha (CE optional, Cloud contact)

Replaces removed `TURNSTILE_*` / `PUBLIC_TURNSTILE_SITE_KEY` (see open-core refactor plan §14.8). Full Altcha provider ships in TASK-027.

| Key | What it does | CE | commerce | slugbase-cloud | Required | Secret | When set | Example value |
|---|---|---|---|---|---|---|---|---|
| `ALTCHA_HMAC_KEY` | Altcha server HMAC secret (API + contact) | Optional | — | Yes | Optional | Yes | Runtime | `<openssl rand -hex 32>` (min 32 chars) |
| `CHALLENGE_DEV_SKIP` | Skip challenge verification in development | Yes | — | Yes | Dev only | No | Runtime | `true` (default non-production) |

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
| `VITE_MAIL_ADMIN_UI` | Show workspace SMTP admin panel | Yes | Build only | Optional | No | Build | `false` (both editions) |
| `VITE_OIDC_ADMIN_UI` | Show workspace OIDC admin panel | Yes | Build only | Optional | No | Build | `false` (both editions) |
| `VITE_AI_BYO_CREDENTIAL` | Show full AI credential form (BYO key) | Yes | Build only | Optional | No | Build | `false` (both editions) |
| `VITE_APP_BASE_URL` | API URL shown in OIDC callback settings | Yes | Build only | Optional | No | Build | `https://api.example.com` |
| `VITE_MARKETING_ORIGIN` | Marketing site origin for absolute legal-page links in the web app; unset hides links (CE) | Yes | Build only | Optional | No | Build | `https://www.example.com` |
| `VITE_DOCS_BASE_URL` | Customer docs site origin for the sidebar Help link; unset defaults to `https://docs.slugbase.app` | Yes | Build only | Optional | No | Build | `https://docs.slugbase.app` |

---

### 6. Cloud — Marketing site (`PUBLIC_*`)

Baked in at **`pnpm --filter @slugbase/marketing build`**. Not used by CE api/web images unless you deploy marketing separately.

| Key | What it does | Cloud | CE | Required | Secret | When set | Example value |
|---|---|---|---|---|---|---|---|
| `PUBLIC_FRONTEND_ORIGIN` | App URL for sign-in / register CTAs | Yes | No | Cloud | No | Build | `https://app.example.com` |
| `PUBLIC_FORWARDING_DOMAIN` | Forwarding domain shown in demo copy | Yes | No | Optional | No | Build | `go.example.com` |
| `PUBLIC_API_BASE_URL` | API base URL for fetching prices from `GET /pricing/public` | Yes | No | Cloud | No | Build | `https://api.example.com` |
| `PUBLIC_CONTACT_ENDPOINT` | `POST` target for contact form | — | — | Yes | Cloud | No | Build | `https://api.example.com/contact` |
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

Repository secrets (`REGISTRY`, `REGISTRY_USER`, `REGISTRY_TOKEN`, `PANGOLIN_*`) and GHA environment secrets (`COOLIFY_DEPLOY_*`, `DATABASE_URL`) for image push, Coolify webhook triggers, and cloud DB migrations. Runtime app secrets are configured in Coolify (operators mirror Phase → GHA values).

| Key | What it does | Cloud | CE | Required | Secret | When set | Example value |
|---|---|---|---|---|---|---|---|
| `PANGOLIN_ENDPOINT` | Pangolin control-plane URL for machine-client tunnel (cloud migrate job) | Yes | No | CI only | Yes | CI (repo secret) | `https://…` |
| `PANGOLIN_MACHINE_ID` | Pangolin machine client id (cloud migrate job) | Yes | No | CI only | Yes | CI (repo secret) | `<machine id>` |
| `PANGOLIN_MACHINE_SECRET` | Pangolin machine client secret (cloud migrate job) | Yes | No | CI only | Yes | CI (repo secret) | `<machine secret>` |
| `REGISTRY` | Private container registry host | Yes | No | CI only | No | CI | `berth.mdg-labs.dev` |
| `REGISTRY_USER` | Registry login user | Yes | No | CI only | Yes | CI | `<registry user>` |
| `REGISTRY_TOKEN` | Registry login token | Yes | No | CI only | Yes | CI | `<registry token>` |
| `COOLIFY_DEPLOY_TOKEN` | Coolify API token with `deploy` permission | Yes | No | CI only | Yes | CI | `<bearer token>` |
| `COOLIFY_DEPLOY_WEBHOOK_API` | Coolify deploy webhook URL for API app | Yes | No | CI only | Yes | CI | `https://…/api/v1/deploy?uuid=…` |
| `COOLIFY_DEPLOY_WEBHOOK_WEB` | Coolify deploy webhook URL for web app | Yes | No | CI only | Yes | CI | `https://…/api/v1/deploy?uuid=…` |
| `COOLIFY_DEPLOY_WEBHOOK_MARKETING` | Coolify deploy webhook URL for marketing app | Yes | No | CI only | Yes | CI | `https://…/api/v1/deploy?uuid=…` |
| `COOLIFY_DEPLOY_WEBHOOK_ADMIN` | Coolify deploy webhook URL for admin app | Yes | No | CI only | Yes | CI | `https://…/api/v1/deploy?uuid=…` |

**Cloud image paths** (private registry, not Phase keys): `{REGISTRY}/slugbase-cloud/{api|web|marketing|admin}:{version}` — resolved by [`scripts/ci/cloud-registry-image.sh`](../scripts/ci/cloud-registry-image.sh). Example: `berth.mdg-labs.dev/slugbase-cloud/api:1.2.3` (staging also pushes `:dev`). CE GHCR images are unchanged (`ghcr.io/mdg-labs/slugbase-api`, `slugbase-web`).

---

### 9. CE — runtime and image build

CE ships as **`slugbase-api`** (NestJS API, migrations, operator integrations) and **`slugbase-web`** (React Router SSR client). Set `SERVE_WEB_CLIENT=false` on the api image; the web image receives `API_BASE_URL` at runtime.

**Do not bake Cloud telemetry at image build time.** CE operators and CI must never pass `VITE_SENTRY_*` (or other Cloud-only telemetry keys) as Docker `--build-arg` values on the **web** image. GHCR CI and local/e2e builds share the same hardcoded CE flags in [`scripts/CE-vite-build-args.sh`](../scripts/CE-vite-build-args.sh). Runtime `SENTRY_DSN` on the API container is optional and separate from client build-time keys — leave both empty for a fully no-op error-reporting install (spec §11.7).

| Key | What it does | Cloud | CE | Required | Secret | When set | Example value |
|---|---|---|---|---|---|---|---|
| `SERVE_WEB_CLIENT` | Serve web from API container (legacy combined image); split CE api must use `false` | No | Yes (api) | Optional | No | Runtime | `false` (`Dockerfile.api` preset) |
| `WEB_CLIENT_SERVER_BUILD` | RR7 server entry path (legacy combined image only) | No | Yes (combined) | Optional | No | Runtime | `/app/packages/web/build/server/index.js` |
| `API_BASE_URL` | Upstream API for web SSR loaders and server actions | Yes (web container) | Yes (web container) | Yes (web) | No | Runtime | `http://api:3000` |
| `VITE_BILLING_ENABLED` | Hide billing UI | No | Build only | Optional | No | Build | `false` |
| `VITE_MAIL_ADMIN_UI` | Hide SMTP workspace panel (operator-managed) | No | Build only | Optional | No | Build | `false` |
| `VITE_OIDC_ADMIN_UI` | Hide OIDC workspace panel (operator-managed) | No | Build only | Optional | No | Build | `false` |
| `VITE_AI_BYO_CREDENTIAL` | Hide BYO AI credential form (operator-managed key) | No | Build only | Optional | No | Build | `false` |
| `VITE_APP_BASE_URL` | Public URL for OIDC display | No | Build only | Optional | No | Build | `https://bookmarks.example.com` |
| `VITE_SENTRY_DSN` | Client error reporting — **must remain unset at CE image build** | No | No (build) | No | No | Build | Empty (default; do not bake) |
| `VITE_UMAMI_HOST` | Client analytics | No | Optional | Optional | No | Build | Empty (default) |
| `VITE_UMAMI_WEBSITE_ID` | Client analytics site id | No | Optional | Optional | No | Build | Empty (default) |

All other `VITE_*` pricing keys: deprecated — prices now fetched from `GET /pricing/public` when `API_BASE_URL` is configured. Legacy env vars are still accepted as fallback on CE when the API is unreachable.

---

## GitHub Actions environments

SlugBase uses three **GitHub Actions environments** as the CI/deploy secret source (populated automatically from Phase):

| GHA environment | Phase source | Used by |
|---|---|---|
| `ci` | CI-only keys in Phase | Parallel CI jobs (`ci.yml`) |
| `staging` | Phase `Staging` | Staging deploy (`deploy.yml`), smoke |
| `production` | Phase `Production` | Production deploy (`main.yml` → `deploy.yml`), smoke |

Repository secrets: `REGISTRY`, `REGISTRY_USER`, `REGISTRY_TOKEN` (image push); `PANGOLIN_ENDPOINT`, `PANGOLIN_MACHINE_ID`, `PANGOLIN_MACHINE_SECRET` (cloud DB migrations via Pangolin on `ubuntu-latest`). Application runtime secrets live in Phase → GHA environments and are mirrored into Coolify by operators. Coolify webhook secrets (`COOLIFY_DEPLOY_*`) and `DATABASE_URL` / `DATABASE_URL_UNPOOLED` live in GHA `staging` / `production` environments.

### Deploy idempotency (live `/version` probes)

Cloud deploy scope is **not** tracked in repository variables. **`deploy-plan.yml`** probes each surface's live `GET /version` and deploys when `semver_gt(V_intended, V_live)`. Production skips surfaces with `V_intended < 1.0.0` (hard floor). See spec §22.5 and `docs/internal/ci-cd-deployment-refactor-proposal.md`.

See `docs/internal/ci-cd-deployment-refactor-proposal.md` and `docs/internal/ci-cd-example2/` for the authoritative sync-secrets workflow and script layout.

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

**Not used on admin:** `SESSION_SECRET`, `ENCRYPTION_KEY`, `MOLLIE_*`, OIDC secrets, `FRONTEND_ORIGIN`, `APP_BASE_URL`.

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
