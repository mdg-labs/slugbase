# SlugBase — Architecture

---

## 1. Stack

| Layer | Technology | Rationale |
|---|---|---|
| Language | TypeScript 5.x, `strict`, `noUncheckedIndexedAccess`; no `any` (D5) | One language across server, worker, web and operator console |
| Runtime | Node.js 24 LTS (upgrade policy Q7) | Current LTS through April 2028; native `fetch`, `node:test`-free (Vitest), stable ESM |
| Workspace | pnpm 10 workspaces + Turborepo | Cached lint/typecheck/test/build per package; one lockfile per repository |
| HTTP server | Hono on `@hono/node-server` (D12; fallback Q19) | Small surface, Web-standard `Request`/`Response`, first-class Zod + OpenAPI (`@hono/zod-openapi`), middleware model that makes the security chain explicit (§4) |
| Validation & contracts | Zod 4 — request, response and env schemas; OpenAPI 3.1 generated from them and committed | One contract source; drift fails CI (doc 04 §1) |
| Persistence | PostgreSQL 18 (D6; CE supports 17 and 18, Q3) via `postgres` (porsager) driver | Fast, pipelining driver with good transaction ergonomics and `SET LOCAL` support |
| ORM / migrations | Drizzle ORM + drizzle-kit (D7) | Typed queries close to SQL; generated, committed, forward-only migrations |
| Search | Postgres full-text (`tsvector`, `simple` + `german`/`english` configurations) + `pg_trgm` for slug/title prefix and fuzzy match | No search service to operate; adequate far past launch scale (§9.3) |
| Jobs | pg-boss on Postgres (D15) | Durable queue, retries, schedules, singleton jobs; no broker |
| Sessions | DB-backed, opaque tokens, hashed (D10) | Revocation without blocklists |
| Password hashing | argon2id (`@node-rs/argon2`), OWASP parameters (m=19 MiB, t=2, p=1) as the floor | Memory-hard, native binding, no node-gyp |
| MFA | TOTP via `otpauth`; QR via `qrcode` | RFC 6238; backup codes hashed |
| OIDC | `openid-client` v6 | Certified relying-party library; PKCE, nonce, state handled correctly |
| Mail rendering | React Email templates → HTML + text, sent through the mail port | Same component model as the app, previewable, i18n-aware |
| Web app | React 19 + Vite SPA, TanStack Router + TanStack Query (D13) | Static assets, typed routes and search params (filters live in the URL), cache-first data fetching |
| UI system | coss ui (Base UI + Tailwind CSS v4), vendored in `@slugbase/ui`; `lucide-react`; `cmdk`-equivalent coss Command for the palette (D13) | One accessible component vocabulary; copy-and-own |
| i18n | `i18next` + `react-i18next`; ICU plural rules; EN + DE catalogs (D19) | Mature, typed keys via generated declarations |
| Marketing site (Cloud) | Astro, static, zero-JS by default; served by nginx (doc 11) | Fast, cacheable, no runtime |
| Operator console (Cloud) | Hono + Vite/React SPA on `@slugbase/ui`, separate service and origin (doc 07 §6) | Never part of the customer app or the CE image |
| Tests | Vitest (unit + integration against a real Postgres), Playwright (e2e) | Doc 08 |
| Logs / telemetry | `pino` JSON logs; OpenTelemetry traces and metrics, Sentry-protocol error reporting behind the error port | Vendor-neutral; Cloud's backends are self-hosted and lightweight at launch (D27) |
| Container images | Distroless/`node:24-slim` multi-stage builds, non-root, read-only root filesystem | Small attack surface; any container platform or orchestrator runs them unchanged |

### Why TypeScript and not Go

Go (as in Hoserva) would give a single static binary and lower memory per process. It was declined for SlugBase because:

- **The billing service SlugBase Cloud integrates with is TypeScript too** (D29). One stack across both lets agents change both sides of the billing integration in one idiom.
- **The workload is I/O-bound.** SlugBase's hot paths are indexed lookups (`/go`, lists, search). Node handles them at thousands of requests per second per core-bound process; CPU is not the scaling limit — Postgres is (§9).
- **One language for the whole stack** (server, web, console, marketing, email templates, contracts) lets agents make a full-stack change in one idiom, with one type system across the API boundary.

### Why a static SPA and not SSR

The application is entirely behind sign-in; there is nothing to server-render for SEO (the marketing site is separate and static). A static SPA means **no Node SSR process to scale or secure**, assets are content-hashed and cached at the CDN forever, and CE ships as one container. The first implementation's React Router SSR server was a second runtime with its own proxying of API calls and its own failure modes — removed.

### Why PostgreSQL only

Settled (D6). It is also the feature that makes the security model work: row-level security (D8), transactional DDL for safe migrations, and a scaling path (replicas, partitioning, managed offerings) that every orchestrator supports.

---

## 2. Runtime topology

### 2.1 CE

```
                 operator's reverse proxy (TLS)
                              │
                              ▼
           ┌──────────────────────────────────────┐
           │  slugbase  (one image)                │
           │                                      │
           │  server ── serves  /api/*  /go/*     │
           │          ── serves  SPA static assets │
           │  worker ── jobs + schedules           │  (same image, second container
           │                                      │   or `--with-worker` in-process)
           └───────────────┬──────────────────────┘
                           │
                           ▼
                    PostgreSQL 18
```

- `docker compose up` brings up `slugbase` (server), `slugbase-worker` (same image, `worker` command) and `postgres`. A single-container mode (`slugbase serve --with-worker`) runs the worker loop inside the server process for the smallest installs (Q11).
- Migrations run on startup in CE (`server` takes a Postgres advisory lock, applies pending migrations with a `lock_timeout`, releases it); a CE operator never runs a separate migration step (D25).
- No other service is required. Mail, AI, OIDC and error reporting are optional adapters configured through environment variables (§6).

### 2.2 Cloud

```
     Browser ──► CDN (EU edge: TLS, static cache, WAF rules)
                      │
                      ▼
     deployment platform — reverse proxy
        ├── slugbase.app            → marketing   (static)
        ├── app.slugbase.app        → server ×N   (/api/*, /go/*, SPA assets)
        ├── operator console        → console     (own origin, access-restricted)
        └── worker ×1..N            (no ingress)
                      │
                      ▼
              PostgreSQL 18 (primary; replicas later; no host port) ── WAL archive + base backups
                      ▲
     CI ── private tunnel ── migrate (new image), before each deploy

     server ──► billing service API
     server ◄── signed billing events (a `machine` route, §4)
                billing service ◄──► payment provider (SlugBase never calls the payment provider)
```

- **Images** (in a private registry, D16): one Cloud app image (server + worker + migrate commands — CE composed with the Cloud modules), plus the marketing site and the operator console. CE's public image is `slugbase/slugbase`, mirrored to GHCR for operators (Q12).
- **Ingress** is the deployment platform's reverse proxy; a **CDN** sits in front for TLS at the edge, caching of hashed SPA assets and the marketing site, and basic WAF/rate rules. `/api/*` and `/go/*` are never cached (`Cache-Control: no-store`).
- **Postgres** runs on EU servers the operator controls, with WAL archiving to EU object storage; Cloud doc 07 §5 covers backups, PITR and the move to a dedicated database host.
- **Private access without host ports** (D26): no SlugBase resource maps a host port. Internal access (operator tools, CI's migrate step) goes through a private tunnel that reaches containers by name. Non-production hostnames sit behind an SSO gate, which lets through only the `machine` routes and the probes CI needs.
- **Billing is an external billing service** (D29), not part of SlugBase's deployment. SlugBase's server calls its API (checkout, subscription changes, billing documents), and the service delivers signed events to a `machine` route. Customers never see the billing service; SlugBase's frontend shows all billing UI (Cloud doc 06).
- **Migrations in Cloud run from CI** (D25): before each deploy, CI runs the new image's `migrate` through the private tunnel as a separate step; the deploy is triggered only after it succeeds. The Cloud app runs with `MIGRATE_ON_START=false` (Cloud doc 07 §5.5).

### 2.3 One origin

The SPA, the API and `/go` share one origin per deployment (D11). Consequences, all intended:

- No CORS configuration exists for the application; the server rejects cross-origin state-changing requests outright (§4, step 5). Forms on the marketing site do not call the app origin from the browser: the marketing site proxies their endpoints same-origin to the Cloud server over the internal network (Q41), so no CORS header is ever emitted anywhere.
- The session cookie is `__Host-slugbase_session` — host-only, `Path=/`, `Secure`, `HttpOnly`, `SameSite=Lax`. A `__Host-` cookie cannot be set or overwritten by a sibling subdomain.
- The browser search-engine template is `https://app.slugbase.app/go/%s` (Cloud) or `https://<operator-host>/go/%s` (CE). `SameSite=Lax` cookies are sent on these top-level navigations, so `/go` works from the address bar.
- The marketing site and the operator console are **different origins** and never receive the session cookie.

---

## 3. Processes

All application processes are one image, one codebase, three commands:

| Command | Role | Replicas | State |
|---|---|---|---|
| `server` | HTTP: `/api/*`, `/go/*`, SPA static files, `/health`, `/ready`, `/version`, `/metrics` (internal port) | 1 → N | None |
| `worker` | pg-boss consumers and schedules: metadata/favicon fetch, AI suggestion jobs, email sending, usage-counter flush, retention purges, and the jobs Cloud modules register (billing reconciliation, downgrade-overflow processing) | 1 → N (schedules are singletons) | None |
| `migrate` | Applies pending migrations for the composed chain (§7.3) under an advisory lock with `lock_timeout`, then exits. CE: invoked by `server` on startup (`MIGRATE_ON_START`, default on). A managed deployment may set `MIGRATE_ON_START=false` and run it as a separate deploy step instead; Cloud runs it from the CI deploy job, never from a Cloud container (D25) | One-shot | None |

**Rules every process follows** (they are what makes D14 true):

1. **No local state.** No files written outside `/tmp` (tmpfs); uploads (Netscape HTML import) are streamed and parsed in memory under a size cap; no in-memory caches that must be coherent across replicas. Process-local caches are allowed only for immutable data (compiled templates, the entitlement catalog) or with a short TTL where staleness is harmless (§8.3).
2. **Graceful shutdown.** On `SIGTERM`: stop accepting connections, finish in-flight requests (deadline 25 s), let pg-boss finish or release active jobs, close the pool.
3. **Readiness ≠ liveness.** `/health` answers if the process runs; `/ready` answers only when the database is reachable and migrations are at the version the build expects. Orchestrators route traffic on `/ready`.
4. **Every job is idempotent** and safe to retry; every schedule is a pg-boss singleton, so N workers never double-run a schedule.
5. **Configuration only from the environment**, validated at startup by a Zod schema; a production process with missing or weak secrets refuses to start (§6).

---

## 4. Request lifecycle

The server's middleware chain, in order. The order is part of the security model; doc 10 §4 states the invariants it enforces.

| # | Stage | What it does |
|---|---|---|
| 1 | **Request context** | Request ID (accepts the CDN's, else generates), structured logger child, OpenTelemetry span; trusted-proxy handling — client IP is taken from `X-Forwarded-For` only across the configured number of trusted hops (`TRUSTED_PROXY_HOPS`) |
| 2 | **Security headers** | `Content-Security-Policy` (strict: `default-src 'self'`; scripts by hash/nonce only, no inline, no eval; `frame-ancestors 'none'`; `img-src 'self' data:` — favicons come from our own proxy), `Strict-Transport-Security`, `Referrer-Policy: strict-origin-when-cross-origin` (`no-referrer` on `/go` responses), `X-Content-Type-Options`, `Cross-Origin-Opener-Policy: same-origin`, `Permissions-Policy` minimal |
| 3 | **Body limits** | Per-route maximum body size (default 64 KiB; import 5 MiB); JSON only on `/api/*` mutations except the import upload |
| 4 | **Authentication** | `Authorization: Bearer slb_…` → API-token principal (cookies are then ignored entirely); else the session cookie → session principal (sliding expiry, revocation checked against the DB on every request); else anonymous |
| 5 | **Cross-site request protection** | For every browser-facing `POST/PUT/PATCH/DELETE` — cookie-authenticated **or anonymous** (login, registration, setup, password reset): the `Origin` header must equal the deployment origin, and `Sec-Fetch-Site`, when present, must be `same-origin`; `Content-Type` must be `application/json` (or `multipart/form-data` on the import route). Bearer-token requests are exempt (no ambient credential). There is **no path exemption list** (Q5). The only other exemptions are declared **in the route definition**, typed and reviewable: `audience: 'machine'` (inbound service events — in Cloud, the billing service's events: cookies are stripped before the handler, and the payload is accepted only with a valid sender signature and timestamp, Q69) and `audience: 'marketing-form'` (form endpoints a Cloud module serves through the marketing site's same-origin proxy — `Origin` must equal the configured marketing origin, cookies are stripped, challenge-port verification is required, Q41) |
| 6 | **Rate limiting** | Through the rate-limit port (§8.2): per-IP and per-principal buckets; strict buckets on login, MFA, registration, password reset, invitation accept, token creation, contact |
| 7 | **Tenant resolution** | The tenant-resolution port derives the **active workspace** from the session (or, for API tokens, from the single workspace the token is bound to — no override header, Q40); membership and role are loaded once per request |
| 8 | **Validation** | Zod request schema; unknown fields rejected (`strict`) |
| 9 | **Authorization** | Route-declared policy (`requires: { role: 'admin' }`, `entitlement: 'sharing.teams'`, `instanceAdmin: true`) checked before the handler; record-level checks inside the service layer (§5.4) |
| 10 | **Handler → service → repository** | Business logic in services; all data access through the workspace-scoped repository inside a tenant transaction (§5.3) |
| 11 | **Response** | Zod response schema validates in development and CI (strips undeclared fields in production); errors mapped to RFC 9457 problem details (doc 04 §3); no stack traces or internal identifiers in responses |
| 12 | **Audit and telemetry** | Audit events for significant actions are written in the same transaction as the change; metrics and logs (redacting the fields listed in doc 10 §4) |

**Rule for an `audience: 'machine'` route** (service events): no session or token principal is ever derived; the handler verifies the sender's signature and timestamp before reading the payload, applies each event at most once by its id, and changes only the state the event is allowed to change (for Cloud's billing events: the workspace's billing state, Cloud doc 06). Where the sender is a third party without signatures, the handler reads only the object identifier and re-fetches the object from the provider.

`/go/<slug>` runs the same chain but is a `GET` that returns `302` (or the disambiguation page in the SPA) and records usage asynchronously (§8.1).

---

## 5. Multi-tenancy

### 5.1 Model

Every tenant-owned row carries `workspace_id`. An account can be a member of several workspaces with a role in each (owner, admin, member). One workspace is **active** per session; switching is an explicit API call that verifies membership. There is no "default tenant" and no single-tenant mode — a CE install is a deployment that happens to have few workspaces.

### 5.2 Tenant resolution is a port

`TenantResolver` turns an authenticated request into `{ workspaceId, memberId, role }`. The v1 adapter reads the session's active workspace (and, for API tokens, the token's workspace binding). Subdomain or path tenancy would be a different adapter; no application code changes.

### 5.3 Enforcement layer 1 — the scoped data-access layer

Services never receive a raw database handle. They receive a `TenantTx` obtained from `withTenant(ctx, fn)`, which:

1. opens a transaction on the application role,
2. runs `SET LOCAL app.workspace_id = $1, app.account_id = $2` (transaction-scoped, so it is safe with connection pooling in transaction mode),
3. exposes repositories whose every query is built with the workspace predicate already applied and every insert stamped with `workspace_id`.

A lint rule forbids importing the raw `db` handle outside `@slugbase/db`'s own internals and the migration/admin tooling.

### 5.4 Enforcement layer 2 — row-level security

Every tenant-owned table has `ENABLE` **and** `FORCE ROW LEVEL SECURITY`, and a policy of the form `workspace_id = current_setting('app.workspace_id')::uuid`. The tables are owned by `slugbase_owner` (no login); migrations run as `slugbase_migrator`; the application connects as `slugbase_app`, which **does not own the tables** and has no `BYPASSRLS`; the Cloud operator console reads through `slugbase_console_ro` (doc 05 §2 defines all roles and grants). Consequently:

- a query that forgets the workspace predicate returns nothing rather than another tenant's rows;
- a query run outside `withTenant` (no `app.workspace_id` set) fails closed — `current_setting(..., true)` yields NULL and the policy matches no rows;
- the few cross-tenant operations that must exist (session lookup, login by email, invitation acceptance, inbound billing events (Cloud), scheduled purges, the CE instance admin's workspace list) run as **named, audited system operations** through a separate `slugbase_system` role or `SECURITY DEFINER` functions with a narrow signature (doc 05 §3), never by turning RLS off.

Within a workspace, sharing rules (owner, shared with me, shared via team, via a shared folder) are enforced by the service layer and its tests (doc 02 §8); RLS guarantees the workspace boundary, the service guarantees the record boundary.

### 5.5 Tests that defend isolation

The integration suite contains a **cross-tenant matrix**: for every repository method and every API operation, a fixture with two workspaces asserts that workspace B's data is invisible and immutable from workspace A — both through the API and by calling the repository directly with RLS as the only guard (the scoped predicate deliberately removed in a test-only build of the repository). Doc 08 §4.

---

## 6. Ports and adapters

Every capability that leaves the process or the database is a port (D22). The composition root selects one adapter per port from configuration; application code depends only on the port.

| Port | Responsibility | CE default | CE optional | Cloud adapter |
|---|---|---|---|---|
| `MailPort` | Send a typed transactional message; report availability | Log-only (flows degrade and say so) | SMTP | The same SMTP adapter, via an EU relay — one interface for both editions (Q9) |
| `AiSuggestPort` | URL + metadata + language → title, slug, tags, confidence | Unavailable | OpenAI-compatible HTTP endpoint (covers OpenAI, Mistral, local models) | EU provider via the OpenAI-compatible adapter (Q8) |
| `IdentityPort` | List OIDC providers, run the OIDC handshake, map claims | None configured | `OIDC_<SLUG>_*` providers | Same, operator-configured |
| `BillingPort` | Checkout, plan state, seat and plan changes, cancellation, billing-document list and PDFs, event intake | No-op: full entitlements | — | Client of the external billing service, with signed event intake (Cloud doc 06) |
| `EntitlementSource` | Entitlement set for a workspace/account | Full/unlimited | — | Derived from billing state stored locally in the `cloud` schema, never from a live call to the billing service (Cloud doc 06) |
| `AnalyticsPort` | Consent-gated product events | No-op (CE never phones home, Q18) | — | A self-hosted analytics service (server-side events only for conversions) |
| `ErrorReportPort` | Capture exceptions with PII scrubbing | No-op (logs only) | Sentry-protocol DSN | The Sentry-protocol adapter, pointed at a self-hosted error tracker (D27) |
| `ChallengePort` | Verify a bot-protection solution | Disabled | Altcha (on-server HMAC) | Altcha |
| `EgressPort` | All server-initiated HTTP: DNS-resolve-then-validate (no private, loopback, link-local, CGNAT, metadata ranges; IPv4 and IPv6), pinned resolved IP, redirects re-validated, timeouts, size caps, content-type allowlist | Built-in (always on) | Outbound proxy URL | Built-in + outbound proxy (Q10) |
| `SecretBoxPort` | Envelope encryption of secrets at rest (MFA secrets) with key ID for rotation | AES-256-GCM, key from `ENCRYPTION_KEY` | — | Same; key in the deployment platform's environment (Cloud doc 07 §7), yearly rotation (D24, Q13) |
| `RateLimitPort` | Token buckets keyed by IP/principal/route | Postgres (unlogged table) | — | Postgres; Valkey adapter when measured (§8.2) |
| `BlobPort` | Reserved — no v1 feature stores files | — | — | — |

Adapters for CE live in the public repository; Cloud-only adapters (the billing client, the Cloud entitlement source) live in the private Cloud repository and reach CE only through the composition root (§7).

---

## 7. Open-core composition

How Cloud extends CE without forking it (D3). Doc 09 §3 covers the repository mechanics (submodule pinning, CI).

### 7.1 Server

CE exports one factory:

```ts
createServer({
  config,               // validated env
  adapters: { mail, ai, identity, billing, entitlements, analytics, errors, challenge, rateLimit, secretBox },
  modules: [ ... ],     // additional route/service/job modules
  migrations: [ ... ],  // additional migration sets, applied after CE's (§7.3)
})
```

- CE's own `main` calls it with CE adapters and no extra modules.
- Cloud's `main` calls it with its billing adapter, the Cloud entitlement source and the Cloud modules: a billing module (SlugBase-side billing routes for its own UI, an event endpoint declared `audience: 'machine'`, and the reconciliation of billing state), a module for the marketing site's forms (`audience: 'marketing-form'`), and Cloud registration rules (e.g. disposable-domain checks). Cloud doc 06 describes the billing module.
- A **module** contributes routes (with their OpenAPI schemas), services, pg-boss job handlers and schedules, and event subscribers. It receives the same tenant transaction, logger, ports and authorization helpers as core code — it cannot reach around them.
- **Domain events** are the extension points inside core flows: `workspace.created`, `member.joined`, `member.left`, `bookmark.created`, `account.deleted`, … Cloud's billing module subscribes (e.g. `member.joined` → seat recount) instead of core calling billing.

### 7.2 Web

CE's web package exports `createWebApp({ extensions })`. An extension contributes routes (e.g. `/settings/billing`), navigation items, and components for named **slots** that CE's shell renders (e.g. `sidebar.footer`, `entitlement.upgradeAction`, `settings.workspace.nav`; doc 03 §"Extension slots" is the complete, authoritative list and part of the contract in §7.4). Without extensions the slots render nothing — a CE build never contains billing UI. Cloud's web entry imports `createWebApp` plus its extensions and is built by Vite in the Cloud repository; the result is embedded in the Cloud `app` image exactly as CE embeds its own build.

### 7.3 Database

Each repository owns a **separate migration history in its own Postgres schema**:

| Order | Owner | Schema | Contents |
|---|---|---|---|
| 1 | CE | `public` | Product tables |
| 2 | Cloud | `cloud` | Cloud-only records (Cloud doc 06) |
| — | Cloud console | `console` | Operator accounts, sessions, audit, snapshots (doc 07 §6) |

Billing data does not live in SlugBase's database; it stays in the billing service (D29). `migrate` applies them in that order. Cloud tables may reference CE tables by foreign key; CE tables never reference Cloud tables. A CE schema change that would break a Cloud foreign key is a contract change (doc 09 §3).

### 7.4 Contracts

What Cloud may depend on, and therefore what CE must keep stable or version: the `createServer`/`createWebApp` signatures, the port interfaces, the module interface, the domain event catalog, the web slot names, the exported repositories and authorization helpers, and the `public` schema. Each lives in an explicitly exported entry point; anything not exported is not a contract.

---

## 8. Background work and shared state

### 8.1 Jobs

| Job | Trigger | Notes |
|---|---|---|
| `bookmark.fetchMetadata` | Bookmark created/URL changed | Through `EgressPort`; result cached per canonical URL (7 days) |
| `favicon.fetch` | First request for a host's favicon | Stored in Postgres (`bytea`, size-capped) and served by our own `/api/favicons/<host>` with long cache headers |
| `ai.suggest` | User asks for suggestions (sync with timeout, async fallback) | Cached per (workspace, account, canonical URL, language) for 30 days |
| `mail.send` | Any transactional mail | Retries with backoff; never blocks a request |
| `usage.flush` | Every 10 s | `/go` and opens increment an in-memory counter per process **only as a write buffer**; the buffer is flushed as one batched `UPDATE` (lost on crash: at most 10 s of counts — accepted, doc 10 §5) |
| `retention.purge` | Hourly schedule | Expired sessions, tokens, rate-limit buckets, audit beyond retention (doc 05 §6) |
| `billing.reconcile` (Cloud) | Daily schedule | Re-reads billing state from the billing service and corrects local drift (Cloud doc 06 §4.4) |
| `plan.downgradeOverflow` (Cloud) | A cancellation event, or the stored period end passing with a pending cancellation, plus grace | Archives over-cap bookmarks deterministically (doc 06 §5) |

### 8.2 Rate limiting

Token buckets in an `UNLOGGED` Postgres table, updated with a single `INSERT … ON CONFLICT DO UPDATE` per check. At launch scale this costs well under a millisecond per check. When rate-limit writes show up as a measurable share of database load, a Valkey adapter replaces it behind `RateLimitPort` (Q14) — the first and most likely reason to add Valkey at all.

### 8.3 Caching

- **SPA assets**: content-hashed, `immutable`, cached at the CDN and in the browser.
- **Entitlements**: per-request memoised; per-process cache keyed by `(workspace_id, entitlement_version)` with the version bumped on any plan change, so staleness is impossible rather than short.
- **Nothing else at v1.** The hot paths are indexed single-row lookups; a cache in front of them would add invalidation bugs without measurable benefit until well past the first scaling step (§9).

---

## 9. Scaling model

### 9.1 What scales how

| Component | Scales by | Limit that triggers the next step |
|---|---|---|
| `server` | More replicas behind the reverse proxy and CDN (stateless, D14) | CPU on the host; then more hosts |
| `worker` | More replicas (pg-boss distributes; schedules stay singleton) | Job latency SLOs |
| PostgreSQL | Vertical first (CPU, RAM, NVMe); then a PgBouncer pool, read replicas for read-heavy endpoints, a dedicated database host | Write throughput and connection count — the real ceiling for this product |
| Marketing | Static at the CDN | Effectively none |

### 9.2 Connection discipline

Every process uses a small pool (server: 10, worker: 5 by default). Before running more than ~8 replicas in total, PgBouncer in **transaction mode** goes in front of Postgres; the tenant context uses `SET LOCAL` (transaction-scoped) precisely so transaction pooling is safe (§5.3). No session-level state, advisory locks only via pg-boss or transaction-scoped `pg_advisory_xact_lock`.

### 9.3 The hot paths

- **`/go/<slug>`**: one indexed lookup over the member's own bookmarks plus a lookup over bookmarks shared with them (directly, via teams, via shared folders) — doc 05 §4 defines the indexes and an accessible-slug query that stays index-only. Target p95 under 30 ms at the server, excluding network.
- **Lists and search**: keyset pagination on `(workspace_id, …sort key, id)`, `tsvector` + `pg_trgm` indexes per workspace. Target p95 under 100 ms for libraries up to 50 000 bookmarks per workspace.
- **Writes**: small, single-row, plus audit rows. Usage counters are batched (§8.1), so `/go` traffic does not turn into write load.

### 9.4 Capacity of a single-server deployment

Cloud doc 07 §9 works through the numbers. In short: one well-sized EU server running the stateless processes plus Postgres comfortably serves **tens of thousands of registered accounts** for a product with SlugBase's request profile; splitting Postgres onto its own server and running several app replicas extends that into the **low hundreds of thousands**. Beyond that, the architecture is already shaped for an orchestrator with autoscaling and a managed or replicated Postgres — no application change, only a different runtime (D14, D16).

---

## 10. Security architecture (summary)

Doc 10 is the threat model; this is the shape that implements it.

- **Sessions** (D10): 32-byte random token, SHA-256 at rest, sliding 30-day expiry (90 with "remember me"), absolute cap 180 days, recent-auth window for sensitive actions (Q6), rotated on login, MFA completion and privilege changes; "sign out everywhere" deletes all rows for the account.
- **Credentials**: argon2id passwords (min. length 12, breached-password check against a local k-anonymity range list is Q15); TOTP with replay protection (last used step stored); backup codes hashed; API tokens `slb_` + 32 random bytes, hashed, scoped to one workspace and optionally read-only (Q16).
- **Cross-site** (§4 step 5): Origin + Fetch-Metadata checks on every cookie-authenticated mutation, JSON-only bodies, `SameSite=Lax`, strict CSP. No CSRF-token plumbing to forget.
- **Egress**: every outbound request through `EgressPort` (§6); a lint rule forbids `fetch`/`http` imports elsewhere.
- **Secrets at rest**: `SecretBoxPort` with key IDs; rotation re-encrypts lazily on read and in a background sweep.
- **Tenancy**: two layers (§5).
- **Supply chain**: pinned dependencies, lockfile-only installs, `pnpm audit` and OSV scanning in CI, Renovate with grouping, images built in CI only, SBOM and provenance attached to every image, image signing (Q17).
- **Admin surfaces**: the CE instance admin is a flag on an account inside the app (MFA required to use it); the Cloud operator console is a separate service, origin, account system and network allowlist — the customer app has no operator endpoints at all.

---

## 11. Configuration

- One Zod env schema per process type, composed from per-module fragments (Cloud modules add their own). Values come only from the process environment: the deployment platform's environment in Cloud, the operator's compose/env file in CE, a gitignored `.env` from `.env.example` in development (D24). The key inventory is generated from the schemas (doc 07 §7). Booleans parse with an explicit `envBoolean()` (`"false"` is false). Unknown `SLUGBASE_*` keys produce a startup warning.
- **Production refuses to start** when `SESSION_SECRET`/`ENCRYPTION_KEY` are missing or short, `APP_ORIGIN` is not HTTPS, or a configured adapter's required keys are missing.
- **No edition flag** (D4). Cloud's composition root sets Cloud defaults (public registration on, email verification required) by passing them in; CE's sets CE defaults (registration off). Both are overridable by env where doc 07 lists it.
- Client-side configuration is **not** built into the SPA bundle: the SPA fetches `/api/config` (public, cacheable per deployment) for the origin, enabled sign-in methods, locale defaults and entitlement-free feature flags. One SPA build therefore runs on any CE host — operators never rebuild the frontend.

---

## 12. Observability

- **Logs**: JSON via `pino`, one line per request with request ID, route template (never the raw path with slugs), status, latency, principal type, workspace ID (an internal UUID, never names or emails); redaction list in doc 10 §4.
- **Metrics**: OpenTelemetry metrics, exposed in Prometheus format on an internal port — request rate/latency per route, `/go` resolution outcomes, job queue depth and age, pool saturation, rate-limit rejections. At launch nothing scrapes it (D27): host health comes from the deployment platform's host and container metrics, database load from `pg_stat_statements`; a metrics stack is added when a measurement needs it.
- **Traces**: OpenTelemetry, sampled; database spans without bound parameters.
- **Errors**: `ErrorReportPort` (a self-hosted error tracker in Cloud); PII scrubbing before send; client-side reporting consent-gated (doc 11).
- **Uptime**: an external uptime monitor checks `/health` of every public host each minute and alerts via Discord (Cloud doc 07 §11).
- **Health**: `/health` (liveness), `/ready` (DB + migration level), `/version` (`{ name, version, commit, builtAt }`) — the deploy pipeline gates on `/version` (doc 07 §4).
