# Environment variables

Complete reference for every configuration key SlugBase reads from the environment. Values are managed in **Infisical** (project `slugbase-cloud`) for local dev and deployed environments; see [`.env.example`](../.env.example) for the machine-readable key list (names only, no values).

Product model: [slugbase-mvp-spec.md §15](slugbase-mvp-spec.md). Backend validation: [`packages/backend/src/config/env.schema.ts`](../packages/backend/src/config/env.schema.ts).

---

## At a glance

### Infisical project

| Field | Value |
|---|---|
| Instance | `https://secrets.mdg-labs.dev/` |
| Project slug | `slugbase-cloud` |
| Environments | `dev` · `staging` · `prod` |
| Key layout | Project root only (no subfolders) |

**Local dev**

```bash
infisical login --domain https://secrets.mdg-labs.dev
infisical run --env=dev -- pnpm dev
```

**CI** fetches the full environment via OIDC (`Infisical/secrets-action`). Only `INFISICAL_DOMAIN` and `INFISICAL_OIDC_IDENTITY_ID` live in GitHub Actions secrets — see [GitHub Actions secrets](#github-actions-secrets-not-in-infisical).

### Table legend

Every inventory table uses the same columns:

| Column | Meaning |
|---|---|
| **Hosted** | Needed on managed Fly.io + Cloudflare Workers deployment |
| **Self-host** | Needed on combined GHCR Docker image |
| **Required** | `Always` · `Hosted` · `Optional` · `Dev only` · `CI only` |
| **Secret** | `Yes` = never commit or log; `No` = safe in client bundles |
| **When set** | `Runtime` (process env at start) · `Build` (Vite/Astro bake-in) · `Both` · `CI` |

> **Build-time warning:** Keys prefixed `VITE_` (web app) or `PUBLIC_` (marketing site) are **inlined into client bundles at build time**. Never put true secrets there — session keys, API secrets, SMTP passwords, Stripe keys, etc. belong in unprefixed runtime keys only.

---

## Quick start — hosted

Minimum keys to boot a **managed** deployment (API on Fly.io, web on Cloudflare Workers, marketing on Cloudflare Workers). See [full inventory](#full-inventory) for optional interfaces.

```bash
# Generate secrets once (example — store in Infisical, not in shell history)
openssl rand -hex 32   # → SESSION_SECRET
openssl rand -hex 32   # → ENCRYPTION_KEY

# Set in Infisical staging/prod (projectId from .infisical.json)
infisical secrets set SESSION_SECRET="<64-char hex>" --env=staging --projectId=<id>
infisical secrets set ENCRYPTION_KEY="<64-char hex>" --env=staging --projectId=<id>
infisical secrets set DATABASE_URL="postgresql://…" --env=staging --projectId=<id>
infisical secrets set APP_BASE_URL="https://api.example.com" --env=staging --projectId=<id>
infisical secrets set FRONTEND_ORIGIN="https://app.example.com" --env=staging --projectId=<id>
infisical secrets set API_BASE_URL="https://api.example.com" --env=staging --projectId=<id>
infisical secrets set VITE_API_URL="https://api.example.com" --env=staging --projectId=<id>
infisical secrets set PUBLIC_REGISTRATION="true" --env=staging --projectId=<id>
infisical secrets set EMAIL_VERIFICATION_REQUIRED="true" --env=staging --projectId=<id>
infisical secrets set VITE_BILLING_ENABLED="true" --env=staging --projectId=<id>
# + Stripe, Turnstile, deploy tokens — see hosted tables below
```

### URL wiring (hosted)

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

Typical hosted flags: `PUBLIC_REGISTRATION=true`, `EMAIL_VERIFICATION_REQUIRED=true`, `VITE_BILLING_ENABLED=true`, `VITE_MAIL_ADMIN_UI=false`, `VITE_OIDC_ADMIN_UI=false`, `VITE_AI_BYO_CREDENTIAL=false`.

---

## Quick start — self-hosted

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

# Image build — pass VITE_* as docker build-args (see Dockerfile)
VITE_BILLING_ENABLED=false
VITE_MAIL_ADMIN_UI=true
VITE_OIDC_ADMIN_UI=true
VITE_AI_BYO_CREDENTIAL=true
VITE_APP_BASE_URL=https://bookmarks.example.com
# Leave Stripe, Turnstile, Umami, Sentry empty for no-op interfaces
```

Example `docker run` (illustrative — use secrets from your vault, not inline):

```bash
docker run -d \
  --env-file /path/to/slugbase.env \
  -p 3000:3000 \
  ghcr.io/<owner>/slugbase:latest
```

CI builds the image with all `VITE_*` keys from Infisical as `--build-arg` (see [`.github/scripts/build-push-ghcr.sh`](../.github/scripts/build-push-ghcr.sh)).

### URL wiring (self-hosted)

| Key | Example |
|---|---|
| `APP_BASE_URL` | `https://bookmarks.example.com` |
| `FRONTEND_ORIGIN` | `https://bookmarks.example.com` |

---

## How keys are consumed

```mermaid
flowchart LR
  subgraph infisical [Infisical env root]
    keys[All keys]
  end
  subgraph hosted [Hosted]
    fly[Fly.io API runtime]
    webBuild[Web VITE build]
    mktBuild[Marketing PUBLIC build]
    ci[CI deploy smoke]
  end
  subgraph selfhost [Self-hosted]
    dockerBuild[Docker VITE build-args]
    container[Combined container runtime]
  end
  keys --> fly
  keys --> webBuild
  keys --> mktBuild
  keys --> ci
  keys --> dockerBuild
  keys --> container
```

| When set | Where | Examples |
|---|---|---|
| **Runtime** | Fly.io API process, self-host container, Worker SSR (`process.env`) | `SESSION_SECRET`, `DATABASE_URL`, `STRIPE_SECRET_KEY` |
| **Build** | `pnpm build` for web/marketing; Docker `ARG VITE_*` | `VITE_BILLING_ENABLED`, `PUBLIC_PLAN_PRICE_PERSONAL_MONTHLY` |
| **Both** | Set at build for client; may also be read at SSR | `API_BASE_URL`, `VITE_API_URL` |
| **CI** | GitHub Actions runner only; never shipped to production runtime | `FLY_API_TOKEN`, `CLOUDFLARE_API_TOKEN`, `SENTRY_AUTH_TOKEN` |

---

## Full inventory

### 1. Required secrets and URLs

Every deployment must set these. The API refuses to start in production without valid values ([`env.schema.ts`](../packages/backend/src/config/env.schema.ts)).

| Key | What it does | Hosted | Self-host | Required | Secret | When set | Example value |
|---|---|---|---|---|---|---|---|
| `SESSION_SECRET` | Signs and verifies server-side session cookies | Yes | Yes | Always | Yes | Runtime | `<openssl rand -hex 32>` (min 32 chars) |
| `ENCRYPTION_KEY` | Encrypts at-rest sensitive values (SMTP, OIDC, MFA secrets) | Yes | Yes | Always | Yes | Runtime | `<openssl rand -hex 32>` (min 32 chars) |
| `DATABASE_URL` | PostgreSQL connection (pooled URL for runtime) | Yes | Yes | Always | Yes | Runtime | `postgresql://user:pass@host:5432/slugbase` |
| `DATABASE_URL_UNPOOLED` | Direct DB URL for migrations / drizzle-kit | Yes | Optional | Optional | Yes | Runtime | Neon direct URL; falls back to `DATABASE_URL` |
| `APP_BASE_URL` | Public HTTPS base URL of the API (links, OIDC callbacks, CORS) | Yes | Yes | Always | No | Runtime | `https://api.example.com` |
| `FRONTEND_ORIGIN` | Public web app origin (CORS allowlist) | Yes | Yes | Always | No | Runtime | `https://app.example.com` |
| `API_BASE_URL` | API origin for web SSR loaders/actions | Yes | Optional | Hosted | No | Both | Same as `APP_BASE_URL` on hosted |
| `VITE_API_URL` | API origin baked into web client (consent, SSR fallback) | Yes | Optional | Hosted | No | Build | Same as `APP_BASE_URL` on hosted |
| `MARKETING_ORIGIN` | Public marketing site URL (CI smoke only) | Yes | No | Hosted | No | CI | `https://www.example.com` |

---

### 2. Deployment flags

Control registration, email verification, and how the web UI is served.

| Key | What it does | Hosted | Self-host | Required | Secret | When set | Example value |
|---|---|---|---|---|---|---|---|
| `PUBLIC_REGISTRATION` | Allow open signup (`POST /auth/register`) | Yes | Yes | Optional | No | Runtime | Hosted: `true`; self-host: `false` |
| `EMAIL_VERIFICATION_REQUIRED` | Block login until email verified | Yes | Yes | Optional | No | Runtime | Hosted: `true`; self-host: `false` |
| `SERVE_WEB_CLIENT` | Nest serves bundled RR7 web on same port | No | Yes | Optional | No | Runtime | Self-host image: `true` (preset in Dockerfile) |
| `WEB_CLIENT_SERVER_BUILD` | Path to RR7 server build entry | No | Yes | Optional | No | Runtime | `/app/packages/web/build/server/index.js` |
| `OPENAPI_INTERACTIVE_DOCS` | Scalar UI at `GET /docs` | Yes | Yes | Optional | No | Runtime | `true` (default) |
| `CHALLENGE_DEV_SKIP` | Skip Turnstile verification in non-production | Yes | Yes | Optional | No | Runtime | Unset in prod; `true` in local dev |
| `PORT` | HTTP listen port | Yes | Yes | Optional | No | Runtime | `3000` (default) |
| `NODE_ENV` | Node environment | Yes | Yes | Optional | No | Runtime | Set by platform/image (`production`) |

---

### 3. Shared optional — SMTP, AI, sessions, rate limits

Optional on both deployment shapes. Empty values activate **no-op** interface implementations.

| Key | What it does | Hosted | Self-host | Required | Secret | When set | Example value |
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

> **Self-host note:** SMTP, OIDC, and AI credentials are usually configured via **workspace settings in the UI** (encrypted in DB). Deployment-level `SMTP_*` / `OPENAI_*` are optional fallbacks for operator-managed transport.

---

### 4. Hosted — Stripe and billing (API runtime)

Required for paid entitlements on hosted. Leave empty on self-host (no-op billing grants full entitlements).

| Key | What it does | Hosted | Self-host | Required | Secret | When set | Example value |
|---|---|---|---|---|---|---|---|
| `STRIPE_SECRET_KEY` | Stripe API secret key | Yes | No | Hosted | Yes | Runtime | `sk_live_…` |
| `STRIPE_WEBHOOK_SECRET` | Webhook signing secret | Yes | No | Hosted | Yes | Runtime | `whsec_…` |
| `STRIPE_PRICE_PERSONAL` | Price id for Personal plan checkout | Yes | No | Hosted | No | Runtime | `price_…` |
| `STRIPE_PRICE_TEAM` | Price id for Team plan checkout | Yes | No | Hosted | No | Runtime | `price_…` |
| `STRIPE_PRICE_TEAM_EXTRA_SEAT` | Price id for extra Team seats | Yes | No | Optional | No | Runtime | `price_…` |
| `STRIPE_PRICE_SUPPORTER` | Price id for one-time supporter purchase | Yes | No | Optional | No | Runtime | `price_…` |
| `TEAM_BASE_SEATS` | Included seats on Team plan | Yes | No | Optional | No | Runtime | `5` (default) |
| `SUPPORTER_PROMOTION_END` | ISO-8601 end of supporter offer | Yes | No | Optional | No | Runtime | `2026-12-31T23:59:59Z` |
| `DOWNGRADE_GRACE_PERIOD_DAYS` | Days after period end before overflow archive | Yes | Optional | Optional | No | Runtime | `7` (default) |
| `TURNSTILE_SECRET_KEY` | Turnstile server secret (API + contact) | Yes | No | Optional | Yes | Runtime | `<Turnstile secret>` |

---

### 5. Hosted — Web client (`VITE_*`)

Baked in at **`pnpm --filter @slugbase/web build`**. Public display config only — never secrets.

| Key | What it does | Hosted | Self-host | Required | Secret | When set | Example value |
|---|---|---|---|---|---|---|---|
| `VITE_BILLING_ENABLED` | Show billing settings and plan gates | Yes | Build only | Hosted | No | Build | Hosted: `true`; self-host: `false` |
| `VITE_PLAN_PRICE_PERSONAL_MONTHLY` | Personal monthly display price | Yes | No | Optional | No | Build | `$4/mo` |
| `VITE_PLAN_PRICE_PERSONAL_YEARLY` | Personal yearly display price | Yes | No | Optional | No | Build | `$3.33/mo` |
| `VITE_PLAN_PRICE_TEAM_SEAT` | Team per-seat display price | Yes | No | Optional | No | Build | `$9/seat/mo` |
| `VITE_PLAN_PRICE_SUPPORTER` | Supporter one-time display price | Yes | No | Optional | No | Build | `$59` |
| `VITE_SUPPORTER_PROMOTION_END` | Supporter deadline (display/countdown) | Yes | No | Optional | No | Build | `2026-12-31T23:59:59Z` |
| `VITE_TEAM_BASE_SEATS` | Team seats shown in plan table | Yes | No | Optional | No | Build | `5` |
| `VITE_FREE_BOOKMARK_CAP` | Free cap shown in billing meter | Yes | No | Optional | No | Build | `50` |
| `VITE_MAIL_ADMIN_UI` | Show workspace SMTP admin panel | Yes | Build only | Optional | No | Build | Hosted: `false`; self-host: `true` |
| `VITE_OIDC_ADMIN_UI` | Show workspace OIDC admin panel | Yes | Build only | Optional | No | Build | Hosted: `false`; self-host: `true` |
| `VITE_AI_BYO_CREDENTIAL` | Show full AI credential form (BYO key) | Yes | Build only | Optional | No | Build | Hosted: `false`; self-host: `true` |
| `VITE_APP_BASE_URL` | API URL shown in OIDC callback settings | Yes | Build only | Optional | No | Build | `https://api.example.com` |
| `VITE_TOLGEE_API_URL` | Tolgee instance for DevTools (dev builds) | Optional | Optional | Dev only | No | Build | `https://tolgee.example.com` |

---

### 6. Hosted — Marketing site (`PUBLIC_*`)

Baked in at **`pnpm --filter @slugbase/marketing build`**. Not used by the self-host combined image unless you deploy marketing separately.

| Key | What it does | Hosted | Self-host | Required | Secret | When set | Example value |
|---|---|---|---|---|---|---|---|
| `PUBLIC_FRONTEND_ORIGIN` | App URL for sign-in / register CTAs | Yes | No | Hosted | No | Build | `https://app.example.com` |
| `PUBLIC_FORWARDING_DOMAIN` | Forwarding domain shown in demo copy | Yes | No | Optional | No | Build | `go.example.com` |
| `PUBLIC_CONTACT_ENDPOINT` | `POST` target for contact form | Yes | No | Hosted | No | Build | `https://api.example.com/contact` |
| `PUBLIC_TURNSTILE_SITE_KEY` | Turnstile site key (contact form) | Yes | No | Optional | No | Build | `<Turnstile site key>` |
| `PUBLIC_PLAN_PRICE_PERSONAL_MONTHLY` | Personal monthly price on pricing page | Yes | No | Optional | No | Build | `$4/mo` |
| `PUBLIC_PLAN_PRICE_PERSONAL_YEARLY` | Personal yearly price on pricing page | Yes | No | Optional | No | Build | `$3.33/mo` |
| `PUBLIC_PLAN_PRICE_TEAM_SEAT` | Team seat monthly price | Yes | No | Optional | No | Build | `$9/seat/mo` |
| `PUBLIC_PLAN_PRICE_TEAM_SEAT_YEARLY` | Team seat yearly price | Yes | No | Optional | No | Build | `$9/seat/mo` (falls back to monthly) |
| `PUBLIC_PLAN_PRICE_SUPPORTER` | Supporter price on pricing page | Yes | No | Optional | No | Build | `$59` |
| `PUBLIC_SUPPORTER_PROMOTION_END` | Supporter deadline on marketing site | Yes | No | Optional | No | Build | `2026-12-31T23:59:59Z` |
| `PUBLIC_TEAM_BASE_SEATS` | Team seats on pricing page | Yes | No | Optional | No | Build | `5` |
| `PUBLIC_FREE_BOOKMARK_CAP` | Free cap on pricing page | Yes | No | Optional | No | Build | `50` |
| `PUBLIC_TOLGEE_API_URL` | Tolgee URL for marketing DevTools | Optional | No | Dev only | No | Build | `https://tolgee.example.com` |

---

### 7. Analytics and error reporting

Optional on both shapes. Empty = no-op (no tracker, no Sentry init).

| Key | What it does | Hosted | Self-host | Required | Secret | When set | Example value |
|---|---|---|---|---|---|---|---|
| `UMAMI_HOST` | Umami base URL (server-side events) | Optional | No | Optional | No | Runtime | `https://analytics.example.com` |
| `UMAMI_WEBSITE_ID` | Umami website UUID (API) | Optional | No | Optional | No | Runtime | `<uuid>` |
| `VITE_UMAMI_HOST` | Umami script host (web client) | Optional | No | Optional | No | Build | `https://analytics.example.com` |
| `VITE_UMAMI_WEBSITE_ID` | Umami website UUID (web client) | Optional | No | Optional | No | Build | `<uuid>` |
| `PUBLIC_UMAMI_HOST` | Umami script host (marketing) | Optional | No | Optional | No | Build | `https://analytics.example.com` |
| `PUBLIC_UMAMI_WEBSITE_ID` | Umami website UUID (marketing) | Optional | No | Optional | No | Build | `<uuid>` |
| `SENTRY_DSN` | Sentry ingest DSN (API) | Optional | No | Optional | Yes | Runtime | `https://…@sentry.io/…` |
| `SENTRY_ENVIRONMENT` | Sentry environment tag override | Optional | No | Optional | No | Runtime | `staging` |
| `SENTRY_RELEASE` | Sentry release / deploy version | Optional | No | Optional | No | Runtime | `slugbase@1.2.3` |
| `VITE_SENTRY_DSN` | Public Sentry DSN (web client) | Optional | No | Optional | No | Build | `https://…@sentry.io/…` |
| `SENTRY_AUTH_TOKEN` | Auth token for source map upload | CI only | CI only | CI only | Yes | CI | `<Sentry auth token>` |
| `SENTRY_ORG` | Sentry org slug (source maps) | CI only | CI only | CI only | No | CI | `my-org` |
| `SENTRY_PROJECT` | Sentry project slug (source maps) | CI only | CI only | CI only | No | CI | `slugbase-web` |

---

### 8. Hosted — CI and deploy

Stored in Infisical `staging` / `prod`. Injected into GitHub Actions runners only — never client bundles or Fly/Worker runtime unless explicitly listed above.

| Key | What it does | Hosted | Self-host | Required | Secret | When set | Example value |
|---|---|---|---|---|---|---|---|
| `FLY_API_TOKEN` | Fly.io deploy token for `flyctl deploy` | Yes | No | CI only | Yes | CI | `<Fly deploy token>` |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token for `wrangler deploy` | Yes | No | CI only | Yes | CI | `<CF API token>` |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account id | Yes | No | CI only | No | CI | `<32-char hex id>` |
| `CF_ACCESS_CLIENT_ID` | Cloudflare Access service token id (staging smoke) | Yes | No | CI only | Yes | CI | `<service token id>` |
| `CF_ACCESS_CLIENT_SECRET` | Cloudflare Access service token secret | Yes | No | CI only | Yes | CI | `<service token secret>` |

---

### 9. Self-hosted — runtime and image build

| Key | What it does | Hosted | Self-host | Required | Secret | When set | Example value |
|---|---|---|---|---|---|---|---|
| `SERVE_WEB_CLIENT` | Serve web from API container | No | Yes | Optional | No | Runtime | `true` (Dockerfile preset) |
| `WEB_CLIENT_SERVER_BUILD` | RR7 server entry path | No | Yes | Optional | No | Runtime | `/app/packages/web/build/server/index.js` |
| `VITE_BILLING_ENABLED` | Hide billing UI | No | Build only | Optional | No | Build | `false` |
| `VITE_MAIL_ADMIN_UI` | Show SMTP workspace panel | No | Build only | Optional | No | Build | `true` |
| `VITE_OIDC_ADMIN_UI` | Show OIDC workspace panel | No | Build only | Optional | No | Build | `true` |
| `VITE_AI_BYO_CREDENTIAL` | Show BYO AI credential form | No | Build only | Optional | No | Build | `true` |
| `VITE_APP_BASE_URL` | Public URL for OIDC display | No | Build only | Optional | No | Build | `https://bookmarks.example.com` |
| `VITE_SENTRY_DSN` | Client error reporting | No | Optional | Optional | No | Build | Empty (default) |
| `VITE_UMAMI_HOST` | Client analytics | No | Optional | Optional | No | Build | Empty (default) |
| `VITE_UMAMI_WEBSITE_ID` | Client analytics site id | No | Optional | Optional | No | Build | Empty (default) |

All other `VITE_*` pricing keys: optional on self-host (billing UI hidden when `VITE_BILLING_ENABLED=false`).

---

### 10. Development and tooling (Tolgee / i18n)

Used locally and in CI for translation sync — not required at production runtime (catalogs are baked at build).

| Key | What it does | Hosted | Self-host | Required | Secret | When set | Example value |
|---|---|---|---|---|---|---|---|
| `TOLGEE_API_KEY` | Tolgee personal access token | Dev only | Dev only | Dev only | Yes | Dev | `<Tolgee PAT>` |
| `TOLGEE_PROJECT_ID` | Tolgee project id | Dev only | Dev only | Dev only | No | Dev | `4` |
| `VITE_TOLGEE_API_URL` | Tolgee API URL (web DevTools) | Dev only | Dev only | Dev only | No | Build | `https://tolgee.mdg-labs.dev` |
| `PUBLIC_TOLGEE_API_URL` | Tolgee API URL (marketing DevTools) | Dev only | Dev only | Dev only | No | Build | `https://tolgee.mdg-labs.dev` |

```bash
infisical run --env=dev -- pnpm i18n:push
infisical run --env=dev -- pnpm i18n:check:tolgee
```

---

## GitHub Actions secrets (not in Infisical)

These live in the **GitHub repository** secrets settings, not in the Infisical project:

| Key | What it does | Example value |
|---|---|---|
| `INFISICAL_DOMAIN` | Infisical instance URL for OIDC | `https://secrets.mdg-labs.dev/` |
| `INFISICAL_OIDC_IDENTITY_ID` | Infisical OIDC identity id for CI | `<identity uuid>` |

---

## Related docs

- [`.env.example`](../.env.example) — key names only (no values)
- [`local-development.md`](local-development.md) — Node version, Infisical login, `infisical run`
- [`defaults-and-constants.md`](defaults-and-constants.md) — product constants and Workers custom domains
- [`slugbase-mvp-spec.md` §15](slugbase-mvp-spec.md) — configuration model (deployment vs DB vs user prefs)
- Rule [`.cursor/rules/05-env-vars.mdc`](../.cursor/rules/05-env-vars.mdc) — four-step workflow when adding new keys

---

## Adding a new key

When introducing a new environment variable, complete all four steps in one commit:

1. Set the value in Infisical `dev` via CLI
2. Add the key name to [`.env.example`](../.env.example)
3. Add to [`packages/backend/src/config/env.schema.ts`](../packages/backend/src/config/env.schema.ts) (or client env types if `VITE_*` / `PUBLIC_*`)
4. Add a row to **this document**
