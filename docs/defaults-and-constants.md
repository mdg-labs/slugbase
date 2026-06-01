# SlugBase — Defaults & Constants

**Status:** Settled starting values for v1. **All values here are configuration** unless marked *fixed*. They are pinned so implementation tasks share one source of truth instead of each inventing a value. Tuning a value later does **not** require code changes (it's config), except where a value is a `SCREAMING_SNAKE_CASE` constant in code (noted).

**Precedence:** product rules in the spec win; this doc concretises spec values that were left "confirmable as config later." Where the spec states a number (e.g. Free cap = 50), that number is repeated here as the canonical default.

Naming for code constants follows rule `04-naming` (`SCREAMING_SNAKE_CASE`). Env-driven values follow rule `05-env-vars`.

---

## 1. Slugs & forwarding (spec §8)

| Constant | Value | Kind | Notes |
|---|---|---|---|
| Slug grammar | `^[a-z0-9][a-z0-9-]{0,63}$` | config | lowercase, digits, hyphen; 1–64 chars; no leading hyphen |
| Reserved slugs | `go`, `api`, `auth`, `health`, `version`, `login`, `logout`, `setup` | config | rejected at create/edit; avoids collision with routes |
| Slug uniqueness | per **workspace** | *fixed* | decision #7 |
| Max one slug per bookmark | 1 | *fixed* | §8.1 |

## 2. Bookmarks, lists, import/export (spec §6, §13)

| Constant | Value | Kind | Notes |
|---|---|---|---|
| Free bookmark cap | **50** / workspace | config | decision #14; `FREE_BOOKMARK_CAP` |
| Pagination default page size | 24 | config | card grid default |
| Pagination size options | 24 / 48 / 96 | config | |
| Pagination max page size | 100 | config | hard ceiling on `pageSize` |
| Import max bookmarks / request | 5,000 | config | `MAX_IMPORT_BOOKMARKS` (§13) |
| Import Netscape HTML max size | 5 MB | config | reject larger uploads |
| Metadata/favicon cache TTL | 7 days | config | SSRF-safe fetch cache (§6.4, §11.10) |

## 3. Auth, sessions, tokens, MFA (spec §5)

| Constant | Value | Kind | Notes |
|---|---|---|---|
| Session TTL | 30 days, sliding | config | DB-backed; individually revocable (§5.3) |
| Max API tokens / user | 10 | config | `MAX_API_TOKENS_PER_USER` |
| API token prefix | `slb_` | config | for display + leak scanning |
| MFA backup codes | 10, single-use | config | shown once, stored hashed (§5.7) |
| Password min length | 12 | config | no forced composition; strength meter (§5.4) |
| Verification/reset token TTL | 1 hour | config | hashed, time-limited (§5.5) |
| `INVITATION_TTL_DAYS` | 7 days | config | Invitation token lifetime; hashed token only (§4.2) |
| Public registration default | off | config | on for hosted; `PUBLIC_REGISTRATION` (§5.2) |
| Email verification required | hosted: yes | config | `EMAIL_VERIFICATION_REQUIRED` (§5.5) |

## 4. Rate limits (spec §18)

Per-IP **and** per-account where applicable; response 429.

| Endpoint | Limit | Kind |
|---|---|---|
| Login | 10 / minute | config |
| Registration | 5 / hour | config |
| Password reset | 5 / hour | config |
| API token creation | 20 / hour | config |
| Contact form (marketing) | 5 / hour / IP | config |

## 5. Billing, plans, entitlements (spec §12)

| Constant | Value | Kind | Notes |
|---|---|---|---|
| Workspaces per Free account | 1 | *fixed (entitlement)* | decision #30 |
| Free: AI / team sharing / audit log | off | *fixed (entitlement)* | §12.2 |
| Personal / Team / supporter: bookmarks | unlimited | *fixed* | §12.1 |
| Team base seats | 5 | config | illustrative; Fast-Follow tuning (#17) |
| Downgrade grace period | 7 days after period end | config | then archive overflow (§12.5) |
| Archive selection rule | keep most-recently-**accessed**; tiebreak most-recently-**created**; archive remainder over cap | config | deterministic, documented (§12.5) |
| AI suggestion cache TTL | 30 days | config | keyed by (workspace, user, canonical URL, output language) (§11.2) |

## 6. Pricing (illustrative — config + marketing only, never in app logic)

Per spec §12.1 and §23.4: prices, the supporter price/deadline, and exact seat counts live in deployment configuration and the marketing site. The prototype's `$4`/`$9`/`$59` and "25 members" are **placeholders**, not commitments. The paid individual tier is **"Personal"** (never "Pro").

---

## 7. Environment variables — config reference inventory (spec §15)

Keys are registered incrementally per task (rule `05-env-vars`). Full categories live in spec §15. All keys are stored at the **Infisical environment root** for project `slugbase-cloud` (no subfolders).

| Key | Purpose | Environments | Default / notes |
|---|---|---|---|
| `SERVE_WEB_CLIENT` | When `true`, Nest serves the bundled React Router v7 web client on the same port via `@react-router/express` (combined self-host image) | `development` (optional local combined-mode testing); combined Docker image | `false` for local API-only dev; combined `Dockerfile` sets `true` |
| `WEB_CLIENT_SERVER_BUILD` | Absolute path to the RR7 server build entry (`index.js`) | Required when `SERVE_WEB_CLIENT=true` | Optional when web serving disabled; combined image uses `/app/packages/web/build/server/index.js` |
| `SESSION_TTL_DAYS` | Session sliding-window TTL in days (spec §5.3, def §3) | `development` | `30` (default); integer |
| `MFA_TOTP_ISSUER` | Authenticator app issuer label for TOTP (spec §5.7) | `development` | `SlugBase` (default) |
| `RATE_LIMIT_LOGIN_MAX` | Max requests per window for login / register / MFA challenge (per IP) — spec §18, def §4 | `development` | `10` (default) |
| `RATE_LIMIT_LOGIN_TTL_SECONDS` | Window size in seconds for the `ip` throttler | `development` | `900` (15 min) |
| `RATE_LIMIT_TOKEN_CREATION_MAX` | Max token-creation requests per window (per session) — spec §18, def §4 | `development` | `20` (default) |
| `RATE_LIMIT_TOKEN_CREATION_TTL_SECONDS` | Window size in seconds for the `user-hour` throttler | `development` | `3600` (1 hr) |
| `OPENAPI_INTERACTIVE_DOCS` | When `true`, serves Scalar interactive API docs at `GET /docs`; `GET /openapi.json` is always published (spec §18) | `development` | `true` (default); set `false` to disable interactive UI |
| `OPENAI_API_KEY` | OpenAI API credential for AI bookmark suggestions (spec §11.2) | `development` (optional); hosted `staging`/`production` | Empty = AI disabled (no-op); self-hosted BYO key may also be set via encrypted workspace settings |
| `OPENAI_MODEL` | OpenAI chat model id for suggestions | `development` | `gpt-4o-mini` (default) |
| `STRIPE_SECRET_KEY` | Stripe API secret for hosted billing (spec §11.4) | `staging`/`production` (hosted) | Empty = no-op billing / full entitlements (self-host) |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret for idempotent event processing (spec §11.4) | hosted | Required when Stripe billing is enabled |
| `STRIPE_PRICE_PERSONAL` | Stripe price id for Personal recurring checkout | hosted | Config-driven; not hard-coded in app logic (§12.1) |
| `STRIPE_PRICE_TEAM` | Stripe price id for Team recurring checkout | hosted | Config-driven |
| `STRIPE_PRICE_TEAM_EXTRA_SEAT` | Stripe price id for Team extra-seat quantity updates | hosted | Optional; config-driven |
| `STRIPE_PRICE_SUPPORTER` | Stripe price id for one-time supporter / lifetime purchase | hosted | Grants Personal entitlement permanently (§12.1) |
| `TEAM_BASE_SEATS` | Included seats on Team plan | hosted | Default `5` (def §5); Fast-Follow tuning |
| `SUPPORTER_PROMOTION_END` | ISO-8601 end of supporter promotion window | hosted | Optional; empty = no deadline enforced in app |
| `DOWNGRADE_GRACE_PERIOD_DAYS` | Days after billing period end before overflow archive (spec §12.5, def §5) | `development` | Default `7` |
| `VITE_BILLING_ENABLED` | Show hosted billing settings UI | hosted `development`/`staging`/`production` | `false` on self-host |
| `VITE_PLAN_PRICE_PERSONAL_MONTHLY` | Display price for Personal (monthly) in billing UI | hosted | Illustrative; marketing-aligned |
| `VITE_PLAN_PRICE_PERSONAL_YEARLY` | Display price for Personal (yearly) in billing UI | hosted | Illustrative |
| `VITE_PLAN_PRICE_TEAM_SEAT` | Display price per Team seat in billing UI | hosted | Illustrative |
| `VITE_PLAN_PRICE_SUPPORTER` | Display price for supporter one-time offer | hosted | Illustrative |
| `VITE_SUPPORTER_PROMOTION_END` | ISO-8601 supporter offer deadline (display + countdown) | hosted | Optional |
| `VITE_TEAM_BASE_SEATS` | Included Team seats shown in plan table | hosted | Default `5` |
| `VITE_FREE_BOOKMARK_CAP` | Free cap shown in billing meter/table | hosted | Default `50` |
| `VITE_MAIL_ADMIN_UI` | Show workspace SMTP settings panel (admin UI mail source) | `development` | Default `true` when `VITE_BILLING_ENABLED` is false; `false` when operator-managed |
| `VITE_OIDC_ADMIN_UI` | Show workspace OIDC provider admin panel (DB-sourced providers) | `development` | Default `true` when `VITE_BILLING_ENABLED` is false |
| `VITE_AI_BYO_CREDENTIAL` | Show full AI credential form (BYO key) vs enable-only toggle | `development` | Default `true` when `VITE_BILLING_ENABLED` is false |
| `VITE_APP_BASE_URL` | Public API base URL for OIDC callback display in workspace settings | `development` | Falls back to `API_BASE_URL` at runtime when empty |
| `UMAMI_HOST` | Umami instance base URL for server-side event recording (spec §11.6) | hosted optional | Empty = no-op (self-host default) |
| `UMAMI_WEBSITE_ID` | Umami website UUID for server-side events | hosted optional | Required with `UMAMI_HOST` |
| `VITE_UMAMI_HOST` | Umami script host for web client analytics | hosted optional | Empty = no tracker / no consent banner |
| `VITE_UMAMI_WEBSITE_ID` | Umami website UUID for web client | hosted optional | Required with `VITE_UMAMI_HOST` |
| `PUBLIC_UMAMI_HOST` | Umami script host for marketing site | hosted optional | Empty = no tracker / no consent banner |
| `PUBLIC_UMAMI_WEBSITE_ID` | Umami website UUID for marketing site | hosted optional | Required with `PUBLIC_UMAMI_HOST` |
| `PUBLIC_PLAN_PRICE_PERSONAL_MONTHLY` | Display price for Personal (monthly) on marketing pricing page | hosted | Illustrative; aligned with `VITE_PLAN_PRICE_PERSONAL_MONTHLY` |
| `PUBLIC_PLAN_PRICE_PERSONAL_YEARLY` | Display price for Personal (yearly) on marketing pricing page | hosted | Illustrative |
| `PUBLIC_PLAN_PRICE_TEAM_SEAT` | Display price per Team seat (monthly) on marketing pricing page | hosted | Illustrative |
| `PUBLIC_PLAN_PRICE_TEAM_SEAT_YEARLY` | Display price per Team seat (yearly) on marketing pricing page | hosted | Optional; falls back to monthly |
| `PUBLIC_PLAN_PRICE_SUPPORTER` | Display price for supporter one-time offer on marketing site | hosted | Illustrative |
| `PUBLIC_SUPPORTER_PROMOTION_END` | ISO-8601 supporter offer deadline (marketing countdown) | hosted | Optional |
| `PUBLIC_TEAM_BASE_SEATS` | Included Team seats shown on marketing pricing page | hosted | Default `5` |
| `PUBLIC_FREE_BOOKMARK_CAP` | Free cap shown on marketing pricing page | hosted | Default `50` |
| `PUBLIC_FRONTEND_ORIGIN` | App origin for marketing CTAs (sign-in, register) | all | Same as `FRONTEND_ORIGIN` |
| `MARKETING_ORIGIN` | Public marketing Workers URL for CI smoke (`GET /health`, `/version`) | `staging` / `production` | e.g. `https://slugbase-staging-marketing.<account>.workers.dev` |
| `FLY_API_TOKEN` | Fly.io deploy token for `flyctl deploy --app` | `staging` / `prod` | CI OIDC via Infisical only; read from runner env, never `${{ env.* }}` |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token for `wrangler deploy` | `staging` / `production` | CI OIDC via Infisical only |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account id for Workers deploy | `staging` / `production` | CI OIDC via Infisical only |
| `PUBLIC_CONTACT_ENDPOINT` | Absolute URL for `POST /contact` (marketing form target) | all | e.g. `{APP_BASE_URL}/contact` |
| `PUBLIC_TURNSTILE_SITE_KEY` | Cloudflare Turnstile site key for marketing contact form | hosted | Empty = dev/no-op challenge token path |
| `SENTRY_DSN` | Sentry ingest DSN for API error reporting (spec §11.7) | `development` (optional); hosted `staging`/`production` | Empty = no-op (self-host default) |
| `SENTRY_ENVIRONMENT` | Sentry environment tag override | optional | Defaults to `NODE_ENV` |
| `SENTRY_RELEASE` | Sentry release identifier (deploy version) | optional | Empty = omitted from SDK init |
| `SENTRY_AUTH_TOKEN` | Sentry auth token for source map upload at build time | CI / release build only | Empty = skip upload; do not commit |
| `SENTRY_ORG` | Sentry organization slug for source map upload | CI / release build only | Required with `SENTRY_AUTH_TOKEN` |
| `SENTRY_PROJECT` | Sentry project slug for source map upload | CI / release build only | Required with `SENTRY_AUTH_TOKEN` |
| `VITE_SENTRY_DSN` | Public Sentry DSN for web client error reporting | hosted optional | Empty = client SDK not initialized |

---

## Change policy

- Changing a **config** value: update the deployment configuration / config schema default + this table. No code logic change.
- Changing a **`SCREAMING_SNAKE_CASE` code constant**: update the constant + this table in the same commit.
- Changing a **fixed** value: requires a spec decision update first (these encode product/security invariants).
