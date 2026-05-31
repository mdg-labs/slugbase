# SlugBase — Development Roadmap (v1)

**Status:** 🚧 **DRAFT — pre-Jira.** No tickets created. Working draft for review.
**Purpose:** the machine-executable work plan for the Cursor **orchestrator** (`.cursor/skills/orchestrator/SKILL.md`). After review it converts to Jira on project **SB**; then **Jira becomes the execution source of truth** and this file is archived.

## Hierarchy (Jira mapping — decision #16/#20)

```
Epic   = Phase             (P1 … P6)                      6 epics
Story  = deliverable        (P2-02, P3-07, …)             a roadmap task
Sub-task = commit-sized leaf (P2-16.1, P3-14.2, …)         when a Story is decomposed
```

- The orchestrator implements **leaf** issues: a **Sub-task** when a Story is decomposed, otherwise the **Story** itself (an *atomic leaf* — one commit). Epics and parent Stories are never implemented directly.
- **Every leaf is self-contained** — it carries its own **AC, Tests, Files (WRITE-scope hint), Deps, Lane** so the orchestrator can drop them straight into an execution/verifier prompt with no story-level lookup. Doc Ref is given at Story level and inherited by its leaves unless a leaf overrides it.

### Decomposition principle (why some Stories have sub-tasks and others don't)

A Story is split into Sub-tasks **only** when its parts (a) live in **different domains** (e.g. a Backend interface + a Frontend screen), or (b) can run **in parallel** (e.g. independent route files / marketing pages). Otherwise the Story is itself the commit-sized leaf — including its migration. Splitting "schema vs service" inside one backend module buys no parallelism (a migration forces Lane S, and same-module files contend) so we do **not** do it. *Want finer-grained sub-tasks purely for tracking? Say so before Jira creation and I'll split them.*

## How to read

- **Lifecycle:** `[ ]` not started · `[~]` awaiting verification · `[x]` verified · `[!]` failed.
- **ID:** `P<phase>-<seq>` (Story) · `P<phase>-<seq>.<n>` (Sub-task); mirrored to `SB-N` on Jira, kept in the **Roadmap ID** field.
- **Domain:** `BE` Backend · `FE` Frontend · `Infra` Infrastructure · `Ops` Operations → Jira **Domain** field.
- **Lane:** `S` serial on `main` · `P` parallel in an isolated worktree (disjoint WRITE scope). Default when uncertain: **S**.
- **`[mig]`** = the leaf generates a Drizzle migration → **always Lane S** (the migration history is a single shared seam; two parallel migrations would collide — eng §11). The verifier checks no hand-written SQL (Layer 3d).
- **Files** = WRITE-scope hint at package/module granularity; the orchestrator expands it to absolute paths and uses it to confirm Lane P disjointness. Conventions: per-domain schema `…/<domain>/<domain>.schema.ts`, per-domain contract `shared-types/src/contracts/<domain>.contract.ts`, file-based web routes (eng §11).
- **Doc Ref shorthands:** `spec` = `slugbase-mvp-spec.md` · `eng` = `engineering-decisions.md` · `def` = `defaults-and-constants.md` · `proto` = `design-prototype/V1/` (screen map spec §23.2).

## Universal acceptance criteria (apply to EVERY leaf — not repeated per row)

Per rule `02-orchestrator`: file/identifier naming (`04`); Conventional Commit with `[SB-N]`/`[P*-*]` (`01`,`07`); TS strict, no `any`, no `console.log`; security baseline (`03`); every new UI string via Tolgee en+de (`10`); every new env var via the Infisical 4-step (`05`); **no `isCloud`/deployment-mode branches** — entitlements + interface selection (spec §15). The DB MIGRATIONS block (orchestrator `prompt-templates.md`) applies to every execution prompt.

## Phases (= Epics)

| Phase | Theme | Domain | Fix version | Exit |
|---|---|---|---|---|
| **P1** | Foundation & infra seam | Infra | MVP Alpha | scaffold + CI gate green + health/version + DB abstraction (both engines) |
| **P2** | Auth, accounts, tenancy, entitlements core | BE | MVP Alpha | set up/sign in (MFA, sessions); workspaces + membership + isolation |
| **P3** | Bookmarks, organization, slugs, search, dashboard, AI | BE | MVP Alpha | core product usable end-to-end for one workspace |
| **P4** | Sharing, teams, audit | BE | MVP Alpha | team collaboration + entitlement gating |
| **P5** | Billing & plan enforcement | BE | MVP Alpha | Stripe (hosted) + no-op (self-host); downgrade overflow |
| **P6** | Marketing, i18n completeness, deploy, polish | Ops | MVP Alpha | hosted + self-host deployable; launch-ready |

> **All v1 work is `MVP Alpha`** (fix version `10035`). `Public Launch v1.0.0` (`10037`) is reserved for post-MVP / Fast-Follow.

---

## P1 — Foundation & infra seam · Epic · Domain Infra

> **Suggested order / batch plan:** Serial spine `P1-01 → P1-02 → P1-03 → P1-04 → P1-05`; `P1-09` after `P1-01`, sequenced with `P1-05` (both edit the CI file). Parallel **B1** (worktrees, after `P1-03`): `{P1-06, P1-07, P1-08}`. Parallel **B2** (after `P1-03`+`P1-08`): `{P1-10}`.
> **D-21 exit slice:** `P1-01`, `P1-03`, `P1-04`, `P1-09` green.

### P1-01 — Initialize pnpm + Turborepo monorepo scaffold — Infra · Lane S
- **AC:** pnpm workspace with `packages/{backend,web,marketing,shared-types,ui}` placeholders; root strict `tsconfig`, ESLint/Prettier, `turbo.json`; root scripts `lint`/`typecheck`/`test:unit`/`test:integration`/`build` via Turbo; `.env.example` + `.infisical.json` (project `slugbase-cloud`).
- **Tests:** `pnpm lint && pnpm typecheck && pnpm build` succeed on empty packages.
- **Files:** repo root (`package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig*.json`, eslint/prettier configs, `.env.example`, `.infisical.json`, `packages/*/package.json`)
- **Doc Ref:** spec §2.2, §19; eng §2, §3, §7 · **Deps:** — · **Status:** [ ]

### P1-02 — shared-types: Zod + ts-rest + OpenAPI generation — Infra · Lane S
- **AC:** ts-rest + Zod set up; `contracts/` per-domain layout + root composer; sample contract compiles; OpenAPI doc generated via script; consumable by `backend` + `web`.
- **Tests:** unit asserts OpenAPI generation produces a valid doc for the sample contract.
- **Files:** `packages/shared-types/**`
- **Doc Ref:** spec §18, §19; eng §5 · **Deps:** P1-01 · **Status:** [ ]

### P1-03 — Backend skeleton: modules, config schema, health, version — BE · Lane S
- **AC:** NestJS boots; empty per-domain feature-module stubs registered in `app.module` (removes the registration seam for later domains — eng §11); Zod env-config validates required secrets at startup (`SESSION_SECRET`, `ENCRYPTION_KEY`, `DATABASE_URL`, `APP_BASE_URL`, `FRONTEND_ORIGIN`), refuses prod start if missing; `GET /health` + `GET /version`.
- **Tests:** integration: health/version 200; startup throws on missing secret in production mode.
- **Files:** `packages/backend/src/{main.ts,app.module.ts,config/**,health/**}`, empty `packages/backend/src/<domain>/<domain>.module.ts` stubs
- **Doc Ref:** spec §14.2, §15, §18; eng §3, §8; rule `05` · **Deps:** P1-01 · **Status:** [ ]

### P1-04 — Persistence interface + Drizzle + SQLite + migrations — BE · Lane S · `[mig]`
- **AC:** `DB` data-access abstraction with Drizzle impl + thin dialect layer + per-domain schema glob; embedded SQLite wired; Drizzle Kit tooling (`pnpm db:generate`/`db:migrate`); migration-bookkeeping table; auto-migrate on startup (§14.3).
- **Tests:** integration: migrate up on temp SQLite; trivial repository round-trips.
- **Files:** `packages/backend/src/db/**`, `drizzle.config.ts`, `packages/backend/migrations/**`
- **Doc Ref:** spec §11.9, §16; eng §4, §11 · **Deps:** P1-03 · **Status:** [ ]

### P1-05 — Neon Postgres engine on identical schema + CI matrix — Infra · Lane S
- **AC:** Postgres engine selectable by config on the same schema/migrations; CI runs the integration suite against **both** SQLite and Postgres.
- **Tests:** integration suite passes on both engines in CI.
- **Files:** `packages/backend/src/db/**`, `.github/workflows/ci-cd.yml`
- **Doc Ref:** spec §11.9, decision #32; eng §4, §6 · **Deps:** P1-04, P1-09 · **Status:** [x]

### P1-06 — Crypto interface (at-rest encryption) — BE · Lane P
- **AC:** `CRYPTO` encrypt/decrypt with `ENCRYPTION_KEY`; strict mode refuses silent failure in prod; exercised by a sample settings field.
- **Tests:** unit: round-trip; strict-mode throws on bad key.
- **Files:** `packages/backend/src/crypto/**`, `packages/shared-types/src/contracts/crypto.contract.ts`
- **Doc Ref:** spec §11.11, §18; rule `03`; eng §3 · **Deps:** P1-03 · **Status:** [x]

### P1-07 — SSRF-safe outbound fetch interface — BE · Lane P
- **AC:** single `FETCH` egress chokepoint: host resolution + private/loopback blocking, timeouts, response size limits, caching; no other code does raw outbound `fetch`.
- **Tests:** unit: blocks private IPs/loopback; enforces timeout + size cap; caches.
- **Files:** `packages/backend/src/fetch/**`
- **Doc Ref:** spec §11.10, §6.4, §18; rule `03` · **Deps:** P1-03 · **Status:** [x]

### P1-08 — Web + ui skeleton: tokens, theme, layout, Tolgee provider — FE · Lane P
- **AC:** React Router v7 boots on Node adapter; `ui` exposes Tailwind config bridged to `colors_and_type.css` tokens (dark-first, periwinkle, IBM Plex); app shell + theme switch (light/dark/auto); Tolgee React SDK provider wired; no hard-coded hex/strings.
- **Tests:** unit: theme tokens resolve; snapshot of base layout.
- **Files:** `packages/ui/**`, `packages/web/**`
- **Doc Ref:** spec §19, §23.1; eng §1, §3, §9; rule `11` · **Deps:** P1-01 · **Status:** [!] failed — SB-10: ErrorBoundary hard-coded strings in root.tsx

### P1-09 — CI checks job (`.github/workflows/ci-cd.yml`) — Infra · Lane S
- **AC:** workflow with PR/push triggers (`staging`,`main`); CI job: install → lint/typecheck/unit → Infisical OIDC fetch → build → integration → `pnpm audit`; only `INFISICAL_DOMAIN`+`INFISICAL_OIDC_IDENTITY_ID` as GHA secrets.
- **Tests:** workflow YAML validates; CI green on the P1 scaffold.
- **Files:** `.github/workflows/ci-cd.yml`, `.github/actions/**`
- **Doc Ref:** spec §22.1–22.3, §22.9; eng §7, §8, §10 · **Deps:** P1-01 · **Status:** [x]

### P1-10 — Container images (combined + API-only) — Infra · Lane P
- **AC:** API-only + combined (API + bundled web) images; single port; mounted volume for embedded DB; health/version reachable in-container.
- **Tests:** image builds; container smoke hits `/health` + `/version`.
- **Files:** `Dockerfile`, `Dockerfile.api`, `.dockerignore`, `fly.toml`, worker config
- **Doc Ref:** spec §14.2, §22.8; eng §10 · **Deps:** P1-03, P1-08 · **Status:** [x]

---

## P2 — Auth, accounts, tenancy, entitlements core · Epic · Domain BE

> **Suggested order / batch plan:** Serial spine `P2-01 → P2-02 → P2-08 → P2-09 → P2-10 → P2-11 → P2-12`. `[mig]` leaves (`P2-04/06/07/13/14`) join the spine in dep order. Parallel **B1** (after P1-06): `{P2-03}`. Parallel **B2** (after P2-02, no shared migration in flight): `{P2-05, P2-15}`. Parallel **B3** FE (after P2-12 + P1-08): `P2-16.1` then `{P2-16.2, P2-16.3, P2-16.4}`.

### P2-01 — Server-side session store + cookie + CSRF — BE · Lane S · `[mig]`
- **AC:** DB-backed session store; HTTP-only/Secure/SameSite cookie; configurable TTL (def §3, 30d sliding); individual + "log out everywhere" revocation; double-submit CSRF with the §5.8 exempt allowlist + CSRF-token endpoint.
- **Tests:** integration: session create/revoke; CSRF rejects missing token on a mutation; allowlisted endpoints exempt.
- **Files:** `packages/backend/src/sessions/**`, `packages/backend/src/auth/csrf/**`, `shared-types/src/contracts/auth.contract.ts`
- **Doc Ref:** spec §5.3, §5.8, §18; def §3; eng §1 · **Deps:** P1-04 · **Status:** [ ]

### P2-02 — Account model + password auth (argon2id) — BE · Lane S · `[mig]`
- **AC:** `user_account` (email unique, name, language, theme, instance-admin flag, MFA state, AI opt-out); argon2id hashing; password policy (def §3, min 12) + strength signal; login/logout issuing + revoking sessions.
- **Tests:** unit: hash/verify, policy. integration: login → session; logout → revoked.
- **Files:** `packages/backend/src/accounts/**`, `packages/backend/src/auth/**`
- **Doc Ref:** spec §5.1, §5.4; def §3; eng §1 · **Deps:** P2-01 · **Status:** [ ]

### P2-03 — Mail interface (SMTP + no-op) — BE · Lane P
- **AC:** `MAIL` interface (send + is-available); SMTP impl (config-driven, creds encrypted via `CRYPTO`) + no-op/log default; "send test".
- **Tests:** unit: no-op reports unavailable + logs; SMTP send invoked with correct payload (mocked transport).
- **Files:** `packages/backend/src/mail/**`
- **Doc Ref:** spec §11.1; rule `05` · **Deps:** P1-06 · **Status:** [ ]

### P2-04 — Email verification (signup + change) — BE · Lane S · `[mig]`
- **AC:** distinct signup-verification + email-change flows; hashed time-limited tokens (def §3, 1h); generic responses; address switches only after confirm.
- **Tests:** integration: token issue → verify → state change; expired token rejected.
- **Files:** `packages/backend/src/auth/verification/**`
- **Doc Ref:** spec §5.5; def §3 · **Deps:** P2-02, P2-03 · **Status:** [ ]

### P2-05 — Password reset — BE · Lane P
- **AC:** tokenized (reuses P2-04 token store), time-limited, email-delivered; always-generic response (no enumeration); rate-limited (def §4).
- **Tests:** integration: reset issues token, sets new password; generic response regardless of account existence.
- **Files:** `packages/backend/src/auth/password-reset/**`
- **Doc Ref:** spec §5.4; def §3, §4 · **Deps:** P2-02, P2-03, P2-04 · **Status:** [ ]

### P2-06 — TOTP MFA + backup codes — BE · Lane S · `[mig]`
- **AC:** enrol (otplib secret encrypted via `CRYPTO` + QR + text), 10 single-use hashed backup codes shown once; password logins require 2nd factor post-enrol; disable (with verification) + regenerate; configurable issuer; admin/support recovery documented.
- **Tests:** unit: TOTP verify, backup-code single-use. integration: login requires MFA after enrol.
- **Files:** `packages/backend/src/auth/mfa/**`
- **Doc Ref:** spec §5.7; def §3 · **Deps:** P2-02, P1-06 · **Status:** [ ]

### P2-07 — Personal API tokens — BE · Lane S · `[mig]`
- **AC:** named, prefixed (`slb_`), hashed; max per user (def §3, 10); last-use tracking; revoke; Bearer auth path; tokens bypass MFA, get no cookie session.
- **Tests:** integration: create → shown-once → authenticate via Bearer → revoke → denied.
- **Files:** `packages/backend/src/auth/api-tokens/**`
- **Doc Ref:** spec §5.3; def §3 · **Deps:** P2-02 · **Status:** [ ]

### P2-08 — Workspace, membership, roles — BE · Lane S · `[mig]`
- **AC:** Workspace + Membership (owner/admin/member); always ≥1 owner invariant; every tenant table carries `workspace_id`; membership CRUD.
- **Tests:** unit: role checks; cannot remove last owner. integration: membership CRUD.
- **Files:** `packages/backend/src/workspaces/**`
- **Doc Ref:** spec §4.1, §4.2, §16 · **Deps:** P2-02 · **Status:** [ ]

### P2-09 — Tenant resolution + active-workspace switch — BE · Lane S
- **AC:** resolution behind an interface; active workspace in session; explicit switch verifies membership; stale selection re-derived; tenant ops rejected without context.
- **Tests:** integration: switch verifies membership; revoked membership clears context.
- **Files:** `packages/backend/src/workspaces/**`, `packages/backend/src/sessions/**`
- **Doc Ref:** spec §4.3, §4.6 · **Deps:** P2-08 · **Status:** [ ]

### P2-10 — Data isolation enforcement + cross-tenant tests — BE · Lane S
- **AC:** data-access auto-scopes every tenant query by active `workspace_id`; writes stamp it; centralized guard.
- **Tests:** integration: cross-workspace read/write denied (**mandatory isolation suite**, eng §6).
- **Files:** `packages/backend/src/db/**`, `packages/backend/src/common/tenant/**`
- **Doc Ref:** spec §4.4, §18; eng §4, §6 · **Deps:** P2-09 · **Status:** [ ]

### P2-11 — Entitlements engine (core; self-host unlimited) — BE · Lane S
- **AC:** engine answers workspace + account entitlements (bookmark cap, AI, team sharing, admin, audit, seats, workspaces-per-account); self-host = unlimited; hosted defaults to Free (billing wired P5); central checks, no deployment-mode branch.
- **Tests:** unit: self-host unlimited; hosted Free caps; workspaces-per-account enforced.
- **Files:** `packages/backend/src/entitlements/**`
- **Doc Ref:** spec §11.5, §12.2; def §5 · **Deps:** P2-08 · **Status:** [ ]

### P2-12 — First-run setup + workspace creation (entitlement-gated) — BE · Lane S
- **AC:** empty-DB setup creates first account (instance-admin + owner) + first workspace; workspace-creation enforces workspaces-per-account (hosted Free=1; self-host unrestricted); hosted signup auto-creates personal workspace.
- **Tests:** integration: setup on empty DB; Free 2nd-workspace blocked; self-host unrestricted.
- **Files:** `packages/backend/src/setup/**`, `packages/backend/src/workspaces/**`
- **Doc Ref:** spec §4.1, §5.2, §14.3, §12.2/§12.4 · **Deps:** P2-11 · **Status:** [ ]

### P2-13 — Invitations (seats on acceptance) — BE · Lane S · `[mig]`
- **AC:** invite by email (hashed token, expiry); join workspace on acceptance; seat consumed on acceptance not send; seat count cannot drop below member count.
- **Tests:** integration: invite → accept consumes seat; over-seat acceptance blocked on hosted Team.
- **Files:** `packages/backend/src/invitations/**`
- **Doc Ref:** spec §4.2, §5.2, §12.2; def §5 · **Deps:** P2-12, P2-03 · **Status:** [ ]

### P2-14 — OIDC / auth-provider interface — BE · Lane S · `[mig]`
- **AC:** `AUTH_PROVIDER` (list, start, callback, claims, link/auto-create); self-host = DB-sourced admin config (encrypted secrets, custom endpoints); hosted = deployment-config; email-verified linking; federated login skips SlugBase MFA.
- **Tests:** integration (mock IdP): handshake → link/auto-create; unverified routed correctly.
- **Files:** `packages/backend/src/auth/oidc/**`
- **Doc Ref:** spec §5.6, §11.3; eng §1 · **Deps:** P2-02, P1-06 · **Status:** [ ]

### P2-15 — Rate limiting on sensitive endpoints — BE · Lane P
- **AC:** limits on login, registration, password reset, token creation (def §4); 429 on exceed; per-IP + per-account.
- **Tests:** integration: limit triggers 429; resets after window.
- **Files:** `packages/backend/src/common/rate-limit/**`
- **Doc Ref:** spec §18; def §4 · **Deps:** P2-02 · **Status:** [ ]

### P2-16 — Auth UI (setup, login, MFA, register, verify, reset) — FE · parent Story
- **Doc Ref:** spec §5, §23.2 (`AuthApp.jsx`/`AuthKit.jsx`); proto; rule `10`,`11`
- **Goal:** all auth screens in the prototype design language; non-enumerating copy; shown-once backup codes; strings via Tolgee (en+de). Each screen is its own route file → parallel after the shared shell.
- `P2-16.1` — Auth shell + first-run setup + sign-in — FE · Lane S
  - **AC:** shared auth layout/kit; first-run setup screen; sign-in (non-enumerating errors). · **Tests:** component: setup + sign-in render/validate. · **Files:** `packages/web/app/routes/auth/**`, `packages/ui/**` · **Deps:** P1-08, P2-12
- `P2-16.2` — MFA challenge + backup codes — FE · Lane P
  - **AC:** MFA challenge screen; backup-code entry; shown-once backup-code display. · **Tests:** component: MFA challenge flow. · **Files:** `packages/web/app/routes/auth/mfa/**` · **Deps:** P2-16.1, P2-06
- `P2-16.3` — Register + verify-email — FE · Lane P
  - **AC:** register screen (gated by `PUBLIC_REGISTRATION`); verify-email screen; generic copy. · **Tests:** component: register + verify. · **Files:** `packages/web/app/routes/auth/register/**`, `…/verify/**` · **Deps:** P2-16.1, P2-04
- `P2-16.4` — Password reset + set-password — FE · Lane P
  - **AC:** request-reset + set-new-password screens; generic copy. · **Tests:** component: reset flow. · **Files:** `packages/web/app/routes/auth/reset/**` · **Deps:** P2-16.1, P2-05

---

## P3 — Bookmarks, organization, slugs, search, dashboard, AI · Epic · Domain BE

> **Suggested order / batch plan:** Serial spine (migrations) `P3-01 → P3-02 → P3-03 → P3-07 → P3-14.2`; `P3-04` after `P3-02/03`. Parallel leaves: after `P3-01` → `{P3-06}`; after `P3-04` → `{P3-05}`; after `P3-01`+entitlements → `{P3-08}`; after `P3-08/02/03` → `{P3-09}`; after `P3-02/03` → `{P3-10, P3-11.1}`. FE chain: `P3-11.2 → {P3-11.3, P3-12}`, `P3-13`; then `P3-14.1 → P3-14.3`.

### P3-01 — Bookmark domain (CRUD, pin, hard delete, usage) — BE · Lane S · `[mig]`
- **AC:** Bookmark (title, url, slug?, forwarding flag, pinned, plan-archived, access count, last-accessed); CRUD + ownership; hard delete cascades associations; pin toggle; async usage tracking (never blocks).
- **Tests:** integration: CRUD + ownership; usage increment async; cascade on delete.
- **Files:** `packages/backend/src/bookmarks/**`, `shared-types/src/contracts/bookmarks.contract.ts`
- **Doc Ref:** spec §6.1–6.3, §16; def §1 · **Deps:** P2-10 · **Status:** [ ]

### P3-02 — Folders — BE · Lane S · `[mig]`
- **AC:** Folder (name, optional icon); many-to-many with bookmarks; CRUD + list (search/sort/paginate); no folder cap (§23.4).
- **Tests:** integration: CRUD; a bookmark in multiple folders.
- **Files:** `packages/backend/src/folders/**`
- **Doc Ref:** spec §7.1, §16 · **Deps:** P3-01 · **Status:** [ ]

### P3-03 — Tags (user-private) — BE · Lane S · `[mig]`
- **AC:** Tag user-private; CRUD; never shared cross-user; distribution/overview support.
- **Tests:** integration: tags scoped per user; not visible cross-user.
- **Files:** `packages/backend/src/tags/**`
- **Doc Ref:** spec §7.2, §16 · **Deps:** P3-01 · **Status:** [ ]

### P3-04 — Bookmark listing: filter/sort/paginate + select-all-ids — BE · Lane S
- **AC:** filter by folder/tags/pinned/scope; query match on title/url/slug; sort recent/alpha/most-used/recently-accessed; pagination (def §2); companion IDs endpoint for select-all; plan-archived excluded everywhere.
- **Tests:** integration: each filter/sort; pagination bounds; IDs endpoint matches list.
- **Files:** `packages/backend/src/bookmarks/**`
- **Doc Ref:** spec §6.5; def §2 · **Deps:** P3-02, P3-03 · **Status:** [x]

### P3-05 — Bulk actions — BE · Lane P
- **AC:** bulk delete / move-to-folder / add-tags (with merge preview) / share (where available); respect ownership + authorization; works with explicit selection and select-all-ids.
- **Tests:** integration: bulk op across selected + select-all-ids; unauthorized items skipped.
- **Files:** `packages/backend/src/bookmarks/bulk/**`
- **Doc Ref:** spec §6.6 · **Deps:** P3-04 · **Status:** [ ]

### P3-06 — Metadata + favicon fetch (via SSRF egress) — BE · Lane P
- **AC:** fetch title/description/site-name + favicon proxy **through `FETCH` only**; cached (def §2, 7d).
- **Tests:** integration: metadata parsed; private URL blocked; cache hit.
- **Files:** `packages/backend/src/bookmarks/metadata/**`
- **Doc Ref:** spec §6.4, §11.10; def §2 · **Deps:** P1-07, P3-01 · **Status:** [ ]

### P3-07 — Slugs + `/go` redirect + disambiguation + go-preferences — BE · Lane S · `[mig]`
- **AC:** slug validation (def §1 grammar + reserved list) unique per workspace; `/go/<slug>` requires auth, resolves within active workspace over accessible+forwarding bookmarks; no-match 404; single→redirect (async usage); multi→disambiguation with "always use this" → stored go-preference; preference management (list/remove).
- **Tests:** integration: single/multi/no-match; reserved slug rejected; preference honored.
- **Files:** `packages/backend/src/slugs/**` (+ `go-preference` table), `shared-types/src/contracts/slugs.contract.ts`
- **Doc Ref:** spec §8.1–8.4, §16; def §1 · **Deps:** P3-01 · **Status:** [ ]

### P3-08 — Bookmark cap enforcement (Free 50) — BE · Lane P
- **AC:** creation + import blocked at/over cap on capped workspaces with actionable message; enforced server-side via entitlements; unlimited plans unaffected.
- **Tests:** integration: 51st create blocked on Free; unlimited on Personal.
- **Files:** `packages/backend/src/bookmarks/**` (cap guard), `packages/backend/src/entitlements/**` (read)
- **Doc Ref:** spec §12.2, §12.4; def §2, §5 · **Deps:** P3-01, P2-11 · **Status:** [ ]

### P3-09 — Import (JSON + Netscape HTML) — BE · Lane P
- **AC:** import JSON array + Netscape HTML (size cap def §2, 5MB); folders/tags created-or-matched by name; invalid/dup slugs skipped; bounded count (def §2, 5000); success/failure report; respects cap.
- **Tests:** integration: mixed valid/invalid reports counts; cap respected.
- **Files:** `packages/backend/src/import/**`
- **Doc Ref:** spec §13; def §2 · **Deps:** P3-08, P3-02, P3-03 · **Status:** [ ]

### P3-10 — Export (lossless / round-trip) — BE · Lane P
- **AC:** export each accessible bookmark with title/url/slug/forwarding/pinned + folder & tag names; export→import into a fresh workspace reproduces faithfully (verified against P3-09).
- **Tests:** integration: round-trip equality for bookmarks/folders/tags.
- **Files:** `packages/backend/src/export/**`
- **Doc Ref:** spec §13, §14.4 · **Deps:** P3-02, P3-03 · **Status:** [ ]

### P3-11 — Search endpoint + command palette (cmdk) + go-mode — parent Story
- **Doc Ref:** spec §9.1, §8.4; proto (`PaletteApp.jsx`); rule `10`,`11`
- **Goal:** server search + `⌘K` palette with `go <slug>` mode. BE endpoint + FE palette shell + FE go-mode are separate leaves.
- `P3-11.1` — Search endpoint — BE · Lane P
  - **AC:** server search across bookmarks/folders/tags with per-type limits + client fallback contract. · **Tests:** integration: search across types; limits. · **Files:** `packages/backend/src/search/**` · **Deps:** P3-02, P3-03
- `P3-11.2` — Command palette shell (cmdk) — FE · Lane S
  - **AC:** `⌘K` palette: empty=nav/quick-actions, query=search results; keyboard shortcuts (proto). · **Tests:** component: palette open + search mode. · **Files:** `packages/web/app/components/command-palette/**`, `packages/ui/**` · **Deps:** P3-11.1, P1-08
- `P3-11.3` — `go <slug>` palette mode — FE · Lane P
  - **AC:** `go <slug>` mode with live matches; open-in-new-tab modifier; routes via `/go`. · **Tests:** component: go-mode matches + modifier. · **Files:** `packages/web/app/components/command-palette/**` (go-mode module) · **Deps:** P3-11.2, P3-07

### P3-12 — Dashboard — FE · Lane P
- **AC:** counts; search entry; quick-access slugs; pinned; most-used tags; sharing stats; dismissible onboarding checklist; entitlement-driven limit/upgrade prompts (no deployment-mode branch).
- **Tests:** component: sections render from data; prompts gated by the entitlements engine.
- **Files:** `packages/web/app/routes/dashboard/**`
- **Doc Ref:** spec §9.2; proto (`DashboardApp.jsx`); rule `10`,`11` · **Deps:** P3-04, P3-07 · **Status:** [ ]

### P3-13 — Bookmark create/edit modal — FE · Lane S
- **AC:** modal-only create/edit (url, title, slug, folders, tags, pin, forwarding, sharing placeholder); **no detail route** (decision #19); validation surfaced; strings via Tolgee.
- **Tests:** component: create/edit modal validates + submits.
- **Files:** `packages/web/app/components/bookmark-modal/**`, `packages/ui/**`
- **Doc Ref:** spec §6.2; proto §23.5; rule `10`,`11` · **Deps:** P3-04, P3-07 · **Status:** [ ]

### P3-14 — AI suggestions (OpenAI) + cache + opt-out — parent Story
- **Doc Ref:** spec §11.2, §6.4, §17; def §5; rule `05`,`10`
- **Goal:** vendor-neutral `AI` interface with OpenAI impl, cache, and inline suggestions in the modal. BE interface + BE cache (migration) + FE integration are separate leaves.
- `P3-14.1` — `AI` interface + OpenAI impl + availability + key config — BE · Lane P
  - **AC:** `AI` interface (suggest title/slug/tags/detected-language/confidence + availability); OpenAI impl; self-host BYO key, hosted operator key; disabled when no key. · **Tests:** integration (mocked OpenAI): suggestions returned; disabled when no key. · **Files:** `packages/backend/src/ai/**` · **Deps:** P2-11, P1-06
- `P3-14.2` — Suggestion cache — BE · Lane S · `[mig]`
  - **AC:** cache keyed by (workspace, user, canonical URL, output language) TTL def §5 (30d). · **Tests:** integration: cache hit/miss + key correctness. · **Files:** `packages/backend/src/ai/cache/**` (+ cache table) · **Deps:** P3-14.1
- `P3-14.3` — Inline suggestions in modal + opt-out + entitlement gate — FE · Lane P
  - **AC:** inline title/slug/tags suggestions in the modal; per-workspace toggle + entitlement gate; user opt-out honored; output language = user locale. · **Tests:** component: suggestions shown; opt-out short-circuits. · **Files:** `packages/web/app/components/bookmark-modal/**` (ai module) · **Deps:** P3-14.2, P3-13

---

## P4 — Sharing, teams, audit · Epic · Domain BE

> **Suggested order / batch plan:** Serial spine `P4-01 → P4-02` (auth model is shared); `P4-04` after P2-11 (own migration, serialize with spine). Parallel FE **B1** (after P4-02): `{P4-03, P4-05}`. Tail S: `P4-06` after `P4-02/04/05`.

### P4-01 — Teams + team membership — BE · Lane S · `[mig]`
- **AC:** Team (name, description) + team membership; CRUD; teams are sharing targets; workspace-scoped.
- **Tests:** integration: team CRUD + membership.
- **Files:** `packages/backend/src/teams/**`
- **Doc Ref:** spec §10.1, §16 · **Deps:** P2-08 · **Status:** [ ]

### P4-02 — Sharing records + authorization model — BE · Lane S · `[mig]`
- **AC:** bookmark/folder → team/user share grants; centralized authorization (owner R/W; shared = read; folder share transitively exposes contained bookmarks); applied consistently across list/read/redirect/search/bulk.
- **Tests:** integration: shared read visible; non-shared denied; folder-share transitivity; `/go` honors sharing.
- **Files:** `packages/backend/src/sharing/**`, `packages/backend/src/common/authz/**`
- **Doc Ref:** spec §5.9, §6, §7.1, §16 · **Deps:** P4-01, P3-07 · **Status:** [ ]

### P4-03 — Sharing UI + scope filters — FE · Lane P
- **AC:** share controls on bookmarks/folders; scope filters (all / mine / shared-with-me / shared-by-me); sharing labels; entitlement-gated visibility.
- **Tests:** component: share dialog; scope filter queries.
- **Files:** `packages/web/app/components/sharing/**`, bookmark list route
- **Doc Ref:** spec §6.5, §7.1; proto; rule `10`,`11` · **Deps:** P4-02 · **Status:** [ ]

### P4-04 — Audit log (workspace-scoped) — BE · Lane S · `[mig]`
- **AC:** append-only events (actor, action, entity, metadata, time); read-only paginated view; entitlement-gated (Team on hosted; on for self-host).
- **Tests:** integration: significant actions recorded; access gated by entitlement.
- **Files:** `packages/backend/src/audit/**`
- **Doc Ref:** spec §10.1, §16 · **Deps:** P2-11 · **Status:** [ ]

### P4-05 — Members & Teams admin UI — FE · Lane P
- **AC:** invite/add/edit/remove members, set roles, resend invites, assign to teams, ownership transfer; team management; entitlement-gated (Team on hosted) with API enforcement independent of UI.
- **Tests:** component + integration: role changes; gated endpoints refuse off-plan.
- **Files:** `packages/web/app/routes/settings/members/**`
- **Doc Ref:** spec §10.1, §12.4; proto (`SettingsMembers.jsx`); rule `10`,`11` · **Deps:** P4-01, P2-13 · **Status:** [ ]

### P4-06 — Entitlement gating for sharing/admin/audit — BE · Lane S
- **AC:** team sharing, team admin, member invitations, audit log gated to Team on hosted; UI hides/disables, API refuses; always on for self-host.
- **Tests:** integration: each gated surface refused on non-Team hosted; allowed on self-host.
- **Files:** `packages/backend/src/{sharing,teams,invitations,audit}/**` (guards), `packages/backend/src/entitlements/**`
- **Doc Ref:** spec §12.2, §12.4 · **Deps:** P4-02, P4-04, P4-05 · **Status:** [ ]

---

## P5 — Billing & plan enforcement · Epic · Domain BE

> **Suggested order / batch plan:** Serial spine `P5-01 → P5-02 → P5-03 → P5-04`. Parallel: `P5-05` (UI) after `P5-03`; `P5-06` (stats) is an independent floater (after P1-03).

### P5-01 — Billing interface (Stripe + no-op) — BE · Lane S
- **AC:** `BILLING` interface (checkout, portal, subscription state, seat quantity, async events); Stripe impl (hosted); no-op impl (self-host) granting full entitlements; app logic checks entitlements only.
- **Tests:** unit: no-op grants unlimited; Stripe adapter maps state (mocked).
- **Files:** `packages/backend/src/billing/**`
- **Doc Ref:** spec §11.4, §12.3 · **Deps:** P2-11 · **Status:** [ ]

### P5-02 — Plan → entitlement mapping (Free/Personal/Team/supporter) — BE · Lane S
- **AC:** plans map to entitlement sets; supporter = "Personal, permanent" (no separate code path); prices/seats config-driven (not hard-coded); paid tier named "Personal".
- **Tests:** unit: each plan → expected entitlements; supporter = Personal-permanent.
- **Files:** `packages/backend/src/billing/plans/**`, `packages/backend/src/entitlements/**`
- **Doc Ref:** spec §12.1, §12.2; def §5, §6 · **Deps:** P5-01 · **Status:** [ ]

### P5-03 — Checkout, portal, webhooks (idempotent), seats — BE · Lane S · `[mig]`
- **AC:** start checkout (recurring + one-time supporter); self-service portal; idempotent webhook processing (dedupe store) updates entitlements; seat add/remove (not below member count); VAT where relevant; deletion blocked while billing owner of an active paid workspace.
- **Tests:** integration (mocked Stripe events): idempotent apply; seat floor enforced.
- **Files:** `packages/backend/src/billing/**` (+ webhook-event dedupe table)
- **Doc Ref:** spec §11.4, §12.3, §12.4; def §5 · **Deps:** P5-02 · **Status:** [ ]

### P5-04 — Downgrade overflow (archive + restore) — BE · Lane S
- **AC:** downgrade to Free at period-end + grace (def §5, 7d); over-cap bookmarks archived (hidden from lists/search/counts/slug/dashboard, preserved) per the deterministic rule (def §5); creation blocked while at/over cap; re-upgrade restores up to the new cap.
- **Tests:** integration: downgrade archives correct set; re-upgrade restores; archived excluded everywhere.
- **Files:** `packages/backend/src/billing/downgrade/**`, `packages/backend/src/bookmarks/**`
- **Doc Ref:** spec §12.5; def §5 · **Deps:** P5-03, P3-08 · **Status:** [ ]

### P5-05 — Plans & billing UI — FE · Lane P
- **AC:** plan table, supporter offer, cancel/downgrade, seat management, invoices; config-driven prices; "Personal" not "Pro"; no folder cap / no custom-domain entitlement (§23.4).
- **Tests:** component: plan table from config; upgrade/cancel flows (mocked).
- **Files:** `packages/web/app/routes/settings/billing/**`
- **Doc Ref:** spec §12; proto (`SettingsBilling.jsx`); §23.4; rule `10`,`11` · **Deps:** P5-03 · **Status:** [ ]

### P5-06 — Aggregate-stats endpoint (secret-protected) — BE · Lane P
- **AC:** shared-secret-protected aggregate operational stats endpoint (hosted operator observability); no PII; secret via Infisical.
- **Tests:** integration: rejects without secret; returns aggregates with it.
- **Files:** `packages/backend/src/admin/stats/**`
- **Doc Ref:** spec §10.2, §18; rule `05` · **Deps:** P1-03 · **Status:** [ ]

---

## P6 — Marketing, i18n completeness, deploy, polish · Epic · Domain Ops

> **Suggested order / batch plan:** Independent floaters (after P1-03/P1-02): `{P6-01, P6-05, P6-09, P5-06}`. Chain `P6-01 → P6-02 → P6-03.1 → {P6-03.2, P6-03.3}`. Parallel FE (after their deps): `{P6-04, P6-06.1, P6-06.2, P6-08.1, P6-08.2}`. Tail S (cross-cutting + deploy, CI-file serial): `P6-07 → P6-10 → P6-11`.

### P6-01 — Challenge interface (Turnstile + no-op) — BE · Lane P
- **AC:** `CHALLENGE` interface (verify token, dev-skip); Turnstile impl (hosted) + no-op (self-host default).
- **Tests:** unit: no-op passes in dev; Turnstile verify (mocked).
- **Files:** `packages/backend/src/challenge/**`
- **Doc Ref:** spec §11.8, §2.3 · **Deps:** P1-03 · **Status:** [ ]

### P6-02 — Contact endpoint (behind challenge + mail) — BE · Lane P
- **AC:** public contact endpoint validates challenge token, rate-limited (def §4), sends via `MAIL`.
- **Tests:** integration: rejects bad challenge; sends on valid.
- **Files:** `packages/backend/src/contact/**`
- **Doc Ref:** spec §2.3, §11.1, §11.8 · **Deps:** P6-01, P2-03 · **Status:** [ ]

### P6-03 — Marketing site (Astro): landing, pricing, contact, legal — parent Story · Domain Ops
- **Doc Ref:** spec §2.3, §23.2 (`marketing/*`); §23.4; rule `10`,`11`
- **Goal:** Astro static site, separately built; en+de via Tolgee. Pages are independent leaves after the shared layout.
- `P6-03.1` — Astro scaffold + shared layout + landing + Tolgee — FE · Lane S
  - **AC:** Astro app + shared layout + landing page; Tolgee wiring (en+de). · **Tests:** build succeeds; landing renders both locales. · **Files:** `packages/marketing/**` · **Deps:** P1-01
- `P6-03.2` — Pricing + legal pages — FE · Lane P
  - **AC:** pricing (config-driven, "Personal"); legal (Impressum/AGB/Datenschutz, subprocessors Fly/Neon/Cloudflare). · **Tests:** build; pricing from config. · **Files:** `packages/marketing/src/pages/{pricing,legal}/**` · **Deps:** P6-03.1
- `P6-03.3` — Contact form + Turnstile — FE · Lane P
  - **AC:** contact form + Turnstile widget, posts to P6-02. · **Tests:** form posts to endpoint (mocked). · **Files:** `packages/marketing/src/pages/contact/**` · **Deps:** P6-03.1, P6-02

### P6-04 — Analytics interface + consent/cookie mechanism — FE/BE · Lane P
- **AC:** `ANALYTICS` interface (event record, no-op default); consent/cookie banner gating on hosted; self-host off.
- **Tests:** unit: no-op when no consent/unconfigured; records when consented.
- **Files:** `packages/backend/src/analytics/**`, `packages/web/app/components/consent/**`
- **Doc Ref:** spec §11.6, §18 · **Deps:** P3-12 · **Status:** [ ]

### P6-05 — Error-reporting interface — BE · Lane P
- **AC:** `ERROR_REPORTING` interface (capture, no-op default); consent/PII-aware; self-host off; hosted operator-configured; source maps on prod build (if token set).
- **Tests:** unit: no-op unconfigured; capture invoked when configured (mocked).
- **Files:** `packages/backend/src/error-reporting/**`
- **Doc Ref:** spec §11.7, §18 · **Deps:** P1-03 · **Status:** [ ]

### P6-06 — Settings shells (account, workspace SMTP/AI/OIDC) — parent Story
- **Doc Ref:** spec §10.1, §15; proto (`SettingsAccount.jsx`,`SettingsWorkspace.jsx`); §23.4; rule `10`,`11`
- **Goal:** account + workspace settings; panel visibility driven by config/interface selection (not deployment-mode); no workspace-identifier-in-URL field. Two independent route trees.
- `P6-06.1` — Account settings — FE · Lane P
  - **AC:** profile, password, MFA, API tokens, prefs (AI opt-out, language, theme, accent). · **Tests:** component: settings persist. · **Files:** `packages/web/app/routes/settings/account/**` · **Deps:** P2-16.1, P2-06, P2-07
- `P6-06.2` — Workspace settings (general/SMTP/AI/OIDC) — FE · Lane P
  - **AC:** general, SMTP, AI, OIDC panels; visibility by config/interface (no `isCloud`). · **Tests:** component: panel visibility by config. · **Files:** `packages/web/app/routes/settings/workspace/**` · **Deps:** P2-14, P3-14.1, P2-03

### P6-07 — i18n completeness + Tolgee CI check — parent Story
- **Doc Ref:** spec §17, §22.6; rule `10`
- **Goal:** all UI strings in Tolgee en+de + a CI gate.
- `P6-07.1` — String audit + en/de completeness + language resolution — FE · Lane P
  - **AC:** all UI strings catalog keys with en+de; language resolution (user → Accept-Language → en); AI output-language honored. · **Tests:** rg finds no hard-coded UI strings. · **Files:** `packages/web/**`, `packages/marketing/**`, `packages/ui/**` (key usage) · **Deps:** P3-13, P4-03, P5-05, P6-03
- `P6-07.2` — Tolgee build gate in CI — Infra · Lane S
  - **AC:** `tolgee pull --check` fails build on a missing default-locale key; rg hard-coded-string check in CI. · **Tests:** CI translation check passes. · **Files:** `.github/workflows/ci-cd.yml`, i18n scripts · **Deps:** P6-07.1, P1-09

### P6-08 — Error pages + UX polish — parent Story · Domain FE
- **Doc Ref:** spec §18, §23.3; proto (`EdgePages.jsx`,`EdgeStates.html`); rule `11`
- **Goal:** edge pages + baseline interaction polish.
- `P6-08.1` — Error pages (404/403/500, app + marketing) — FE · Lane P
  - **AC:** 404/403/500 for app and marketing; accessible. · **Tests:** component: error pages render. · **Files:** `packages/web/app/routes/**` (error boundaries), `packages/marketing/src/pages/**` · **Deps:** P3-12, P6-03.1
- `P6-08.2` — Skeletons, empty states, toasts, confirmations — FE · Lane P
  - **AC:** loading skeletons, empty states, toasts, destructive-action confirmations as baseline; keyboard-friendly. · **Tests:** a11y smoke on key screens. · **Files:** `packages/ui/**`, key web routes · **Deps:** P3-12

### P6-09 — OpenAPI publish + optional interactive docs — BE · Lane P
- **AC:** OpenAPI document published; optional interactive docs disable-able by config.
- **Tests:** integration: OpenAPI served; docs toggle works.
- **Files:** `packages/backend/src/openapi/**`
- **Doc Ref:** spec §18; eng §5 · **Deps:** P1-02 · **Status:** [ ]

### P6-10 — Staging deploy pipeline (Fly + Workers + migration + smoke) — Infra · Lane S
- **AC:** push-`staging` pipeline: parallel API + web/marketing builds with staging secrets; DB migration; deploy `slugbase-staging-api` (Fly, scale-to-zero) + `slugbase-staging-web`/`-marketing` (Workers, retry); `/health`+`/version` smoke; GitHub Deployment records.
- **Tests:** workflow validates; staging deploy succeeds + smoke green.
- **Files:** `.github/workflows/ci-cd.yml`, `fly.toml`, worker deploy config
- **Doc Ref:** spec §22.5, §14.7; eng §10 · **Deps:** P1-10, P6-03 · **Status:** [ ]

### P6-11 — Prepare release + production deploy + GHCR image — Infra · Lane S
- **AC:** push-`main` prepare-release (version-bump check, translations check, changelog, draft release); release-published production deploy (idempotent via `DEPLOYED_VERSION`, `slugbase-production-*`, migration on Neon, smoke); combined self-host image pushed to GHCR `vX.Y.Z`+`latest`.
- **Tests:** workflow validates; dry-run/idempotency check; image builds + pushes.
- **Files:** `.github/workflows/ci-cd.yml`, release scripts
- **Doc Ref:** spec §22.6–22.8; eng §10 · **Deps:** P6-10 · **Status:** [ ]

---

## Jira field mapping

Convert to project **SB** (`mdg-labs.atlassian.net`) via the `jira-intake` skill (descriptions ← `jira-intake/templates.md`; summaries ← `jira-triage/summary-patterns.md`). IDs are authoritative in `.cursor/skills/orchestrator/jira-board.md`. Create in **Backlog**, then intake transitions Epic + leaves to **Ready**. The orchestrator enumerates the leaf set per epic with the JQL in jira-board.md § Epic pattern.

### Common fields (all issue types)

| Field | Jira key | Value |
|---|---|---|
| Project | `project` | `SB` |
| Domain | `customfield_10081` | `Frontend` `10092` / `Backend` `10093` / `Infrastructure` `10094` / `Operations` `10095` — from the `BE/FE/Infra/Ops` tag |
| Roadmap ID | `customfield_10082` | the roadmap ID (`P3-07` Story · `P2-16.1` Sub-task · `P3` Epic) |
| Legacy Key | `customfield_10083` | empty (greenfield) |
| Fix version | `fixVersions` | **`MVP Alpha` `10035`** for every v1 issue (Epic, Story, Sub-task) |
| Status | workflow | create **Backlog** → intake → **Ready** |

### Per issue type

| Aspect | **Epic** (Phase) | **Story** (deliverable) | **Sub-task** (leaf) |
|---|---|---|---|
| `issuetype` | Epic | Story | Sub-task |
| `summary` | phase theme | imperative task title | scope line |
| `parent` | — | Epic key | parent Story key |
| `description` | Epic template: background, subtask/story table, goal, epic-level product rules, **Suggested implementation order = this phase's batch plan** | Backend/Frontend subtask template: spec refs, schema, endpoints/routes, **AC + Tests + Files** from the leaf row | same template; AC/Tests/Files from the sub-task row + `[mig]` note when present |
| Domain | owning domain (P1 Infra · P2–P5 Backend · P6 Operations) | the leaf's `BE/FE/Infra/Ops` tag | the sub-task's tag |
| `priority` | High | per rule below | inherit parent Story; `[mig]`/spine = High |
| Dependencies | — | `createIssueLink` **"depends on"** per the leaf's **Deps** (outward; link type `10006`) | per the sub-task's `Deps` (incl. intra-Story `.1→.2→.3`) |
| `labels` | `phase-N` | `security`/`i18n`/`migration`/`infra`/`billing` as applicable | inherit + `migration` on `[mig]` |

For an **atomic Story** (no sub-tasks), the Story itself is the leaf: its description carries the AC/Tests/Files and it gets no child issues.

### Priority rule (orders the Ready queue: `… status = "Ready" ORDER BY priority DESC`)

- **High** — all of P1; each phase's serial **spine** (`P2-01/02/08/09/10/11/12`, `P3-01/02/03/04/07`, `P4-01/02`, `P5-01/02/03/04`, `P6-10/11`); every `[mig]` leaf.
- **Medium** — parallel feature leaves (most Lane P).
- **Low** — polish/optional (`P6-04/05/08/09`).

### Dependency links

One `depends on` link per **Deps** entry (outward = "depends on"; inward shows "is required by"). The orchestrator gates a leaf on `issue in linkedIssues("SB-N", "depends on")` all being **Done** before batching it. Intra-Story order (`.1 → .2 → .3`) is expressed the same way so a blocked `.1` halts dependents.

### Worked example — Epic P3 → Story P2-16 → its sub-tasks

```
Epic  SB-A  "Bookmarks, slugs, search & AI"            issuetype=Epic · Domain=Backend · Roadmap ID=P3 · fixVersion=MVP Alpha · priority=High
                                                       description: Suggested order = P3 batch plan
Story SB-B  "Build the authentication screens"          issuetype=Story · parent=<P2 epic> · Domain=Frontend · Roadmap ID=P2-16 · priority=High
  Sub-task SB-B1 "Auth shell + first-run setup + sign-in"  parent=SB-B · Domain=Frontend · Roadmap ID=P2-16.1 · priority=High · labels=[i18n]
                                                            depends on: SB(P1-08), SB(P2-12)
                                                            description AC: shared layout; setup; sign-in (non-enumerating)
  Sub-task SB-B2 "MFA challenge + backup codes"            parent=SB-B · Roadmap ID=P2-16.2 · priority=Medium · depends on: SB-B1, SB(P2-06)
  Sub-task SB-B3 "Register + verify-email"                 parent=SB-B · Roadmap ID=P2-16.3 · priority=Medium · depends on: SB-B1, SB(P2-04)
  Sub-task SB-B4 "Password reset + set-password"           parent=SB-B · Roadmap ID=P2-16.4 · priority=Medium · depends on: SB-B1, SB(P2-05)
```

---

## Verification (this draft)

- **No dependency cycles**; all `Deps` point to earlier-or-equal phases (P5-06/P6-01/P6-05/P6-09 are intentional early floaters depending only on P1).
- **Every `[mig]` leaf is Lane S** (migration history is serial); every Lane P leaf touches a disjoint package/module per its **Files** hint.
- **Each leaf is execution-ready**: AC + Tests + Files + Deps + Lane present; Doc Ref inherited from the Story for sub-tasks.

## Open follow-ups (not v1 tasks)

- Per-surface Infisical CI identities (hardening; eng §12).
- `schema-reference.md` / `api-design.md` grow incrementally alongside P1–P5 domain tasks (eng §12).
- Fast-Follow items per spec §20 (operator console, soft-delete, additional provider impls, etc.).
