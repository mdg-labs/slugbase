# SlugBase

A keyboard-driven bookmark manager where every link can get a short, private slug. This repository is the public **Community Edition** (AGPL-3.0). The design is in [docs/internal/](docs/internal/), starting with [00-overview.md](docs/internal/00-overview.md).

## Agent workflow

<!-- Read by the vendored skills (orchestrate, triage, cr-review, security-audit, customer-docs).
     Keep these headings exactly. Machine-read settings live in .claude/workflow.json. -->

### Project

SlugBase is a keyboard-driven bookmark manager where any bookmark can carry a private slug that forwards through
`/go/<slug>`, with a ⌘K command palette. This repository is the public Community Edition (AGPL-3.0) and every
package SlugBase Cloud builds on. TypeScript strict on Node 24, pnpm + Turborepo; Hono API with Zod contracts and a
generated OpenAPI 3.1 document; PostgreSQL 17 and 18, Drizzle with generated migrations and row-level security;
pg-boss jobs; React 19 + Vite SPA with TanStack Router/Query and coss ui (Base UI + Tailwind v4); EN + DE.
Cloud (the private Cloud repository) composes these packages from a pinned submodule.

### Design docs

`docs/internal/` 00–13. Decisions D1–D29 are settled (doc 00 §5); every Qn in doc 13 is decided, by the
maintainer or by adopting its recommended default. Precedence on conflict: 00 decision log > 01 architecture > 02 product spec > 03 web UI spec >
04/05 > the rest. Cite as `doc 02 §8`, `D8`, `Q5`. Threat model: `docs/internal/10-threat-model.md` (doc 10). Docs 06, 07 and 11 live in the private Cloud repository; they are referenced here only by number.

### Area → paths

| Label | Paths |
|---|---|
| `area:contracts` | `packages/contracts/` |
| `area:core` | `packages/core/` |
| `area:db` | `packages/db/` |
| `area:server` | `packages/server/` |
| `area:adapters` | `packages/adapters/` |
| `area:web` | `packages/web/` |
| `area:ui` | `packages/ui/` |
| `area:email` | `packages/email/` |
| `area:ci` | `.github/`, `apps/slugbase/`, `scripts/`, `compose*.yml`, `e2e/` |
| `area:docs` | `docs/` |

### Always-shared files

`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`,
`packages/contracts/generated/openapi.json`, `packages/*/etc/*.api.md`, `packages/db/src/schema/index.ts`,
`packages/db/migrations/` (journal), `packages/web/src/i18n/locales/{en,de}.json`,
`packages/email/src/i18n/{en,de}.json`, `packages/server/src/create-server.ts`, `packages/web/src/create-web-app.tsx`,
`packages/core/src/events/catalog.ts`, `CLAUDE.md`, `docs/internal/13-open-questions.md`.

### Entry points

- **API:** `packages/server/src/create-server.ts` (middleware chain, module registration), routes under
  `packages/server/src/routes/<domain>/`; contracts in `packages/contracts/src/operations/`.
- **Worker:** `packages/server/src/worker/` (job and schedule registration).
- **Web:** `packages/web/src/create-web-app.tsx`, routes under `packages/web/src/routes/`.
- **Composition (CE):** `apps/slugbase/src/main.ts`, `apps/slugbase/src/web.tsx`.
- **Release surfaces:** the CE image built and signed by `.github/workflows/release.yml` and published to the public registry named in Q12.

A capability is reachable when an operation in `openapi.json` or a route in `packages/web/src/routes/` uses it,
and `apps/slugbase` wires it.

### Hazards

- **This repository is public.** Never write Cloud code, non-public Cloud hostnames, internal infrastructure names
  (hosting platform, tunnel, registry, servers), prices, billing implementations, secrets or token-shaped examples —
  in code, docs, issues or commits (doc 09 §4). Promoting SlugBase Cloud is fine: its name, public hostnames,
  plan names and links to pricing and signup.
- Sibling private repositories are read-only from here; a contract change files its Cloud follow-up (doc 09 §3.3).
- Use only the development Postgres from `compose.dev.yml` (port 54329) and databases the test harness creates;
  never connect to a staging or production database; never run `drizzle-kit push`.
- Never read or write deployment environment values or GitHub Actions secrets, and never print a secret. Staging and
  Production values are set by the maintainer only (D24); an agent may run the read-only key-name check against
  doc 07's inventory, never a value.

### Implementation rules

- No edition flags (`isCloud`, `SLUGBASE_EDITION`): differences are entitlements, config or adapters (D4).
- Every tenant query goes through `withTenant()` and the scoped repositories; never the raw handle (D8, doc 01 §5).
- Every operation is declared in `packages/contracts` with its auth policy; handlers are typed from it; regenerate
  `openapi.json` and the client in the same commit (D12).
- Every outbound request goes through the egress adapter; no `fetch` elsewhere (doc 01 §6).
- Schema changes edit `packages/db/src/schema/**` and run `pnpm db:generate`; never hand-write or edit a merged
  migration; expand/contract for anything a running replica still reads (D7, doc 05).
- UI uses `@slugbase/ui` (coss ui) components and tokens only, as doc 03 names them; no ad-hoc styled primitives (D13).
- Every user-facing string in the EN and DE catalogs (D19). Vocabulary: workspace, folder, pinning, slug, go (doc 00 §3).
- TypeScript strict, no `any`, no `console.*` (use the logger), no `@ts-ignore` without an issue link.
- A new environment variable lands in the env schema, `.env.example` (name only, no value) and doc 07's key inventory
  (its CE self-host section for CE keys) in the same commit (D24). Booleans parse with `envBoolean()`.
- `migrate` is the only code path that applies migrations; the CE image entrypoint runs it before the server starts, under
  the advisory lock with `lock_timeout`, and migrations stay fast and schema-only (backfills and concurrent index builds
  are worker jobs) (D25).
- Identifiers are generated in the application (UUIDv7, Q91), never by a database function.
- Flag v1 non-goals (doc 00 §4) and ask before building one.

### Risk review

- **Tenancy:** the change keeps T1/T2 (doc 10 §4): `withTenant()` used, RLS policy present and `FORCE`d on any new
  tenant table, the cross-tenant matrix extended for every new repository method and operation.
- **Auth and sessions:** cookie attributes, hashing, rotation, non-enumerating responses and rate limits unchanged
  or strengthened (T4, T5, T8, T9).
- **Egress:** new outbound calls go through the egress adapter with its tests (T6).
- **Migrations:** generated, forward-only, applied to the seeded fixture database in the migration test (doc 08 §3.4);
  destructive steps only as the contract half of an expand/contract pair, in a release after the one that stopped
  using the object (Q52); schema-only and fast, with `lock_timeout`; the `migrate` lock and both call sites keep
  their tests (D25).
- **Contracts:** `.api.md` or `openapi.json` changed → the commit body says so and the Cloud follow-up issue exists.
- A test reproduces the failure the change guards against.

### Security units

| Unit | Paths | Attackers | Invariants | Priority |
|---|---|---|---|---|
| `http-chain` — middleware, sessions, cross-site checks | `packages/server/src/http/` `packages/server/src/auth/` | 2.1 2.2 2.6 2.12 | T3 T4 T5 T8 T9 T18 | yes |
| `tenancy` — withTenant, RLS, repositories, system ops | `packages/db/` | 2.2 2.3 2.5 | T1 T2 | yes |
| `domain` — services, sharing, go, entitlements | `packages/core/` | 2.2 2.3 2.4 2.5 | T2 T11 T12 | yes |
| `egress` — metadata, favicon, AI, OIDC discovery | `packages/adapters/src/egress/` `packages/adapters/src/ai/` | 2.7 | T6 T13 | yes |
| `identity` — OIDC, MFA, secret box | `packages/adapters/src/identity/` `packages/adapters/src/secret-box/` | 2.1 2.7 2.12 | T7 T17 T18 T20 | yes |
| `import` — JSON and Netscape parsers | `packages/core/src/import/` | 2.8 | T13 | no |
| `web` — SPA rendering of user content | `packages/web/` `packages/ui/` | 2.6 2.7 | T14 | no |
| `rest` — everything else | `packages/` `apps/` | 2.11 | T16 | no |

Sweeps:
- `sweep-raw-fetch` — files: `git grep -l -e 'fetch(' -e 'node:http' -e 'undici' -- 'packages/**/*.ts'` — any outbound call outside egress (T6).
- `sweep-raw-db` — files: `git grep -l -e 'drizzle(' -e 'postgres(' -- 'packages/**/*.ts'` — DB handles outside `packages/db` (T1).
- `sweep-html` — files: `git grep -l -e 'dangerouslySetInnerHTML' -e 'innerHTML' -- 'packages/**/*.tsx'` — unsanitised rendering (T14).

### Machine check

```
node -v                                # v24.x
pnpm -v                                # 10.x
docker info --format '{{.ServerVersion}}'
docker compose -f compose.dev.yml ps --status running postgres
```
