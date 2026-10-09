# SlugBase — Overview

*A keyboard-driven bookmark manager where every link can get a short, private slug — saved once, reachable from the address bar in a few keystrokes. Self-hostable as the open-source Community Edition, or managed as SlugBase Cloud, built and hosted in the EU.*

---

## Document set

| Doc | Contents | Lands in |
|---|---|---|
| **00-overview.md** (this file) | Vision, editions, audiences, scope, decision log | `slugbase` |
| **01-architecture.md** | Stack, runtime topology, open-core composition, request lifecycle, tenancy enforcement, ports and adapters, background work, scaling model, extension points for composed deployments | `slugbase` |
| **02-product-spec.md** | Domain behaviour: accounts, workspaces, bookmarks, folders, tags, slugs and `/go`, search and palette, sharing, administration, import/export, AI suggestions | `slugbase` |
| **03-webui-spec.md** | Page inventory, per-page functionality, the coss ui component and particle for every element, design tokens | `slugbase` |
| **04-api.md** | API conventions, authentication, errors, pagination, rate limits, versioning, the operation inventory | `slugbase` |
| **05-data-model.md** | Schema, row-level security, migration policy, indexes, retention | `slugbase` |
| **06-billing-and-entitlements.md** | Cloud-only, private. Its CE-facing part (the entitlements engine and the no-op billing adapter) lands here as code | private Cloud repository |
| **07-deployment-and-operations.md** | Cloud-only, private. Its CE self-host part lands here | private Cloud repository |
| **08-dev-and-testing.md** | Local development, test tiers, CI gate, e2e | `slugbase` |
| **09-repo-architecture.md** | The three repositories, package layout, how Cloud composes CE, `CLAUDE.md` strategy, agent-driven workflow | `slugbase` |
| **10-threat-model.md** | Assets, attackers, entry points mapped to code, security invariants, accepted residuals, severity rubric | `slugbase` |
| **11-marketing-and-legal.md** | Cloud-only, private | private Cloud repository |
| **12-roadmap.md** | CE phases and epics, order of work, risk register (Cloud-only phases are planned in the Cloud roadmap) | `slugbase` |
| **13-open-questions.md** | **Every question raised while writing the docs, each with its decision** (maintainer's answer or adopted default, 2026-10-08) | `slugbase` |

Docs 06, 07 and 11 and the decision worksheet live in the private Cloud repository (`docs/internal/`); everything else is here. References like "doc 07" point there. Cloud-only material never lands in this public repository (D2).

Where a section says *(Qn)*, the choice it describes is decided in doc 13 (by the maintainer or by adopting the recommended default, 2026-10-08). Architecture-level decisions are also in the decision log below (Dn).

---

## 1. The product

SlugBase combines three tools that usually live apart:

1. **A bookmark manager** — save, organise into folders, tag, pin, search.
2. **A personal short-link service** — any bookmark can carry a **slug** (`mail`, `ci`, `wiki`) that forwards through `/go/<slug>` to the destination.
3. **A keyboard launcher** — `⌘K` opens a command palette that searches everything and accepts `go <slug>`; registering SlugBase as a browser search engine makes `go mail` in the address bar jump straight there.

Slugs are **private**: they resolve only for a signed-in member of the workspace that owns them. SlugBase is not a public URL shortener and never will be in v1 (D9).

### Editions

| | **Community Edition (CE)** | *SlugBase Cloud* |
|---|---|---|
| Who runs it | The operator, on their own server | MDG Labs, on EU infrastructure |
| Source | Public, AGPL-3.0 (`mdg-labs/slugbase`) | CE plus private Cloud modules, in a private repository |
| Onboarding | First-run setup, then admin invitations; public registration off by default | Public registration with email verification |
| Billing | None — full entitlements, no caps | Free, Personal, Team and a launch Supporter offer, through a separate billing service; current prices at [slugbase.app/pricing](https://slugbase.app/pricing) |
| Shape | One application image + PostgreSQL | Same application image composed with Cloud modules, scaled horizontally |

**CE and Cloud are the same product.** Every difference between them is configuration, an entitlement, or a different adapter behind a port — never an `if (cloud)` in application code (D4).

### Audiences

- **Individuals** who want a private, fast bookmark and short-link tool.
- **Teams** who share curated folders and slugs (`go onboarding`, `go runbook`).
- **CE operators** who run an instance for themselves, a family or a company and administer it with an instance-wide admin account.
- **The Cloud operator** (MDG Labs), who needs billing, plan enforcement and an operator console that is not part of the customer-facing application.

### What makes it worth building

Bookmark managers exist; short-link services exist; launchers exist. None of the self-hostable ones treat **the slug as the primary interface to a personal or team link library**, with real multi-user workspaces, sharing and a keyboard-first UI — and none of the hosted ones are EU-first with a self-hostable twin. That combination is the product.

---

## 2. Why a rebuild

The first implementation reached a working CE and a partly-deployed Cloud, but it is being replaced rather than refactored:

- **The frontend is inconsistent.** Components were hand-assembled on Radix primitives per screen; spacing, states and patterns drift between pages. The rebuild uses one component vocabulary — coss ui — named element by element in doc 03 (D13).
- **The open-core seam was fragile.** Cloud consumed CE through symlinks into a sibling checkout (`vendor/slugbase/`), which broke CI builds, Dockerfiles and installs whenever the two checkouts disagreed. The rebuild composes CE as a pinned source dependency with explicit extension points (D3, doc 09).
- **Two SQL dialects were a mistake.** "One schema for Postgres and SQLite" produced dialect drift and was removed. The rebuild is PostgreSQL-only from the first commit (D6).
- **The deployment story changed three times.** The rebuild ships stateless processes in one container image, so the deployment platform can change without an application change when scale demands it (D14, D16).
- **The agent harness changed** from Cursor to Claude Code with the MDG Labs workflow. The rebuild's docs, `CLAUDE.md` and rules are written for that workflow (D21, doc 09).

**What carries over unchanged:** the product idea, the vocabulary, the CE/Cloud split, the entitlement model and plan shape, the security posture (server-side sessions, SSRF-safe egress, encrypted secrets), the EU-first stack, and the V1 design prototype's visual language (dark-first, periwinkle accent, IBM Plex).

**What does not carry over:** any code, any migration, any data. The old instances hold no customer data worth migrating; the rebuild starts with an empty database and a single new migration history (D7). The old in-product billing library is retired too; Cloud billing is now a separate billing service (D29).

---

## 3. Vocabulary

Canonical product terms, used identically in UI copy, API names, database names and docs.

| Term | Meaning | Never |
|---|---|---|
| **Workspace** | The tenant. Owns all bookmarks, folders, tags, teams, slugs and settings; the unit of billing. | organization, org, tenant (in product copy) |
| **Account** | A person: a global identity by email that can sign in. | — |
| **Member** | An account's seat in a workspace, with a role: owner, admin or member. | user (when meaning membership) |
| **Bookmark** | A saved destination URL with a title and optional slug, owned by one member in one workspace. | link, item |
| **Slug** | A short keyword on a bookmark; unique per owner within a workspace. | alias, shortlink, keyword |
| **Forwarding / Go** | Resolving a slug through `/go/<slug>` to its destination. | redirect (in user-facing copy) |
| **Folder** | A named container; a bookmark can be in several. | collection |
| **Tag** | A label private to the member who created it. | — |
| **Team** | A named group of members, used as a sharing target. | group |
| **Pinning** | The only way to mark a bookmark as prominent. | favorite, star |
| **Plan / entitlement** | A plan is the Cloud package; entitlements are what the application checks. | — |
| **Workspace admin** | A member with the admin or owner role in a workspace. | org admin |
| **Instance admin** | A CE account with deployment-wide administration rights. | super admin, site admin |
| **Operator** | Whoever runs the deployment: the CE operator, or MDG Labs for Cloud. | — |

---

## 4. Scope

### v1 in scope

- Multi-tenant workspaces, membership and roles, a session-carried active workspace with an explicit switch.
- Accounts: password sign-in (argon2id), TOTP MFA with backup codes, email verification, password reset, change email, personal API tokens, OIDC sign-in with operator-configured providers, session management ("sign out everywhere").
- Bookmarks with modal-only create/edit, hard delete, folders, member-private tags, pinning, usage tracking, SSRF-safe metadata and favicon fetch.
- Slugs and `/go`: authenticated resolution in the active workspace, disambiguation with remembered choices, browser search-engine integration.
- Global search, the `⌘K` command palette with `go` mode, the dashboard.
- Sharing of bookmarks and folders with members and teams.
- Workspace administration: members, invitations, teams, audit log, AI toggle. CE instance administration: workspaces, accounts, instance settings.
- Entitlements engine; Cloud billing through a separate billing service (D29); no-op billing with full entitlements on CE.
- Plans (Cloud): Free, Personal, Team, and a time-boxed Supporter launch offer (entitlement-equivalent to permanent Personal), each an entitlement set with its limits; CE has no plans and full entitlements.
- Downgrade overflow: over-cap bookmarks are archived, never deleted, and restored on re-upgrade.
- Lossless JSON import/export, Netscape HTML import and export, and the documented CE backup story.
- AI field suggestions (title, slug, tags) behind a vendor-neutral port, operator-configured, opt-out per member.
- English and German throughout.
- The Cloud marketing site at slugbase.app (Cloud-only, doc 11).
- The Cloud operator console for **product data**, read-only, as its own service (doc 07 §6) — after launch (Phase 7, doc 12); not needed for launch. Billing operations live in the billing service, not here.

### v1 explicitly out of scope

| Excluded | Reason |
|---|---|
| Public or anonymous slug resolution, public share pages | Slugs are private by design (D9); a public shortener is a different abuse surface and product |
| Subdomain or path tenancy (`acme.slugbase.app`) | Session-carried workspace is enough for v1; the resolver is a port so it can be added (doc 01 §5) |
| Custom forwarding domains | Depends on per-workspace TLS and DNS verification; post-1.0 |
| Soft delete / trash | Hard delete plus confirmations for v1; plan-archive is not a trash |
| Browser extension, bookmarklet | Post-1.0; the API and API tokens are designed so an extension needs no new endpoints |
| Drag-and-drop reordering | Sort orders cover v1 |
| Notifications centre | Email covers the few notifications v1 has |
| AI beyond field suggestions (summaries, chat, auto-filing) | Narrow AI surface keeps cost, privacy and review bounded |
| A second SQL dialect (SQLite) | Removed on purpose (D6) |
| Additional adapters per port (second mail, AI or billing provider) | One adapter each at v1; the port exists |
| First-class backup/restore in the UI | Export + `pg_dump` documented for CE (`docs/self-hosting/backup-restore.md`, the CE part of doc 07 §7) |
| Languages beyond English and German | Catalog-based i18n makes adding them a translation task |

---

## 5. Decision log

Decisions already settled, with rationale. Reopening any of these needs a new reason, not a new preference. Recommended defaults for everything still open live in doc 13; a default is promoted here once it has survived real code. Where a decision has a Cloud half, this log states the part that holds for CE and the shared code; the Cloud half is recorded in the Cloud documentation under the same number.

| # | Decision | Rationale |
|---|---|---|
| D1 | The product, its vocabulary (§3) and its v1 scope (§4) carry over from the first implementation; the code, migrations and data do not | The idea and the spec were sound; the implementation was not. Starting from an empty database removes every migration-compatibility constraint |
| D2 | Open-core across three repositories: `mdg-labs/slugbase` (public, AGPL-3.0 — CE and every shared package), a private Cloud repository (Cloud modules, marketing, operator console, deployment), and a separate private billing service (the central MDG Labs billing service, D29) | The CE must be fully open and runnable on its own; Cloud-only code (billing integration, operator tooling, infrastructure details) must never be public; billing is shared across MDG Labs products |
| D3 | Cloud extends CE only through **composition roots and extension points** that CE defines (`createServer({ adapters, modules })`, `createWebApp({ extensions })`, a migration chain, and the named hooks of doc 01 §13), and consumes CE as a **pinned git submodule** built from source — no symlinks, no deep imports, no forks (doc 09 §3) | The old sibling-symlink seam broke builds; a submodule pins an exact CE commit for every Cloud build, makes the Cloud CI self-contained, and makes every seam an explicit, reviewable contract |
| D4 | No edition branches. Application code never reads an edition flag; differences are entitlements, configuration, or the adapter selected for a port | Keeps CE and Cloud one product; a CE user never runs code paths Cloud doesn't test and vice versa |
| D5 | **TypeScript, strict, end to end**, on **Node.js 24 LTS**, pnpm workspaces + Turborepo | One language for API, web, workers and the billing service; agents work across the whole stack in one idiom; the billing service and its client use the same stack. CPU-heavy work is rare in this product (doc 01 §1) |
| D6 | **PostgreSQL only** (18 is the reference version and ships in the compose file; CE also supports 17, Q3), on both editions | Two dialects were tried and removed; Postgres gives row-level security, `tsvector` search, `pg_trgm`, transactional DDL and a mature replication/scaling path |
| D7 | **Drizzle ORM**; schema in TypeScript is the single source; migrations are **generated by drizzle-kit**, reviewed, committed, never edited after merge, forward-only and expand/contract | The schema cannot drift from the migrations; immutable migrations mean an applied migration means the same thing on every install; expand/contract keeps rolling deploys safe with several API replicas |
| D8 | **Tenant isolation is enforced twice**: every query goes through a workspace-scoped data-access layer, **and** Postgres **row-level security** (`FORCE ROW LEVEL SECURITY`, non-owner application role, `SET LOCAL app.workspace_id` per transaction) rejects anything the first layer misses | Cross-tenant leakage is the worst bug a multi-tenant product can ship; RLS turns a forgotten `WHERE workspace_id = …` from a breach into an empty result |
| D9 | Slugs are private to a workspace; `/go` always requires a signed-in member; no anonymous resolution, no public pages in v1 | Defines the product and removes the abuse class (phishing, spam redirects) that public shorteners attract |
| D10 | **Server-side sessions only**: an opaque random token in a `__Host-` HttpOnly, Secure, SameSite=Lax cookie, stored as a SHA-256 hash in Postgres; individually revocable. Personal API tokens (hashed, prefixed `slb_`) for programmatic access. No JWT sessions, nothing in browser storage | Immediate revocation and "sign out everywhere" without a token-blocklist; nothing a script injection can exfiltrate from storage |
| D11 | **One origin per deployment**: the SPA, `/api/*` and `/go/*` share a single origin (Cloud: `app.slugbase.app`; CE: the operator's host) | Removes CORS and cookie-domain configuration entirely, makes SameSite and Origin checks strict by default, and lets the browser search-engine URL be the app URL |
| D12 | API: **Hono** on Node, **code-first** — Zod schemas in `@slugbase/contracts` define every operation; the **OpenAPI 3.1 document is generated and committed**, CI fails on drift; the web client and operator console use a **generated typed client** (`openapi-typescript` + `openapi-fetch`). REST + JSON, no GraphQL; every UI capability is a documented operation | One contract source; a mismatched client fails to compile; scripts, API-token users and a future extension can do anything the UI can. Hono's small surface, standard `Request`/`Response` model and first-class Zod/OpenAPI support suit a security-sensitive, agent-built API |
| D13 | Web app: **React 19 SPA built with Vite**, **TanStack Router** (type-safe routes and search params) and **TanStack Query**; UI built on **coss ui** — Base UI primitives with Tailwind CSS v4, vendored with the shadcn CLI from the `@coss` registry into `@slugbase/ui`, `lucide-react` icons — and doc 03 names the component and particle for every element | One accessible, consistent component vocabulary for a UI built largely by agents (the first implementation's main failure); copy-and-own means no runtime dependency on a moving design system; the same choice as Hoserva (its D15), so MDG Labs products share one vocabulary and the coss agent skills; coss is AGPL-3.0, compatible with CE (D20). A static SPA needs no Node SSR server: it is served as hashed static assets and cached at the CDN |
| D14 | **Stateless application processes**: `server` (HTTP) and `worker` (jobs and schedules) are the same image with different commands; all state lives in Postgres (sessions, jobs, rate-limit counters, caches) at v1; nothing is kept on local disk | Any process can be killed, restarted or replicated at any time; horizontal scaling is "run more containers", and changing the deployment platform needs no application change |
| D15 | Background work runs on **pg-boss** (Postgres-backed queue) in the `worker` process; scheduled jobs use pg-boss schedules (single-runner by design). No Redis/Valkey at v1; shared fast state is behind ports so a Valkey adapter can be added when measurements call for it (doc 01 §8) | One less service for CE operators and for Cloud ops; Postgres comfortably carries this product's job volume well past launch scale |
| D16 | **Cloud runs as Docker-image applications** pulling immutable, version-tagged images from a private registry; CI builds and pushes images and triggers deploys; the deployment platform never builds from source. Environments: `staging` and `production` (doc 07) | Builds are reproducible and happen once; the same image digest moves from staging to production; the deployment platform stays a thin runtime that can be swapped for Kubernetes or another orchestrator later (doc 07 §9) |
| D17 | **EU-first**: every Cloud subprocessor and every service that touches customer data is EU-established and EU-hosted, including the AI provider (Q8); the subprocessor list is in the Cloud documentation (doc 11) | A deliberate product property and a GDPR simplification: no third-country transfers in the default Cloud configuration |
| D18 | Billing: Cloud's adapter for CE's `BillingPort` is a **client of the separate billing service** (D29), and the Cloud `EntitlementSource` derives entitlements from what that service reports. The payment provider is reached only by the billing service. CE uses the no-op adapter (full entitlements, never charges). Application code checks **entitlements**, never billing state | Keeps billing out of the public repository and out of product logic; the billing invariants live once, in the billing service, for every product |
| D19 | **English and German** from the first screen; every user-facing string in repo JSON catalogs (`react-i18next` in the app); CI checks catalog parity and hard-coded strings | Retrofitting i18n is expensive; German is the operator's and the first market's language |
| D20 | **CE is AGPL-3.0**, `LICENSE` at the repository root; Cloud and the billing service are proprietary; "SlugBase" is a trademark with a `TRADEMARK.md` policy | An open, inspectable CE whose derivatives stay open; the hosted service is the commercial surface, not license terms. (The first implementation's marketing copy still said "ELv2"; that was wrong and is not carried over) |
| D21 | Development is agent-driven with **Claude Code** and the **MDG Labs workflow from `mdg-labs/skills`**, vendored with `/mdg-setup:setup` (**full** profile: triage, orchestrate, open-pr, cr-review, dev-diff, security-audit, customer-docs) into `slugbase` **and** the private repositories from their first commit. **GitHub issues are the tracker and the plan** (`status:*` labels, `issue-status.yml`); `/orchestrate` implements `ready` items with executor/verifier agents in scratch clones and lands them on **`dev`** (`landing: dev-cherry-pick`); `dev` → `main` moves through one promotion PR (`/open-pr`, one `/cr-review` round). `CLAUDE.md` `## Agent workflow` and `.claude/workflow.json` are written from these docs (doc 09 §5); `threatModel` points at doc 10 from day one, so `/security-audit` works before the first feature | One workflow across every MDG Labs repository, proven in Hoserva; vendored files work locally and in cloud sessions; issues-as-plan keeps these docs and the work in one traceable chain (roadmap phase → epic → issue → commit `Fixes #n`) |
| D22 | Every external dependency sits behind a **port** with a no-op or local default, so a bare CE install runs with zero external services: mail, AI, OIDC, billing, analytics, error reporting, bot protection, outbound HTTP (SSRF-safe egress), secret encryption, rate limiting, object storage (if introduced) | Swappable adapters replace edition branches (D4); a CE install never fails because an optional service is missing |
| D23 | **Security is a v1 requirement, not a phase**: the threat model (doc 10) exists before the first feature; every risk-flagged change gets the risk review in `CLAUDE.md`; a security audit runs before each production promotion | The product holds people's private link libraries and team runbooks; one leak ends trust in a privacy-positioned product |
| D24 | **Configuration comes only from environment variables**, validated by the env schema; values are set by the operator (for Cloud, by the maintainer). Agents may compare key *names* against the key inventory but never read or write values. Local development uses a gitignored `.env` copied from the committed `.env.example`. Cloud's secret handling is in the Cloud documentation (Q75, Q13) | One fewer service and sync step. Each secret lives where it is consumed, and nothing on a developer machine holds staging or production values |
| D25 | **Migrations: one `migrate` command.** CE migrates on startup: the image entrypoint runs `migrate` under a Postgres advisory lock with `lock_timeout`, then starts the server without the migrator credentials. A managed deployment may disable that with `MIGRATE_ON_START=false` and run `migrate` from the new image before deploying it; Cloud does, and its deploy order is in the Cloud documentation. Both paths run the same `migrate` command (Q76, Q56) | Migrations run once, before rollout, and are safe with any number of replicas; a failed migration stops the rollout before anything changes. CE operators run no extra step |
| D26 | Cloud network topology — recorded in the Cloud documentation | — |
| D27 | **Observability:** errors go through `ErrorReportPort`, which accepts any Sentry-SDK compatible tracker (no-op by default); `/health` and `/version` serve uptime monitors and deploy checks; the app's internal `/metrics` endpoint stays, unscraped by default. Cloud's tooling is in the Cloud documentation (Q66) | Lightweight, and it covers the questions that matter at launch: is it up, what broke. Heavier tooling waits for a measured need |
| D28 | Cloud commercial terms — recorded in the Cloud documentation | — |
| D29 | **Billing is one separate MDG Labs billing service**, outside this repository, and the payment provider only moves money. The billing service owns products, customers, plans and prices, checkout, renewals, signed events to products, reporting, and the billing operator console for all products. **Customers never see it:** SlugBase's own frontend shows all billing UI, SlugBase's backend calls the billing service, and the only redirect is the payment provider's hosted payment page | Billing is business-level, not product-level: one seller, one console and one set of business-wide totals across MDG Labs products. A library inside each product would duplicate the console and scatter those totals across databases |

---

## 6. Naming and positioning

**Name:** SlugBase — settled. Domain `slugbase.app`. Product hostnames: `slugbase.app` (marketing), `app.slugbase.app` (Cloud application, Q4), `docs.slugbase.app` (user docs, Q2).

**Positioning:** described by what it does — *bookmarks with private short links and a keyboard launcher* — and by two properties: **self-hostable** (CE, AGPL-3.0) and **EU-hosted** (Cloud). No "X alternative" framing, no claims about competitors that aren't sourced facts.

**Licence copy:** CE is "open source (AGPL-3.0)". Never "source available", never "ELv2".
