# SlugBase — Engineering Decisions

**Status:** Settled for v1. This is the **engineering / "how we build it" source of truth**.
**Precedence:** For *product* behaviour (scope, entitlements, tenancy, security, data model) the spec wins — `slugbase-mvp-spec.md` is authoritative. For *implementation* specifics (stack, tooling, conventions, infra, commands) this document is authoritative. Both derive from the spec's Resolved Decisions log (§21, decisions #37–#51).

This doc exists so roadmap tasks and sub-agents have concrete, runnable answers (frameworks, commands, package boundaries) instead of "TBD." It contains tool/framework choices and conventions — not product requirements.

---

## 1. Stack (settled — spec §19, decisions #37–#50)

| Concern | Choice | Rationale (spec anchor) |
|---|---|---|
| Language | **TypeScript** (strict, no `any`) | All packages; shared types across boundaries (§19) |
| Backend | **NestJS** | DI/modules host the config-selected external interfaces (§2.6, §11) — replaces deployment-mode branching; `@nestjs/swagger`/ts-rest → OpenAPI (§18). Runs as a Node container on Fly.io (§14.7) |
| Web client | **React Router v7** (framework mode) | One app, two adapters: Cloudflare Workers (hosted SSR) + Node (self-host combined image) — §14.2, §14.7 |
| Marketing | **Astro** (static) | Zero-JS-by-default; separately built; Cloudflare Workers (§2.3, decision #28) |
| Persistence | **Drizzle ORM** + **Drizzle Kit** | Data-access abstraction (§11.9); PostgreSQL-only at v1 (Neon hosted + self-host Postgres); SQLite self-host deferred (§16, #32/#41) |
| Contracts/validation | **Zod** + **ts-rest** | Server validation + env schema; single typed contract → OpenAPI, consumed by backend + web (§18, §19) |
| UI | **Tailwind** + **Radix** + **cmdk** | Tailwind bridged to prototype tokens (§23.1); Radix = accessible primitives; cmdk = `⌘K` palette (§9) |
| Tests | **Vitest** + **Supertest** + **Playwright** | Unit/integration (Vitest/Supertest), e2e (Playwright, CI-only, §22.4) |
| Build | **Turborepo** over pnpm workspace | Cached lint/typecheck/test/build pipelines (`turbo.json`) |
| Sessions | **DB-backed** server-side store | No Redis — bare self-host needs no extra services (§5.3, §14.5) |
| Password hashing | **argon2id** | OWASP-recommended adaptive hash (§5.4) |
| MFA | **otplib** + QR | TOTP enrolment + verification (§5.7) |
| CSRF | **double-submit token** | Over the §5.8 exempt allowlist |
| Background work | **In-process** (no worker/broker) | §22.10, §6.3 |
| AI provider (v1) | **OpenAI** | Behind the vendor-neutral AI interface (§11.2) |
| i18n | **Tolgee** (React SDK) | en + de catalogs (§17) |
| Secrets | **Infisical Cloud (EU)** | All envs (§15, §22.9) |

---

## 2. Package layout (decision #50)

pnpm workspace, single repo:

```
packages/
  backend/        # NestJS API: tenancy, auth/sessions, domain, entitlements, ALL interface impls
  web/            # React Router v7 signed-in app (canonical name — never "web-client")
  marketing/      # Astro static marketing site (separately built/deployed)
  shared-types/   # Zod + ts-rest contracts, interface contracts, generated OpenAPI types
  ui/             # shared components + design tokens (bridged from colors_and_type.css)
docs/             # customer/operator docs + internal-engineering section (this file)
```

- **No app package may depend on another app package.** Both `backend` and `web` depend on `shared-types` (and `web`/`marketing` on `ui`); never `web → backend`.
- The external-interface **contracts** live in `shared-types`; their **implementations** live in `backend`.
- Commit scopes for these packages: `backend`, `web`, `marketing`, `ui`, `shared`, `db` (rule `01-git-workflow`).

---

## 3. Conventions

- **File/identifier naming:** rule `04-naming` (kebab-case files with NestJS suffixes `*.service.ts`/`*.controller.ts`; `PascalCase.tsx` React components; `snake_case` DB columns; `SCREAMING_SNAKE_CASE` env).
- **TypeScript:** `strict: true`, `noUncheckedIndexedAccess`, no `any`, no `console.log` in committed code.
- **Interface pattern (NestJS):** each external dependency is an injectable token (e.g. `MAIL`, `AI`, `BILLING`, `CHALLENGE`, `FETCH`, `CRYPTO`, `DB`) bound to a config-selected provider in a module. Application services depend on the **token/contract**, never a concrete impl, and never on a deployment-mode flag (§2.6, §15). Default/no-op impls let a bare self-host run.
- **Public client env prefixes:** `VITE_` (the `web` app) / `PUBLIC_` (Astro `marketing`). Never put secrets in these — they are inlined into client bundles.

---

## 4. Data layer

- **One logical schema** defined in Drizzle for **PostgreSQL**. Drizzle Kit generates migrations from the Postgres schema (`dialect: postgresql`); one forward-only history applies to hosted Neon and self-host Postgres alike. Every tenant-owned table carries `workspace_id` (§4, §16). Embedded SQLite self-host is **deferred** (Fast-Follow).
- **Migrations:** owned by **Drizzle Kit** — `drizzle-kit generate` to create, `drizzle-kit migrate` to apply (typically wrapped as `pnpm db:generate` / `pnpm db:migrate`). **Single forward-only history.** Never hand-write SQL, never `drizzle-kit push`, never edit generated files (rule + orchestrator `prompt-templates` DB MIGRATIONS block). Requires `DATABASE_URL` with a `postgresql://` scheme for generate/migrate.
- **CI runs integration tests against Postgres** (GitHub Actions service container).
- **Data access is centralized** so every tenant query is workspace-scoped; cross-tenant access is impossible through normal paths and is defended by tests (§4.4).

---

## 5. API & contracts

- **REST**, described by **OpenAPI** generated from **ts-rest** contracts in `shared-types` (§18). The web client consumes the same contracts (no drift).
- All request bodies validated with **Zod `.strict()`** (reject unknown fields — rule `03-security-baseline`).
- Auth: session cookie **or** personal API token (Bearer); CSRF on cookie-authenticated mutations except the §5.8 allowlist.

---

## 6. Testing

| Layer | Tool | Lives in | Runs |
|---|---|---|---|
| Unit | Vitest | colocated `*.spec.ts` | every gate (`pnpm test:unit`) |
| Integration (API) | Vitest + Supertest | `*.e2e-spec.ts` / `packages/backend/test` | every gate (`pnpm test:integration`) |
| E2E | Playwright | `e2e/` | **CI only**, on `staging → main` PR (§22.4) |

Tenant-isolation tests (attempt cross-workspace access → expect denial) are mandatory for any data-access task (§4.4).

---

## 7. Build & local CI gate (rule `06-local-ci`)

Turborepo fans these out across packages. Full gate for code-impacting commits:

```bash
pnpm lint && \
pnpm typecheck && \
pnpm test:unit && \
pnpm build && \
pnpm test:integration && \
pnpm audit --audit-level=high
```

- Playwright e2e is **not** in the local gate (CI-only).
- Commands needing env run under Infisical: `infisical run --env=dev -- <cmd>`.
- Exact `pnpm` script names are finalized in the P1 scaffold; this gate is the contract they must satisfy.

---

## 8. Secrets — Infisical Cloud (EU) (spec §15, §22.9, decision #34)

| Field | Value |
|---|---|
| Instance | `https://eu.infisical.com` (Infisical Cloud, EU) |
| Project slug | `slugbase-cloud` |
| Environments | `dev` · `staging` · `prod` (no `dev` *deployment* — local only) |
| CI auth | OIDC via `Infisical/secrets-action`; **single** machine identity `INFISICAL_OIDC_IDENTITY_ID` (project-scoped read-only) |
| GHA secrets | only `INFISICAL_DOMAIN` + `INFISICAL_OIDC_IDENTITY_ID` |

**Layout:** all keys for an environment live at the **project root** (no Infisical subfolders). CI and `infisical run --env=<slug>` inject the full environment. Never put true secrets in `VITE_*` or `PUBLIC_*` keys (client bundles).

Adding an env var = the 4-step Infisical-first workflow in rule `05-env-vars` (Infisical + `.env.example` + Zod config schema + config-reference doc), in one commit. Security-critical secrets validated at startup; **no silent defaults** (§15).

---

## 9. i18n — Tolgee (spec §17, decision #33)

| Field | Value |
|---|---|
| Instance | `https://tolgee.mdg-labs.dev` (self-hosted) |
| Project | `4` (`/projects/4`); `TOLGEE_PROJECT_ID=4` |
| Client API URL | `VITE_TOLGEE_API_URL=https://tolgee.mdg-labs.dev` |
| PAT | `TOLGEE_API_KEY` (secret, Infisical env root) |
| SDK | Tolgee **React SDK** in `web`; shared project for Astro `marketing` |

Every UI string is a catalog key `<scope>.<context>.<descriptor>`; en + de required before merge (rule `10-i18n`). Language resolution: user pref → `Accept-Language` → `en`.

---

## 10. Hosted infrastructure & deploy (spec §14.7, decisions #31/#32/#51)

| Surface | Platform | Region |
|---|---|---|
| API | Fly.io `fra` (container, API-only variant) | Frankfurt |
| Web | Cloudflare Workers | Global edge |
| Marketing | Cloudflare Workers | Global edge |
| Database | Neon Postgres `aws-eu-central-1` | Frankfurt |

- **App naming:** `slugbase-<env>-<app>` — `<env>` ∈ {`staging`, `production`}, `<app>` ∈ {`api`, `web`, `marketing`}. Platform identifiers, not public hostnames. (decision #51)
- **Staging API scale-to-zero:** `slugbase-staging-api` runs `auto_stop_machines` + `min_machines_running = 0` (cold-start on request). `slugbase-production-api` stays warm (`≥ 1`). Workers scale to zero natively.
- **Self-hosted:** combined container image (API + bundled web) to GHCR on release; not subject to the hosted topology or naming.
- **CI/CD:** single `.github/workflows/ci-cd.yml`, GitHub-hosted runners, branches `staging`/`main` (spec §22; reference `docs/example.ci-cd.yml`).

---

## 11. Parallelization conventions (orchestrator Lane P enablers)

The roadmap marks tasks Lane P (parallel, isolated worktree) only when their WRITE scopes are disjoint. These conventions make most domain work genuinely non-contending so the orchestrator can batch it:

- **Schema split by domain:** each domain owns `packages/backend/src/<domain>/<domain>.schema.ts`; Drizzle Kit reads them via a glob/barrel. A new domain adds its own schema file (no contention). The **migration history + bookkeeping table is the one shared seam** → any task that *generates a migration* is **Lane S** (serialized), even if its schema file is new.
- **Contracts split by domain:** each domain owns `packages/shared-types/src/contracts/<domain>.contract.ts`; a thin root router composes them. Domain tasks add their own contract file rather than editing a central one.
- **NestJS feature modules are self-contained:** one module per domain, providing its own controllers/services and interface bindings. `app.module.ts`'s import list is a small shared seam → when two batch tasks must both register a module, the orchestrator either sequences the registration edits (Lane S touch) or splits the batch (Lane B). Prefer pre-creating empty module stubs in the foundation phase to remove the seam.
- **Web routes are file-based** (React Router v7): each route/loader/component is its own file → no central route-registry contention. Shared `ui` tokens/components are stabilized in P1 and treated as read-only by feature tasks (extending `ui` is its own task).
- **Known shared seams that force Lane S / B** (never parallelize against each other): Drizzle migration history, `app.module.ts` import list, the contract root router barrel, root tooling config (`package.json`, `pnpm-lock.yaml`, `turbo.json`), and the CI workflow file. The cross-cutting exception in the orchestrator SKILL applies (minimal, task-specific, justified).

The roadmap's per-phase **Batch plan** encodes this: a serial **spine** (schema/migration/module-registration/shared contracts) plus **parallel batches** of disjoint leaves.

---

## 12. Still finalized during implementation (not blockers)

- Concrete `pnpm`/`turbo` script names (must satisfy §7's gate) — fixed in the P1 scaffold task.
- `schema-reference.md` and `api-design.md` grow **incrementally** with the foundation + per-domain roadmap tasks (each domain task adds its tables/endpoints), rather than as a big upfront doc. They reference spec §16/§18.
- Per-surface CI identities — deferred hardening, not v1.
