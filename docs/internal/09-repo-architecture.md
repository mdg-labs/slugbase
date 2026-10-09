# SlugBase — Repository Architecture

## Recommendation: three repositories, each a pnpm monorepo — this public CE repository and two private ones (SlugBase Cloud and the MDG Labs billing service); Cloud composes CE from a pinned submodule; the MDG Labs agent workflow is vendored into all three from their first commit.

---

## 1. Why three repositories, and not one

Hoserva is one monorepo because one developer ships one artefact (its doc 12 §1). SlugBase has a constraint Hoserva doesn't: **part of the product must be public and part must never be** (D2). That decides the split; everything else follows Hoserva's reasoning *inside* each repository.

| Repository | Visibility | Owns | Why separate |
|---|---|---|---|
| `mdg-labs/slugbase` | Public, AGPL-3.0 | CE and every package Cloud builds on: contracts, core, db, server, adapters, email, ui, web, testing; the CE image | The CE must be fully open, buildable and runnable on its own (D20). Anything in it is published the moment it is pushed |
| The private Cloud repository | Private, proprietary | The SlugBase Cloud composition of CE, plus Cloud-only modules, web extensions and tooling (Cloud doc 09 §1) | Billing, operator tooling and infrastructure details must never be public (§4) |
| The billing service | Private, proprietary | The central MDG Labs billing service, shared by every MDG Labs product (Cloud doc 09 §1) | SlugBase Cloud talks to it only through its API; CE never does |

**Inside each repository the monorepo arguments hold unchanged**: backend, contracts and UI change in one commit; one gate gives one verification signal; one `CLAUDE.md` holds the rules; refactors are mechanical. The cost of the split is concentrated in one place — the CE ↔ Cloud seam — and §3 makes that seam explicit, versioned and checked, instead of the symlinked sibling checkout that broke the first implementation (doc 00 §2).

**Kept here, published elsewhere:** the documentation content (end users, operators, release notes) lives in this repository, written with the `customer-docs` skill (§5.6) and held to the docs contract (§3.5). There is no separate docs repository (Q2). The one site that publishes it, `slugbase.app/docs`, is built in the private Cloud repository (§4), which asks for a rebuild when the documentation changes (the hook of §3.5, Q111).

---

## 2. Layouts

`packages/` holds libraries; `apps/` holds deployables (a composition root, an image, a `main`). A library never imports an app.

### 2.1 `mdg-labs/slugbase` (CE, public)

```
slugbase/
├── CLAUDE.md                     agent instructions (§5.3)
├── LICENSE                       AGPL-3.0 (D20)
├── TRADEMARK.md · SECURITY.md · CONTRIBUTING.md
├── package.json · pnpm-workspace.yaml · pnpm-lock.yaml · turbo.json · tsconfig.base.json
├── compose.dev.yml               local Postgres (+ Mailpit) for development and tests (doc 08 §1)
├── compose.yml                   the published self-hosting stack: postgres, slugbase, slugbase-worker (doc 01 §2.1)
├── .nvmrc                        24
│
├── .claude/                      vendored MDG Labs workflow (§5) + repo-owned workflow.json, rules, known-escapes.md,
│                                 and customer-docs/docs-config.md (content root docs/user, build check pnpm docs:check)
├── .github/
│   ├── workflows/                ci.yml, e2e.yml, release.yml, codeql.yml, issue-status.yml (doc 08 §6)
│   ├── ISSUE_TEMPLATE/           from mdg-labs/skills templates/github (§5.5)
│   └── actionlint.yaml
├── docs/
│   ├── internal/                 these design docs, including the threat model at 10-threat-model.md,
│   │                             the path workflow.json `threatModel` names (§7)
│   ├── user/                     end-user documentation, written with /customer-docs (§3.5, §7); published
│   │                             at slugbase.app/docs by the site
│   ├── self-hosting/             operator documentation: install, environment, reverse proxy, mail, OIDC,
│   │                             backup and restore, upgrade, operations, security (§7)
│   └── releases/                 release notes per version, `<version>.md`, the source of the draft GitHub
│                                 Release (§7)
│
├── packages/
│   ├── contracts/                @slugbase/contracts — Zod schemas per operation in src/operations/, the OpenAPI
│   │                             generator, and generated/ with openapi.json and the TS client types (both committed)
│   ├── core/                     @slugbase/core — domain services, port interfaces, entitlement engine,
│   │                             authorization policies, domain events catalog; no I/O imports allowed
│   ├── db/                       @slugbase/db — Drizzle schema, generated migrations, RLS policy SQL, roles,
│   │                             withTenant(), repositories, system operations (doc 05)
│   ├── server/                   @slugbase/server — createServer(), the middleware chain (doc 01 §4),
│   │                             routes, module interface, worker runtime, `server|worker|migrate` commands
│   ├── adapters/                 @slugbase/adapters — CE adapters: smtp, log-mail, openai-compatible AI, OIDC,
│   │                             Altcha, sentry-protocol errors, egress, secret box, pg rate limit,
│   │                             no-op billing, full entitlements
│   ├── email/                    @slugbase/email — React Email templates, EN/DE
│   ├── ui/                       @slugbase/ui — coss ui components vendored with the shadcn CLI (D13) into
│   │                             src/components/ui/, SlugBase tokens and particles; components.json with the @coss registry
│   ├── web/                      @slugbase/web — the SPA as a library: createWebApp({ extensions }),
│   │                             routes, slots, i18n catalogs
│   └── testing/                  @slugbase/testing — Postgres test harness, factories, two-workspace fixtures,
│                                 the cross-tenant matrix runner, MSW handlers generated from contracts
│
├── apps/
│   └── slugbase/                 the CE composition root: server main (CE adapters, no extra modules),
│                                 web entry (no extensions), the embedded web build and build-info file that
│                                 /version reads, Dockerfile and entrypoint → the CE image (name per Q12)
│
└── e2e/                          Playwright against the CE image (doc 08 §5)
```

Package boundaries are enforced by `eslint-plugin-boundaries` (or dependency-cruiser) rules in the lint step:

| Package | May import | Must not import |
|---|---|---|
| `contracts` | `zod` | anything in the repo |
| `core` | `contracts` | `db`, `server`, `adapters`, any I/O module (`node:net`, `node:http`, `fetch`, drivers) |
| `db` | `core`, `contracts` | `server`, `adapters` |
| `adapters` | `core`, `contracts`, the public entry of `db` | `server`, `db` internals |
| `server` | `core`, `db`, `contracts` | `adapters` (adapters are injected by the app) |
| `web` | `contracts`, `ui` | `core`, `db`, `server` |
| `ui`, `email` | no workspace package | every workspace package (widening needs an edit here) |
| `apps/*` | everything | — |

`fetch`, `node:http(s)` and `undici` are importable only inside `adapters/src/egress/` (doc 01 §10); the raw database handle only inside `db` (doc 01 §5.3); `@slugbase/testing` only from test files, `test/` folders and `apps/*` development tooling.

### 2.2 The private Cloud repository

(Cloud) Recorded in the Cloud documentation (Cloud doc 09 §2.2). From CE's side it is enough to know that Cloud builds CE from source at exactly the pinned commit (§3.2) and never includes CE's own `apps/slugbase`.

### 2.3 The billing service

(Cloud) Recorded in the Cloud documentation (Cloud doc 09 §2.3). CE holds no billing-service code, schema or client; CE ships the no-op billing adapter with full entitlements (§2.1).

---

## 3. The CE ↔ Cloud seam

### 3.1 What Cloud may depend on

Exactly the contracts listed in doc 01 §7.4, each exported from a named entry point:

| Contract | Exported from |
|---|---|
| `createServer()` options, the module interface, domain event catalog, port interfaces, authorization helpers, exported repositories | `@slugbase/server`, `@slugbase/core`, `@slugbase/db` (public entry points only) |
| `createWebApp()` options, slot names and props, exported hooks and route helpers | `@slugbase/web` |
| Every `@slugbase/ui` component | `@slugbase/ui` |
| The `public` schema (tables, columns, enums Cloud references by foreign key) | `@slugbase/db` schema |
| The HTTP API | `@slugbase/contracts` → `openapi.json` |

The generic extension points a composition can use beyond these contracts (hooks with default no-op behaviour) are listed in one place in doc 01, under "Extension points for composed deployments".

Every exported entry point has an **API Extractor report** (`packages/*/etc/*.api.md`) committed in CE. CI regenerates the reports and fails when they differ from the committed ones, so **a contract change is always visible in the diff** — the author has to commit the new report on purpose. Deep imports (`@slugbase/server/src/...`) are blocked by each package's `exports` map and by a lint rule in Cloud.

### 3.2 Pinning and bumping

- `ce/` is a submodule. Cloud's **`dev`** may pin any CE commit reachable from CE `dev`; Cloud's **`main`** must pin a commit reachable from CE **`main`**. Cloud's CI enforces both, so production Cloud never runs unreviewed CE code.
- **A bump is a pull request in the private Cloud repository,** opened or updated by a scheduled workflow there (CE never calls it): it moves the submodule pin, regenerates the Cloud lockfile and passes the gate; contract fallout is fixed in the same pull request or filed as an item. One bump per CE promotion is the rhythm; bumping to a CE `dev` commit is allowed when a Cloud item needs an unreleased CE change.
- **Cloud never edits `ce/`.** The submodule is read-only from Cloud — a change CE needs is an item in `mdg-labs/slugbase` (the follow-up-item rule, §3.3). A lint rule and a CI check (`git -C ce status --porcelain` empty, pin unchanged except in bump commits) enforce it.

### 3.3 The follow-up-item rule

- A **CE change that alters a contract** (an `.api.md` report, `openapi.json`, the `public` schema, a slot or event name) names it in its commit body and, in the same `/orchestrate` run, the orchestrator files the follow-up issue in the private Cloud repository: "Adopt CE `<change>` (CE #n)". The CE verifier checks that the follow-up exists before PASS (CLAUDE.md Risk review, §5.3).
- A **Cloud item that needs a CE change** is blocked-by a CE issue filed in `mdg-labs/slugbase` that describes the need without Cloud internals (it will be public), e.g. "Expose a `member.left` domain event" — never the Cloud reason behind the need.
- **Removal follows deprecation**: a contract Cloud uses is marked `@deprecated` in one CE promotion and removed in a later one, after the Cloud bump that stops using it.

### 3.4 Schema ownership

CE owns `public`; Cloud owns its own schemas (doc 01 §7.3). The billing service has its own database, so no billing-service schema exists in SlugBase. Cloud tables may reference `public` by foreign key; `public` never references anything else. A CE migration that drops or renames a column referenced from a Cloud schema is a contract change (§3.3) and follows expand/contract across two promotions (doc 05).

### 3.5 The documentation contract and the docs-published hook

The documentation content is in this repository (Q2). The site that publishes it is built in the private Cloud repository, which merges these files with its own Cloud-only pages. Both sides rely on the two things below, stated once here.

**Where the content lives.**

| Root | Content |
|---|---|
| `docs/user/` | End-user documentation, written with `/customer-docs` |
| `docs/self-hosting/` | Operator documentation (§7) |
| `docs/releases/<version>.md` | Release notes (§7) |

`/customer-docs` is configured in `.claude/customer-docs/docs-config.md` with content root `docs/user` and the build check `pnpm docs:check`, which is the same command as `docs.build` in `.claude/workflow.json`. CE's CI runs `docs:check` on every change under these roots.

**The docs contract.** `docs:check` fails a change that breaks any of the following:

- **Format.** Markdown or MDX files with frontmatter. The fields are `title`, `description` and `edition` (`ce`, `cloud` or `both`); `since` (a version) and `order` are optional. `edition` and `since` tell the reader which edition and from which version a feature is available; the site renders them as edition callouts and badges.
- **MDX is restricted,** because the content is built by the CI of whoever publishes the site. A file may not contain `import` or `export` statements or arbitrary JSX. The only components allowed are an allow-list: callout, tabs, steps, edition badge and screenshot.
- **Links** are relative, or to `/docs/...`.
- **Assets.** Images live next to the page that shows them. There are no scripts, iframes or third-party embeds.
- **Language.** English only for now.
- **Help links from the app.** The app links to the documentation through a stable `/docs/<route>` structure and a configurable docs base URL whose default is `https://slugbase.app/docs` (`DOCS_BASE_URL`, doc 01 §11; doc 03 sidebar footer).

**The docs-published hook (Q111).** The workflow `.github/workflows/docs-published.yml` asks the site repository to rebuild when documentation changes. It is generic: it names no private repository and no host (§4); the target comes from configuration.

- **Triggers.** A push to `main` that touches `docs/user/**`, `docs/self-hosting/**` or `docs/releases/**`, and `workflow_dispatch`.
- **Action.** It sends a GitHub `repository_dispatch` of type `docs-published` with `client_payload.sha` set to the commit it runs on (for a push, the pushed commit). Nothing else is in the payload.
- **Configuration.** The target repository is the repository variable `DOCS_SITE_REPOSITORY` (owner/name). The credential is the secret `DOCS_SITE_DISPATCH_TOKEN`, a fine-grained token limited to dispatching on that one repository. The token and the variable are set by the maintainer only (D24).
- **No-op rules.** The workflow does nothing when the variable or the secret is unset, or when the repository it runs in is not the upstream CE repository. Forks and self-hosters therefore never send anything.
- **The receiving side** is recorded in the Cloud documentation (Cloud doc 07 §4.4, Cloud doc 11). What CE relies on is that it treats the payload as untrusted data: it accepts only a 40-character hexadecimal `sha` that is reachable from CE `main`, fetches only the three docs paths at that commit, never executes or interpolates the payload into a shell, and falls back to the docs of its pinned CE submodule when the fetch fails, so this repository's availability never blocks a deploy. A daily scheduled rebuild on that side is the safety net for a missed dispatch.

---

## 4. What never appears in the public repository

The CE repository is public from its first commit, and `CLAUDE.md` restates this as a hazard in every dispatch.

- **No Cloud code or Cloud-specific names** beyond the generic seams (`BillingPort`, entitlements, the module, event and slot interfaces). That rules out: the names of the payment provider and the billing service, billing adapter implementations, plan prices and commercial terms, Cloud hostnames other than the public `slugbase.app` website and its customer-facing subdomains, the private image registry, the names of the deployment platform's projects and servers, the private tunnel's sites and resources, internal IPs and operator emails.
- **No secrets, ever**, including token-shaped examples (`<your API token>`).
- **No issue or commit text that describes Cloud internals** (§3.3).
- **No Cloud-only docs**: doc 07 (except its CE self-host section), doc 11, the billing half of doc 06, legal drafts, runbooks and Cloud assessments live in the private Cloud repository.
- **Mechanical guards**: a `forbidden-terms` check (`scripts/check-forbidden-terms.sh`, run by the `forbidden-terms` workflow until CE's lint step takes it over), GitHub secret scanning with push protection, and the verifier's hazard check. The concrete patterns live only in `scripts/forbidden-terms.txt`, which holds generic patterns for the categories above; this doc does not repeat them.

**What is welcome.** The line is drawn at how Cloud is run and built, not at whether it exists. CE promotes SlugBase Cloud as the managed alternative to self-hosting, in the README, the user docs and the product itself:

- the name *SlugBase Cloud*, that it is managed and EU-hosted, and that it is built from this code;
- its public hostnames: `slugbase.app` (website, pricing, signup, and the documentation at `slugbase.app/docs`) and `app.slugbase.app`; there is no `docs.slugbase.app` (Q2);
- the plan names (Free, Personal, Team, the Supporter offer) and what each entitles, since the entitlement engine is CE's;
- links to the pricing page and signup. Prices themselves are linked, never written into this repository, so they have one source and cannot go stale here.

The site itself (`slugbase.app`: marketing pages at `/`, documentation at `/docs`) is built and deployed from the private Cloud repository, because it carries the legal pages, prices read from the billing service and Cloud's contact and analytics modules. It takes the documentation content from this repository (§3.5), so the content is public from its first commit and follows these rules like any other file here. It links to this repository for self-hosting.

---

## 5. Agent workflow — the MDG Labs Claude Code workflow from day one

All three repositories run the workflow from `mdg-labs/skills` (D21). It is installed before the first line of product code, so the first product issue is already implemented by `/orchestrate`.

### 5.1 Install

On the development machine, once:

```bash
claude plugin marketplace add mdg-labs/skills
claude plugin install mdg-setup@mdg-labs
```

In each repository, as its first commit after the skeleton:

```
/mdg-setup:setup            → profile: full
```

`setup` vendors the skills (`triage`, `orchestrate`, `open-pr`, `cr-review`, `dev-diff`, `security-audit`, `customer-docs`), the agents (`task-executor`, `task-verifier`, `issue-refiner`, `ci-investigator`, `security-reviewer`, `security-verifier`), scripts, tracker docs and the shared rules (`mdg-git.md`, `mdg-security.md`, `mdg-github-actions.md`) into `.claude/`, records them in `.claude/mdg-workflow.lock.json`, and writes the `## Agent workflow` skeleton into `CLAUDE.md`. The vendored files are committed, so the workflow also runs in claude.ai/code cloud sessions. `mdg-workflow` is never enabled as a plugin. Re-running `setup` updates the vendored copy; local edits are detected and asked about.

Then, per repository: fill `.claude/workflow.json` (§5.2) and the `## Agent workflow` section (§5.3), run `.claude/scripts/bootstrap-labels.sh`, commit `.github/workflows/issue-status.yml` and the issue templates `setup` rendered.

### 5.2 `.claude/workflow.json`

**`mdg-labs/slugbase`:**

```json
{
  "$schema": "./workflow.schema.json",
  "repo": "mdg-labs/slugbase",
  "maintainer": "mdguggenbichler",
  "githubRunner": "ubuntu-latest",
  "tracker": { "type": "github" },
  "branches": { "integration": "dev", "production": "main" },
  "landing": "dev-cherry-pick",
  "promotionBudget": 100,
  "gate": "pnpm gate",
  "checks": [
    { "paths": ["packages/contracts/**"], "run": "pnpm turbo run lint typecheck test:unit build --filter=@slugbase/contracts... && pnpm contracts:check", "requires": ["node", "pnpm"] },
    { "paths": ["packages/core/**"], "run": "pnpm turbo run lint typecheck test:unit --filter=@slugbase/core...", "requires": ["node", "pnpm"] },
    { "paths": ["packages/db/**"], "run": "pnpm turbo run lint typecheck test:unit --filter=@slugbase/db... && pnpm db:check && pnpm test:integration --filter=@slugbase/db...", "requires": ["node", "pnpm", "docker"] },
    { "paths": ["packages/server/**", "packages/adapters/**"], "run": "pnpm turbo run lint typecheck test:unit --filter=@slugbase/server... --filter=@slugbase/adapters... && pnpm test:integration --filter=@slugbase/server", "requires": ["node", "pnpm", "docker"] },
    { "paths": ["packages/web/**", "packages/ui/**"], "run": "pnpm turbo run lint typecheck test:unit build --filter=@slugbase/web... --filter=@slugbase/ui... && pnpm i18n:check", "requires": ["node", "pnpm"] },
    { "paths": ["packages/email/**"], "run": "pnpm turbo run lint typecheck test:unit --filter=@slugbase/email... && pnpm i18n:check", "requires": ["node", "pnpm"] },
    { "paths": ["apps/slugbase/**", "Dockerfile*"], "run": "pnpm turbo run build --filter=slugbase && docker build -f apps/slugbase/Dockerfile -t slugbase:check .", "requires": ["node", "pnpm", "docker"] },
    { "paths": ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "turbo.json", "tsconfig*.json"], "run": "pnpm gate", "requires": ["node", "pnpm", "docker"] },
    { "paths": [".github/workflows/**"], "run": "actionlint", "requires": ["actionlint"] }
  ],
  "bootstrap": "pnpm install --frozen-lockfile",
  "signoff": { "mode": "hook", "hooksPath": ".githooks" },
  "models": { "verifier": "opus", "refiner": "auto" },
  "ci": { "branchPrefix": "ci/", "watchTimeout": 5400 },
  "threatModel": "docs/internal/10-threat-model.md",
  "securityAudit": { "exclude": ["packages/contracts/generated/**", "packages/db/migrations/**", "packages/ui/src/components/ui/**"] },
  "riskPaths": [
    "packages/db/**",
    "packages/server/src/http/**",
    "packages/server/src/auth/**",
    "packages/core/src/auth/**",
    "packages/core/src/entitlements/**",
    "packages/core/src/sharing/**",
    "packages/core/src/go/**",
    "packages/adapters/src/egress/**",
    "packages/adapters/src/secret-box/**",
    "packages/adapters/src/identity/**",
    "packages/contracts/**",
    "packages/server/src/migrate/**",
    "apps/slugbase/Dockerfile",
    "apps/slugbase/docker-entrypoint.sh"
  ],
  "labels": {
    "areas": [
      { "name": "area:contracts", "color": "006b75", "description": "API contracts and OpenAPI — packages/contracts" },
      { "name": "area:core", "color": "1d76db", "description": "Domain services, ports, entitlements — packages/core" },
      { "name": "area:db", "color": "0e8a16", "description": "Schema, migrations, RLS, repositories — packages/db" },
      { "name": "area:server", "color": "0052cc", "description": "HTTP server, middleware, routes, worker — packages/server" },
      { "name": "area:adapters", "color": "5319e7", "description": "CE adapters — packages/adapters" },
      { "name": "area:web", "color": "d876e3", "description": "Web app — packages/web" },
      { "name": "area:ui", "color": "c5def5", "description": "coss ui components and tokens — packages/ui" },
      { "name": "area:email", "color": "fef2c0", "description": "Email templates — packages/email" },
      { "name": "area:ci", "color": "e99695", "description": "CI, images, release — .github, apps/slugbase/Dockerfile, scripts" },
      { "name": "area:docs", "color": "0075ca", "description": "docs/ — design docs and threat model" }
    ],
    "risk": { "name": "safety-critical", "color": "b60205", "description": "Touches tenancy, auth, sessions, egress, secrets or migrations — Opus verifier, never bundled" },
    "maintainerOnly": { "name": "maintainer-only", "color": "5d4037", "description": "Needs the maintainer: legal, money, DNS, registry or production access" }
  },
  "readiness": {
    "stale": [
      { "pattern": "NestJS|@nestjs", "reason": "the old backend framework; the server is Hono (D12)" },
      { "pattern": "React Router (v7|framework)|entry\\.server|SSR", "reason": "the old SSR web app; the app is a Vite SPA (D13)" },
      { "pattern": "vendor/slugbase|link-slugbase-workspace|sibling checkout", "reason": "the old symlink seam; Cloud uses a pinned submodule (D3)" },
      { "pattern": "Fly\\.io|Cloudflare|Workers|Neon|Turnstile", "reason": "retired hosting and bot protection; bot protection is Altcha (D16, D17)" },
      { "pattern": "Stripe", "reason": "retired payment provider; billing sits behind BillingPort (D18, D29)" },
      { "pattern": "SQLite|better-sqlite3", "reason": "PostgreSQL only (D6)" },
      { "pattern": "ELv2|source[- ]available", "reason": "CE is AGPL-3.0 (D20)" },
      { "pattern": "\\bstaging\\b branch|origin/staging|push to staging", "reason": "the integration branch is dev; staging is only a deployment environment", "exempt": "environment" },
      { "pattern": "SLUGBASE_EDITION|SLUGBASE_MODE|isCloud", "reason": "no edition flags (D4)" },
      { "pattern": "Radix|cmdk|ts-rest|Phasical|\\.cursor/", "reason": "retired UI stack, contract tool or agent harness" }
    ]
  }
}
```

The vendored coss components live in `packages/ui/src/components/ui/` (doc 03); that one path is excluded from `securityAudit` here and from the review path filters in `.coderabbit.yaml`, so exactly one path is excluded everywhere.

The private Cloud repository has its own `workflow.json`, recorded in the Cloud documentation (Cloud doc 09 §5.2). It reads its threat model, doc 10, from the pinned CE submodule.

CE uses a DCO hook **plus a CLA** (Q80, decided): `CONTRIBUTING.md` explains both, a CLA Assistant check runs on every pull request, and no outside code is merged until the contributor has signed.

The billing service has its own `workflow.json` and `CLAUDE.md` (Cloud doc 09 §5.2).

### 5.3 `CLAUDE.md` — `## Agent workflow`, CE

The fixed headings the vendored skills read, filled from these docs. This is the starting text; it is edited in the same commit as any doc change it summarises.

~~~markdown
## Agent workflow

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
| `area:docs` | `docs/internal/`, `docs/user/`, `docs/self-hosting/`, `docs/releases/` |

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
- Documentation under `docs/user/`, `docs/self-hosting/` and `docs/releases/` follows the docs contract (doc 09 §3.5):
  frontmatter `title`, `description` and `edition` (`ce`, `cloud` or `both`), optional `since` and `order`; MDX with no
  `import`/`export` and no JSX beyond the allow-listed components (callout, tabs, steps, edition badge, screenshot);
  links relative or to `/docs/...`; images next to the page; no scripts, iframes or third-party embeds; English only.
  `pnpm docs:check` passes.
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
~~~

### 5.4 `CLAUDE.md` — `## Agent workflow`, Cloud (differences)

(Cloud) Recorded in the Cloud documentation (Cloud doc 09 §5.4).

### 5.5 Labels, issue templates, lifecycle

- **Labels**: `bootstrap-labels.sh` creates the base set (`feat`, `bug`, `chore`, `docs`, `spike`, `epic`, `blocked`, `security`, `regression`, `dependencies`, `status:new` … `status:cancelled`) plus each repo's `labels.areas`, `safety-critical` and `maintainer-only` from `workflow.json`.
- **Issue templates**: `bug_report.yml`, `feature_request.yml`, `config.yml` from the skills templates. CE's `config.yml` routes security reports to private vulnerability reporting (`SECURITY.md`) and support questions to Discussions (Q83).
- **Lifecycle**: `status:new → ready → in-progress → in-review → implemented → done/closed`, driven by `.claude/scripts/issue-status.sh` and `issue-status.yml`. Agents never close issues and never set `status:closed`; an issue closes when its `Fixes #n` commit reaches `main` through the promotion PR.
- **Commits**: `type(scope): subject` ≤ 72 chars, body explains why, `Fixes #n` trailer, one item per commit, explicit-path staging, no attribution of any kind (`mdg-git.md`).

### 5.6 How the plan flows

1. **Docs → epics.** Each roadmap phase in doc 12 is turned into an epic with `/triage seed phase <N>`; the epics named under each phase in doc 12 are the expected result. `triage` reads the docs, proposes the epic and its sub-issues, and creates them after approval.
2. **Epics → issues.** Sub-issues carry acceptance criteria, `Reachable via:` lines, design references (`doc 02 §8.2`, `D8`), area labels and native blocked-by links.
3. **Issues → commits on `dev`.** `/orchestrate #<epic>` refines, executes and verifies in scratch clones and cherry-picks each PASS onto `dev`.
4. **`dev` → `main`.** `/dev-diff` sizes the promotion; `/open-pr` opens the promotion PR; `/cr-review` works one CodeRabbit round; the maintainer merges. Cloud deploys are driven from `main` and `dev` pushes (Cloud doc 07 §4).
5. **Security.** `/security-audit` runs against doc 10 before each production promotion (D23) and whenever a safety-critical epic completes; Critical/High findings go to private advisories, fixed with `/orchestrate --advisory`.
6. **Docs stay true.** A change that alters a documented behaviour edits the doc in the same commit; a default (Qn) that survives implementation is promoted to a decision (Dn) by a `docs` item.
7. **End-user docs.** `/customer-docs` maintains `docs/user/` in this repository from shipped behaviour (Q2). A merge to `main` that changes a docs root triggers the docs-published hook (§3.5, Q111), and the site rebuilds.

---

## 6. Development flow, in one picture

```
maintainer idea / bug / dependabot
          │  /triage
          ▼
GitHub issue (status:ready, area:*, Fixes target) ──► /orchestrate ──► executor ─► verifier ─► cherry-pick to dev
                                                                                                │ CI on dev
                                                                                                ▼
                                    staging deploy (Cloud) ◄── /dev-diff · /open-pr · /cr-review ── dev → main PR
                                                                                                │ maintainer merges
                                                                                                ▼
                                                              main ─► production deploy (Cloud) · CE release
```

---

## 7. Where these docs go at repository creation

| Doc | Lands in | Notes |
|---|---|---|
| 00, 01, 02, 03, 04, 05, 08, 09, 12, 13 | `mdg-labs/slugbase` `docs/internal/` | Public. Strip any line naming Cloud infrastructure first (a review step in the repo-bootstrap epic); doc 09's Cloud parts are Cloud doc 09 |
| 10 | `mdg-labs/slugbase` `docs/internal/10-threat-model.md` | Public; the `threatModel` path |
| 06 | Split: entitlement engine → `slugbase`; the billing integration → the private Cloud repository | |
| 07 | The private Cloud repository; its CE self-host section → `slugbase` `docs/self-hosting/` (operator documentation, below) | |
| 11 | The private Cloud repository | |

**Documentation that is not a design doc** has fixed homes, so no item invents one:

| Kind | Home | Files |
|---|---|---|
| Operator documentation for self-hosting CE | `mdg-labs/slugbase` `docs/self-hosting/` | `install.md`, `environment.md` (generated from the env schemas, checked for drift), `reverse-proxy.md`, `mail.md`, `oidc.md`, `backup-restore.md`, `upgrade.md`, `operations.md`, `security.md`. The backup and restore guide of Phase 4 is the first version of `backup-restore.md`; settings added in Phases 3 and 4 are documented in `environment.md` from the start |
| Release notes | `mdg-labs/slugbase` `docs/releases/<version>.md` | The source of the draft GitHub Release that `release.yml` creates |
| End-user documentation | `mdg-labs/slugbase` `docs/user/`, written with `/customer-docs` (Q2) | The content root and the build check (`pnpm docs:check`) are set in `.claude/customer-docs/docs-config.md`. The files follow the docs contract (§3.5). Cloud-only pages are not here: they live in the private Cloud repository next to the site |

The three documentation roots are published together on the site at `slugbase.app/docs` (§3.5); a change to them requests the rebuild through the docs-published hook (Q111).

Since 2026-10-08 the docs live in their repositories: this repository's `docs/internal/` holds docs 00–05, 08–10, 12, 13 and the design prototype; the private Cloud repository holds docs 06, 07, 11, the Cloud parts of this doc (Cloud doc 09) and the Cloud carry-over. Nothing is duplicated.
