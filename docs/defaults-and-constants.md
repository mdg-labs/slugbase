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

Keys are registered incrementally per task (rule `05-env-vars`). Full categories live in spec §15.

| Key | Purpose | Infisical folder | Environments | Default / notes |
|---|---|---|---|---|
| `SERVE_WEB_CLIENT` | When `true`, Nest serves the bundled React Router v7 web client on the same port via `@react-router/express` (combined self-host image) | `/api` | `development` (optional local combined-mode testing); combined Docker image | `false` for local API-only dev; combined `Dockerfile` sets `true` |
| `WEB_CLIENT_SERVER_BUILD` | Absolute path to the RR7 server build entry (`index.js`) | `/api` | Required when `SERVE_WEB_CLIENT=true` | Optional when web serving disabled; combined image uses `/app/packages/web/build/server/index.js` |
| `SESSION_TTL_DAYS` | Session sliding-window TTL in days (spec §5.3, def §3) | `/api` | `development` | `30` (default); integer |

---

## Change policy

- Changing a **config** value: update the deployment configuration / config schema default + this table. No code logic change.
- Changing a **`SCREAMING_SNAKE_CASE` code constant**: update the constant + this table in the same commit.
- Changing a **fixed** value: requires a spec decision update first (these encode product/security invariants).
