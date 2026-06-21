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
| Slug uniqueness | per **owner** within workspace | *fixed* | decision #7 |
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
| Remember-me session TTL | 90 days, sliding | config | When login remember-me is checked (§5.3) |
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
| `TEAM_MIN_SEATS` | **2** | *fixed* | decision #17; Team checkout and subscription floor (§12.2) |
| Downgrade grace period | 7 days after period end | config | then archive overflow (§12.5) |
| Archive selection rule | keep most-recently-**accessed**; tiebreak most-recently-**created**; archive remainder over cap | config | deterministic, documented (§12.5) |
| AI suggestion cache TTL | 30 days | config | keyed by (workspace, user, canonical URL, output language) (§11.2) |

## 6. Pricing (illustrative — config + marketing only, never in app logic)

Per spec §12.1 and §23.4: prices, the supporter price/deadline, and exact seat counts live in deployment configuration and the marketing site. The prototype's `$4`/`$9`/`$59` and "25 members" are **placeholders**, not commitments. Updated illustrative values for #318: Personal €3/seat/mo, Team €4/seat/mo, Supporter €49 one-time. The paid individual tier is **"Personal"** (never "Pro").

---

## 7. Environment variables

Full key inventory (hosted vs self-hosted, examples, Phase environments): **[`environment-variables.md`](environment-variables.md)**.

Machine-readable key list (names only): [`.env.example`](../.env.example). Backend validation: [`packages/backend/src/config/env.schema.ts`](../packages/backend/src/config/env.schema.ts).

When adding a new key, follow rule `05-env-vars.mdc` (Phase + `.env.example` + schema + update `environment-variables.md`).

### Sentry release auto-derivation

The Sentry release identifier (`SENTRY_RELEASE` for the API, `VITE_SENTRY_RELEASE` for the web client) is **auto-derived** from root `package.json` `version` field (format: `slugbase@<version>`):

- **API** (`SENTRY_RELEASE`): when the env var is unset, `sentry-error-reporting.service.ts` reads root `package.json` at startup and formats the release as `slugbase@<version>`. CI also derives the string and exports it for Fly.io deploy steps.
- **Web** (`VITE_SENTRY_RELEASE`): inlined at build time via Vite `define`. CI sets this from the root `package.json` version; no extra GHA secret required.
- **Override**: setting `SENTRY_RELEASE` or `VITE_SENTRY_RELEASE` explicitly still works — the auto-derived value is only a fallback.
- **Root version bump**: the release version is bumped during the release promotion workflow (`release published` on `main`).

---

## 8. Hosted Workers custom domains (spec §14.7, §22.5–22.7)

CI deploys attach public hostnames via wrangler `routes` with `custom_domain: true`. Staging routes live in committed `wrangler.jsonc`; production hostnames are swapped in `.github/scripts/pack-production-worker-artifacts.sh` (worker script name + domain).

| Surface | Worker script (staging / production) | Custom domain (staging / production) | Deploy config |
|---|---|---|---|
| Web app | `slugbase-staging-web` / `slugbase-production-web` | `staging-cloud.slugbase.app` / `cloud.slugbase.app` | `build/server/wrangler.json` (generated by `react-router build` from `packages/web/wrangler.jsonc`) |
| Marketing | `slugbase-staging-marketing` / `slugbase-production-marketing` | `staging.slugbase.app` / `slugbase.app` | `packages/marketing/wrangler.jsonc` / `wrangler.production.jsonc` (packed) |
| Admin portal | `slugbase-staging-admin` / `slugbase-production-admin` | `staging-admin.slugbase.app` / `admin.slugbase.app` | `packages/admin/fly.toml` |

**Operator follow-up — admin Fly apps (first time only):** create Fly apps before the first admin deploy:

```bash
fly apps create slugbase-staging-admin --org <org>
fly apps create slugbase-production-admin --org <org>
```

Set Phase keys per admin PRD §11.1 (`ADMIN_URL`, `ADMIN_BOOTSTRAP_*`, SMTP reuse, optional `SENTRY_DSN_ADMIN`). Remove `ADMIN_BOOTSTRAP_EMAIL` and `ADMIN_BOOTSTRAP_PASSWORD` from Phase after the first platform admin is bootstrapped. Configure Cloudflare Access on `staging-admin.slugbase.app` / `admin.slugbase.app` before exposing the portal.

**Operator follow-up:** staging smoke (`.github/scripts/smoke-staging-health.sh`) probes `APP_BASE_URL` and `FRONTEND_ORIGIN` via `/health` and `/version`; marketing liveness is `GET ${MARKETING_ORIGIN}/` (site root, HTTP 200) — not `/health` or `/version` on the static marketing Worker. Admin smoke (`.github/scripts/smoke-admin-health.sh`) probes `GET ${ADMIN_URL}/health`. Requires a successful staging deploy after merge. Staging hostnames sit behind Cloudflare Access; set `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` in the GHA `staging` environment so smoke sends service-token headers. First deploy creates Worker scripts and custom domains when the `slugbase.app` zone is on the deploy Cloudflare account and the API token has Workers + DNS permissions.

---

## Change policy

- Changing a **config** value: update the deployment configuration / config schema default + [`environment-variables.md`](environment-variables.md). No code logic change.
- Changing a **`SCREAMING_SNAKE_CASE` code constant**: update the constant + [`defaults-and-constants.md`](defaults-and-constants.md) in the same commit.
- Changing a **fixed** value: requires a spec decision update first (these encode product/security invariants).
