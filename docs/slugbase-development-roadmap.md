# SlugBase — Development Roadmap (v1)

**Status:** 🚧 **DRAFT — pre-Jira.** Not yet converted to Jira; **no tickets created.** Working draft for review.
**Purpose:** the machine-executable work plan for the Cursor **orchestrator** (`.cursor/skills/orchestrator/SKILL.md`). After review it converts to Jira on project **SB**; after conversion **Jira becomes the execution source of truth** and this file is archived.

## Hierarchy (Jira mapping — decision #16/#20)

```
Epic   = Phase            (P1 … P6)                 6 epics
Story  = roadmap task      (P2-02, P3-07, …)        the deliverable unit
Sub-task = commit-sized decomposition of a Story (P2-02.1, P2-02.2, …)
```

- The orchestrator implements **leaf** issues: a **Sub-task** when a Story is decomposed, otherwise the **Story** itself (an *atomic leaf* — one commit). Epics are never implemented directly.
- A Story is decomposed only when it exceeds one commit or spans domains/lanes. Atomic stories say so explicitly.
- Field mapping for every Epic / Story / Sub-task is in **§ Jira field mapping** at the end.

## How to read

- **Lifecycle:** `[ ]` not started · `[~]` awaiting verification · `[x]` verified · `[!]` failed.
- **ID:** `P<phase>-<seq>` (Story) · `P<phase>-<seq>.<n>` (Sub-task); mirrored to `SB-N` on Jira (kept in the **Roadmap ID** field).
- **Domain:** `BE` Backend · `FE` Frontend · `Infra` Infrastructure · `Ops` Operations — maps to the Jira **Domain** field.
- **Lane:** `S` = serial on `main` · `P` = parallel in an isolated worktree (disjoint WRITE scope) · `B` = blocked (must serialize). Default when uncertain: **S**.
- **Migration rule (eng §11):** any sub-task that *generates a Drizzle migration* is **Lane S** even if its schema file is new — the migration history is a shared seam. Such sub-tasks are tagged `[mig]`.
- **Doc Ref shorthands:** `spec` = `slugbase-mvp-spec.md` · `eng` = `engineering-decisions.md` · `def` = `defaults-and-constants.md` · `proto` = `design-prototype/V1/` (screen map: spec §23.2).

## Universal acceptance criteria (apply to EVERY task — not repeated per row)

Per rule `02-orchestrator`: file/identifier naming (`04`); Conventional Commit with `[SB-N]`/`[P*-*]` (`01`,`07`); TS strict, no `any`, no `console.log`; security baseline (`03` — server-side sessions, no logged secrets, server-side validation, SSRF-safe egress, encrypted at-rest secrets); every new UI string via Tolgee en+de (`10`); every new env var via the Infisical 4-step (`05`); **no `isCloud`/deployment-mode branches** — entitlements + interface selection (spec §15).

## Phases (= Epics)

| Phase | Theme | Domain | Fix version | Exit |
|---|---|---|---|---|
| **P1** | Foundation & infra seam | Infra | MVP Alpha | Vertical slice: scaffold + CI gate green + health/version + DB abstraction (one engine) |
| **P2** | Auth, accounts, tenancy, entitlements core | BE | MVP Alpha | Set up/sign in (MFA, sessions); workspaces + membership + isolation |
| **P3** | Bookmarks, organization, slugs, search, dashboard, AI | BE | MVP Alpha | Core product usable end-to-end for one workspace |
| **P4** | Sharing, teams, audit | BE | MVP Alpha | Team collaboration + entitlement gating |
| **P5** | Billing & plan enforcement | BE | Public Launch v1.0.0 | Stripe (hosted) + no-op (self-host); downgrade overflow |
| **P6** | Marketing, i18n completeness, deploy, polish | Ops | Public Launch v1.0.0 | Hosted + self-host deployable; launch-ready |

> Fix-version split (P1–P4 = *MVP Alpha*, P5–P6 = *Public Launch v1.0.0*) is a proposal — adjust before Jira creation if you want billing inside Alpha.

---

## P1 — Foundation & infra seam · Epic · Domain Infra

> **D-21 exit slice:** `P1-01`, `P1-03`, `P1-04`, `P1-09` green.
> **Batch plan:** Serial spine `P1-01 → P1-02 → P1-03 → P1-04 → P1-05`. Parallel **B1** after `P1-03`: `{P1-06, P1-07}` (BE interfaces) ∥ `P1-08` (web/ui). `P1-09` serializes with `P1-05.2` (both edit the CI file). Parallel **B2** after `P1-03`+`P1-08`: `P1-10`.

### P1-01 — Initialize pnpm + Turborepo monorepo scaffold — BE/Infra · Lane S
- **Doc Ref:** spec §2.2, §19; eng §2, §3, §7
- **Acceptance Criteria:** pnpm workspace with `packages/{backend,web,marketing,shared-types,ui}` placeholders; root strict `tsconfig`, ESLint/Prettier, `turbo.json`; root scripts `lint`/`typecheck`/`test:unit`/`test:integration`/`build` via Turbo; `.env.example` + `.infisical.json` (project `slugbase-cloud`).
- **Tests:** `pnpm lint && pnpm typecheck && pnpm build` succeed on empty packages.
- **Deps:** — · **Status:** [ ]
- **Sub-tasks:**
  - `P1-01.1` · Infra · S · deps — — pnpm workspace + 5 package stubs + root strict `tsconfig` + `turbo.json` pipelines
  - `P1-01.2` · Infra · S · deps P1-01.1 — ESLint/Prettier + root pnpm scripts + `.env.example` + `.infisical.json`

### P1-02 — shared-types package (Zod + ts-rest + OpenAPI) — BE/Infra · Lane S
- **Doc Ref:** spec §18, §19; eng §5
- **Acceptance Criteria:** ts-rest + Zod set up; per-domain contract folder + root composer; sample contract compiles; OpenAPI generated via script; consumable by `backend` + `web`.
- **Tests:** unit asserts OpenAPI generation produces a valid doc for the sample contract.
- **Deps:** P1-01 · **Status:** [ ]
- **Sub-tasks:**
  - `P1-02.1` · Infra · S · deps P1-01 — ts-rest + Zod base, `contracts/` layout + root router, sample contract
  - `P1-02.2` · Infra · S · deps P1-02.1 — OpenAPI generation script + validity test

### P1-03 — Backend skeleton: config schema, health, version — BE · Lane S
- **Doc Ref:** spec §14.2, §15, §18; eng §3, §8; rule `05`
- **Acceptance Criteria:** NestJS boots; empty per-domain feature-module stubs registered (removes the `app.module` seam for later domains, eng §11); Zod env-config validates required secrets at startup (`SESSION_SECRET`, `ENCRYPTION_KEY`, `DATABASE_URL`, `APP_BASE_URL`, `FRONTEND_ORIGIN`), refuses prod start if missing; `GET /health` + `GET /version`.
- **Tests:** integration: health/version 200; startup throws on missing secret in production mode.
- **Deps:** P1-01 · **Status:** [ ]
- **Sub-tasks:**
  - `P1-03.1` · BE · S · deps P1-01 — NestJS bootstrap + module structure + empty feature-module stubs
  - `P1-03.2` · BE · S · deps P1-03.1 — Zod env-config module + startup validation (refuse insecure prod)
  - `P1-03.3` · BE · P · deps P1-03.2 — `/health` + `/version` endpoints

### P1-04 — Persistence interface + Drizzle + SQLite + migrations — BE/Infra · Lane S
- **Doc Ref:** spec §11.9, §16; eng §4, §11
- **Acceptance Criteria:** `DB` data-access abstraction with Drizzle impl; thin dialect layer; per-domain schema glob; embedded SQLite wired; Drizzle Kit tooling (`db:generate`/`db:migrate`); migration-bookkeeping table; auto-migrate on startup (§14.3).
- **Tests:** integration: migrate up on temp SQLite; trivial repository round-trips.
- **Deps:** P1-03 · **Status:** [ ]
- **Sub-tasks:**
  - `P1-04.1` · BE · S · deps P1-03 — `DB` token + data-access abstraction + Drizzle setup + dialect layer + schema glob
  - `P1-04.2` · BE · S · deps P1-04.1 — SQLite engine wiring + connection config
  - `P1-04.3` · BE · S `[mig]` · deps P1-04.2 — Drizzle Kit tooling + bookkeeping + auto-migrate on startup

### P1-05 — Add Neon Postgres engine on identical schema — Infra · Lane S
- **Doc Ref:** spec §11.9, decision #32; eng §4, §6
- **Acceptance Criteria:** Postgres engine selectable by config on the same schema/migrations; CI matrix runs the integration suite against **both** SQLite and Postgres.
- **Tests:** integration suite passes on both engines in CI.
- **Deps:** P1-04 · **Status:** [ ]
- **Sub-tasks:**
  - `P1-05.1` · BE · S · deps P1-04 — Postgres engine selectable by config on shared schema
  - `P1-05.2` · Infra · S · deps P1-05.1, P1-09 — CI integration matrix {SQLite, Postgres}

### P1-06 — Crypto interface (at-rest encryption) — BE · Lane P
- **Doc Ref:** spec §11.11, §18; rule `03`; eng §3
- **Acceptance Criteria:** `CRYPTO` encrypt/decrypt with `ENCRYPTION_KEY`; strict mode refuses silent failure in prod; used by a sample settings field.
- **Tests:** unit: round-trip; strict-mode throws on bad key.
- **Deps:** P1-03 · **Status:** [ ] · **Sub-tasks:** none (atomic leaf).

### P1-07 — SSRF-safe outbound fetch interface — BE · Lane P
- **Doc Ref:** spec §11.10, §6.4, §18; rule `03`
- **Acceptance Criteria:** single `FETCH` egress chokepoint: host resolution + private/loopback blocking, timeouts, size limits, caching; no other code does raw outbound `fetch`.
- **Tests:** unit: blocks private IPs/loopback; enforces timeout + size cap; caches.
- **Deps:** P1-03 · **Status:** [ ] · **Sub-tasks:** none (atomic leaf).

### P1-08 — Web + ui skeleton: tokens, theme, layout — FE · Lane S (within web/ui; parallel to P1-06/07)
- **Doc Ref:** spec §19, §23.1; eng §1, §3; rule `11`
- **Acceptance Criteria:** React Router v7 boots on Node adapter; `ui` exposes Tailwind config bridged to `colors_and_type.css` tokens (dark-first, periwinkle, IBM Plex); app shell + theme switch (light/dark/auto); Tolgee React SDK provider wired; no hard-coded hex/strings.
- **Tests:** unit: theme tokens resolve; snapshot of base layout.
- **Deps:** P1-01 · **Status:** [ ]
- **Sub-tasks:**
  - `P1-08.1` · FE · S · deps P1-01 — `ui` package: Tailwind config bridged to tokens + token primitives
  - `P1-08.2` · FE · S · deps P1-08.1 — `web` React Router v7 boot (Node adapter) + app shell layout
  - `P1-08.3` · FE · P · deps P1-08.2 — theme switch + Tolgee React SDK provider wiring

### P1-09 — CI checks job (`.github/workflows/ci-cd.yml`) — Infra · Lane S
- **Doc Ref:** spec §22.1–22.3, §22.9; eng §7, §8, §10
- **Acceptance Criteria:** workflow with PR/push triggers (`staging`,`main`); CI job: install → lint/typecheck/unit → Infisical OIDC fetch → build → integration → `pnpm audit`; only `INFISICAL_DOMAIN`+`INFISICAL_OIDC_IDENTITY_ID` as GHA secrets.
- **Tests:** workflow YAML validates; CI green on P1 scaffold.
- **Deps:** P1-01 · **Status:** [ ]
- **Sub-tasks:**
  - `P1-09.1` · Infra · S · deps P1-01 — workflow skeleton + triggers + install + lint/typecheck/unit
  - `P1-09.2` · Infra · S · deps P1-09.1 — Infisical OIDC fetch + build + integration + `pnpm audit`

### P1-10 — Container images (combined + API-only) — Infra · Lane P
- **Doc Ref:** spec §14.2, §22.8; eng §10
- **Acceptance Criteria:** API-only + combined (API + bundled web) images; single port; mounted volume for embedded DB; health/version reachable in-container.
- **Tests:** image builds; container smoke hits `/health` + `/version`.
- **Deps:** P1-03, P1-08 · **Status:** [ ]
- **Sub-tasks:**
  - `P1-10.1` · Infra · P · deps P1-03 — API-only Dockerfile (single port, health/version)
  - `P1-10.2` · Infra · P · deps P1-10.1, P1-08 — combined image (API + bundled web) + DB volume

---

## P2 — Auth, accounts, tenancy, entitlements core · Epic · Domain BE

> **Batch plan:** Serial spine `P2-01 → P2-02 → P2-08 → P2-09 → P2-10 → P2-11 → P2-12` (sessions → accounts → tenancy → isolation → entitlements → setup). `[mig]` sub-tasks for P2-04/05/06/07/13/14 join the spine; their service/API sub-tasks then run parallel.
> Parallel **B1** (after P1-06): `P2-03` (mail). **B2** (after P2-02 + needed `[mig]`s): `{P2-05, P2-06.*, P2-07.*, P2-14.*, P2-15}`. **B3** (after P2-04/05/06/12 + P1-08): `P2-16` auth screens (each route file parallel after the shared layout).

### P2-01 — Server-side session store + cookie + CSRF — BE · Lane S
- **Doc Ref:** spec §5.3, §5.8, §18; def §3; eng §1
- **Acceptance Criteria:** DB-backed session store; HTTP-only/Secure/SameSite cookie; configurable TTL (def §3); individual + "log out everywhere" revocation; double-submit CSRF with §5.8 exempt allowlist + CSRF-token endpoint.
- **Tests:** integration: session create/revoke; CSRF rejects missing token; allowlisted endpoints exempt.
- **Deps:** P1-04 · **Status:** [ ]
- **Sub-tasks:**
  - `P2-01.1` · BE · S `[mig]` · deps P1-04 — session schema + DB-backed store (create/lookup/revoke, TTL)
  - `P2-01.2` · BE · S · deps P2-01.1 — cookie issuance + session middleware + "log out everywhere"
  - `P2-01.3` · BE · S · deps P2-01.2 — double-submit CSRF guard + exempt allowlist + token endpoint

### P2-02 — Account model + password auth (argon2id) — BE · Lane S
- **Doc Ref:** spec §5.1, §5.4; def §3; eng §1
- **Acceptance Criteria:** `user_account` (email unique, name, language, theme, instance-admin, MFA state, AI opt-out); argon2id; password policy (def §3) + strength signal; login/logout issuing sessions.
- **Tests:** unit: hash/verify, policy. integration: login → session; logout → revoked.
- **Deps:** P2-01 · **Status:** [ ]
- **Sub-tasks:**
  - `P2-02.1` · BE · S `[mig]` · deps P2-01 — `user_account` schema
  - `P2-02.2` · BE · S · deps P2-02.1 — argon2id hashing + password policy/strength
  - `P2-02.3` · BE · S · deps P2-02.2, P2-01.2 — login/logout issuing + revoking sessions

### P2-03 — Mail interface (SMTP + no-op) — BE · Lane P
- **Doc Ref:** spec §11.1; rule `05`
- **Acceptance Criteria:** `MAIL` interface (send + is-available); SMTP impl (config-driven) + no-op/log default; "send test"; encrypted SMTP creds where admin-managed (via `CRYPTO`).
- **Tests:** unit: no-op reports unavailable + logs; SMTP send invoked with correct payload (mocked transport).
- **Deps:** P1-06 · **Status:** [ ]
- **Sub-tasks:**
  - `P2-03.1` · BE · P · deps P1-06 — `MAIL` interface + no-op/log impl + is-available
  - `P2-03.2` · BE · P · deps P2-03.1 — SMTP impl (encrypted creds) + send-test

### P2-04 — Email verification (signup + change) — BE · Lane S
- **Doc Ref:** spec §5.5; def §3
- **Acceptance Criteria:** signup-verification + email-change flows distinct; hashed time-limited tokens (def §3); generic responses; address switches only after confirm.
- **Tests:** integration: token issue → verify → state change; expired token rejected.
- **Deps:** P2-02, P2-03 · **Status:** [ ]
- **Sub-tasks:**
  - `P2-04.1` · BE · S `[mig]` · deps P2-02 — verification token schema + signup-verify flow
  - `P2-04.2` · BE · P · deps P2-04.1, P2-03 — email-change flow (switch after confirm)

### P2-05 — Password reset — BE · Lane P
- **Doc Ref:** spec §5.4; def §3, §4
- **Acceptance Criteria:** tokenized, time-limited, email-delivered; always-generic response (no enumeration); rate-limited (def §4).
- **Tests:** integration: reset issues token, sets new password; generic response regardless of account existence.
- **Deps:** P2-02, P2-03 · **Status:** [ ] · **Sub-tasks:** none (atomic leaf; reuses P2-04 token infra).

### P2-06 — TOTP MFA + backup codes — BE · Lane mixed
- **Doc Ref:** spec §5.7; def §3
- **Acceptance Criteria:** enrol (otplib secret + QR + text), 10 single-use hashed backup codes shown once; password logins require second factor post-enrol; disable (with verification) + regenerate; configurable issuer; admin/support recovery documented.
- **Tests:** unit: TOTP verify, backup-code single-use. integration: login requires MFA after enrol.
- **Deps:** P2-02 · **Status:** [ ]
- **Sub-tasks:**
  - `P2-06.1` · BE · S `[mig]` · deps P2-02, P1-06 — MFA secret + backup-code schema (secret encrypted via `CRYPTO`)
  - `P2-06.2` · BE · P · deps P2-06.1 — enrol (otplib + QR) + backup codes shown-once
  - `P2-06.3` · BE · P · deps P2-06.2, P2-02.3 — enforce 2nd factor on login + disable/regenerate

### P2-07 — Personal API tokens — BE · Lane mixed
- **Doc Ref:** spec §5.3; def §3
- **Acceptance Criteria:** named, prefixed (`slb_`), hashed; max per user (def §3); last-use tracking; revoke; Bearer auth path; bypass MFA, no cookie session.
- **Tests:** integration: create → shown-once → authenticate via Bearer → revoke → denied.
- **Deps:** P2-02 · **Status:** [ ]
- **Sub-tasks:**
  - `P2-07.1` · BE · S `[mig]` · deps P2-02 — `api_token` schema (hashed, prefix, last-use)
  - `P2-07.2` · BE · P · deps P2-07.1 — create/revoke + shown-once + Bearer auth path (no cookie, bypass MFA)

### P2-08 — Workspace, membership, roles — BE · Lane S
- **Doc Ref:** spec §4.1, §4.2, §16
- **Acceptance Criteria:** Workspace + Membership (owner/admin/member); always ≥1 owner invariant; every tenant table carries `workspace_id`.
- **Tests:** unit: role checks; cannot remove last owner. integration: membership CRUD.
- **Deps:** P2-02 · **Status:** [ ]
- **Sub-tasks:**
  - `P2-08.1` · BE · S `[mig]` · deps P2-02 — Workspace + Membership schema + `workspace_id` convention
  - `P2-08.2` · BE · S · deps P2-08.1 — role model + ≥1-owner invariant + membership CRUD

### P2-09 — Tenant resolution + active-workspace switch — BE · Lane S
- **Doc Ref:** spec §4.3, §4.6
- **Acceptance Criteria:** resolution behind an interface; active workspace in session; explicit switch verifies membership; stale selection re-derived; tenant ops rejected without context.
- **Tests:** integration: switch verifies membership; revoked membership clears context.
- **Deps:** P2-08 · **Status:** [ ]
- **Sub-tasks:**
  - `P2-09.1` · BE · S · deps P2-08, P2-01.2 — resolution interface + active workspace in session
  - `P2-09.2` · BE · S · deps P2-09.1 — switch endpoint (verify membership) + stale re-derive + reject-without-context

### P2-10 — Data isolation enforcement + cross-tenant tests — BE · Lane S
- **Doc Ref:** spec §4.4, §18; eng §4, §6
- **Acceptance Criteria:** data-access auto-scopes every tenant query by active `workspace_id`; writes stamp it; centralized guard.
- **Tests:** integration: cross-workspace read/write denied (**mandatory isolation suite**).
- **Deps:** P2-09 · **Status:** [ ]
- **Sub-tasks:**
  - `P2-10.1` · BE · S · deps P2-09 — auto-scoping in data-access + write stamping + central guard
  - `P2-10.2` · BE · S · deps P2-10.1 — mandatory cross-tenant isolation test suite

### P2-11 — Entitlements engine (core; self-host unlimited) — BE · Lane S
- **Doc Ref:** spec §11.5, §12.2; def §5
- **Acceptance Criteria:** engine answers workspace + account entitlements (bookmark cap, AI, team sharing, admin, audit, seats, workspaces-per-account); self-host = unlimited; hosted defaults to Free (billing wired P5); central checks, no deployment-mode branch.
- **Tests:** unit: self-host unlimited; hosted Free caps; workspaces-per-account enforced.
- **Deps:** P2-08 · **Status:** [ ]
- **Sub-tasks:**
  - `P2-11.1` · BE · S · deps P2-08 — engine + entitlement-set model + central check API
  - `P2-11.2` · BE · S · deps P2-11.1 — self-host unlimited + hosted Free default mapping (interface-selected, no `isCloud`)

### P2-12 — First-run setup + workspace creation (entitlement-gated) — BE · Lane S
- **Doc Ref:** spec §4.1, §5.2, §14.3, §12.2/§12.4
- **Acceptance Criteria:** empty-DB setup creates first account (instance-admin + owner) + first workspace; workspace-creation enforces workspaces-per-account (hosted Free=1; self-host unrestricted); hosted signup auto-creates personal workspace.
- **Tests:** integration: setup on empty DB; Free 2nd-workspace blocked; self-host unrestricted.
- **Deps:** P2-11 · **Status:** [ ]
- **Sub-tasks:**
  - `P2-12.1` · BE · S · deps P2-11 — empty-DB first-run setup (first admin/owner + first workspace)
  - `P2-12.2` · BE · S · deps P2-12.1 — workspace-creation endpoint w/ entitlement + hosted auto-personal-workspace

### P2-13 — Invitations (seats on acceptance) — BE · Lane mixed
- **Doc Ref:** spec §4.2, §5.2, §12.2; def §5
- **Acceptance Criteria:** invite by email (hashed token, expiry); join on acceptance; seat consumed on acceptance not send; seat count cannot drop below member count.
- **Tests:** integration: invite → accept consumes seat; over-seat acceptance blocked on hosted Team.
- **Deps:** P2-12 · **Status:** [ ]
- **Sub-tasks:**
  - `P2-13.1` · BE · S `[mig]` · deps P2-12 — invitation schema (hashed token, expiry)
  - `P2-13.2` · BE · P · deps P2-13.1, P2-03 — invite → accept (join + seat-on-acceptance + seat floor)

### P2-14 — OIDC / auth-provider interface — BE · Lane mixed
- **Doc Ref:** spec §5.6, §11.3; eng §1
- **Acceptance Criteria:** `AUTH_PROVIDER` (list, start, callback, claims, link/auto-create); self-host = DB-sourced admin config (encrypted secrets, custom endpoints); hosted = deployment-config; email-verified linking; federated login skips SlugBase MFA.
- **Tests:** integration (mock IdP): handshake → link/auto-create; unverified routed correctly.
- **Deps:** P2-02, P1-06 · **Status:** [ ]
- **Sub-tasks:**
  - `P2-14.1` · BE · S `[mig]` · deps P2-02, P1-06 — `AUTH_PROVIDER` interface + provider-config schema (encrypted)
  - `P2-14.2` · BE · P · deps P2-14.1 — self-host DB-sourced config + hosted deployment-config selection
  - `P2-14.3` · BE · P · deps P2-14.2 — handshake (start/callback/claims) + email-verified linking/auto-create + skip MFA

### P2-15 — Rate limiting on sensitive endpoints — BE · Lane P
- **Doc Ref:** spec §18; def §4
- **Acceptance Criteria:** limits on login, registration, password reset, token creation (def §4); 429 on exceed; per-IP + per-account.
- **Tests:** integration: limit triggers 429; resets after window.
- **Deps:** P2-02 · **Status:** [ ] · **Sub-tasks:** none (atomic leaf).

### P2-16 — Auth UI (setup, login, MFA, register, verify, reset) — FE · Lane mixed
- **Doc Ref:** spec §5, §23.2 (`AuthApp.jsx`/`AuthKit.jsx`); proto; rule `10`,`11`
- **Acceptance Criteria:** screens for first-run setup, sign-in, MFA challenge, register, verify-email, password reset, set-password; non-enumerating copy; shown-once backup codes; all strings via Tolgee (en+de); built from prototype design language.
- **Tests:** component tests per screen; e2e (P6) covers login+MFA.
- **Deps:** P2-04, P2-05, P2-06, P2-12; P1-08 · **Status:** [ ]
- **Sub-tasks:**
  - `P2-16.1` · FE · S · deps P1-08, P2-12 — shared auth layout/kit + first-run setup + sign-in screens
  - `P2-16.2` · FE · P · deps P2-16.1, P2-06 — MFA challenge + shown-once backup codes
  - `P2-16.3` · FE · P · deps P2-16.1, P2-04 — register + verify-email
  - `P2-16.4` · FE · P · deps P2-16.1, P2-05 — password reset + set-password

---

## P3 — Bookmarks, organization, slugs, search, dashboard, AI · Epic · Domain BE

> **Batch plan:** Serial spine `P3-01 → P3-07` (bookmark core + slug/`/go`); `P3-04` after folders/tags. Parallel **B1** (after P3-01): `{P3-02, P3-03}`. **B2** (after P3-04): `{P3-05, P3-06, P3-08}`. **B3** (after P3-08+02+03): `P3-09 → P3-10`. **B4** FE (after P3-07): `P3-11.1` (BE) ∥ then `P3-11.2 → {P3-11.3, P3-12}`, `P3-13`. **B5** (after P3-13+P3-06): `P3-14`.

### P3-01 — Bookmark domain (CRUD, pin, hard delete, usage) — BE · Lane S
- **Doc Ref:** spec §6.1–6.3, §16; def §1
- **Acceptance Criteria:** Bookmark (title, url, slug?, forwarding, pinned, plan-archived, access count, last-accessed); CRUD; hard delete cascades; pin; async usage tracking (never blocks).
- **Tests:** integration: CRUD + ownership; usage increment async; cascade on delete.
- **Deps:** P2-10 · **Status:** [ ]
- **Sub-tasks:**
  - `P3-01.1` · BE · S `[mig]` · deps P2-10 — Bookmark schema
  - `P3-01.2` · BE · S · deps P3-01.1 — CRUD + ownership + hard delete cascade
  - `P3-01.3` · BE · P · deps P3-01.2 — pin toggle + async usage tracking

### P3-02 — Folders — BE · Lane mixed
- **Doc Ref:** spec §7.1, §16
- **Acceptance Criteria:** Folder (name, optional icon); many-to-many with bookmarks; CRUD, list (search/sort/paginate); no folder cap (§23.4).
- **Tests:** integration: CRUD; bookmark in multiple folders.
- **Deps:** P3-01 · **Status:** [ ]
- **Sub-tasks:**
  - `P3-02.1` · BE · S `[mig]` · deps P3-01.1 — Folder schema + `bookmark_folder` join
  - `P3-02.2` · BE · P · deps P3-02.1 — CRUD + list (search/sort/paginate), no cap

### P3-03 — Tags (user-private) — BE · Lane mixed
- **Doc Ref:** spec §7.2, §16
- **Acceptance Criteria:** Tag user-private; CRUD; never shared; distribution/overview.
- **Tests:** integration: tags scoped per user; not visible cross-user.
- **Deps:** P3-01 · **Status:** [ ]
- **Sub-tasks:**
  - `P3-03.1` · BE · S `[mig]` · deps P3-01.1 — Tag schema (user-private) + `bookmark_tag` join
  - `P3-03.2` · BE · P · deps P3-03.1 — CRUD scoped per user + distribution

### P3-04 — Bookmark listing: filter/sort/paginate + select-all-ids — BE · Lane S
- **Doc Ref:** spec §6.5; def §2
- **Acceptance Criteria:** filter by folder/tags/pinned/scope; query match title/url/slug; sort recent/alpha/most-used/recently-accessed; pagination (def §2); companion IDs endpoint for select-all; plan-archived excluded.
- **Tests:** integration: each filter/sort; pagination bounds; IDs endpoint matches list.
- **Deps:** P3-02, P3-03 · **Status:** [ ]
- **Sub-tasks:**
  - `P3-04.1` · BE · S · deps P3-02, P3-03 — filter/sort/paginate endpoint + plan-archived exclusion
  - `P3-04.2` · BE · P · deps P3-04.1 — select-all-ids companion endpoint

### P3-05 — Bulk actions — BE · Lane P
- **Doc Ref:** spec §6.6
- **Acceptance Criteria:** bulk delete/move-to-folder/add-tags (with merge preview)/share (where available); respect ownership + authorization.
- **Tests:** integration: bulk op across selected + select-all-ids; unauthorized items skipped.
- **Deps:** P3-04 · **Status:** [ ] · **Sub-tasks:** none (atomic leaf).

### P3-06 — Metadata + favicon fetch (via SSRF egress) — BE · Lane P
- **Doc Ref:** spec §6.4, §11.10; def §2
- **Acceptance Criteria:** fetch title/description/site-name + favicon proxy through `FETCH` only; cached (def §2).
- **Tests:** integration: metadata parsed; private URL blocked; cache hit.
- **Deps:** P1-07, P3-01 · **Status:** [ ] · **Sub-tasks:** none (atomic leaf).

### P3-07 — Slugs + `/go` redirect + disambiguation + go-preferences — BE · Lane S
- **Doc Ref:** spec §8.1–8.4, §16; def §1
- **Acceptance Criteria:** slug validation (def §1, reserved list); unique per workspace; `/go/<slug>` requires auth, resolves within active workspace over accessible+forwarding bookmarks; no-match 404; single→redirect (async usage); multi→disambiguation with "always use this" → stored go-preference; preference management (list/remove).
- **Tests:** integration: single/multi/no-match; preference honored; reserved slug rejected.
- **Deps:** P3-01 · **Status:** [ ]
- **Sub-tasks:**
  - `P3-07.1` · BE · S `[mig]` · deps P3-01.1 — slug validation (grammar/reserved) + unique-per-workspace + `go_preference` schema
  - `P3-07.2` · BE · S · deps P3-07.1 — `/go/<slug>` resolve (auth, active workspace, accessible+forwarding) + 404 + single→redirect (async usage)
  - `P3-07.3` · BE · P · deps P3-07.2 — multi→disambiguation + "always use this" store + management (list/remove)

### P3-08 — Bookmark cap enforcement (Free 50) — BE · Lane P
- **Doc Ref:** spec §12.2, §12.4; def §2, §5
- **Acceptance Criteria:** creation + import blocked at/over cap on capped workspaces with actionable message; server-side via entitlements; unlimited plans unaffected.
- **Tests:** integration: 51st create blocked on Free; unlimited on Personal.
- **Deps:** P3-01, P2-11 · **Status:** [ ] · **Sub-tasks:** none (atomic leaf).

### P3-09 — Import (JSON + Netscape HTML) — BE · Lane P
- **Doc Ref:** spec §13; def §2
- **Acceptance Criteria:** import JSON array + Netscape HTML (size cap def §2); folders/tags created-or-matched by name; invalid/dup slugs skipped; bounded count; success/failure report; respects cap.
- **Tests:** integration: mixed valid/invalid reports counts; cap respected.
- **Deps:** P3-08, P3-02, P3-03 · **Status:** [ ]
- **Sub-tasks:**
  - `P3-09.1` · BE · P · deps P3-08, P3-02, P3-03 — JSON array import + folder/tag match-or-create + report
  - `P3-09.2` · BE · P · deps P3-09.1 — Netscape HTML import + size cap + invalid/dup-slug skip + cap respect

### P3-10 — Export (lossless / round-trip) — BE · Lane P
- **Doc Ref:** spec §13, §14.4
- **Acceptance Criteria:** export each accessible bookmark with title/url/slug/forwarding/pinned + folder & tag names; export→import into fresh workspace reproduces faithfully.
- **Tests:** integration: round-trip equality for bookmarks/folders/tags.
- **Deps:** P3-09 · **Status:** [ ] · **Sub-tasks:** none (atomic leaf).

### P3-11 — Search endpoint + command palette (cmdk) + go-mode — mixed · Lane mixed
- **Doc Ref:** spec §9.1, §8.4; proto (`PaletteApp.jsx`); rule `10`,`11`
- **Acceptance Criteria:** server search across bookmarks/folders/tags with per-type limits + client fallback; cmdk palette (`⌘K`): empty=nav/quick-actions, query=search, `go <slug>` mode with live matches; open-in-new-tab modifier; keyboard shortcuts (proto).
- **Tests:** integration: search endpoint; component: palette modes incl. go-mode.
- **Deps:** P3-07 · **Status:** [ ]
- **Sub-tasks:**
  - `P3-11.1` · BE · P · deps P3-07 — search endpoint (bookmarks/folders/tags, per-type limits)
  - `P3-11.2` · FE · S · deps P3-11.1, P1-08 — cmdk palette shell (`⌘K`, empty=nav/quick-actions, query=search)
  - `P3-11.3` · FE · P · deps P3-11.2 — `go <slug>` mode (live matches + open-in-new-tab + shortcuts)

### P3-12 — Dashboard — FE · Lane P
- **Doc Ref:** spec §9.2; proto (`DashboardApp.jsx`); rule `10`,`11`
- **Acceptance Criteria:** counts; search entry; quick-access slugs; pinned; most-used tags; sharing stats; dismissible onboarding checklist; entitlement-driven limit/upgrade prompts (no deployment-mode branch).
- **Tests:** component: sections render from data; prompts gated by engine.
- **Deps:** P3-11 · **Status:** [ ] · **Sub-tasks:** none (atomic leaf).

### P3-13 — Bookmark create/edit modal — FE · Lane S
- **Doc Ref:** spec §6.2 (decision #19); proto §23.5; rule `10`,`11`
- **Acceptance Criteria:** modal-only create/edit (url, title, slug, folders, tags, pin, forwarding, sharing placeholder); no detail route; validation surfaced; strings via Tolgee.
- **Tests:** component: create/edit modal validates + submits.
- **Deps:** P3-04, P3-07 · **Status:** [ ] · **Sub-tasks:** none (atomic leaf — shared component, anchor for FE batch).

### P3-14 — AI interface (OpenAI) + inline suggestions + cache + opt-out — mixed · Lane mixed
- **Doc Ref:** spec §11.2, §6.4, §17; def §5; rule `05`,`10`
- **Acceptance Criteria:** `AI` interface (suggest title/slug/tags/detected-language/confidence + availability); OpenAI impl; self-host BYO key, hosted operator key + per-workspace toggle + entitlement gate; user opt-out honored; cache keyed (workspace,user,canonical URL,output language) TTL def §5; output language = user locale.
- **Tests:** integration (mocked OpenAI): suggestions returned + cached; opt-out short-circuits; disabled when no key.
- **Deps:** P3-13, P3-06, P2-11 · **Status:** [ ]
- **Sub-tasks:**
  - `P3-14.1` · BE · P · deps P2-11, P1-06 — `AI` interface + OpenAI impl + availability + key config (BYO/operator)
  - `P3-14.2` · BE · S `[mig]` · deps P3-14.1 — suggestion cache schema + cache logic (TTL, keyed incl. output language)
  - `P3-14.3` · FE · P · deps P3-14.2, P3-13 — inline suggestions in modal + opt-out + entitlement gate + output-language = locale

---

## P4 — Sharing, teams, audit · Epic · Domain BE

> **Batch plan:** Serial `P4-01.1 → P4-02` (auth model is shared). Parallel **B1**: `{P4-01.2, P4-04}` after migrations. **B2** (after P4-02): `{P4-03, P4-05}` FE. Tail S: `P4-06` gating after P4-02/04/05.

### P4-01 — Teams + team membership — BE · Lane mixed
- **Doc Ref:** spec §10.1, §16
- **Acceptance Criteria:** Team (name, description) + membership; CRUD; sharing targets; workspace-scoped.
- **Tests:** integration: team CRUD + membership.
- **Deps:** P2-08 · **Status:** [ ]
- **Sub-tasks:**
  - `P4-01.1` · BE · S `[mig]` · deps P2-08 — Team + `team_membership` schema
  - `P4-01.2` · BE · P · deps P4-01.1 — CRUD + membership management

### P4-02 — Sharing records + authorization model — BE · Lane S
- **Doc Ref:** spec §5.9, §6, §7.1, §16
- **Acceptance Criteria:** bookmark/folder → team/user share grants; centralized authorization (owner R/W; shared=read; folder share transitive); consistent across list/read/redirect/search/bulk.
- **Tests:** integration: shared read visible; non-shared denied; folder-share transitivity; redirect honors sharing.
- **Deps:** P4-01, P3-07 · **Status:** [ ]
- **Sub-tasks:**
  - `P4-02.1` · BE · S `[mig]` · deps P4-01.1, P3-07 — share-grant schema (bookmark/folder → team/user)
  - `P4-02.2` · BE · S · deps P4-02.1 — centralized authorization (owner R/W; shared read; folder transitive)
  - `P4-02.3` · BE · S · deps P4-02.2 — apply consistently across list/read/redirect/search/bulk

### P4-03 — Sharing UI + scope filters — FE · Lane P
- **Doc Ref:** spec §6.5, §7.1; proto; rule `10`,`11`
- **Acceptance Criteria:** share controls on bookmarks/folders; scope filters (all/mine/shared-with-me/shared-by-me); sharing labels; entitlement-gated visibility.
- **Tests:** component: share dialog; scope filter queries.
- **Deps:** P4-02 · **Status:** [ ] · **Sub-tasks:** none (atomic leaf).

### P4-04 — Audit log (workspace-scoped) — BE · Lane mixed
- **Doc Ref:** spec §10.1, §16
- **Acceptance Criteria:** append-only events (actor, action, entity, metadata, time); read-only paginated view; entitlement-gated (Team on hosted; on for self-host).
- **Tests:** integration: significant actions recorded; access gated.
- **Deps:** P2-11 · **Status:** [ ]
- **Sub-tasks:**
  - `P4-04.1` · BE · S `[mig]` · deps P2-11 — audit-event schema (append-only)
  - `P4-04.2` · BE · P · deps P4-04.1 — recording on significant actions + paginated read view + entitlement gate

### P4-05 — Members & Teams admin UI — FE · Lane P
- **Doc Ref:** spec §10.1, §12.4; proto (`SettingsMembers.jsx`); rule `10`,`11`
- **Acceptance Criteria:** invite/add/edit/remove members, set roles, resend invites, assign to teams, ownership transfer; team management; entitlement-gated (Team on hosted) with API enforcement independent of UI.
- **Tests:** component + integration: role changes; gated endpoints refuse off-plan.
- **Deps:** P4-01, P2-13 · **Status:** [ ] · **Sub-tasks:** none (atomic leaf).

### P4-06 — Entitlement gating for sharing/admin/audit — BE · Lane S
- **Doc Ref:** spec §12.2, §12.4
- **Acceptance Criteria:** team sharing, team admin, member invitations, audit log gated to Team on hosted; UI hides/disables, API refuses; always on for self-host.
- **Tests:** integration: each gated surface refused on non-Team hosted; allowed on self-host.
- **Deps:** P4-02, P4-04, P4-05 · **Status:** [ ] · **Sub-tasks:** none (atomic leaf — cross-cutting gate pass).

---

## P5 — Billing & plan enforcement · Epic · Domain BE

> **Batch plan:** Serial spine `P5-01 → P5-02 → P5-03 → P5-04`. Parallel: `P5-05` (UI) after P5-03; `P5-06` (stats) is independent — floats any time after P1-03.

### P5-01 — Billing interface (Stripe + no-op) — BE · Lane S
- **Doc Ref:** spec §11.4, §12.3
- **Acceptance Criteria:** `BILLING` interface (checkout, portal, subscription state, seat quantity, async events); Stripe impl (hosted); no-op impl (self-host) granting full entitlements; app logic checks entitlements only.
- **Tests:** unit: no-op grants unlimited; Stripe adapter maps state (mocked).
- **Deps:** P2-11 · **Status:** [ ]
- **Sub-tasks:**
  - `P5-01.1` · BE · S · deps P2-11 — `BILLING` interface + no-op impl (self-host full entitlements)
  - `P5-01.2` · BE · S · deps P5-01.1 — Stripe impl mapping subscription/seat state (mocked tests)

### P5-02 — Plan → entitlement mapping (Free/Personal/Team/supporter) — BE · Lane S
- **Doc Ref:** spec §12.1, §12.2; def §5, §6
- **Acceptance Criteria:** plans map to entitlement sets; supporter = "Personal, permanent" (no separate code path); prices/seats config-driven (not hard-coded); paid tier named "Personal".
- **Tests:** unit: each plan → expected entitlements; supporter = Personal-permanent.
- **Deps:** P5-01 · **Status:** [ ] · **Sub-tasks:** none (atomic leaf).

### P5-03 — Checkout, portal, webhooks (idempotent), seats — BE · Lane S
- **Doc Ref:** spec §11.4, §12.3, §12.4; def §5
- **Acceptance Criteria:** start checkout (recurring + one-time supporter); self-service portal; idempotent webhook processing updates entitlements; seat add/remove (not below member count); VAT where relevant; deletion blocked while billing owner of active paid workspace.
- **Tests:** integration (mocked Stripe events): idempotent apply; seat floor enforced.
- **Deps:** P5-02 · **Status:** [ ]
- **Sub-tasks:**
  - `P5-03.1` · BE · S · deps P5-02 — checkout (recurring + one-time supporter) + self-service portal
  - `P5-03.2` · BE · S `[mig]` · deps P5-03.1 — idempotent webhook processing → entitlement updates (+ webhook-event dedupe store)
  - `P5-03.3` · BE · S · deps P5-03.2 — seat add/remove (floor=member count) + VAT + deletion-block (active paid billing owner)

### P5-04 — Downgrade overflow (archive + restore) — BE · Lane S
- **Doc Ref:** spec §12.5; def §5
- **Acceptance Criteria:** downgrade to Free at period-end + grace (def §5); over-cap bookmarks archived (hidden from lists/search/counts/slug/dashboard, preserved) per deterministic rule (def §5); creation blocked while at/over cap; re-upgrade restores up to new cap.
- **Tests:** integration: downgrade archives correct set; re-upgrade restores; archived excluded everywhere.
- **Deps:** P5-03, P3-08 · **Status:** [ ]
- **Sub-tasks:**
  - `P5-04.1` · BE · S · deps P5-03, P3-08 — downgrade-at-period-end + grace + deterministic archive selection
  - `P5-04.2` · BE · S · deps P5-04.1 — archived hidden everywhere + creation blocked at cap
  - `P5-04.3` · BE · S · deps P5-04.2 — re-upgrade restores up to new cap

### P5-05 — Plans & billing UI — FE · Lane P
- **Doc Ref:** spec §12; proto (`SettingsBilling.jsx`); §23.4; rule `10`,`11`
- **Acceptance Criteria:** plan table, supporter offer, cancel/downgrade, seat management, invoices; config-driven prices; "Personal" not "Pro"; no folder cap / no custom-domain entitlement.
- **Tests:** component: plan table from config; upgrade/cancel (mocked).
- **Deps:** P5-03 · **Status:** [ ] · **Sub-tasks:** none (atomic leaf).

### P5-06 — Aggregate-stats endpoint (secret-protected) — BE · Lane P
- **Doc Ref:** spec §10.2, §18; rule `05`
- **Acceptance Criteria:** shared-secret-protected aggregate operational stats endpoint (hosted operator observability); no PII; secret via Infisical.
- **Tests:** integration: rejects without secret; returns aggregates with it.
- **Deps:** P1-03 · **Status:** [ ] · **Sub-tasks:** none (atomic leaf; independent — may schedule earlier).

---

## P6 — Marketing, i18n completeness, deploy, polish · Epic · Domain Ops

> **Batch plan:** Independent floaters after P1-03: `{P6-01, P6-05, P6-09, P5-06}`. Chain `P6-01 → P6-02 → P6-03`. Parallel FE: `{P6-04, P6-06, P6-08}` after their deps. Tail S (cross-cutting + deploy): `P6-07 → P6-10 → P6-11`.

### P6-01 — Challenge interface (Turnstile + no-op) — BE · Lane P
- **Doc Ref:** spec §11.8, §2.3
- **Acceptance Criteria:** `CHALLENGE` interface (verify token, dev-skip); Turnstile impl (hosted) + no-op (self-host default).
- **Tests:** unit: no-op passes in dev; Turnstile verify (mocked).
- **Deps:** P1-03 · **Status:** [ ] · **Sub-tasks:** none (atomic leaf).

### P6-02 — Contact endpoint (behind challenge + mail) — BE · Lane P
- **Doc Ref:** spec §2.3, §11.1, §11.8
- **Acceptance Criteria:** public contact endpoint validates challenge token, rate-limited (def §4), sends via `MAIL`.
- **Tests:** integration: rejects bad challenge; sends on valid.
- **Deps:** P6-01, P2-03 · **Status:** [ ] · **Sub-tasks:** none (atomic leaf).

### P6-03 — Marketing site (Astro): landing, pricing, contact, legal — Ops/FE · Lane mixed
- **Doc Ref:** spec §2.3, §23.2 (`marketing/*`); §23.4; rule `10`,`11`
- **Acceptance Criteria:** Astro static site; landing, pricing (config-driven, "Personal"), contact form + Turnstile wired to P6-02, legal (Impressum/AGB/Datenschutz with correct subprocessors: Fly/Neon/Cloudflare); en+de via Tolgee; separately built.
- **Tests:** build succeeds; contact form posts to endpoint; Lighthouse smoke.
- **Deps:** P6-02 · **Status:** [ ]
- **Sub-tasks:**
  - `P6-03.1` · FE · S · deps P1-01, P6-02 — Astro scaffold + shared layout + landing + Tolgee wiring (en+de)
  - `P6-03.2` · FE · P · deps P6-03.1 — pricing (config-driven, "Personal") + legal pages (subprocessors)
  - `P6-03.3` · FE · P · deps P6-03.1 — contact form + Turnstile wired to P6-02

### P6-04 — Analytics interface + consent/cookie mechanism — mixed · Lane P
- **Doc Ref:** spec §11.6, §18
- **Acceptance Criteria:** `ANALYTICS` interface (event record, no-op default); consent/cookie banner gating on hosted; self-host off.
- **Tests:** unit: no-op when no consent/unconfigured; records when consented.
- **Deps:** P3-12 · **Status:** [ ] · **Sub-tasks:** none (atomic leaf).

### P6-05 — Error-reporting interface — BE · Lane P
- **Doc Ref:** spec §11.7, §18
- **Acceptance Criteria:** `ERROR_REPORTING` interface (capture, no-op default); consent/PII-aware; self-host off; hosted operator-configured; source maps on prod build (if token set).
- **Tests:** unit: no-op unconfigured; capture invoked when configured (mocked).
- **Deps:** P1-03 · **Status:** [ ] · **Sub-tasks:** none (atomic leaf).

### P6-06 — Settings shells (account, workspace SMTP/AI/OIDC) — FE · Lane P
- **Doc Ref:** spec §10.1, §15; proto (`SettingsAccount.jsx`,`SettingsWorkspace.jsx`); §23.4; rule `10`,`11`
- **Acceptance Criteria:** account settings (profile, password, MFA, API tokens, prefs incl. AI opt-out, language, theme, accent); workspace settings (general, SMTP, AI, OIDC) with hosted/self-host panel visibility driven by config/interface selection (not deployment-mode); no workspace-identifier-in-URL field.
- **Tests:** component: panel visibility by config; settings persist.
- **Deps:** P2-16, P2-14, P3-14 · **Status:** [ ]
- **Sub-tasks:**
  - `P6-06.1` · FE · P · deps P2-16, P2-06, P2-07 — account settings (profile/password/MFA/API tokens/prefs/language/theme/accent)
  - `P6-06.2` · FE · P · deps P2-14, P3-14, P2-03 — workspace settings (general/SMTP/AI/OIDC) panel visibility by config/interface

### P6-07 — i18n completeness + Tolgee CI check — FE/Infra · Lane S
- **Doc Ref:** spec §17, §22.6; rule `10`
- **Acceptance Criteria:** all UI strings in Tolgee en+de; language resolution (user→Accept-Language→en); `tolgee pull --check` fails build on missing default-locale key; AI output-language honored.
- **Tests:** CI: translation check passes; no hard-coded UI strings (rg checks).
- **Deps:** P3-13, P4-03, P5-05, P6-03 · **Status:** [ ]
- **Sub-tasks:**
  - `P6-07.1` · FE · P · deps P3-13, P4-03, P5-05, P6-03 — audit/extract all strings → Tolgee en+de + language resolution
  - `P6-07.2` · Infra · S · deps P6-07.1, P1-09 — `tolgee pull --check` build gate + rg hard-coded-string CI checks

### P6-08 — Error pages + UX polish (skeletons, empty states, toasts, confirmations) — FE · Lane P
- **Doc Ref:** spec §18, §23.3; proto (`EdgePages.jsx`,`EdgeStates.html`); rule `11`
- **Acceptance Criteria:** 404/403/500 (app + marketing); loading skeletons, empty states, toasts, destructive-action confirmations as baseline; accessible + keyboard-friendly.
- **Tests:** component: error pages; a11y smoke on key screens.
- **Deps:** P3-12 · **Status:** [ ]
- **Sub-tasks:**
  - `P6-08.1` · FE · P · deps P3-12, P6-03.1 — 404/403/500 pages (app + marketing)
  - `P6-08.2` · FE · P · deps P3-12 — skeletons/empty states/toasts/destructive confirmations + a11y baseline

### P6-09 — OpenAPI publish + optional interactive docs — BE · Lane P
- **Doc Ref:** spec §18; eng §5
- **Acceptance Criteria:** OpenAPI document published; optional interactive docs that can be disabled by config.
- **Tests:** integration: OpenAPI served; docs toggle works.
- **Deps:** P1-02 · **Status:** [ ] · **Sub-tasks:** none (atomic leaf).

### P6-10 — Staging deploy pipeline (Fly + Workers + migration + smoke) — Infra · Lane S
- **Doc Ref:** spec §22.5, §14.7; eng §10
- **Acceptance Criteria:** push-`staging` pipeline: parallel API + web/marketing builds w/ staging secrets; DB migration; deploy `slugbase-staging-api` (Fly, scale-to-zero) + `slugbase-staging-web`/`-marketing` (Workers, retry); `/health`+`/version` smoke; GitHub Deployment records.
- **Tests:** workflow validates; staging deploy succeeds + smoke green.
- **Deps:** P1-10, P6-03 · **Status:** [ ]
- **Sub-tasks:**
  - `P6-10.1` · Infra · S · deps P1-10, P1-09 — push-staging: parallel builds w/ staging secrets + DB migration step
  - `P6-10.2` · Infra · S · deps P6-10.1, P6-03 — deploy Fly (`slugbase-staging-api`, scale-to-zero) + Workers (`-web`/`-marketing`) + smoke + Deployment records

### P6-11 — Prepare release + production deploy + GHCR image — Infra · Lane S
- **Doc Ref:** spec §22.6–22.8; eng §10
- **Acceptance Criteria:** push-`main` prepare-release (version-bump check, translations check, changelog, draft release); release-published production deploy (idempotent via `DEPLOYED_VERSION`, `slugbase-production-*`, migration on Neon, smoke); combined self-host image pushed to GHCR `vX.Y.Z`+`latest`.
- **Tests:** workflow validates; dry-run/idempotency check; image builds + pushes.
- **Deps:** P6-10 · **Status:** [ ]
- **Sub-tasks:**
  - `P6-11.1` · Infra · S · deps P6-10 — push-main prepare-release (version/translations check, changelog, draft release)
  - `P6-11.2` · Infra · S · deps P6-11.1 — release-published prod deploy (idempotent, `slugbase-production-*`, Neon migration, smoke)
  - `P6-11.3` · Infra · S · deps P6-11.1 — combined self-host image → GHCR `vX.Y.Z` + `latest`

---

## Jira field mapping

When converting to project **SB** (`mdg-labs.atlassian.net`), populate fields as below. Source of truth for IDs: `.cursor/skills/orchestrator/jira-board.md`. Created via the `jira-intake` skill (descriptions from `jira-intake/templates.md`, summaries from `jira-triage/summary-patterns.md`). Issues are created in **Backlog**, then intake transitions Epic + leaves to **Ready**.

### Common fields (all issue types)

| Field | Jira key | Value |
|---|---|---|
| Project | `project` | `SB` |
| Domain | `customfield_10081` | `Frontend` `10092` / `Backend` `10093` / `Infrastructure` `10094` / `Operations` `10095` — from the `BE/FE/Infra/Ops` tag |
| Roadmap ID | `customfield_10082` | the roadmap ID (`P3-07` for a Story, `P3-07.2` for a Sub-task) |
| Legacy Key | `customfield_10083` | empty (greenfield) |
| Fix version | `fixVersions` | per phase table (P1–P4 = `MVP Alpha` `10035`; P5–P6 = `Public Launch v1.0.0` `10037`) |
| Status | workflow | create in **Backlog** → intake → **Ready** |

### Per issue type

| Aspect | **Epic** (Phase) | **Story** (roadmap task) | **Sub-task** (decomposition) |
|---|---|---|---|
| `issuetype` | Epic | Story | Sub-task |
| `summary` | Phase theme, e.g. `Bookmarks, slugs, search & AI` | imperative task title, e.g. `Resolve & forward slugs via /go with disambiguation` | scope line, e.g. `Add /go resolution + single-match redirect` |
| `parent` | — | the Epic key (P-phase) | the Story key |
| `description` | Epic template (background, subtask table, goal, epic-level product rules, **suggested implementation order** = the Batch plan) | Backend/Frontend subtask template (spec refs, schema, endpoints/routes, AC, files, tests) | short scope + AC checklist + `[mig]` note when applicable |
| Domain | owning domain (P1 Infra, P2–P5 Backend, P6 Operations) | the task's `BE/FE/Infra/Ops` tag | the sub-task's tag (may differ from Story) |
| `priority` | High | High for spine/foundation; Medium for parallel feature leaves; Low for polish (see rule below) | inherit Story; `[mig]` + spine sub-tasks = High |
| Roadmap ID | the phase, e.g. `P3` | `P3-07` | `P3-07.2` |
| Dependencies | — | `createIssueLink` **"depends on"** (link type — outward, Jira id `10006`) per the Story's **Deps** | same, per the Sub-task's `deps` |
| `labels` | `phase-3` | domain/topic labels: `i18n` (any UI-string task), `security` (auth/crypto/SSRF/csrf), `migration` (`[mig]`), `infra`, `billing` | inherit + `migration` on `[mig]` |

### Priority rule (keeps the Ready queue ordered for the orchestrator)

- **High** — P1 (all), and each phase's serial **spine** Stories (`P2-01/02/08/09/10/11/12`, `P3-01/04/07`, `P4-02`, `P5-01/02/03/04`, `P6-10/11`) + every `[mig]` sub-task.
- **Medium** — parallel feature leaves (most Lane P Stories/Sub-tasks).
- **Low** — polish/optional (`P6-04/05/08/09`, docs).

The orchestrator's Ready JQL is `project = "SB" AND status = "Ready" ORDER BY priority DESC`, so priority + `depends on` links together drive batch selection.

### Dependency links

Create one `depends on` link per entry in a task's **Deps** / sub-task `deps` (outward = "this depends on that"; inward shows as "is required by"). The orchestrator queries prerequisites with `issue in linkedIssues("SB-N", "depends on")` and only batches a leaf once its prerequisites are **Done**. Intra-Story sub-task ordering (`.1 → .2 → .3`) is also expressed as `depends on` links so a verifier-blocked `.1` halts its dependents.

### Worked example — Epic P3 → Story P3-07 → its sub-tasks

```
Epic  SB-X  "Bookmarks, slugs, search & AI"
  issuetype=Epic · Domain=Backend · Roadmap ID=P3 · fixVersion=MVP Alpha · priority=High
  description: Epic template; Suggested implementation order = P3 Batch plan
  Story SB-Y  "Resolve & forward slugs via /go with disambiguation"
    issuetype=Story · parent=SB-X · Domain=Backend · Roadmap ID=P3-07
    fixVersion=MVP Alpha · priority=High · labels=[security]
    depends on: SB(P3-01)
    Sub-task SB-Y1  "Add slug validation + uniqueness + go_preference schema"
      parent=SB-Y · Domain=Backend · Roadmap ID=P3-07.1 · priority=High · labels=[migration,security]
      depends on: SB(P3-01.1)
    Sub-task SB-Y2  "Add /go resolution + single-match redirect (async usage)"
      parent=SB-Y · Domain=Backend · Roadmap ID=P3-07.2 · priority=High
      depends on: SB-Y1
    Sub-task SB-Y3  "Add multi-match disambiguation + go-preference store"
      parent=SB-Y · Domain=Backend · Roadmap ID=P3-07.3 · priority=Medium
      depends on: SB-Y2
```

---

## Open follow-ups (not v1 tasks)

- Per-surface Infisical CI identities (hardening; eng §12).
- `schema-reference.md` / `api-design.md` grow incrementally alongside P1–P5 domain tasks (eng §12).
- Fast-Follow items per spec §20 (operator console, soft-delete, additional provider impls, etc.).
