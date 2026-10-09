# SlugBase — Decided Questions

Every question raised while writing docs 00–12 is **decided** (2026-10-08). A decision is either the maintainer's answer or the recommended default, adopted as it stands; the working record of that review is kept with the Cloud documentation. Reopening a decision needs a new reason, not a new preference — edit its entry here and the sections it lists under **Affects**, nothing else. Decisions that change the architecture are also promoted to the decision log (doc 00 §5, D24–D28).

**Some questions concern only SlugBase Cloud** (its infrastructure, billing, prices and legal texts). They are recorded in the Cloud documentation. Their numbers stay here, in the index and as one-line stubs, so every citation still resolves. Where a question has a general half and a Cloud half, this document keeps the general half.

Numbers are stable: Q1–Q19 come from docs 00–01, Q20–Q39 from 02–03, Q40–Q59 from 04–05, Q60–Q79 from 06, 07 and 11, Q80–Q99 from 08–10 and 12. Unused numbers stay free; numbers are never reused.

### Status legend

| Status | Meaning |
|---|---|
| **Decided (maintainer)** | The maintainer answered; the docs follow that answer. |
| **Decided (default)** | The recommended default was adopted unchanged. |
| **Cloud — recorded in the Cloud documentation** | The question concerns only SlugBase Cloud; its decision is kept there. |
| **Settled → Dn** | Also promoted to the decision log in doc 00 §5. |
| **Merged → Qn** | Folded into another entry; kept only so its number resolves. |
| **Pending external** | Decided, but something outside the project is still awaited (a DPA, a lawyer); the entry says what. |

**Due** is the roadmap phase (doc 12) by which the decision must be implemented or the external item resolved.

---

## Index

### Needed for Phase 0

| Q | Decision | Status |
|---|---|---|
| Q4 | `app.slugbase.app` for the Cloud application, `slugbase.app` for the website | Decided (default) |
| Q64 | Cloud plans and prices | Cloud — recorded in the Cloud documentation |
| Q87 | Cloud pre-launch call to action | Cloud — recorded in the Cloud documentation |
| Q72 | Cloud legal texts | Cloud — recorded in the Cloud documentation |
| Q79 | Cloud pre-launch mode and contact details | Cloud — recorded in the Cloud documentation |
| Q41 | Cloud contact form routing | Cloud — recorded in the Cloud documentation |
| Q46 | Cloud contact form storage | Cloud — recorded in the Cloud documentation |
| Q84 | Package registry for MDG Labs packages | Cloud — recorded in the Cloud documentation |
| Q88 | Cloud marketing site delivery | Cloud — recorded in the Cloud documentation |

### Entitlements and billing (Phase 5 unless noted)

| Q | Decision | Status |
|---|---|---|
| Q60 | Cloud tax treatment | Cloud — recorded in the Cloud documentation |
| Q65 | Cloud launch offer | Cloud — recorded in the Cloud documentation |
| Q73 | Cloud business customers | Cloud — recorded in the Cloud documentation |
| Q74 | Cloud billing record retention | Cloud — recorded in the Cloud documentation |
| Q61 | Cloud billing data location | Cloud — recorded in the Cloud documentation |
| Q62 | Cloud billing document numbering | Cloud — recorded in the Cloud documentation |
| Q63 | Cloud seat changes | Cloud — recorded in the Cloud documentation |
| Q67 | Cloud plan and payment changes | Cloud — recorded in the Cloud documentation |
| Q69 | `audience: 'machine'` routes; CE registers none | Decided (default) |
| Q70 | Per workspace — keep the `bookmarks.max` most-recently-accessed bookmarks across all members, tie-break by most recent `created_at`, then `id` | Decided (default) |
| Q71 | Members stay members | Decided (default) |
| Q82 | How Cloud consumes the billing service | Cloud — recorded in the Cloud documentation |

### Licensing and governance

| Q | Decision | Status |
|---|---|---|
| Q80 | DCO sign-off (`Signed-off-by:` via a `prepare-commit-msg` hook, `signoff.mode: hook`) plus a short contributor licence agreement (CLA Assistant)… | Decided (default) |
| Q1 | Merged into Q80 | Merged → Q80 |
| Q81 | A git submodule `ce/` pinned to a CE commit, built from source inside the Cloud pnpm workspace | Decided (default) |
| Q83 | GitHub Discussions on `mdg-labs/slugbase` for questions | Decided (default) |
| Q86 | Private vulnerability reporting or `support@slugbase.app`; 3 days / 30 days / +7 days | Decided (maintainer) |
| Q2 | A separate public repository `mdg-labs/slugbase-docs`, built with the `/customer-docs` skill, published at `docs.slugbase.app` | Decided (default) |
| Q89 | Deleted on 2026-10-08 (maintainer decision), without a deprecation period | Decided (maintainer) |

### External services

| Q | Decision | Status |
|---|---|---|
| Q8 | AI suggestions through the OpenAI-compatible adapter; the provider is configuration | Decided (maintainer) |
| Q9 | One generic SMTP adapter for every deployment | Decided (maintainer) |
| Q66 | Errors through `ErrorReportPort`; internal `/metrics` endpoint; no metrics stack required | Settled → D27 (maintainer) |

### Infrastructure and operations

| Q | Decision | Status |
|---|---|---|
| Q77 | Cloud server placement | Cloud — recorded in the Cloud documentation |
| Q75 | Runtime secrets from the environment, build/deploy secrets in CI, local `.env` | Settled → D24 (maintainer) |
| Q13 | Keys from the environment, rotated with key IDs | Settled → D24 (maintainer) |
| Q76 | CE migrates on startup; a managed deployment may run `migrate` as a separate step | Settled → D25 (maintainer) |
| Q78 | Cloud image promotion | Cloud — recorded in the Cloud documentation |
| Q68 | Cloud backups | Cloud — recorded in the Cloud documentation |
| Q14 | No Valkey until rate limiting measurably loads Postgres (`pg_stat_statements`) | Decided (default) |
| Q10 | No proxy at launch | Decided (default) |

### CE packaging

| Q | Decision | Status |
|---|---|---|
| Q3 | PostgreSQL 17 and 18 supported | Decided (default) |
| Q11 | Support `slugbase serve --with-worker` (worker loop in the server process) for the smallest installs | Decided (default) |
| Q12 | Built in the public CE repository's CI on GitHub-hosted runners and published to `ghcr.io/mdg-labs/slugbase` (public) | Decided (default) |
| Q17 | Build SBOM (SPDX) and SLSA provenance attestations with BuildKit for every image | Decided (default) |
| Q18 | None | Decided (default) |
| Q56 | CE takes two URLs — `DATABASE_URL` (`slugbase_app`) and `DATABASE_MIGRATE_URL` (`slugbase_migrator`) — and the published compose file provisions… | Decided (default) |

### Stack and process

| Q | Decision | Status |
|---|---|---|
| Q19 | Hono | Decided (default) |
| Q7 | Run the current Active LTS | Decided (default) |
| Q51 | Declarative SQL files under `packages/db/src/sql/` (policies, grants, `SECURITY DEFINER` functions, triggers), emitted into the generated… | Decided (default) · confirmed by the first code in Phase 1 |
| Q52 | CI rejects destructive or table-rewriting steps unless the PR carries `migration:contract` and the dropped object was unused in the previous release | Decided (default) |
| Q85 | Ladle | Decided (default) |

### Security

| Q | Decision | Status |
|---|---|---|
| Q5 | Origin + Fetch-Metadata checks on every cookie-authenticated mutation, JSON-only bodies, `SameSite=Lax` host-only cookie — no CSRF token and no… | Decided (default) |
| Q6 | Sliding 30 days | Decided (default) |
| Q15 | Check new passwords against a locally stored k-anonymity range dataset of breached-password hashes (no outbound request), refreshed per release | Decided (default) |
| Q16 | Two scopes at v1, `read` and `read-write` | Decided (default) |
| Q40 | A token is bound to the one workspace it was created in | Decided (default) |
| Q45 | `/instance/*` requires the calling account to have MFA enrolled | Decided (default) |
| Q47 | Tokens can be created with an expiry (30 / 90 / 365 days) or none | Decided (default) |
| Q48 | Password reset 1 hour, email change 1 hour, signup email verification 24 hours, invitations 7 days | Decided (default) |
| Q31 | An invitation token proves control of the email, so an account created through it is verified at once, even when `EMAIL_VERIFICATION_REQUIRED=true` | Decided (default) |
| Q32 | Automatic linking to an existing account only when the provider asserts `email_verified=true` for a matching email | Decided (default) |
| Q44 | The instance-admin routes are mounted on both editions | Decided (default) |

### Product behaviour

| Q | Decision | Status |
|---|---|---|
| Q25 | Resolution order is a remembered preference, then the member's own bookmark, then a single shared match, then disambiguation among shared matches | Decided (default) |
| Q26 | When a slug has no match in the active workspace but resolves in another of the member's workspaces, the not-found page names those workspaces and… | Decided (default) |
| Q43 | Not in v1 — anything after the slug is a 404 | Decided (default) |
| Q22 | Shares grant read and slug resolution only | Decided (default) |
| Q23 | The acting admin (or the leaving member) chooses between transferring the member's bookmarks and folders to another member and deleting them | Decided (default) |
| Q24 | Self-service and immediate, with typed confirmation and re-authentication | Decided (default) |
| Q54 | Bookmarks and folders the account created in workspaces with other members stay as ownerless workspace content ("Former member") | Decided (maintainer) |
| Q53 | 365 days on Cloud | Decided (maintainer) |
| Q55 | Workspace deletion marks the workspace `deleting` (a `deleting_at` column on `workspaces`, hidden from every query and the switcher) and a pg-boss… | Decided (default) |
| Q27 | If the member already owns a bookmark with the same canonical URL in this workspace, the modal warns and links to it | Decided (default) |
| Q28 | Per bookmark, keep an access count and the last-accessed timestamp only | Decided (default) |
| Q29 | SlugBase JSON (versioned, lossless, the backup format) plus Netscape HTML for re-import into browsers | Decided (default) |
| Q30 | Folders and tags are matched by name (case-insensitive) or created | Decided (default) |
| Q33 | Folders are flat | Decided (default) |
| Q34 | Bookmarks have an optional description (up to 1 000 characters, prefilled from page metadata, searchable) | Decided (default) |
| Q42 | Bookmark, folder and tag lists return an exact `total` up to 10 000 and `null` + `totalAtLeast: 10000` above | Decided (default) |
| Q49 | One `simple`-configuration `tsvector` (no stemming) plus `pg_trgm` on title and slug for prefix and typo tolerance | Decided (default) |
| Q50 | A plain table with time-ordered indexes until it passes ~50 M rows, then monthly range partitions on `created_at` (retention becomes `DROP PARTITION`) | Decided (default) |

### UI

| Q | Decision | Status |
|---|---|---|
| Q20 | A top-level `/forwarding` page that holds the browser search-engine setup, the member's own slugs (with inline forwarding toggles) and their… | Decided (default) |
| Q21 | A folder has an optional lucide icon from a curated set of about 60 icons, and a colour from eight folder tokens (`--folder-1` … `--folder-8`) | Decided (default) |
| Q35 | `system` (follow the OS), with dark as the primary designed theme and light at full parity | Decided (default) |
| Q36 | Six accent presets (periwinkle by default, plus five others from the token palette), each contrast-checked in both themes | Decided (default) |
| Q37 | No avatar uploads in v1 | Decided (default) |
| Q38 | Single-key shortcuts (`C`, `E`, `P`, `G …`) are on by default and can be disabled per account | Decided (default) |
| Q39 | Fully usable on a phone: auth, Home, Bookmarks, the bookmark modal, the palette and the `/go` pages | Decided (default) |

---

## Entries

## Needed for Phase 0

### Q4 — Cloud application hostname
**Status:** Decided (default) · **Due:** Phase 0 (DNS) · **Affects:** doc 00 §6, doc 01 §2.2, Cloud doc 07, Cloud doc 11

**Decision: `app.slugbase.app` for the Cloud application (SPA + API + `/go`); `slugbase.app` for the website.** Non-public environments are recorded in the Cloud documentation.
`cloud.slugbase.app` (the old forwarding host) reads as an edition name, not an app; `app.` is the convention users recognise. The browser search-engine URL is `https://app.slugbase.app/go/%s`. Changing it after launch breaks every user's search-engine entry, so it is fixed before the first public DNS record.

### Q64 — (Cloud) Cloud plans and prices
Recorded in the Cloud documentation.

### Q87 — (Cloud) Cloud pre-launch call to action
Recorded in the Cloud documentation.

### Q72 — (Cloud) Cloud legal texts
Recorded in the Cloud documentation.

### Q79 — (Cloud) Cloud pre-launch mode and contact details
Recorded in the Cloud documentation.

### Q41 — (Cloud) Cloud contact form routing
Recorded in the Cloud documentation.

### Q46 — (Cloud) Cloud contact form storage
Recorded in the Cloud documentation.

### Q84 — (Cloud) Package registry for MDG Labs packages
Recorded in the Cloud documentation.

### Q88 — (Cloud) Cloud marketing site delivery
Recorded in the Cloud documentation.

---

## Entitlements and billing (Phase 5 unless noted)

### Q60 — (Cloud) Cloud tax treatment
Recorded in the Cloud documentation.

### Q65 — (Cloud) Cloud launch offer
Recorded in the Cloud documentation.

### Q73 — (Cloud) Cloud business customers
Recorded in the Cloud documentation.

### Q74 — (Cloud) Cloud billing record retention
Recorded in the Cloud documentation.

### Q61 — (Cloud) Cloud billing data location
Recorded in the Cloud documentation.

### Q62 — (Cloud) Cloud billing document numbering
Recorded in the Cloud documentation.

### Q63 — (Cloud) Cloud seat changes
Recorded in the Cloud documentation.

### Q67 — (Cloud) Cloud plan and payment changes
Recorded in the Cloud documentation.

### Q69 — Machine routes and the Origin check
**Status:** Decided (default) · **Affects:** doc 01 §4 step 5, Cloud doc 06 §4.3, doc 10

**Decision: routes may declare `audience: 'machine'` at registration; such a route never reads the session cookie or a bearer token, is rate-limited, and the declaration is listed in the threat model's entry points.** CE registers no machine route. A composition may register one for a server-to-server callback that authenticates by signature, such as a billing service's signed event endpoint; Cloud's is recorded in the Cloud documentation.
Doc 01 has "no exemption list"; a server-to-server callback can't carry our Origin. Making the exemption a typed property of an unauthenticated route keeps it explicit, reviewable and impossible to combine with ambient credentials.

### Q70 — Scope of the archive selection rule
**Status:** Decided (default) · **Due:** before Cloud launch · **Affects:** Cloud doc 06 §5

**Decision: per workspace — keep the `bookmarks.max` most-recently-accessed bookmarks across all members, tie-break by most recent `created_at`, then `id`.**
The cap is per workspace, so the rule is too; a per-member fair-share split is more complex to explain and only matters for multi-member workspaces, which only exist on Team (and Team → Free is the rare path).

### Q71 — What a Team downgrade does to members, teams and shares
**Status:** Decided (default) · **Due:** before Cloud launch · **Affects:** Cloud doc 06 §5, doc 02 sharing

**Decision: members stay members; teams, sharing grants and audit history are kept but inert (hidden, not enforced as access) until Team is restored; pending invitations are revoked; owners/admins see a banner explaining exactly this.**
Nothing is destroyed (downgrades never destroy data) and re-upgrading restores the previous state. The open point is whether members other than the owner should lose access to the workspace entirely while it is on a single-seat plan; the default keeps their membership and own bookmarks, but the workspace counts against `seats.max = 1`, so new members can't join.

### Q82 — (Cloud) How Cloud consumes the billing service
Recorded in the Cloud documentation.

---

## Licensing and governance

### Q80 — Contribution terms for the public CE
**Status:** Decided (default) · **Due:** before the CE repository accepts its first outside pull request (Phase 1) · **Affects:** doc 09 §5.2 (`signoff`), doc 12 §4 R6, `CONTRIBUTING.md`, `.githooks/`

**Decision: DCO sign-off (`Signed-off-by:` via a `prepare-commit-msg` hook, `signoff.mode: hook`) plus a short contributor licence agreement (CLA Assistant) granting MDG Labs the right to also license contributions under other terms; no outside code is merged until it is in place.**
Unlike Hoserva (DCO, no CLA), SlugBase Cloud runs CE code inside a proprietary service. MDG Labs can do that with its own code, but an outside contribution licensed only under AGPL-3.0 would oblige the Cloud composition to be offered under AGPL too. A CLA (or relicensing grant) keeps the open-core model legally clean; DCO alone does not. Alternative: accept issues and discussion only, no outside code, until the question matters.

### Q1 — Contribution terms for the public CE repository
**Status:** Merged → Q80 · **Affects:** —

Superseded by Q80: Cloud runs CE code inside a proprietary service, so DCO alone is not enough. The entry stays only so its number keeps resolving.

### Q81 — How Cloud consumes CE
**Status:** Decided (default) · **Due:** Phase 1 · **Affects:** doc 09 §2.2, §3.2, doc 08 §6.3

**Decision: a git submodule `ce/` pinned to a CE commit, built from source inside the Cloud pnpm workspace; CE packages are not published to npm for Cloud's use.**
A submodule pins an exact commit per Cloud build with no release step in between and no registry dependency; CE contracts are still versioned through API Extractor reports. Publishing `@slugbase/*` to npm can be added later for third parties (e.g. `@slugbase/contracts` for API clients) without changing how Cloud builds.

### Q83 — Where CE support questions go
**Status:** Decided (default) · **Due:** Phase 1 · **Affects:** doc 09 §5.5, `.github/ISSUE_TEMPLATE/config.yml`

**Decision: GitHub Discussions on `mdg-labs/slugbase` for questions; issues only for bugs and feature requests through the templates; security reports through private vulnerability reporting.**
Keeps the issue tracker the plan (D21) instead of a support inbox; Discussions are searchable and public.

### Q86 — Vulnerability disclosure timeline
**Status:** Decided (maintainer) · **Due:** Phase 1 (`SECURITY.md`) · **Affects:** doc 10 §7

**Decision: reports go through GitHub private vulnerability reporting or `support@slugbase.app` (named in `SECURITY.md` and `/.well-known/security.txt`). Acknowledge within 3 working days, fix-target 30 days for Critical/High, publish the advisory 7 days after a patched CE image is available, credit reporters on request.**

### Q2 — Where user-facing documentation lives
**Status:** Decided (default) · **Due:** Phase 6 · **Affects:** doc 09 §2, doc 11

**Decision: a separate public repository `mdg-labs/slugbase-docs`, built with the `/customer-docs` skill, published at `docs.slugbase.app`; it documents CE and Cloud on one site with edition callouts.**
User docs have a different review bar and cadence than code; one site for both editions mirrors "one product" (D4). The old Documentation.AI content is not carried over; pages are rewritten against the new UI.

### Q89 — Old CE images on GHCR
**Status:** Decided (maintainer) · **Affects:** doc 12 §3.2

**Decision: deleted on 2026-10-08, without a deprecation period** (maintainer, when the old repositories were removed). Nobody was known to run the old CE images; the new CE publishes fresh images (Q12).

---

## External services

### Q8 — AI suggestion provider
**Status:** Decided (maintainer) · **Due:** Phase 4 (AI feature) · **Affects:** doc 01 §6, Cloud doc 11 (subprocessors), D17

**Decision: AI suggestions go through the OpenAI-compatible adapter (small model, no training on inputs). The provider is configuration: an EU provider or a self-hosted model.** AI stays off until a provider is configured. Cloud's provider, and when it is switched on, is recorded in the Cloud documentation.

### Q9 — Transactional mail relay
**Status:** Decided (maintainer) · **Due:** Phase 2 (verification mails) · **Affects:** doc 01 §6, Cloud doc 07, Cloud doc 11

**Decision: the generic SMTP adapter is the one `MailPort` adapter for every deployment, Cloud and CE alike. Operators point it at their own relay and set SPF, DKIM and DMARC for their sending domain.**
Keeping one SMTP interface for both editions means CE operators use the same adapter as Cloud. Cloud's relay is recorded in the Cloud documentation.

### Q66 — Error tracking, metrics and logs backend
**Status:** Settled → D27 (maintainer) · **Due:** before Cloud launch · **Affects:** Cloud doc 07 §11, Cloud doc 11 §5, doc 01 §12

**Decision: errors are reported through `ErrorReportPort` to an error tracker that speaks the Sentry SDK protocol (optional on CE). Container and host metrics and logs come from the deployment platform; an uptime monitor checks `/health`. No Prometheus or Grafana is required; the app keeps its internal `/metrics` endpoint, unscraped at launch.**
Cloud's backends are recorded in the Cloud documentation.

---

## Infrastructure and operations

### Q77 — (Cloud) Cloud server placement
Recorded in the Cloud documentation.

### Q75 — Secrets: environment for runtime, CI for build and deploy
**Status:** Settled → D24 (maintainer) · **Due:** Phase 1 (first app deploy) · **Affects:** Cloud doc 07 §4.3, §7

**Decision: no separate secrets manager. Runtime secrets and configuration come only from environment variables, per application and environment. Build- and deploy-time secrets live only in CI environment secrets. Local development uses a gitignored `.env` copied from the committed `.env.example`.**
- Adding a key means: env schema + `.env.example` + doc 07 key inventory (its CE self-host section for CE keys), in the same commit.
- How Cloud holds and checks its values is recorded in the Cloud documentation.

Each secret lives where it is consumed; there is no sync step and no third system.

### Q13 — Source of the encryption and session keys
**Status:** Settled → D24 (maintainer) · **Due:** Phase 2 · **Affects:** doc 01 §6, §10, Cloud doc 07 (secrets)

**Decision: `SESSION_SECRET` and `ENCRYPTION_KEY` (with `ENCRYPTION_KEY_ID`) are environment variables per application and environment; they rotate with key IDs, and the secret box keeps the previous key for decryption until a re-encryption sweep finishes.** Cloud's rotation schedule is recorded in the Cloud documentation.
Key IDs make rotation routine without a key-management service.

### Q76 — How migrations run (Cloud and CE)
**Status:** Settled → D25 (maintainer) · **Due:** Phase 1 · **Affects:** Cloud doc 07 §4.3, §5.2

**Decision: CE migrates on startup; a managed deployment may run `migrate` as a separate step before rollout instead.**
- **CE:** the server migrates on startup under a Postgres advisory lock with `lock_timeout` (Q56).
- **Managed deployment:** `MIGRATE_ON_START=false`, and the deploy runs `migrate` from the new image before anything rolls out; a failed migration stops the deploy. Cloud does this; its mechanics are recorded in the Cloud documentation.
- **Rules for both,** because they come from rolling updates: expand/contract (D7); fast, schema-only migrations, with backfills and `CREATE INDEX CONCURRENTLY` as worker jobs; contract steps only in a later release (Q52); `lock_timeout`.

### Q78 — (Cloud) Cloud image promotion
Recorded in the Cloud documentation.

### Q68 — (Cloud) Cloud backups
Recorded in the Cloud documentation.

### Q14 — When to add Valkey
**Status:** Decided (default) · **Due:** scaling stage 2 (doc 07 §9) · **Affects:** doc 01 §8.2, §9

**Decision: no Valkey at v1. Add a Valkey adapter for `RateLimitPort` when rate-limit writes exceed ~10% of database write load or p95 check latency exceeds 5 ms, measured with `pg_stat_statements` (there is no Prometheus at launch, Q66). Nothing else moves to Valkey without a measurement.**
A measured trigger keeps the CE stack at two services and avoids a cache nobody needed.

### Q10 — Outbound proxy for egress
**Status:** Decided (default) · **Due:** Phase 3 (metadata fetch) · **Affects:** doc 01 §6, Cloud doc 07, doc 10

**Decision: no proxy at launch; `EgressPort` does DNS-resolve-and-pin validation in-process. A dedicated egress proxy (Smokescreen-style allowlist/denylist) is added when the worker moves to its own host or a second region appears.**
In-process validation with IP pinning closes DNS rebinding; a proxy adds defence in depth and a single egress IP, which matters once there is more than one worker host.

---

## CE packaging

### Q3 — Minimum PostgreSQL version supported for CE operators
**Status:** Decided (default) · **Due:** Phase 2 · **Affects:** doc 01 §1, doc 05, doc 07 (CE packaging)

**Decision: PostgreSQL 17 and 18 supported; CI runs the integration suite against both; the compose file ships 18.**
Many operators run a distro or managed Postgres a major behind. Nothing in the design needs 18-only features; a feature that does would raise the floor deliberately.

### Q11 — Single-container CE mode
**Status:** Decided (default) · **Due:** Phase 6 (CE packaging) · **Affects:** doc 01 §2.1, doc 07 (CE packaging)

**Decision: support `slugbase serve --with-worker` (worker loop in the server process) for the smallest installs; the documented compose file still runs two containers from one image.**
Some operators (NAS app stores, PaaS) only run one container. The same code paths run either way; only the process boundary differs.

### Q12 — Where the CE image is published
**Status:** Decided (default) · **Due:** Phase 6 · **Affects:** doc 01 §2.2, Cloud doc 07, doc 09

**Decision: built in the public CE repository's CI on GitHub-hosted runners and published to `ghcr.io/mdg-labs/slugbase` (public); tags `:<semver>`, `:<major>.<minor>`, `:latest` only on a published release.**
Operators expect a public registry without credentials. Cloud images never go to GHCR.

### Q17 — Image signing and provenance
**Status:** Decided (default) · **Due:** Phase 6 (CE release) · **Affects:** doc 01 §10, Cloud doc 07, doc 09

**Decision: build SBOM (SPDX) and SLSA provenance attestations with BuildKit for every image; sign CE release images with cosign keyless (GitHub OIDC) on GHCR; Cloud images carry provenance and are pulled by digest from a private registry.**
Operators can verify what they run; Cloud deploys pin digests, so a tag can never be swapped underneath production.

### Q18 — Telemetry from CE installs
**Status:** Decided (default) · **Due:** Phase 6 · **Affects:** doc 01 §6, doc 11

**Decision: none. CE sends nothing to MDG Labs: no usage pings, no update check that phones home. The admin UI links to the releases page.**
A privacy-positioned, self-hostable product earns trust by default silence; adoption is measured from image pulls instead.

### Q56 — CE database URLs
**Status:** Decided (default) · **Due:** Phase 1 · **Affects:** doc 05 §3.1, doc 07 (CE compose), doc 01 §2.1

**Decision: CE takes two URLs — `DATABASE_URL` (`slugbase_app`) and `DATABASE_MIGRATE_URL` (`slugbase_migrator`) — and the published compose file provisions both roles with a Postgres init script. If only `DATABASE_URL` is set and it is the database owner, the server refuses to start in production with a message explaining the two-role setup (`SLUGBASE_ALLOW_OWNER_CONNECTION=true` overrides, logged as a warning).**
Running the app as the table owner silently disables RLS (owners bypass non-forced policies, and `FORCE` still lets the owner `ALTER` them away), so the RLS layer of D8 would not exist on such installs. The override exists for operators with managed Postgres that makes extra roles awkward.

---

## Stack and process

### Q19 — HTTP framework fallback
**Status:** Decided (default) · **Due:** Phase 2 (first endpoints) · **Affects:** D12, doc 01 §1, doc 04

**Decision: Hono. If `@hono/zod-openapi` cannot express a needed contract (multipart import, streaming) or the security middleware chain (§4) needs workarounds, switch to Fastify + `fastify-type-provider-zod` before more than a handful of routes exist.**
Both meet the requirements; the decision is cheap only while the route count is small, so the first endpoints double as the spike.

### Q7 — Node.js upgrade policy
**Status:** Decided (default) · **Due:** ongoing · **Affects:** doc 01 §1, doc 08, Dockerfiles

**Decision: run the current Active LTS; move to the next LTS within three months of it entering Active LTS; `engines` and `.nvmrc` pin the major, CI runs the pinned major only.**
One runtime version keeps the matrix small; the three-month window avoids early-LTS regressions.

### Q51 — Where RLS policies, grants and functions are defined
**Status:** Decided (default) · confirmed by the first code in Phase 1 · **Due:** Phase 1 (foundation) · **Affects:** doc 05 §5.1, doc 01 §5.4, doc 08

**Decision: declarative SQL files under `packages/db/src/sql/` (policies, grants, `SECURITY DEFINER` functions, triggers), emitted into the generated migration as a custom step whenever their content hash changes; Drizzle's own `pgPolicy`/`pgRole` support is used where it covers a case cleanly.**
drizzle-kit can model basic policies and roles but not column privileges, `SECURITY DEFINER` functions or deferred constraint triggers. The spike confirms that the custom-step wrapper keeps "migrations are generated, never hand-edited" true, and that the CI drift check covers the SQL files.

### Q52 — Contract migrations in CI
**Status:** Decided (default) · **Due:** Phase 1 · **Affects:** doc 05 §5.2, doc 08 (CI)

**Decision: CI rejects destructive or table-rewriting steps unless the PR carries `migration:contract` and the dropped object was unused in the previous release; the label is maintainer-only (`labels.maintainerOnly` in `.claude/workflow.json`).**
Expand/contract is what makes rolling deploys with several replicas safe; agents should not be able to opt out of it on their own.

### Q85 — Component workshop for `@slugbase/ui`
**Status:** Decided (default) · **Due:** Phase 1 · **Affects:** doc 08 §7

**Decision: Ladle.**
Vite-native, fast, small; enough for documenting coss components, SlugBase particles and page compositions with the a11y check. Storybook is the alternative if visual-regression tooling that needs it (Chromatic-style) is wanted later.

---

## Security

### Q5 — Cross-site request protection without a token
**Status:** Decided (default) · **Due:** Phase 2 · **Affects:** doc 01 §4 step 5, doc 04, doc 10

**Decision: Origin + Fetch-Metadata checks on every cookie-authenticated mutation, JSON-only bodies, `SameSite=Lax` host-only cookie — no CSRF token and no exempt endpoints.**
With one origin (D11) and no cross-origin consumers, an Origin check is a complete defence and cannot be forgotten on a route the way a token can; removing the exemption list removes the old design's riskiest special cases (login, setup). A double-submit token would be the fallback if a supported browser is found that omits `Origin` on same-origin `fetch` mutations.

### Q6 — Session lifetimes
**Status:** Decided (default) · **Due:** Phase 2 · **Affects:** doc 01 §10, doc 02

**Decision: sliding 30 days; 90 days with "remember me"; absolute cap 180 days; re-authentication (password or MFA) required within the last 10 minutes for sensitive actions (change email/password, MFA changes, token creation, workspace deletion, billing owner changes).**
Long sliding sessions fit a launcher people use many times a day; the recent-auth window protects the actions an attacker with a stolen session wants most.

### Q15 — Breached-password check
**Status:** Decided (default) · **Due:** Phase 2 · **Affects:** doc 01 §10, doc 02 (accounts)

**Decision: check new passwords against a locally stored k-anonymity range dataset of breached-password hashes (no outbound request), refreshed per release; reject matches with a clear message. CE ships it on by default and operators can turn it off.**
Calling an external breach API from the server would be a third-country transfer and an availability dependency; a local range list avoids both.

### Q16 — API token scopes
**Status:** Decided (default) · **Due:** Phase 3 · **Affects:** doc 01 §10, doc 02, doc 04

**Decision: two scopes at v1, `read` and `read-write`; every token is bound to exactly one workspace; tokens never reach account-security endpoints (password, MFA, sessions, tokens) or billing.**
Covers scripting and a future browser extension without a permission system to design now; the hard exclusions stop a leaked token becoming account takeover.

### Q40 — API tokens and multiple workspaces
**Status:** Decided (default) · **Due:** Phase 1 · **Affects:** doc 04 §4.2, doc 05 §2.1 (`api_tokens`), doc 01 §4 step 7

**Decision: a token is bound to the one workspace it was created in; there is no `X-Slugbase-Workspace` override. Multi-workspace automation uses one token per workspace.**
A bound token has the smallest blast radius when it leaks, and membership loss revokes it by foreign-key cascade. Doc 01 §4 step 7 mentions an optional header; adopting it later is additive (an account-wide token type with the header required), dropping it after launch would be breaking.

### Q45 — MFA required for instance admins
**Status:** Decided (default) · **Due:** Phase 1 · **Affects:** doc 04 §10.10, doc 02 §2

**Decision: `/instance/*` requires the calling account to have MFA enrolled; the setup flow prompts the first admin to enrol, and the instance pages show an enrol-first gate otherwise.**
The instance admin can delete every workspace. Requiring MFA for all accounts is too much for a family CE install; requiring it for the trust ceiling is cheap.

### Q47 — API token expiry
**Status:** Decided (default) · **Due:** Phase 1 · **Affects:** doc 05 §2.1, doc 04 §10.3, doc 03 (token dialog)

**Decision: tokens can be created with an expiry (30 / 90 / 365 days) or none; the dialog defaults to 90 days. Unused tokens are not auto-revoked.**
Expiry by default limits forgotten-token risk; "none" stays available for long-lived integrations. Auto-revoking unused tokens surprises automation that runs rarely.

### Q48 — Verification token lifetimes
**Status:** Decided (default) · **Due:** Phase 1 · **Affects:** doc 05 §2.1 (`credential_tokens`), doc 02 §2

**Decision: password reset 1 hour, email change 1 hour, signup email verification 24 hours, invitations 7 days.**
The old constants used 1 hour for every emailed token; signup verification often happens the next morning, and a 24-hour token on an unverified, capability-restricted account is low risk.

### Q31 — Accepting an invitation creates a verified account
**Status:** Decided (default) · **Due:** Phase 2 · **Affects:** doc 02 §2.2, §3.4, doc 03 §1.5

**Decision: an invitation token proves control of the email, so an account created through it is verified at once, even when `EMAIL_VERIFICATION_REQUIRED=true`. An invitation is bound to its email; a signed-in account with a different email cannot accept it.**
Asking an invited person to verify an address they have just proven is pure friction. Binding to the email prevents a forwarded link from being redeemed by someone else.

### Q32 — OIDC account linking and auto-create
**Status:** Decided (default) · **Due:** Phase 2 · **Affects:** doc 02 §2.8, doc 10 (account takeover), doc 07 (env keys)

**Decision: automatic linking to an existing account only when the provider asserts `email_verified=true` for a matching email. Otherwise linking happens only explicitly, from Account settings while signed in. Auto-create is off per provider by default, with an optional `ALLOWED_DOMAINS` allowlist.**
Linking on unverified email is a classic account-takeover path: an attacker registers the victim's email at a permissive provider. Off-by-default auto-create keeps CE instances admin-curated.

### Q44 — `/instance/*` on Cloud
**Status:** Decided (default) · **Due:** Phase 1 · **Affects:** doc 04 §10.10, Cloud doc 07 §6

**Decision: the instance-admin routes are mounted on both editions. A deployment that must never have an instance admin turns `POST /setup` off by config (`SETUP_ENABLED=false`) and its composition root refuses to set `is_instance_admin`.** Cloud does both; its details are recorded in the Cloud documentation.
Mounting them conditionally would be an edition branch (D4). Risk to watch: on a fresh deployment of that kind, `POST /setup` must be closed by config before the domain is public.

---

## Product behaviour

### Q25 — Your own slug wins over shared ones
**Status:** Decided (default) · **Due:** Phase 1 · **Affects:** doc 02 §6.2, §9.2, doc 03 §9–§10

**Decision: resolution order is a remembered preference, then the member's own bookmark, then a single shared match, then disambiguation among shared matches.**
The old spec sent every multi-match to disambiguation. That means a teammate sharing a folder that contains their own `mail` would break the member's `go mail` until the member answers a chooser. Own-first makes sharing additive and never disruptive. A member can still reach the shared one through the palette or by setting a preference.

### Q26 — `/go` miss offers the member's other workspaces
**Status:** Decided (default) · **Due:** Phase 2 · **Affects:** doc 02 §6.2, doc 03 §10, doc 04 (resolution operation)

**Decision: when a slug has no match in the active workspace but resolves in another of the member's workspaces, the not-found page names those workspaces and offers "switch and continue". It never forwards across workspaces automatically.**
Members of several workspaces would otherwise hit a dead end on every address-bar `go` meant for another workspace. Showing only the names of workspaces the member already belongs to leaks nothing, and switching stays explicit, as tenant isolation requires (D8).

### Q43 — Path and query after the slug (`/go/jira/PROJ-12`)
**Status:** Decided (default) · **Due:** Phase 2 · **Affects:** doc 04 §9.3, doc 02 §6

**Decision: not in v1 — anything after the slug is a 404. Post-v1, an opt-in per-bookmark "append path" template (`https://jira.example.com/browse/{rest}`) with the remainder URL-encoded.**
Popular in go-link tools, but it turns a fixed destination into a constructed URL, which needs its own validation (scheme and host must stay the bookmark's). Adding it later is additive.

### Q22 — Sharing is read-only, and recipients cannot organise shared bookmarks
**Status:** Decided (default) · **Due:** Phase 2 · **Affects:** doc 02 §5.8, §8, doc 03 §5, doc 05 (share tables)

**Decision: shares grant read and slug resolution only. Recipients cannot edit, pin, tag or file a shared bookmark into their own folders.**
Shared editing raises ownership, conflict and audit questions that v1 doesn't need. Personal pins, tags and folders on someone else's bookmark would need per-viewer association tables, which double the sharing data model. A recipient who wants to organise a shared bookmark can copy it (a later feature), or the owner can file it. Revisit with per-viewer pins as the first extension.

### Q23 — What happens to a departing member's content
**Status:** Decided (default) · **Due:** Phase 2 · **Affects:** doc 02 §3.6, §2.10, doc 03 §11.6–§11.7

**Decision: the acting admin (or the leaving member) chooses between transferring the member's bookmarks and folders to another member and deleting them. Transfer is the default, with the recipient defaulting to the acting admin, or to the longest-standing owner when the member leaves on their own. Tags and go preferences are deleted; colliding slugs are cleared on transfer and reported.**
The old spec said content "remains with the workspace" without naming an owner. Every row needs an owner for the sharing and slug rules to work. An explicit choice avoids both orphaned data and silent deletion.

### Q24 — Account deletion
**Status:** Decided (default) · **Due:** Phase 2 · **Affects:** doc 02 §2.10, doc 03 §11.1, doc 05 §7.1, doc 06 (billing-owner block), Q54

**Decision: self-service and immediate, with typed confirmation and re-authentication. Deletion is blocked while the account is the only owner of a workspace that has other members, or the billing owner of an active Cloud subscription. Workspaces where the account is the only member are deleted with it; its bookmarks and folders in workspaces with other members stay as ownerless "Former member" content (Q54 — the maintainer's answer, which overrides the earlier transfer default; Q23's transfer-or-delete choice applies only when a member leaves or is removed). There is no grace period.**
GDPR Article 17 favours a self-service path. Blocking on sole ownership prevents stranding teams. A 30-day grace period was considered and declined for v1, because it would need a soft-deleted account state everywhere.

### Q54 — Content of a deleted account in shared workspaces
**Status:** Decided (maintainer) · **Due:** Phase 1 · **Affects:** doc 05 §7.1, doc 02 §3.5, doc 11

**Decision: bookmarks and folders the account created in workspaces with other members stay as ownerless workspace content ("Former member"); tags, preferences and AI cache are deleted. Workspaces where it was the only member are deleted entirely.**
Matches the leave-a-workspace rule (content belongs to the workspace) and avoids breaking teammates' shared folders and slugs. The alternative (delete everything the person authored) is the stricter erasure reading; it is a legal call, hence Maintainer.

### Q53 — Audit retention
**Status:** Decided (maintainer) · **Due:** Before 1.0 · **Affects:** doc 05 §6, doc 11 (privacy policy)

**Decision: 365 days on Cloud; CE configurable via `AUDIT_RETENTION_DAYS` (default 365, `0` = forever).**
Long enough for a team to investigate "who deleted this" after a quarter; short enough to be proportionate under GDPR. The Cloud value goes into the privacy policy, so only the maintainer can adopt it.

### Q55 — Deleting large workspaces
**Status:** Decided (default) · **Due:** Phase 2 · **Affects:** doc 05 §7.2, doc 04 §10.4

**Decision: workspace deletion marks the workspace `deleting` (a `deleting_at` column on `workspaces`, hidden from every query and the switcher) and a pg-boss job deletes it in batches; the API returns `202`.**
A single cascading `DELETE` of a 100 000-bookmark workspace holds locks long enough to stall other requests. Small workspaces could be deleted synchronously, but one path is simpler to test.

### Q27 — Duplicate URLs are warned about, not blocked
**Status:** Decided (default) · **Due:** Phase 1 · **Affects:** doc 02 §5.2, §13.1, doc 03 §4

**Decision: if the member already owns a bookmark with the same canonical URL in this workspace, the modal warns and links to it; saving the duplicate anyway is allowed. Import skips duplicates by default.**
Legitimate duplicates exist: the same URL with different slugs or folders. Blocking them frustrates users; silent duplicates clutter libraries.

### Q28 — Usage tracking stores only a count and a last-accessed time
**Status:** Decided (default) · **Due:** Phase 1 · **Affects:** doc 02 §5.5, doc 05, doc 11 (privacy policy)

**Decision: per bookmark, keep an access count and the last-accessed timestamp only. No per-open history, no referrer, no IP.**
That is enough for "most used", quick access and the archive rule. A per-click history would be a browsing log of everyone's private links, a privacy liability with no v1 feature that needs it.

### Q29 — Export formats
**Status:** Decided (default) · **Due:** Phase 1 · **Affects:** doc 02 §13.2–§13.3, doc 03 §11.5, doc 04 (export schema)

**Decision: SlugBase JSON (versioned, lossless, the backup format) plus Netscape HTML for re-import into browsers. In the HTML export, slugs are written as `SHORTCUTURL` and tags as `TAGS`.**
JSON is the only lossless format. HTML is what users expect when moving bookmarks back into a browser, and Firefox honours `SHORTCUTURL` as a keyword, so slugs partly survive.

### Q30 — Import conflict handling
**Status:** Decided (default) · **Due:** Phase 1 · **Affects:** doc 02 §13.1, doc 03 §11.5

**Decision: folders and tags are matched by name (case-insensitive) or created. An invalid or conflicting slug is dropped from that bookmark, which is still imported, and the drop is reported. Duplicates by canonical URL are skipped unless the member unticks "Skip duplicates". Browser folder paths are flattened to the leaf name.**
Failing a whole 3 000-bookmark import over one bad slug is the worst outcome. Dropping per field and reporting it keeps imports useful and honest. Flattening follows from Q33.

### Q33 — No nested folders in v1
**Status:** Decided (default) · **Due:** Phase 1 · **Affects:** doc 02 §7.1, §13.1, doc 03 §6, doc 05

**Decision: folders are flat. A bookmark can be in several folders. Imported browser hierarchies are flattened to leaf names.**
Many-to-many folders plus tags already cover most of what nesting does. Nesting adds tree queries, inherited sharing and move semantics, which are unnecessary for a launch. Revisit with real user requests.

### Q34 — A description field, no free-form notes
**Status:** Decided (default) · **Due:** Phase 1 · **Affects:** doc 02 §5.1, doc 03 §4, doc 05

**Decision: bookmarks have an optional description (up to 1 000 characters, prefilled from page metadata, searchable). There is no rich-text notes field.**
The description gives search and the palette useful text without turning SlugBase into a notes app. A notes field would invite Markdown rendering, and with it XSS surface.

### Q42 — List totals
**Status:** Decided (default) · **Due:** Phase 1 · **Affects:** doc 04 §6.1, doc 03 (pager)

**Decision: bookmark, folder and tag lists return an exact `total` up to 10 000 and `null` + `totalAtLeast: 10000` above; pagination is keyset with "load more", no page-number jumping.**
The UI shows counts; exact counts over very large filtered sets cost a full index scan per request. The design prototype's page-number pager is replaced; if numbered pages are required, they need offset pagination for that view only.

### Q49 — Full-text search configuration
**Status:** Decided (default) · **Due:** Phase 1 · **Affects:** doc 05 §2.4, doc 02 §7

**Decision: one `simple`-configuration `tsvector` (no stemming) plus `pg_trgm` on title and slug for prefix and typo tolerance.**
Bookmarks are short, mixed-language strings (titles in English and German in one library); stemming per language would need a language per row and still misfire on product names. Trigram matching covers partial words. Revisit with per-locale stemming if search quality complaints show up.

### Q50 — Audit log partitioning
**Status:** Decided (default) · **Due:** Before 1.0 · **Affects:** doc 05 §2.9, §6

**Decision: a plain table with time-ordered indexes until it passes ~50 M rows, then monthly range partitions on `created_at` (retention becomes `DROP PARTITION`).**
Partitioning complicates primary keys and Drizzle schema management; at launch scale the purge job's batched deletes are cheap.

---

## UI

### Q20 — A Forwarding page
**Status:** Decided (default) · **Due:** Phase 1 · **Affects:** doc 02 §6.4–§6.5, doc 03 navigation, §8

**Decision: a top-level `/forwarding` page that holds the browser search-engine setup, the member's own slugs (with inline forwarding toggles) and their remembered go preferences.**
The prototype had a "Forwarding" sidebar item with no page behind it. Slugs are the product's signature feature and deserve a home: browser setup is otherwise buried in onboarding, and go preferences need a management screen anyway. The alternative, dropping the item and scattering these into Settings and the bookmarks filters, hides the feature that differentiates SlugBase.

### Q21 — Folder appearance
**Status:** Decided (default) · **Due:** Phase 1 · **Affects:** doc 02 §7.1, doc 03 §6, doc 05 (folder columns)

**Decision: a folder has an optional lucide icon from a curated set of about 60 icons, and a colour from eight folder tokens (`--folder-1` … `--folder-8`); the default is the `folder` icon in colour 1.**
The prototype shows coloured dots and the old spec named icons; both are cheap and help scanning the sidebar. Tokens rather than free hex keep both themes and contrast correct.

### Q35 — Default theme
**Status:** Decided (default) · **Due:** Phase 1 · **Affects:** doc 02 §2.1, doc 03 cross-cutting rules, §11.4

**Decision: `system` (follow the OS), with dark as the primary designed theme and light at full parity.**
The prototype is dark-first, but forcing dark on users who run light systems is hostile. Designing dark first and defaulting to the system setting gives both.

### Q36 — Accent presets
**Status:** Decided (default) · **Due:** Phase 4 · **Affects:** doc 02 §2.1, doc 03 theme tokens, §11.4

**Decision: six accent presets (periwinkle by default, plus five others from the token palette), each contrast-checked in both themes. No free colour picker.**
The old spec listed an accent preference. Presets keep WCAG contrast guaranteed, which a free picker cannot.

### Q37 — Avatars are initials only
**Status:** Decided (default) · **Due:** Phase 1 · **Affects:** doc 02 §2.1, doc 03 §11.1, doc 01 §6 (`BlobPort` stays unused)

**Decision: no avatar uploads in v1; initials on a colour derived from the account ID. OIDC provider pictures are not fetched.**
Uploads are the only feature that would require blob storage and image processing, which means a new port, a new attack surface and new backups. Fetching provider pictures would make browsers contact third parties.

### Q38 — Single-key shortcuts can be turned off
**Status:** Decided (default) · **Due:** Phase 1 · **Affects:** doc 02 §2.1, doc 03 §14, §11.4

**Decision: single-key shortcuts (`C`, `E`, `P`, `G …`) are on by default and can be disabled per account. Modifier shortcuts (`⌘K`) always work.**
WCAG 2.1.4 (Character Key Shortcuts) requires a way to turn off or remap single-character shortcuts. Speech-input and screen-reader users trigger them accidentally.

### Q39 — Mobile scope
**Status:** Decided (default) · **Due:** Phase 2 · **Affects:** doc 03 cross-cutting rules, doc 08 (e2e viewports)

**Decision: fully usable on a phone: auth, Home, Bookmarks, the bookmark modal, the palette and the `/go` pages. Usable but desktop-first: Settings and Admin. e2e runs the phone-critical flows at a 390 px viewport.**
The phone use cases are saving a link and jumping to one. Administration happens at a desk. A native app or a share-target PWA is post-1.0.
