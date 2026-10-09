# SlugBase — Development Workflow and Testing

## The problem

SlugBase is built almost entirely by agents (D21). An agent's work is only as good as the signal it can verify against, so the test system is designed around three needs:

1. **One command that means "done".** `pnpm gate` in each repository is the whole verification signal the executor runs before committing, the verifier re-runs independently, and CI mirrors (§6). Anything that matters and can run locally is in it.
2. **The dangerous properties are tested where they are enforced.** Tenant isolation is enforced by Postgres row-level security (D8), so it is tested against a real Postgres — never against a mock that would pass by construction. The same goes for migrations, sessions and the SSRF guard.
3. **Parallel lanes don't collide.** `/orchestrate` runs several executors in separate scratch clones at once. Every test that touches a database gets its own database (§3.2), so lanes never share state.

---

## 1. Local development

### 1.1 Prerequisites

| Tool | Version | Why |
|---|---|---|
| Node.js | 24.x (`.nvmrc`) | D5. `package.json` `engines` and a `preinstall` check enforce it |
| pnpm | 10.x (`packageManager` field) | Installed with `npm i -g pnpm@10` or Corepack where available |
| Docker + Compose plugin | current | Development Postgres and Mailpit; integration tests; image builds |
| `actionlint` | current | Only for workflow changes |
| GitHub CLI (`gh`) | current | Issues, pull requests and workflow runs. CE needs no package-registry token (§1.6) |

The development host is the maintainer's WSL2 machine. Nothing in the dev loop requires a public hostname, a tunnel or a cloud service.

### 1.2 Services

`compose.dev.yml` (CE) starts the shared development services, used by every checkout and every scratch clone on the machine:

| Service | Image | Port | Purpose |
|---|---|---|---|
| `postgres` | `postgres:18` | `54329` | Development database `slugbase_dev`, plus a superuser the test harness uses to create per-test databases (§3.2) |
| `mailpit` | `axllent/mailpit` | `1025` SMTP, `8025` UI | Catches every mail the SMTP adapter sends |

```bash
pnpm dev:services        # docker compose -f compose.dev.yml up -d --wait
pnpm dev:services:down
```

The port is deliberately not `5432`, so a developer's own Postgres never collides with it and an agent can never connect to the wrong one by default.

### 1.3 Running the app

```bash
pnpm install
pnpm dev:env             # copies .env.example to .env (gitignored) and fills generated dev SESSION_SECRET/ENCRYPTION_KEY
pnpm db:migrate          # applies the CE migration chain to slugbase_dev
pnpm db:seed             # demo instance: admin + 2 workspaces, members, teams, ~300 bookmarks, shared folders
pnpm dev                 # turbo: server (watch), worker (watch), web (Vite)
```

**One origin in development too** (D11). Vite serves the SPA on `http://localhost:5173` and proxies `/api`, `/go` and `/health` to the server on `:3000`. The browser only ever sees `localhost:5173`, so the session cookie, the Origin check and `SameSite` behave exactly as in production. In development the cookie is named `slugbase_session` without the `__Host-` prefix and without `Secure` (browsers refuse `__Host-` on plain HTTP); the server derives both from `APP_ORIGIN`'s scheme, not from a mode flag.

`.env` is created from the committed `.env.example`, whose defaults match `compose.dev.yml`. It is gitignored and never committed, and `pnpm dev:env` refuses to overwrite an existing one. There is no secrets manager in the dev loop (D24). Production refuses to start with the dev defaults (doc 01 §11).

### 1.4 Seed data

`pnpm db:seed` builds a deterministic demo instance from `@slugbase/testing` factories (fixed random seed). It includes the shapes that break UIs: a workspace with 5 000 bookmarks, long titles, RTL and emoji titles, colliding slugs across members and via sharing (to exercise `/go` disambiguation), an over-cap Free workspace (entitlement banners), an account with MFA enrolled, and an expired invitation. The seeded passwords are printed once by the command and are only valid against `slugbase_dev`.

### 1.5 Cloud development

(Cloud) Recorded in the Cloud documentation. Cloud development happens in the private Cloud repository, which checks this repository out as a submodule and reuses `compose.dev.yml`. No external billing or payment service is called in local development.

### 1.6 Registry access for private packages

(Cloud) Recorded in the Cloud documentation. CE has no private package dependency and needs no registry token.

---

## 2. Test tiers

| Tier | What | Runs against | Where |
|---|---|---|---|
| **T1 Unit** | Pure logic: domain services with in-memory ports, entitlement engine, slug grammar, parsers, authorization policies, React components | Nothing external | Every package, `*.test.ts(x)` colocated |
| **T2 Integration** | Repositories, RLS, migrations, the HTTP chain end to end in-process, worker jobs, adapters against local fakes | Real PostgreSQL (per-test database): 18 locally, 17 and 18 in CI (Q3) | `packages/db`, `packages/server`, `packages/adapters`; the Cloud modules in the Cloud repository |
| **T3 Contract** | OpenAPI drift, API Extractor reports, client generation, i18n catalogs, forbidden terms | Generated artefacts vs committed ones | `pnpm contracts:check`, `pnpm i18n:check`, `pnpm lint` |
| **T4 E2E** | User journeys in a browser against the built image | Docker: image + Postgres + Mailpit (+ fakes of Cloud's external services in the Cloud repository) | `e2e/` in each repo |
| **T5 Non-functional** | Accessibility, load/latency budgets, migration timing on large data | Built app; seeded large dataset | Scheduled CI and before promotions (§5.3, §5.4) |

T1–T3 are in `pnpm gate`. T4 runs in CI on every push to `dev` and on promotion PRs, and locally on demand (`pnpm test:e2e`). T5 runs on a schedule and before a production promotion.

---

## 3. T1 and T2 in detail

### 3.1 Unit tests and in-memory ports

Every port (doc 01 §6) ships an in-memory implementation in `@slugbase/testing` — `InMemoryMail` (captures messages), `FakeAi` (deterministic suggestions), `FakeIdentity` (a scripted OIDC provider), `FakeEgress` (scripted responses keyed by URL, including redirects to private addresses and oversized bodies), `FixedClock`, `SequenceIds`. Identifiers are generated in the application, not by a database function (Q91), so `SequenceIds` stands in for the generator and no test depends on a PostgreSQL-version-specific id function. Domain services are tested against these with no database. Unit tests must run in well under a minute for the whole repo; a test that needs Postgres is an integration test.

React components are tested with Testing Library and `vitest-axe` for component-level accessibility. The data layer in the web app is tested against **MSW handlers generated from `openapi.json`** (§7), so a contract change breaks the web tests in the same commit.

### 3.2 The Postgres test harness

`@slugbase/testing/db` gives every integration test file its own database:

1. On first use in a run, it creates `slugbase_tpl_<migrationhash>` by applying the migration chain once (CE, or the composed chain in the Cloud repository, doc 05 §5.5), installs the roles (`slugbase_app` without `BYPASSRLS`, `slugbase_system`) and marks it as a template. The hash is over the migration files, so a changed migration produces a new template automatically.
2. Each test file gets `CREATE DATABASE test_<random> TEMPLATE slugbase_tpl_<hash>` — tens of milliseconds — and drops it afterwards.
3. Tests connect as `slugbase_app` exactly like the server does. Only fixtures connect as the owner role, to insert data RLS would refuse.

The harness needs `SLUGBASE_TEST_PG_URL` (a superuser URL); it defaults to the `compose.dev.yml` Postgres. In CI it points at a service container (§6). Because databases are per file and named randomly, any number of scratch clones can run `pnpm gate` against the same Postgres concurrently.

### 3.3 The cross-tenant matrix (D8, doc 01 §5.5)

The single most important test in the codebase. It lives in `packages/testing/src/tenancy/` and runs in two modes:

- **API mode.** For every operation in `openapi.json`, with a fixture of two workspaces A and B (each with owner, admin, member, a team, shared and unshared bookmarks/folders/tags, slugs, invitations, tokens): authenticate as each principal of A and attempt the operation against every B identifier the fixture holds. Every attempt must return `404` (never `403` — existence is not disclosed) and leave B unchanged (a row-level checksum of B's tables before and after).
- **RLS-only mode.** The same matrix against the repositories, but through a **test-only build of the repositories with the workspace predicate removed**, inside `withTenant(A)`. Every read must return no B rows and every write must fail. This proves that RLS alone holds the boundary (T1), independent of the application layer.

The matrix is **generated from the contract**, not written by hand per operation: a new operation is covered the moment it is declared, and an operation whose path parameters the generator cannot map to fixture identifiers fails the test until a mapping is added. Doc 10 T1 and T2 cite it; the risk review (doc 09 §5.3) requires it to be extended for any new repository method.

Within-workspace sharing rules (owner-only mutation, read via direct share, team share and shared folder; a member who leaves loses access) have their own table-driven suite in `packages/core` (unit, with a policy oracle) and `packages/server` (integration).

### 3.4 Migration tests

- **Fresh apply**: the template build (§3.2) applies the whole chain to an empty database on every run.
- **Upgrade with data**: `packages/db/test/migrations/` keeps a **fixture snapshot per released schema version** (a `pg_dump` of the seeded instance at that version, compressed, committed when a version is released). The test restores each snapshot, applies every later migration, then runs a read-back suite (row counts, invariants such as "every bookmark's slug is unique per owner", RLS still forced on every tenant table). A migration that loses or corrupts data fails here.
- **Policy lint** (`pnpm db:check`): every table with a `workspace_id` column has RLS enabled **and forced** and at least one policy; `slugbase_app` owns no table; no migration file changed after its first commit (checksums in `migrations/meta/`); drizzle-kit reports no pending diff between schema and migrations.
- **Expand/contract check**: a migration that drops or renames a column is rejected unless its file header names the expand migration and release it pairs with (doc 05).
- **The `migrate` command** (D25): two `migrate` processes started at once against the same database apply the chain exactly once (the advisory lock); `lock_timeout` makes a migration blocked by a held table lock fail fast instead of queueing; a failed migration leaves the version table unchanged and exits non-zero.
- **The two call sites** (D25):
  - **CE migrate-on-start:** the image entrypoint runs `migrate` with `DATABASE_MIGRATE_URL`, and only then starts the server with that URL removed from its environment (a failure exits non-zero before anything serves). A second replica waits on the lock and starts without re-applying. The in-process variant (`slugbase serve --with-worker`, Q11, where no entrypoint step exists) migrates inside the process and serves `/health` and `/ready` first, with `/ready` answering `503` until the database is at the expected migration level.
  - **`MIGRATE_ON_START=false`** (a managed deployment that runs `migrate` as a separate step, as Cloud does): the server never runs migrations and refuses `/ready` until the database is at the migration level the build expects.

### 3.5 Security-focused integration suites

| Suite | Asserts |
|---|---|
| `http/cross-site` | Cookie-authenticated mutations without a matching `Origin`, with `Sec-Fetch-Site: cross-site`, or with a non-JSON content type are refused; bearer requests ignore cookies (T5) |
| `http/headers` | CSP, HSTS, COOP, Referrer-Policy per route; `no-store` on `/api` and `/go`, except an operation that declares its own cache lifetime (`GET /api/config`, 60 s) |
| `auth/enumeration` | Login, reset, registration and invitation endpoints return identical status, body shape and timing class for known and unknown emails (T8) |
| `auth/sessions` | Rotation on login, MFA and privilege change; revocation takes effect on the next request; hashes only at rest (T4) |
| `auth/rate-limits` | Limits hold per IP and per account; `X-Forwarded-For` beyond the trusted hops is ignored (T9) |
| `egress/ssrf` | Private, loopback, link-local, CGNAT, metadata, IPv6-mapped and DNS-rebinding targets are refused, including after redirects; size and time caps hold (T6) — against a local DNS stub and HTTP servers, never the internet |
| `go/resolution` | Only accessible, forwarding-enabled bookmarks resolve; non-http(s) destinations are never stored or redirected; disambiguation and remembered choices (T12) |
| `import/hostile` | Oversized, deeply nested, malformed and script-laden JSON/Netscape files are rejected or neutralised (T13) |
| `machine` routes | An event with a missing, wrong or stale signature changes nothing; duplicate deliveries apply once; an older event never overwrites newer state; no session or token principal is derived. Machine routes are not behind the rate-limit port (the signature check is their control, doc 04 §7). Cloud's billing-event suite extends this in the Cloud repository (T10) |

---

## 4. T3 — contracts and generated artefacts

- **OpenAPI drift**: `pnpm contracts:check` regenerates `packages/contracts/generated/openapi.json` and the typed client and fails on any diff. Generated files are committed so reviewers and Cloud see API changes as diffs.
- **API Extractor**: regenerates every package's `etc/*.api.md` and fails on diff (doc 09 §3.1).
- **i18n**: `pnpm i18n:check` — EN and DE catalogs have identical key sets, ICU messages parse, no unused keys, and a lint rule (`eslint-plugin-i18next`) flags literal strings in JSX and in user-facing server messages.
- **Forbidden terms** (CE only): the public-repo guard (doc 09 §4) runs in `pnpm lint`.
- **Vocabulary lint**: product-vocabulary violations (`organization`, `collection`, `favorite`) in identifiers and catalogs fail lint (doc 00 §3).

---

## 5. T4 and T5

### 5.1 E2E

Playwright against the **built image**, never against `pnpm dev`, so what is tested is what ships.

- **CE** (`slugbase/e2e/`): `docker run` the image + Postgres + Mailpit; journeys: first-run setup → invite → accept (mail read from Mailpit's API) → bookmarks, folders, tags, pinning → slug + `/go` + disambiguation → palette `go` mode → sharing via team → MFA enrol/login/backup code → API token → export → import into a fresh workspace (round-trip equality) → instance admin.
- **Cloud**: its own journeys (registration with email verification, entitlement limits, upgrade and downgrade, archive and restore) run in the private Cloud repository against the Cloud image and fakes of its external services.
- Projects for Chromium, Firefox and WebKit on the core journeys; Chromium only for the long tail.
- Traces, videos and screenshots are kept as CI artifacts on failure.

### 5.2 Accessibility

`@axe-core/playwright` runs on every page the e2e journeys visit; violations of WCAG 2.2 AA fail the run (with a reviewed allowlist file for third-party false positives). Keyboard-only journeys cover the palette, modals and bookmark editing (doc 03).

### 5.3 Performance budgets

A scheduled job (weekly, and before a production promotion) runs `k6` against the image with a seeded large instance (50 000 bookmarks in one workspace, 2 000 workspaces): `/go` p95 < 30 ms server time, list and search p95 < 100 ms (doc 01 §9.3), with Postgres on the same runner. Regressions open an issue rather than failing a developer's gate.

### 5.4 Migration timing

The same scheduled job applies pending migrations to the large seeded instance and reports duration and lock time; a migration that takes an `ACCESS EXCLUSIVE` lock for more than 1 s on that data set fails (doc 05).

---

## 6. CI

### 6.1 Runners

| Repository | Runner | Why |
|---|---|---|
| `mdg-labs/slugbase` (public) | GitHub-hosted `ubuntu-latest` | Free for public repos; nothing private to protect (`githubRunner`, doc 09 §5.2) |
| Private repositories | Self-hosted CI runners | Described in the Cloud documentation |

Workflows in this repository use a portable shape where it costs nothing: every job that needs a toolbox runs in a container (`container: node:24-bookworm`), installs pnpm with `pnpm/action-setup`, and reaches service containers **by name** (`postgres:5432`), never `localhost`; image builds use plain `docker build`/`docker push`. They can therefore move to ephemeral self-hosted CI runners unchanged.

### 6.2 Workflows — CE

| Workflow | Trigger | Jobs |
|---|---|---|
| `ci.yml` | push to any branch, PRs | `lint` · `typecheck` · `unit` · `contracts` (T3) · `integration` (Postgres service, a matrix over PostgreSQL 17 and 18, Q3) · `build` (incl. `docker build` of the image, not pushed) · `audit` (`pnpm audit --audit-level=high` + OSV scan) — all parallel after a shared install with Turbo cache |
| `e2e.yml` | push to `dev`, PRs to `main` | Build image → Playwright (CE journeys) against PostgreSQL 17 and 18 |
| `codeql.yml` | push to `dev`/`main`, weekly | CodeQL JavaScript/TypeScript |
| `release.yml` — build | push to `main` with a bumped `apps/slugbase` version | Build from the commit CI tested; SBOM (SPDX) + provenance; cosign keyless signature (GitHub OIDC identity of this workflow on `main`, Q17); push `:<version>` (and `:<major>.<minor>` for a version without a pre-release suffix) to the public registry named in Q12; create a **draft** GitHub Release. `:latest` is not touched |
| `release.yml` — publish | the GitHub Release is published | Re-verify the signature of the digest, then point `:latest` and `:<major>.<minor>` at it. A pre-release (for example `1.0.0-rc.1`) never moves either. A version tag that already exists is refused |
| `nightly.yml` | schedule | T5: performance budgets, migration timing, full browser matrix |
| `issue-status.yml` | issue/label events | Vendored by `setup`; drives `status:*` and auto-assign |

`release.yml` runs only on a push to `main` or a published release, never for a pull request from a fork, and holds no secret beyond the workflow token and the permission to push the image and write the signature (doc 10 T16). The digest that is signed is the digest that is pushed and later tagged. `scripts/verify-image.sh <tag>` runs `cosign verify` and `cosign verify-attestation` against that identity so operators can check an image; it fails on an unsigned image and on one signed by another workflow. When each of these starts is in Q92: the release candidate of Phase 4 carries SBOM and provenance; signing and the public package come in Phase 6.

### 6.3 Workflows — Cloud

(Cloud) Recorded in the Cloud documentation. In outline: CI on every push, Cloud e2e journeys, and a deploy workflow that runs `migrate` as a separate step before rolling out new containers (D25).

### 6.4 The gate, per repository

`pnpm gate` is defined in each root `package.json` and is exactly what `workflow.json` `gate` runs (doc 09 §5.2):

- **CE**: `turbo run lint typecheck test:unit build` → `pnpm contracts:check` → `pnpm db:check` → `pnpm test:integration` → `pnpm i18n:check` → `pnpm audit --audit-level=high`.
- **Cloud**: the CE pin check, then the same sequence over the Cloud workspace, plus its own checks (Cloud documentation).

Per-path `checks` (the faster subset an executor runs before each commit) are listed in doc 09 §5.2. e2e is **not** in the gate — it needs a built image and a minute or two of browser time; it runs in CI and before promotions, and an executor runs the relevant spec only when an item's acceptance criteria name an e2e journey.

### 6.5 Merge and promotion gate

`dev` takes cherry-picked commits from `/orchestrate` only after the verifier has re-run the gate; CI on `dev` re-runs it plus e2e. The `dev → main` promotion PR needs green CI, green e2e, one CodeRabbit round (`/cr-review`), a clean `/security-audit` for the changed security units (D23) and the maintainer's merge. `main` is protected: no direct pushes, no force pushes, linear history.

---

## 7. Frontend development without a backend

UI work must not wait for the API, and agents working on the web app must not need Postgres:

- **MSW handlers generated from `openapi.json`** (`@slugbase/testing/msw`) with realistic fixtures from the same factories as the seed (§1.4). `pnpm dev:web --mock` runs Vite with the service worker and no server.
- Scenario switches in the mock (`?scenario=free-at-cap`, `team-admin`, `empty-workspace`, `mfa-required`) render every state doc 03 lists (empty, loading, error, over-cap, read-only shared).
- **Ladle** (or Storybook, Q85) for `@slugbase/ui` and page-level compositions, with the coss particles documented next to the SlugBase ones; the a11y addon runs on every story.
- Because the mock is generated from the contract, a component built against it works against the real server the day the operation lands — and a contract change breaks the mock in the same commit.

---

## 8. Development loop, in practice

```bash
pnpm dev:services && pnpm dev                 # once per session
pnpm test:unit --filter=@slugbase/core        # tight loop on domain logic
pnpm test:integration --filter=@slugbase/db   # RLS / repository work
pnpm dev:web --mock                           # UI work without the server
pnpm gate                                     # before every commit an agent makes
pnpm test:e2e -- --grep "go disambiguation"   # when an item names a journey
```

The executor in a scratch clone runs `bootstrap` (`pnpm install --frozen-lockfile`, plus `git submodule update --init` in Cloud), then the `checks` for the paths it touched, then `pnpm gate`; the verifier runs `pnpm gate` itself in its own clone. Both use the shared development Postgres through the per-test database harness (§3.2) and never touch `slugbase_dev`'s data.
