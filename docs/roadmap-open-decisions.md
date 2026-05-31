# SlugBase — Open Decisions Before Roadmap Work

**Status:** ✅ **Resolved 2026-05-31** — all decisions accepted as recommended, with these specifics:
- **D-03:** Drizzle ORM + a thin in-house SQLite/Postgres dialect layer (SQLite stays a first-class self-host option).
- **D-19:** AI provider = **OpenAI** (v1).
- **D-20:** phase skeleton = the recommended P1 foundation → P2 auth/tenancy → P3 bookmarks/slugs → P4 sharing/teams → P5 billing/entitlements → P6 marketing/i18n/polish.
- **D-21:** P1 exits on the foundation vertical slice (monorepo scaffold + CI gate + health/version + DB abstraction + one engine).
- **All other D-NN:** accepted as recommended.

The stack/architecture decisions are now folded into `slugbase-mvp-spec.md` (§19 + decisions #37–#50). This worksheet is retained only until the durable companion docs (D-15) are written, then deleted.

---

**Original framing (for reference):** Draft — awaiting decisions. Nothing here is settled until you confirm each item.
**Purpose:** Capture every decision that must be made *before* a development roadmap can be drafted and executed, and pair each one with a recommended answer fitted to the existing product spec (`slugbase-mvp-spec.md`). You confirm or override each `D-NN`; confirmed answers then flow into the permanent companion docs (§E) and the roadmap.

> This doc is a **decision worksheet**, not a spec. Once decisions are locked, the durable content moves into `engineering-decisions.md`, `schema-reference.md`, `api-design.md`, and `defaults-and-constants.md`, and **this file is deleted**.

---

## 0. What the roadmap is for (the end goal)

The roadmap is **not** a human reading guide — it is a **machine-executable work plan** consumed by the Cursor **orchestrator skill** (`.cursor/skills/orchestrator/SKILL.md`):

1. **Drafted** as `docs/slugbase-development-roadmap.md` — a phased list of tasks, each with a Doc Ref (spec section), concrete acceptance criteria, tests, and dependencies.
2. **Verified** — the draft is reviewed for completeness, correct ordering, and testability before any code is written.
3. **Converted to Jira** — phases become **Epics**, tasks become **Stories/Tasks/Sub-tasks** on the **SB** project (via the `jira-intake` skill). After conversion, **Jira becomes the execution source of truth**; the roadmap markdown is archived/retired.
4. **Executed autonomously** — the orchestrator dispatches sub-agents per task (Doc Refs, not pasted spec), a verifier checks each one, and Jira/checkboxes advance through the `[ ] → [~] → [x]` lifecycle.

**Implication for drafting (important):** because tasks become Jira issues and each task = **one implementation commit** (rule `01-git-workflow`), tasks must be **commit-sized, independently verifiable, and dependency-ordered**. Every task needs a testable acceptance criterion the verifier can run — which is impossible until the stack and contracts below are decided. That is the entire reason this doc exists.

---

## How to read each decision

Each decision has: **Question**, **Recommendation** (my best-practice pick), **Why** (rationale + spec anchor), and **Status**. Reply with the `D-NN` id to accept (`✅`), override (give your choice), or defer.

---

## A. Foundational stack decisions (the hard blockers)

These are the items the spec deliberately left as "framework/ORM TBD." Nothing concrete can be scaffolded or tested without them.

### D-01 — Language
- **Question:** Confirm TypeScript across all packages?
- **Recommendation:** **TypeScript, strict mode, no `any`.**
- **Why:** Already assumed by the rules (`02-orchestrator` universal AC: "TypeScript strict, no `any`"). Shared types across backend/web/contracts (§19) need it.
- **Status:** Recommended — awaiting confirmation.

### D-02 — Backend framework
- **Question:** What framework powers the API/back-end?
- **Recommendation:** **NestJS.**
- **Why:** The spec's whole architecture is "everything external behind a swappable interface selected by config" (§2.6, §11). NestJS's module + dependency-injection system maps 1:1 to that: each interface (mail, AI, billing, auth-provider, challenge, analytics, error-reporting, fetch, crypto, db) becomes an injectable token with a config-selected provider — no `if (isCloud)` branching. Built-in guards/interceptors cleanly host CSRF, session-auth, tenant-resolution, and entitlement checks (§4.3, §5.8, §12.4); `@nestjs/swagger` satisfies the OpenAPI requirement (§18). Runs as a normal Node container on Fly.io (§14.7).
- **Alternatives:** Fastify + manual DI (lighter, more wiring); not recommended given how central the interface-swapping pattern is.
- **Status:** Recommended — awaiting confirmation.

### D-03 — Data-access layer / ORM
- **Question:** What ORM/query layer backs the persistence interface (§11.9), given **two engines on an identical schema + forward-only migrations** (decision #26): embedded file-based (SQLite, self-host default) **and** Neon Postgres (hosted)?
- **Recommendation:** **Drizzle ORM**, wrapped behind the spec's data-access abstraction (repository interfaces), with **Drizzle Kit** for forward-only migrations.
- **Why:** TS-native, lightweight, first-class SQLite (`better-sqlite3`/libSQL) **and** Postgres (Neon) — exactly the two engines the spec mandates. Keeps the embedded zero-dependency single-file DB that is "a deliberate self-hosting selling point" (§11.9, §14.1).
- **⚠️ Sub-decision D-03a:** SQLite and Postgres dialects are **not byte-identical** (column types, defaults). "Identical schema/migration story" is realistically met at the **logical/abstraction** level, not a single literal dialect. Recommendation: one logical schema + a thin dialect mapping in the data-access layer; CI runs the full suite against **both** engines.
- **Alternative:** **Prisma** — more mature migrations & DX, but multi-provider single-schema + identical migration history is weaker (provider is pinned per migration set), and the embedded story is less clean. Drizzle fits the spec's constraints better.
- **Status:** Recommended — **needs your explicit call** (highest-impact decision).

### D-04 — Web client framework
- **Question:** What framework for the signed-in web app, given it deploys to **Cloudflare Workers (SSR + static, edge)** on hosted (§14.7) **and** must be bundled & served by the API inside the **combined self-host container** (§14.2)?
- **Recommendation:** **React Router v7 (framework mode, ex-Remix).**
- **Why:** Carries the prototype's React design language (§23); runs **natively on Cloudflare Workers** (web-standard `Request`/`Response`, ideal for HTTP-only session cookies §5.3) **and** has a Node adapter so the *same* app runs inside the self-host container — one codebase, two adapters, matching "same code path, different config" (§1, §15). Avoids the OpenNext/Next-on-Workers shim.
- **Alternative:** **Next.js via `@opennextjs/cloudflare`** if you prefer the Next ecosystem (heavier, more adapter complexity).
- **Status:** Recommended — awaiting confirmation.

### D-05 — Marketing site framework
- **Question:** Framework for the separate static marketing site (§2.3, §23.2), deployed to Cloudflare Workers, separately built (decision #28)?
- **Recommendation:** **Astro.**
- **Why:** Purpose-built for static/content sites, ships zero JS by default (best Lighthouse), trivial CF Workers deploy, cleanly separate build from the app. Contact form posts to the app's public endpoint behind Turnstile (§11.8). Tolgee-driven copy for EN/DE (§17).
- **Alternative:** Reuse React Router v7 in prerender/static mode (one less framework to learn, slightly heavier output).
- **Status:** Recommended — awaiting confirmation.

### D-06 — Styling & UI primitives
- **Question:** Styling system and component primitives for the shared UI package?
- **Recommendation:** **Tailwind CSS** with CSS-variable tokens bridged from `docs/design-prototype/V1/colors_and_type.css` + **Radix UI** primitives + **cmdk** for the command palette.
- **Why:** The prototype already defines tokens as CSS custom properties (dark-first, periwinkle, IBM Plex Sans/Mono — §23.1); Tailwind consumes those variables so components "consume token variables, never hard-coded hex" (rule `11-design-system`). Radix gives accessible, keyboard-first primitives (§18); `cmdk` directly realises the `⌘K` palette + `go` mode (§9, §23.3).
- **Status:** Recommended — awaiting confirmation.

### D-07 — Validation & shared API contracts
- **Question:** How are request/response shapes validated and shared between client and server, and how is OpenAPI generated (§18)?
- **Recommendation:** **Zod** for all validation (DTOs **and** env schema), exposed as **ts-rest** contracts in the `shared-types` package; OpenAPI generated from the contracts.
- **Why:** The env rules already show Zod (`05-env-vars`: `z.string().min(32)`), so Zod is effectively in. ts-rest gives a single typed REST contract consumed by both NestJS and the web client, auto-generates OpenAPI (§18), and eliminates client/server drift — strong fit for "shared types/contracts package" (§19). Server-side validation that "rejects unknown/extra fields" (rule `03-security-baseline`) is native to Zod `.strict()`.
- **Alternative:** Plain Zod schemas + `@nestjs/swagger` decorators (simpler, but more drift risk). ts-rest is the best-practice pick.
- **Status:** Recommended — awaiting confirmation.

### D-08 — Test stack
- **Question:** Unit / integration / e2e test runners (CI gate `06-local-ci`, §22.3–22.4)?
- **Recommendation:** **Vitest** (unit + integration) + **Supertest** (API integration) + **Playwright** (e2e — already decided §22.4).
- **Why:** Vitest is the de-facto TS monorepo runner (fast, ESM-native, Turborepo-friendly). Playwright is already fixed by the spec. This pins the currently-placeholder CI commands (`pnpm test:unit`, `pnpm test:integration`).
- **Status:** Recommended — awaiting confirmation.

### D-09 — Monorepo build orchestration
- **Question:** Task runner/caching across the pnpm workspace?
- **Recommendation:** **Turborepo** (`turbo.json`).
- **Why:** Rule `06-local-ci` already references `turbo.json (if present)`. Gives cached `lint/typecheck/test/build` pipelines and correct cross-package ordering — meaningfully speeds the CI gate and the orchestrator's per-task verification.
- **Status:** Recommended — awaiting confirmation.

---

## B. Cross-cutting implementation decisions

### D-10 — Session store backing
- **Question:** Where do server-side sessions live (§5.3)?
- **Recommendation:** **Database-backed session store** (a `sessions` table via the data-access abstraction) — **no Redis in v1.**
- **Why:** A bare self-host install must run "with zero external services configured" (§2.6, §14.5). Adding Redis breaks that. DB-backed sessions work identically on both engines, give immediate revocation + "log out everywhere" (§5.3), and store the active-workspace selection (§4.3).
- **Status:** Recommended — awaiting confirmation.

### D-11 — Security primitives
- **Question:** Password hashing, MFA, CSRF mechanism?
- **Recommendation:** **argon2id** (passwords); **otplib** + **qrcode** (TOTP/MFA §5.7); **double-submit CSRF token** with the spec's exempt allowlist (§5.8).
- **Why:** Argon2id is the current OWASP-recommended adaptive hash ("strong adaptive hashing" §5.4). otplib is the standard TOTP lib. Double-submit token fits a stateless-per-request CSRF check over server-side sessions.
- **Status:** Recommended — awaiting confirmation.

### D-12 — Background work
- **Question:** How is async work (usage tracking, billing-event processing, metadata fetch) handled, given the spec says "no separate worker process" (§22.10)?
- **Recommendation:** **In-process async** within the API (fire-and-forget tasks + a lightweight in-process queue). No external broker.
- **Why:** Spec explicitly states background work is handled within the API process (§22.10); usage tracking is "asynchronous and never blocks the redirect" (§6.3, §8.2). Keeps self-host single-process.
- **Status:** Recommended — awaiting confirmation.

---

## C. Package layout

### D-13 — Workspace package boundaries & names
- **Question:** Confirm the concrete package list and names (§19 leaves this to the roadmap). **Note a naming inconsistency to resolve:** rule `04-naming` uses `packages/web/`, while rule `10-i18n` references `packages/web-client/`.
- **Recommendation:**
  ```
  packages/
    backend/         # NestJS API + all interface implementations
    web/             # React Router v7 signed-in app
    marketing/       # Astro static marketing site
    shared-types/    # Zod + ts-rest contracts, interface contracts, OpenAPI types
    ui/              # shared components + design tokens
  docs/              # customer/operator docs + internal engineering section
  ```
  Standardise on **`packages/web`** (update the `10-i18n` rule's `web-client` references to match).
- **Why:** Matches §19's conceptual members and the naming-rule examples; one canonical web-package name avoids verifier ambiguity.
- **Status:** Recommended — awaiting confirmation (and confirm the rule fix).

---

## D. Pinned defaults & constants

The spec leaves ~15 values as "config-adjacent / confirmable later." Agents need concrete starting values or they will each invent their own. **All remain configurable; these are just the committed defaults** → destined for `defaults-and-constants.md`.

| ID | Constant | Recommended default | Spec ref |
|---|---|---|---|
| D-14a | Slug grammar | `^[a-z0-9][a-z0-9-]{0,63}$` (lowercase, hyphen, ≤64) | §8.1 |
| D-14b | Reserved slugs / paths | `go`, `api`, `auth`, `health`, `version`, `login`, `logout` | §8.2 |
| D-14c | Free bookmark cap | **50 / workspace** (already decided #14) | §12.1 |
| D-14d | Workspaces per Free account | **1** (already decided #30) | §12.2 |
| D-14e | Max API tokens / user | **10** | §5.3 |
| D-14f | Session TTL | **30 days**, rolling/sliding | §5.3 |
| D-14g | MFA backup codes | **10** codes, single-use | §5.7 |
| D-14h | Password policy | **min 12 chars**, no forced composition, strength meter | §5.4 |
| D-14i | Rate limits | login 10/min, registration 5/h, reset 5/h, token-create 20/h (per IP+account) | §18 |
| D-14j | Import cap | **5,000** bookmarks/request; Netscape HTML ≤ **5 MB** | §13 |
| D-14k | Pagination | default **24**, options 24/48/96, max 100 | §6.5 |
| D-14l | Metadata/favicon cache TTL | **7 days** | §6.4 |
| D-14m | AI suggestion cache TTL | **30 days** | §11.2 |
| D-14n | Downgrade grace period | **7 days** after period end | §12.5 |
| D-14o | Downgrade archive-selection rule | keep most-recently-**accessed** (tiebreak: most-recently-created) up to cap; archive remainder | §12.5 |
| D-14p | Team base seats | **5** (illustrative; flagged Fast-Follow tuning #17) | §12.2 |

- **Status:** Recommended as a block — flag any value you want changed.

---

## E. Companion docs to produce before/with the roadmap

### D-15 — Which durable docs get written from these decisions
- **Recommendation:** Produce, in this order, once stack is locked:
  1. `docs/engineering-decisions.md` — the confirmed A/B/C choices + **final CI gate commands** (replacing the placeholders in `06-local-ci`).
  2. `docs/schema-reference.md` — concrete tables/columns/indexes/enums for the single forward-only migration history (§16, #25).
  3. `docs/api-design.md` — REST endpoint inventory (method, path, request/response) → seeds the ts-rest/OpenAPI contracts (§18).
  4. `docs/defaults-and-constants.md` — the D-14 table.
  5. `docs/slugbase-development-roadmap.md` — the phased task plan (the actual deliverable).
- **Why:** These are exactly the docs `00-project.mdc` says are "to be added alongside the roadmap." The roadmap can't have runnable `Tests` / unambiguous `Doc Ref`s without 1–4.
- **Status:** Recommended — awaiting confirmation.

---

## F. Roadmap structure & Jira conversion

Because the roadmap → Jira, its shape must map cleanly onto the SB board.

### D-16 — Roadmap → Jira mapping
- **Recommendation:**
  - **Phase → Epic.** **Task → Story/Task.** Decomposed work → **Sub-task**.
  - Task ID scheme **`P<phase>-<seq>`** in the roadmap (e.g. `P1-03`), mirrored to **`SB-N`** after Jira creation (rules `01`/`07` already use both).
  - Each task = **one implementation commit** (commit-sized scope).
  - The acceptance criteria + Tests become the Jira issue's description/AC checklist; Doc Ref becomes a spec link.
- **Status:** Recommended — awaiting confirmation.

### D-17 — Roadmap row schema
- **Recommendation:** Each task row carries: `Task ID | Title | Doc Ref | Acceptance Criteria | Tests | Dependencies | Lane (S/P) | Status`.
- **Why:** This is the minimum the orchestrator + verifier need per task (`02-orchestrator`, SKILL.md). `Dependencies` enables correct ordering/parallel batches; `Lane` marks serial vs parallel-worktree execution.
- **Status:** Recommended — awaiting confirmation.

### D-18 — Execution source of truth after conversion
- **Question:** Once converted to Jira, is Jira or the markdown the source of truth during autonomous execution?
- **Recommendation:** **Jira board is the source of truth** post-conversion; the roadmap markdown is archived (kept only as the human-readable phase map). The orchestrator runs in its Jira-board mode.
- **Why:** You stated the roadmap doc is temporary; the orchestrator skill supports reading the SB board directly, and commit linking (`07-jira-commit-linking`) assumes `SB-N` keys.
- **Status:** Recommended — awaiting confirmation.

---

## G. Items genuinely needing *your* input (no safe default)

These aren't best-practice calls — they're product/ops choices only you can make:

- **D-19 — AI provider:** Which single v1 AI provider sits behind the AI interface (§11.2)? (e.g. OpenAI, Anthropic, a self-hostable model.) Affects the self-host "bring your own key" UX and the hosted operator credential.
- **D-20 — Phasing granularity / first milestone:** Do you want the roadmap phased as **(P1 foundation → P2 auth/tenancy → P3 bookmarks/slugs → P4 sharing/teams → P5 billing/entitlements → P6 marketing/i18n/polish)**, or a different cut? Confirming a phase skeleton lets me order dependencies.
- **D-21 — Initial scope of the very first executable batch:** smallest end-to-end vertical slice (monorepo scaffold + CI gate + health/version + DB abstraction + one engine) before feature work — confirm this is the intended P1 exit.

---

## Next step

Reply per `D-NN` (accept / override / defer). Once A–G are settled, I'll write `engineering-decisions.md` first (it unblocks everything), then the schema/api/defaults docs, then draft the roadmap itself.
