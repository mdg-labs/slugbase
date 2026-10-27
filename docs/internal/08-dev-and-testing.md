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
| Node.js | 24.2 or later 24.x (`.nvmrc`) | D5. The direct-entry checks use `import.meta.main`, added in Node 24.2.0. `package.json` `engines` and a `preinstall` check enforce it |
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

**Concurrent runs.** The stack serves several `pnpm test:integration` or `pnpm gate` runs at once, because each run holds a bounded number of connections. `packages/db` and `packages/server` run at most two test files at a time (`maxWorkers` in each package's `vitest.config.ts`), and the harness opens at most one superuser session, four `slugbase_app` and two owner connections per file (§3.2). One `pnpm test:integration` run peaked at 38 connections above what the stack held before it (sampled with `SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend'`). `compose.dev.yml` therefore starts Postgres with `max_connections=300`: three runs at that peak add up to about 115, which the Postgres default of 100 cannot hold, and the rest is room for the app, the worker and other sessions on the machine. The stack supports three concurrent runs. A change to `compose.dev.yml` applies when `pnpm dev:services` next recreates the container. If a run fails with `too many clients already` or `remaining connection slots are reserved`, the stack still has the old limit (`SHOW max_connections`).

**No crash durability.** `compose.dev.yml` starts this Postgres with `fsync=off`, `synchronous_commit=off` and `full_page_writes=off`. The cluster holds only disposable data: the development database can be seeded again and every test database is cloned from a template and dropped (§3.2). Without those settings each `DROP DATABASE` waits for an immediate checkpoint to reach the disk, which costs far more than the clone when several runs share the host. The price is that a crash of the container, Docker or the host can leave the cluster corrupt or without its last writes. When that happens, `docker compose -f compose.dev.yml down -v` followed by `pnpm dev:services` provisions it again. These settings belong to this file only. The `postgres` service of CI (§6) is a separate container that keeps the image defaults, and production and self-hosted Postgres are not configured here. Like `max_connections`, a change to them applies when the container is next recreated.

### 1.3 Running the app

```bash
pnpm install
pnpm dev:env             # copies .env.example to .env (gitignored) and fills generated dev SESSION_SECRET/ENCRYPTION_KEY
pnpm db:migrate          # applies the CE migration chain to slugbase_dev
pnpm db:seed             # demo instance: an admin and a member, a demo workspace of 300 bookmarks, a workspace of 5 000 (§1.4)
pnpm dev                 # turbo: server (watch), worker (watch), web (Vite)
```

**One origin in development too** (D11). Vite serves the SPA on `http://localhost:5173` and proxies `/api`, `/go` and `/health` to the server on `:3000`. The browser only ever sees `localhost:5173`, so the session cookie, the Origin check and `SameSite` behave exactly as in production. In development the cookie is named `slugbase_session` without the `__Host-` prefix and without `Secure` (browsers refuse `__Host-` on plain HTTP); the server derives both from `APP_ORIGIN`'s scheme, not from a mode flag.

`.env` is created from the committed `.env.example`, whose defaults match `compose.dev.yml`. It is gitignored and never committed, and `pnpm dev:env` refuses to overwrite an existing one. There is no secrets manager in the dev loop (D24). Production refuses to start with the dev defaults (doc 01 §11).

### 1.4 Seed data

`pnpm db:seed` builds a deterministic demo instance from `@slugbase/testing` factories (a fixed random seed and a fixed clock, so every run produces the same rows). The factories are plain data builders with no database in them: the seed script turns the instance into one SQL transaction, and the browser journeys import the same builders for their fixtures (`e2e/support/bookmark-fixtures.ts`).

The instance has two accounts (an instance admin and a member), a demo workspace of 300 bookmarks that both use, and a workspace of 5 000 bookmarks owned by the admin. Every workspace starts with the bookmark shapes that break UIs: a title and a description at their length limits and a URL of about 2 000 characters, a title with no break opportunity, a one-character title, Arabic, Hebrew and mixed-direction titles, emoji titles (a ZWJ sequence, a flag, a skin tone), titles and descriptions with markup-like text (`<img src=x onerror=alert(1)>`, `<script>`, HTML entities), pinned rows, rows with opens and rows without, and three URLs that differ and share one canonical form (doc 02 §5.1). The rest is filler with the same mix: about 4 % pinned, a little over half opened, a few percent emoji or right-to-left, and a few percent duplicate canonical URLs. Colliding slugs across members and via sharing, shared folders, an over-cap Free workspace, an account with MFA enrolled and an expired invitation are added by the epics that introduce them; the 50 000-bookmark performance instance belongs to the performance suite (§5.3).

**It writes through `slugbase_system`, not the application role.** The seed connects with `DATABASE_MIGRATE_URL` as `slugbase_migrator`, sets the role for its one transaction and creates the accounts and workspaces with the system operations the product uses (`sys_create_account`, `sys_create_workspace`). The application role cannot set a bookmark's usage (`open_count`, `last_opened_at`) and has no `UPDATE` on `workspaces.bookmark_count`, so the script inserts the bookmarks as the system role and then sets each workspace's `bookmark_count` to the number of its rows (doc 05 §2.2). `psql` must be on the `PATH`, as for the test harness; the script runs through it, so no database handle is created outside `packages/db`. Any failure rolls the whole script back, and a database that already holds one of the seeded addresses is refused as a whole.

**It refuses any database but the development one.** Before it connects, `DATABASE_URL` and `DATABASE_MIGRATE_URL` must both name host `127.0.0.1` (or `localhost`), port `54329` and the database `slugbase_dev`, the address `compose.dev.yml` publishes, with no connection options in the URL, and the migrate URL must connect as `slugbase_migrator`. A value that is unset, unparsable or anything else is a refusal, never a fallback, and the child process gets only that connection and the `PATH`, so a `PG*` variable of the caller cannot redirect it. The passwords are random, made when the command runs and shown once on its output; only their argon2id hashes are stored, in `slugbase_dev`, and they open no other database. To seed again, start from an empty development database (`docker compose -f compose.dev.yml down -v`, `pnpm dev:services`, `pnpm db:migrate`).

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

Every port (doc 01 §6) ships an in-memory implementation in `@slugbase/testing-ports` — `InMemoryMail` (captures messages), `FakeAi` (deterministic suggestions), `FakeIdentity` (a scripted OIDC provider), `FakeEgress` (scripted responses keyed by URL, including redirects to private addresses and oversized bodies), `FixedClock`, `SequenceIds`. Identifiers are generated in the application, not by a database function (Q91), so `SequenceIds` stands in for the generator and no test depends on a PostgreSQL-version-specific id function. Domain services are tested against these with no database. Unit tests must run in well under a minute for the whole repo; a test that needs Postgres is an integration test. `@slugbase/testing-ports` imports no workspace package, so `@slugbase/core` takes it as a development dependency and its unit tests import the fakes directly; `@slugbase/testing` re-exports it, so integration suites keep the single `@slugbase/testing` import. Because the package may not depend on `@slugbase/core` (a `core` → `testing-ports` → `core` edge is a package cycle that Turborepo rejects), a fake does not `implements` the port interface: the fakes are structurally typed, and the check that each satisfies its port lives in `@slugbase/testing`, which may import both. Only test files, `test/` folders and `apps/*` development tooling import it (doc 09 §2.1).

React components are tested with Testing Library and `vitest-axe` for component-level accessibility. The data layer in the web app is tested against **MSW handlers generated from `openapi.json`** (§7), so a contract change breaks the web tests in the same commit.

### 3.2 The Postgres test harness

`@slugbase/testing/db` gives every integration test file its own database:

1. On first use in a run, it creates `slugbase_tpl_<migrationhash>` by applying the migration chain once (CE, or the composed chain in the Cloud repository, doc 05 §5.5), installs the roles (`slugbase_app` without `BYPASSRLS`, `slugbase_system`) and marks it as a template. The hash is over the migration files, so a changed migration produces a new template automatically.
2. Each test file gets `CREATE DATABASE test_<random> TEMPLATE slugbase_tpl_<hash>` — tens of milliseconds — and drops it afterwards.
3. Tests connect as `slugbase_app` exactly like the server does. Only fixtures connect as the owner role, to insert data RLS would refuse.

The harness needs `SLUGBASE_TEST_PG_URL` (a superuser URL); it defaults to the `compose.dev.yml` Postgres. In CI it points at a service container (§6). Because databases are per file and named randomly, concurrent runs never collide with one another; how many runs fit at once is bounded by the connection limit of the dev Postgres, which supports three (§1.2).

Every changed migration, custom SQL file or `roles.sql` leaves one more template behind, and the harness never drops one on its own: scratch clones at different hashes run at the same time. `pnpm --filter @slugbase/db test:prune-templates` drops the `slugbase_tpl_*` templates that nothing uses (template names as arguments limit it to those). It never lists or touches a database outside the `slugbase_tpl_<hash>` names, and it keeps the template of the current hash and any template that is:

- being built or dropped (the per-template build lock, which the prune only tries and never waits for);
- cloned from, or about to be: Postgres records no link from `test_<random>` to its template, so every process holds a per-template *use* lock, shared, from before it looks for the template until its test database is dropped, and the prune only tries the exclusive one;
- connected to (and the `DROP DATABASE` has no `FORCE`, so a connection that opens late makes it fail and leaves the template marked).

A process that wants a template the prune has just dropped builds it again.

Roles are cluster-wide, and every test database depends on them staying as `roles.sql` leaves them, so the harness keeps one advisory lock per cluster (the *cluster lock*) beside the per-template ones:

- **Shared, for as long as a process uses the cluster.** A process holds it, through one superuser session, from before its first test database exists until its last one is dropped. A test file that reads the roles without a database of its own (`migrate.integration.test.ts`, `roles.integration.test.ts`) holds it the same way through `useCluster()`. Any number of processes, in any number of runs, hold it at once, so holders of the shared lock never wait for one another.
- **Exclusive, for the step of a test that changes the roles.** `lockExclusive()` of `useCluster()` waits until no other process holds the lock, which includes every test database of every run, and gives the lock back (shared again) when the step is over. Only the drift test of `roles.integration.test.ts` takes it, and it converges the roles once more before giving the lock back, so a test that failed half way leaves no drift behind. A process that has a test database of its own cannot take it, because it would wait for itself.
- **What a harness user waits for.** A shared request queues behind an exclusive one that waits, so from the moment a step asks for the lock until the step is over, the first test database of a process that does not yet hold the cluster waits. A process that already holds the cluster (it has a test database in use) asks again for nothing and creates more test databases without waiting. That window is the wait for the databases in use to be dropped plus the step itself, and it is the only time the cluster lock holds a harness user up. A test file never takes the lock by itself (`packages/db/test/integration-concurrency.test.ts` checks this), and `harness-cluster-lock.integration.test.ts` runs two harness users at once to show that a test database waits for the exclusive step and not for the rest of the file of the process that took it.

Three concurrent runs (§1.2) share one cluster lock this way.

### 3.3 The cross-tenant matrix (D8, doc 01 §5.5)

The single most important test in the codebase. It lives in `packages/testing/src/tenancy/` and runs in two modes:

- **API mode.** For every operation in `openapi.json`, with a fixture of two workspaces A and B (each with owner, admin, member, a team, shared and unshared bookmarks/folders/tags, slugs, invitations, tokens): authenticate as each principal of A and attempt the operation against every B identifier the fixture holds. Every attempt leaves B unchanged (a row-level checksum of B's tables before and after) and quotes nothing of B, and answers by role, from the operation's `x-slugbase-auth` level: a principal at or above the policy gets `404` (never `403` — existence is not disclosed); a principal below it (a member on an `admin` or `owner` operation, an admin on an `owner` one) gets the `403 forbidden` of stage 9 (doc 01 §4), which is decided before any lookup and so discloses nothing. The matrix still calls with every principal, so a `404` is asserted exactly where a lookup happens, and a handler that is reached by a principal below its policy fails the matrix.
- **RLS-only mode.** The same matrix against the repositories, but through a **test-only build of the repositories with the workspace predicate removed**, inside `withTenant(A)`. Every read must return no B rows and every write must fail. This proves that RLS alone holds the boundary (T1), independent of the application layer.

The matrix is **generated from the contract**, not written by hand per operation: a new operation is covered the moment it is declared, and an operation whose path parameters the generator cannot map to fixture identifiers fails the test until a mapping is added. Doc 10 T1 and T2 cite it; the risk review (doc 09 §5.3) requires it to be extended for any new repository method.

Within-workspace sharing rules (owner-only mutation, read via direct share, team share and shared folder; a member who leaves loses access) have their own table-driven suite in `packages/core` (unit, with a policy oracle) and `packages/server` (integration).

### 3.4 Migration tests

- **Fresh apply**: the template build (§3.2) applies the whole chain to an empty database on every run.
- **Upgrade with data**: `packages/db/test/migrations/` keeps a **fixture snapshot per released schema version** (a `pg_dump` of the seeded instance at that version, compressed, committed when a version is released). The test restores each snapshot, applies every later migration, then runs a read-back suite (row counts, invariants such as "every bookmark's slug is unique per owner", RLS still forced on every tenant table). A migration that loses or corrupts data fails here.
- **Policy lint** (`pnpm db:check`): every table with a `workspace_id` column has RLS enabled **and forced** and at least one policy; `slugbase_app` owns no table; no migration file changed after its first commit (each migration's SHA-256 is recorded in `packages/db/src/check/migration-checksums.json`; `pnpm db:record-checksums` adds the entry of a new migration after `pnpm db:generate`, and an existing entry is never rewritten); drizzle-kit reports no pending diff between schema and migrations.
- **Expand/contract check** (`pnpm db:check`, doc 05 §5.2): a migration added since the latest release tag that drops or renames a released column or table, or takes a rewriting step on one, is rejected unless it is the contract half of a pair. The leading comment block of the file holds the header `-- slugbase:contract expand=<migration tag> release=<version>` (`<version>` is a release tag, `MAJOR.MINOR.PATCH` with an optional pre-release suffix and optional leading `v`, whose release already contains the expand migration), which `pnpm db:generate --contract expand=<migration tag> release=<version>` writes so the recorded checksum covers it. The header alone decides, on every event: a valid one accepts the step, a missing or invalid one fails it, and the check reads no label or environment value. The maintainer approves a contract migration by merging the pull request that carries it, so a required status check never depends on a label. The check reads release tags and migration history from git, so it **fails in a shallow clone**: the `integration` job checks out with `fetch-depth: 0`, and a local clone runs `git fetch --unshallow --tags`. Tests: the rule against temporary git repositories (`packages/db/test/check/expand-contract.test.ts`), the command with and without a header, run with no environment set (`expand-contract.integration.test.ts`) and the generator option (`generate-migration.test.ts`).
- **The `migrate` command** (D25): two `migrate` processes started at once against the same database apply the chain exactly once (the advisory lock); `lock_timeout` makes a migration blocked by a held table lock fail fast instead of queueing; a failed migration leaves the version table unchanged and exits non-zero.
- **The two call sites** (D25):
  - **CE migrate-on-start:** the image entrypoint runs `migrate` with `DATABASE_MIGRATE_URL`, and only then starts the server with that URL removed from its environment (a failure exits non-zero before anything serves). A second replica waits on the lock and starts without re-applying. The in-process variant (`slugbase server --with-worker`, Q11, where no entrypoint step exists) migrates inside the process and serves `/health` and `/ready` first, with `/ready` answering `503` until the database is at the expected migration level.
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

A scheduled job (weekly, and before a production promotion) runs `k6` against the image with a seeded large instance (50 000 bookmarks in one workspace, 2 000 workspaces): `/go` p95 < 30 ms server time, list and search p95 < 100 ms (doc 01 §9.3), with Postgres on the same runner. The search budget holds because a search ranks the bookmarks whose slug and title hold every word of the query (all of them, through their own GIN index) and takes the bookmarks whose host or description completes the words from a bounded window to fill the remaining places: title and slug matches rank ahead of host- and description-only matches, and a word that matches most of a large library is not ranked in full (doc 02 §9.1, doc 05 §3.3). The integration suite measures the same budget on a 50 000-bookmark workspace in `packages/db/test/search-plan.integration.test.ts`, a vitest project of its own (`integration-quiet`) that the root `pnpm test:integration` runs by itself, after the integration suites of every package have finished, so that no other database-heavy file shares the machine with its timings. Regressions open an issue rather than failing a developer's gate.

### 5.4 Migration timing

The same scheduled job applies pending migrations to the large seeded instance and reports duration and lock time; a migration that takes an `ACCESS EXCLUSIVE` lock for more than 1 s on that data set fails (doc 05).

---

## 6. CI

### 6.1 Runners

| Repository | Runner | Why |
|---|---|---|
| `mdg-labs/slugbase` (public) | GitHub-hosted `ubuntu-latest` | Free for public repos; nothing private to protect (`githubRunner`, doc 09 §5.2) |
| Private repositories | Self-hosted CI runners | Described in the Cloud documentation |

Workflows in this repository use a portable shape where it costs nothing: every `ci.yml` job except `build` runs in a container (`container: node:24-bookworm`), installs pnpm with `pnpm/action-setup`, and reaches service containers **by name** (`postgres:5432`), never `localhost`; image builds use plain `docker build`/`docker push`. `build` runs on the runner itself, because its image smoke test (`scripts/smoke-image.sh`) starts the image with Docker Compose and needs the runner's own Docker daemon and published ports; it takes Node from `actions/setup-node` at the major version of `.nvmrc` and uses the same `setup` action as the others. The other `ci.yml` jobs can therefore move to ephemeral self-hosted CI runners unchanged, and `build` can too on a runner that has the Docker CLI with the Compose plugin and a Docker daemon of its own.

`e2e.yml` is a runner job for the same reason: its stack (`e2e/with-stack.sh`, through `scripts/smoke-image.sh`) runs on the runner's own Docker daemon with its ports published on `127.0.0.1`. Only the journeys run in a container, the official Playwright image of `e2e/Dockerfile` (`e2e/in-image.sh`: the repository mounted at its own path, the host's network, the user of the runner so that `e2e/test-results/` and `e2e/playwright-report/` stay readable by the upload step, the `E2E_*` variables handed on by name). The image carries the three engines and their system libraries, so no step installs them from a package mirror, whose speed once decided the job's time. Its tag is the version of `@playwright/test` that `pnpm-lock.yaml` resolves and its digest pins it; `renovate.json` updates both in one group and `e2e/support/playwright-image.test.ts` fails when they differ. The journeys import workspace packages (`@slugbase/testing` for their fixtures) whose `exports` point at `dist/`, so the job builds `@slugbase/e2e`'s dependencies (`pnpm turbo run build --filter='@slugbase/e2e^...'`) on the runner before the journeys; the mounted checkout carries the output into the container, and `e2e/support/playwright-image.test.ts` fails when the step is missing or comes after the journeys.

### 6.2 Workflows — CE

| Workflow | Trigger | Jobs |
|---|---|---|
| `ci.yml` | push to any branch, PRs | `lint` (`pnpm lint`: the Turbo lint tasks and the repository's script checks, among them the forbidden-terms check, `scripts/check-forbidden-terms.sh` against the generic patterns of `scripts/forbidden-terms.txt`, doc 09 §4) · `typecheck` · `unit` · `contracts` (T3) · `docs` (`pnpm docs:check` on a change under the docs roots, doc 09 §3.5) · `integration` (Postgres service, a matrix over PostgreSQL 17 and 18, Q3) · `build` (on the runner, §6.1: the workspace build, `apps/slugbase/test/compose-cli.integration.test.ts` and `scripts/smoke-image.test.sh`, then `docker build` of the image, not pushed, and `scripts/smoke-image.sh` against it; the compose CLI test runs with a skipped or failed case failing the step, because it skips wherever the Docker CLI is absent) · `audit` (`pnpm audit --audit-level=high` + OSV scan) — all parallel after a shared install with Turbo cache |
| `e2e.yml` | push to `dev`, PRs to `main` | Build image → build the workspace packages the journeys import (§6.1) → pull the pinned Playwright image (§6.1) → the CE journeys in it, against the stack on the runner, on PostgreSQL 17 and 18 |
| `codeql.yml` | push to `dev`/`main`, weekly | CodeQL JavaScript/TypeScript |
| `docs-published.yml` | push to `main` touching `docs/user/**`, `docs/self-hosting/**` or `docs/releases/**`, and `workflow_dispatch` | The generic docs-published request to the site repository named by configuration; a no-op without it (doc 09 §3.5, Q111) |
| `release.yml` — build | push to `main` with a bumped `apps/slugbase` version | Build from the commit CI tested; SBOM (SPDX) + provenance; cosign keyless signature (GitHub OIDC identity of this workflow on `main`, Q17); push `:<version>` (and `:<major>.<minor>` for a version without a pre-release suffix) to the public registry named in Q12; create a **draft** GitHub Release. `:latest` is not touched |
| `release.yml` — publish | the GitHub Release is published | Re-verify the signature of the digest, then point `:latest` and `:<major>.<minor>` at it. A pre-release (for example `1.0.0-rc.1`) never moves either. A version tag that already exists is refused |
| `nightly.yml` | schedule | T5: performance budgets, migration timing, full browser matrix |
| `issue-status.yml` | issue/label events | Vendored by `setup`; drives `status:*` and auto-assign |

`release.yml` runs only on a push to `main` or a published release, never for a pull request from a fork, and holds no secret beyond the workflow token and the permission to push the image and write the signature (doc 10 T16). The digest that is signed is the digest that is pushed and later tagged. `scripts/verify-image.sh <tag>` runs `cosign verify` and `cosign verify-attestation` against that identity so operators can check an image; it fails on an unsigned image and on one signed by another workflow. When each of these starts is in Q92: the release candidate of Phase 4 carries SBOM and provenance; signing and the public package come in Phase 6.

### 6.3 Workflows — Cloud

(Cloud) Recorded in the Cloud documentation. In outline: CI on every push, Cloud e2e journeys, and a deploy workflow that runs `migrate` as a separate step before rolling out new containers (D25).

### 6.4 The gate, per repository

`pnpm gate` is defined in each root `package.json` and is exactly what `workflow.json` `gate` runs (doc 09 §5.2):

- **CE**: `pnpm lint` (including the forbidden-terms check) → `turbo run typecheck test:unit build` → `pnpm contracts:check` → `pnpm db:check` → `pnpm test:integration` → `pnpm i18n:check` → `pnpm audit --audit-level=high`.
- **Cloud**: the CE pin check, then the same sequence over the Cloud workspace, plus its own checks (Cloud documentation).

The documentation contract check `pnpm docs:check` (doc 09 §3.5) is a per-path check for changes under `docs/user/`, `docs/self-hosting/` and `docs/releases/`, and runs as the `docs` job of `ci.yml`; it is not part of `pnpm gate`. Per-path `checks` (the faster subset an executor runs before each commit) are listed in doc 09 §5.2. e2e is **not** in the gate — it needs a built image and a minute or two of browser time; it runs in CI and before promotions, and an executor runs the relevant spec only when an item's acceptance criteria name an e2e journey.

### 6.5 Merge and promotion gate

`dev` takes cherry-picked commits from `/orchestrate` only after the verifier has re-run the gate; CI on `dev` re-runs it plus e2e. The `dev → main` promotion PR needs green CI, green e2e, one CodeRabbit round (`/pr-review`), a clean `/security-audit` for the changed security units (D23) and the maintainer's merge. `main` is protected: no direct pushes and no force pushes. The promotion PR is merged with a merge commit, so the tree on `main` is the tree that was reviewed on `dev` (Cloud doc 13 Q78 relies on that identity). Linear history is therefore not required on `main`.

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
