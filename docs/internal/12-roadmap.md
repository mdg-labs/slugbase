# SlugBase — Roadmap and Risks

*The Community Edition's part of the plan. Cloud-only phases, the billing-service dependency and the Cloud-only risks are planned in the Cloud roadmap; their numbers are kept here so citations stay stable.*

---

## 1. Phasing

This section is the rationale; **the plan itself lives in GitHub issues** — one or more epics per phase, created with `/triage seed phase <N>` (doc 09 §5.6), with sub-issues, blocked-by links and a milestone per phase. Once seeded, the issues are authoritative for status and scope; this doc is updated only when a phase's *intent* changes.

Each phase lists the epics `seed` is expected to propose, the repository they live in, and a definition of done. Epic titles are indicative; `triage` refines them against the code at seed time.

```
Phase 0  Cloud-only — planned in the Cloud roadmap
Phase 1  Repositories and foundation             slugbase                  ── the skeleton every feature lands in
Phase 2  Accounts, workspaces, tenancy           slugbase                  ── sign-in to an empty workspace
Phase 3  The core product                        slugbase                  ── bookmarks, slugs, /go, palette: CE usable
Phase 4  Collaboration, admin, AI, import/export slugbase                  ── CE feature-complete (v1 scope, doc 00 §4)
Phase 5  Cloud-only — planned in the Cloud roadmap
Phase 6  Launch hardening and launch             slugbase (CE part)        ── security audit, performance, CE 1.0
Phase 7  Cloud-only — planned in the Cloud roadmap
```

Phases 2–4 run CE-first: each CE capability is picked up by Cloud through a pinned bump as soon as it lands, so Cloud never trails CE by more than a CE bump.

### Phase 0 — Cloud-only — planned in the Cloud roadmap

### Phase 1 — Repositories and foundation

**Starts before any feature code**, the foundation comes first: the test harness, the contracts pipeline and the security chain exist before the first product operation, so every later item lands into them.

**Scope (CE, `mdg-labs/slugbase`):** new public repository (the first implementation's repository is retired first, §3); `LICENSE` (AGPL-3.0), `SECURITY.md` (contact `support@slugbase.app` plus private vulnerability reporting, Q86), `CONTRIBUTING.md` with DCO sign-off and the CLA (CLA Assistant check on pull requests; no outside code merged before it, Q80); workflow vendored (full profile), `workflow.json` and `CLAUDE.md` per doc 09 §5; docs moved in (doc 09 §7) with `docs/internal/10-threat-model.md`; labels; CI (doc 08 §6.2) including the `forbidden-terms` check (doc 09 §4); the docs contract check `docs:check` and the generic docs-published workflow (doc 09 §3.5, Q111); the package skeleton with boundary lint; `contracts` → OpenAPI generation and drift check; API Extractor reports; `db` with roles, `withTenant`, the RLS policy lint and the template-database test harness; the cross-tenant matrix runner (empty, but wired to the contract); `server` with the full middleware chain, config schema, `/health` `/ready` `/version`, graceful shutdown, `server|worker|migrate` commands; pg-boss wiring; the egress adapter with its SSRF suite; secret box; rate-limit adapter; `web` shell with coss ui installed into `@slugbase/ui`, tokens from the V1 prototype, TanStack Router, i18n, the slot system, error pages; MSW mock generation; `apps/slugbase` image; `compose.dev.yml` and the published `compose.yml`.

The Cloud part of Phase 1 (the composition root built on CE's seams, its image and deployment) is planned in the Cloud roadmap.

**Epics `seed phase 1` proposes:**

- `slugbase`: *Repository bootstrap (CE)* · *Contracts and API pipeline* · *Database foundation: roles, RLS, migrations, test harness* · *Server foundation: HTTP chain, config, health, worker* · *Ports and CE adapters: egress, secret box, rate limit, mail, errors* · *Web foundation: coss ui, tokens, router, i18n, slots, mocks* · *CE image and compose*.

**Definition of done:** `pnpm gate` green on CI; the CE image starts against an empty Postgres, migrates, reports `/ready`; `/security-audit` runs against doc 10 (finds nothing to audit but the chain) without stopping.

### Phase 2 — Accounts, workspaces, tenancy

First-run setup (CE), registration with verification (config-driven, on for the Cloud composition), sign-in, sessions and "sign out everywhere", password reset, email change, re-authentication, TOTP MFA with backup codes, API tokens, OIDC providers, workspaces (create, switch, rename, delete), members and roles, invitations, the CE instance-admin area, the audit-event writer, the entitlement engine with the CE full-entitlements source, mail templates EN/DE. UI: auth screens, workspace switcher, account settings, members.

**Epics:** *Sign-in and sessions* · *MFA* · *API tokens* · *OIDC* · *Registration, verification, reset, email change* · *Workspaces and membership* · *Invitations* · *Instance administration (CE)* · *Entitlement engine*.

**Definition of done:** the cross-tenant matrix covers every Phase 2 operation in both modes; T4, T5, T8, T9, T17–T20 have their suites (doc 08 §3.5); e2e covers setup → invite → accept → MFA.

### Phase 3 — The core product

Bookmarks (modal create/edit, hard delete), folders, member-private tags, pinning, lists (grid/table, filters in the URL, keyset pagination, bulk actions), slugs and `/go` (resolution, disambiguation, remembered choices), browser search-engine setup, the ⌘K palette with `go` mode, search (`tsvector` + `pg_trgm`), dashboard, metadata and favicon jobs through egress, usage tracking.

**Epics:** *Bookmarks* · *Folders and tags* · *Slugs and /go* · *Search and command palette* · *Dashboard* · *Metadata and favicons*.

**Definition of done:** CE is usable day to day by one person; `/go` and list budgets met on the seeded large instance (doc 08 §5.3); T12–T14 suites green.

### Phase 4 — Collaboration, administration, AI, import/export

Teams, sharing of bookmarks and folders (direct, team, folder-transitive), "shared with me / by me" scopes, the audit log UI, AI suggestions behind the AI port (OpenAI-compatible adapter, operator-configured, per-workspace toggle, per-member opt-out; a private-address endpoint only through the operator allowlist of Q90), lossless JSON export and import, Netscape HTML import, the CE backup documentation (export + `pg_dump`, in `docs/self-hosting/`, doc 09 §7).

**Epics:** *Teams and sharing* · *Audit log* · *AI suggestions* · *Import and export* · *CE operations docs*.

**Definition of done:** the v1 scope of doc 00 §4 is complete for CE; export → import into a fresh workspace round-trips byte-equivalent content (e2e); CE `1.0.0-rc.1` image published (SBOM and provenance attached, `:latest` untouched; signing and the public package follow in Phase 6, Q92).

### Phase 5 — Cloud-only — planned in the Cloud roadmap

### Phase 6 — Launch hardening and launch

The CE part: full `/security-audit` against doc 10, with every Critical/High fixed through advisories; dependency and image scanning clean; performance budgets on production-sized data; the CE operations docs; end-user docs in `docs/user/`, written with `/customer-docs`, held to the docs contract (doc 09 §3.5) and published at `slugbase.app/docs` by the site, which is rebuilt through the docs-published hook (Q2, Q111); CE `1.0.0` release and public announcement: the image signed with cosign and its package public, `:latest` moved only by the published release (Q92); the operator documentation in `docs/self-hosting/` and the release notes in `docs/releases/` (doc 09 §7). The Cloud part of launch hardening is planned in the Cloud roadmap.

**Epics:** *Security audit and fixes* · *Load and performance* · *CE operations docs* · *User documentation* · *CE 1.0.0 release*.

**Definition of done:** CE 1.0.0 image published, signed and verifiable with `scripts/verify-image.sh`.

### Phase 7 — Cloud-only — planned in the Cloud roadmap

### Post-1.0 candidates

Custom forwarding domains; public share pages; browser extension; subdomain tenancy; trash/soft delete; a second adapter for mail, AI or billing; Valkey for rate limiting when measured; additional languages; drag-and-drop ordering.

### 1.1 (Cloud) Recorded in the Cloud roadmap

---

## 2. Milestones and order of work

| Order | Gate | Parallel with |
|---|---|---|
| Phase 0 | Cloud-only — planned in the Cloud roadmap | — |
| Phase 1 | — | — |
| Phase 2 → 3 → 4 | Each needs the previous phase's epics `implemented` on `dev` | Each CE capability is picked up by Cloud through a pinned bump |
| Phase 5 | Cloud-only — planned in the Cloud roadmap | — |
| Phase 6 | Phase 4 (CE part); the Cloud launch gates are in the Cloud roadmap | — |
| Phase 7 | Cloud-only — planned in the Cloud roadmap | — |

Promotions `dev → main` happen at least at the end of every phase, and more often when `/dev-diff` approaches the 150-file promotion budget (CodeRabbit Essentials' per-PR file limit).

---

## 3. Cutover from the first implementation

The first implementation was retired in October 2026; its repositories are archived.

### 3.1 (Cloud) Recorded in the Cloud roadmap

### 3.2 (Cloud) Recorded in the Cloud roadmap

---

## 4. Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | (Cloud) Recorded in the Cloud roadmap | — | — | — |
| R2 | **A cross-tenant leak ships** | Low | Critical — trust | Two enforcement layers (D8), the generated cross-tenant matrix, risk-labelled verifier on Opus, audit before every promotion |
| R3 | **RLS performance or pooling pitfalls** (policy subqueries on hot paths; `SET LOCAL` misuse; a compared column whose equality is not leakproof) | Medium — it happened: the end-of-Phase-1 measurement found the third, and the JIT compilation it triggers (below) | `/go` latency | Policies are simple equality on `workspace_id` with indexes leading on it; `SET LOCAL` only inside transactions (doc 01 §9.2); the `/go` query measured under forced RLS and PgBouncer in transaction mode by `pnpm perf:go` (`packages/db/test/perf/`), whose `EXPLAIN` check requires the slug in the index condition, not only an `Index Only Scan`; every column a hot-path query compares on a tenant table needs an equality operator that is leakproof (doc 05 §4); the run reports the plan's JIT compilation time and the `jit` setting of the application role, because a plan costed above `jit_above_cost` is compiled on every request; budgets re-measured on the real tables from Phase 3 |
| R4 | **The CE ↔ Cloud seam drifts again** | Medium | Cloud CI breaks, CE contract churn | API Extractor reports, the follow-up-item rule, pin rules, one bump per promotion (doc 09 §3) |
| R5 | **coss ui gaps or churn** (a component SlugBase needs is missing or changes upstream) | Medium | UI work blocks | Copy-and-own (D13): vendored components are ours to extend; a missing component is built in `@slugbase/ui` in coss style, documented in doc 03 |
| R6 | **AGPL and open-core licensing conflict** — external CE contributions without a licence grant prevent their use in proprietary Cloud | Medium | Legal | DCO sign-off plus a CLA (Q80, decided); CLA Assistant blocks unsigned pull requests; no outside code merged before it is in place |
| R7 | (Cloud) Recorded in the Cloud roadmap | — | — | — |
| R8 | **Agent-built code with subtle security defects** | Medium | High | Threat model from day one, risk paths, Opus verifier, security units, advisories workflow, human review of every promotion PR |
| R9 | **Scope creep beyond v1** (public pages, extension, custom domains) | High | Delays launch | v1 non-goals in doc 00 §4 and the implementation rule to flag them (doc 09 §5.3) |
| R10 | (Cloud) Recorded in the Cloud roadmap | — | — | — |
| R11 | (Cloud) Recorded in the Cloud roadmap | — | — | — |
| R12 | **Old repository names reused before the kept artefacts are moved** | Low | Lost design prototype or history | Backups first; the old repositories were deleted only after their kept artefacts were confirmed in the new ones (§3) |

---

## 5. What would make this project fail

- **Shipping a leak.** A privacy-positioned bookmark product that exposes one workspace's links to another does not recover. Everything in D8, doc 08 §3.3 and doc 10 exists to make that the least likely failure.
- **Launching late because Cloud billing came first.** Billing is Phase 5 on purpose: the product must be good before it is sold.
- **A UI as inconsistent as the first one.** The rebuild's visible reason. Doc 03 naming a coss component for every element, and the verifier checking it, is the control.
- **Losing the maintainer's trust in the agent workflow.** If verification signals are weak, every change needs a human re-read and the throughput advantage disappears. One gate, real-Postgres tests and the follow-up-item rule keep the signal strong.

**Kill criteria** (stop and rethink before continuing):

| When | Criterion | Response |
|---|---|---|
| End of Phase 1 | RLS + transaction pooling cannot meet a 30 ms `/go` p95 on a seeded instance | Reconsider: per-request role switch, policy shape, the `jit` setting of the application role (off, or a higher `jit_above_cost`), or app-layer-only isolation with stronger tests (would amend D8) |
| Any phase | The CE ↔ Cloud seam requires Cloud to fork CE code to deliver a Cloud feature | Stop; design the missing extension point in CE first (D3) |

**End of Phase 1 criterion, measured (2026-10-12).** `pnpm perf:go` builds synthetic copies of the six tables of the doc 05 §4 query with the documented indexes and `FORCE`d policies, seeds 50 000 bookmarks in one workspace of 50 members and 2 000 workspaces (about 90 000 bookmarks; slugs carried by 2 to 50 members), and runs the query through `withTenant()` over PgBouncer in transaction mode. Instance: PostgreSQL 18.6 (`postgres:18`, digest `sha256:74935e72…`; defaults for `jit` (on), `jit_above_cost` (100 000) and `jit_inline_above_cost` / `jit_optimize_above_cost` (500 000), read from `pg_settings` in the run) in a container limited to 4 CPUs and 8 GB with `shared_buffers` 2 GB, PgBouncer 1.26.0 (the rig pins `edoburu/pgbouncer:v1.26.0-p0@sha256:b17551c776ef7e5769ef80b956d20f85e2fd25dd8912d31d58f782aad495b711`; the run used the `latest` index of the same build, `sha256:9c789458…`; `pool_mode = transaction`, `default_pool_size = 10`) on a shared 24-thread development host under other load (load average 1.1 to 3.2 during the runs). That is not a production-sized instance; the numbers decide the plan, not a capacity. Percentiles are client-observed `BEGIN`..`COMMIT`, one request at a time, over 3 rounds, reported as the median of the rounds' percentiles. Commands (the rig on ports 54340 and 64340 because the defaults were taken; `--requests` and `--concurrent` are per configuration and round): `pnpm perf:go --slug-type citext --requests 1000 --concurrent 600 --rate 300 --warmup 100 --rounds 3 --explain-runs 200` (`citext`, default `jit`); `pnpm perf:go --slug-type citext --jit off --requests 5000 --concurrent 3000 --rate 300 --warmup 500 --rounds 3 --explain-runs 500`; `pnpm perf:go --slug-type text` and `pnpm perf:go --slug-type text --jit off` (all other options at their defaults). The workspace-size runs add `--bookmarks 5000` or `--bookmarks 20000 --requests 2000 --concurrent 1000 --rate 100 --warmup 200 --rounds 3 --explain-runs 200`; the PostgreSQL 17.11 runs use `PERF_PG_IMAGE=postgres:17` with `--requests 300 --concurrent 150 --rate 20 --warmup 50 --rounds 1 --explain-runs 50` (`citext`, with and without `--jit off`) and `--slug-type text --requests 1000 --concurrent 500 --rate 100 --warmup 100 --rounds 1 --explain-runs 50`.

| `bookmarks.slug` | `jit` | Configuration | p50 | p95 | p99 |
|---|---|---|---|---|---|
| `citext` (doc 05 §2.4 as written) | on (default) | PgBouncer, RLS on (1 000 requests × 3 rounds) | 152 ms | **181 ms** (rounds 172, 209, 181) | 269 ms |
| `citext` | on | direct, RLS on | 149 ms | 180 ms | 248 ms |
| `citext` | on | PgBouncer, RLS off | 1.8 ms | 2.5 ms | 2.9 ms |
| `citext` | off | PgBouncer, RLS on (5 000 requests × 3 rounds) | 12.5 ms | **14.9 ms** (rounds 14.1, 14.9, 25.0) | 19.8 ms |
| `citext` | off | direct, RLS on | 11.2 ms | 13.6 ms | 14.6 ms |
| `citext` | off | PgBouncer, RLS off | 1.9 ms | 3.1 ms | 3.7 ms |
| `text` | on (default) | PgBouncer, RLS on (5 000 requests × 3 rounds) | 1.8 ms | **2.5 ms** (rounds 3.3, 2.4, 2.5) | 3.0 ms |
| `text` | on | direct, RLS on | 1.3 ms | 2.0 ms | 2.3 ms |
| `text` | on | PgBouncer, RLS off | 1.6 ms | 2.2 ms | 2.5 ms |
| `text` | off | PgBouncer, RLS on | 1.8 ms | 2.5 ms | 3.0 ms |

- **Verdict. With `slug citext` (doc 05 §2.4 as written) and PostgreSQL's default `jit = on`, the end-of-Phase-1 kill criterion is met: p95 181 ms through PgBouncer against 30 ms. With `jit = off` it passes (p95 14.9 ms, about half the budget, but one of three rounds measured 25.0 ms) while the slug is still a filter over the whole workspace, about 190× slower than `text` in server execution time (9.6 ms against 0.05 ms at p50) and about 6× at the client (p95 14.9 ms against 2.5 ms), and growing with the workspace. With `slug text` it passes at p95 2.5 ms, with and without JIT. Recommendation: `slug text` (#373).** The same `citext` query is 180 ms direct and 2.5 ms with RLS off, so transaction pooling and the policy's own cost are not the cause.
- **Cause, in two parts.** In every plan measured (PostgreSQL 17.11 and 18.6) the planner does not use `slug = $slug` as an index condition on a table with a policy when its operator is not leakproof (`citext_eq` is not, `texteq` and `uuid_eq` are: `pg_proc.proleakproof`, read on 18.6). The plan still reads `Index Only Scan using bookmarks_slug_idx` with no sequential scan on `bookmarks`, but the slug is a filter over every index entry of the workspace (45 255 rows removed), and the plan's estimated cost is 1.9 to 2.6 million (45 for `text`), far above `jit_above_cost`. `EXPLAIN (ANALYZE)` over 200 runs with `jit = on`: execution p50 152.2 ms, of which JIT compilation 141.6 ms (`JIT.Timing.Total`; 200 of 200 runs compiled) and 10.5 ms the execution itself; over 500 runs with `jit = off`: execution p50 9.6 ms (p95 11.2 ms), no run compiled. Most of the 181 ms is therefore JIT compilation of a plan that does the wrong work, and the wrong work remains without it. In the scratch database, marking `citext_eq` leakproof (a superuser statement) restored the slug index condition in a single run (0.08 ms execution); that confirms the plan cause and is not an option for a managed PostgreSQL. The same two-part result on PostgreSQL 17.11 (short run, 300 requests): `citext`, `jit = on`, p95 156 ms with execution p50 138.5 ms of which JIT 128.7 ms; `jit = off`, p95 14.2 ms; `text`, p95 3.2 ms (`postgres:17`, digest `sha256:2d2b8998…`).
- **The filter grows with the workspace** (`citext`, `jit = off`, RLS on, `EXPLAIN` execution p50; client-observed p95 through PgBouncer): 0.94 ms and 4.4 ms at 5 000 bookmarks in the workspace (4 755 rows filtered), 3.7 ms and 7.1 ms at 20 000 (18 255 rows), 9.6 ms and 14.9 ms at 50 000 (45 255 rows); `text` at 5 000 bookmarks measured 0.04 ms and 2.9 ms. `jit = on` was not run at 5 000 and 20 000; the plans there are costed at 273 568 and 1 031 788, also above `jit_above_cost`, and whether they are compiled was not measured.
- **Under an offered 300 requests/s** (open loop, 32 client connections): `text` p95 2.8 ms (2.7 ms with `jit = off`) at 300 requests/s; `citext` with `jit = off` p95 13.0 ms at 300 requests/s (one round of the direct RLS-on configuration measured 1 139 ms, cause not isolated); `citext` with `jit = on` completes 23 requests/s of the 300 offered through PgBouncer (candidate-query p50 410 ms under load), a saturation figure, not a latency.
- **With a leakproof slug equality the criterion is passed with a 12× margin on this hardware** (`text`, `jit` on or off): p95 2.5 ms through PgBouncer against 2.2 ms with RLS off. `EXPLAIN ANALYZE`: planning p50 0.35 ms, execution p50 0.05 ms, p95 0.61 ms, no JIT (estimated cost 45). RLS added no consistent time at p50 (1.77 ms with it, 1.61 ms without through PgBouncer; 1.34 and 1.37 ms direct). The `set_config` statement costs one round trip: 0.13 ms at p50 direct and 0.23 ms through PgBouncer, and `BEGIN` + `set_config` + `COMMIT` took 0.37 and 0.64 ms against 0.24 and 0.41 ms for `BEGIN` + `COMMIT` with no statement between them.
- **Not decidable here:** whether a production-sized instance holds the passing figures under real concurrency; re-run `pnpm perf:go` there (`packages/db/test/perf/README.md`), with and without `--jit off`. The `citext` result is a plan fault compounded by JIT, not a capacity one; no claim is made about how much faster an instance would need to be.
- **Response to the kill criterion:** none of the three listed responses addresses the cause, and D8 stays. The measured fix is the column type: the slug becomes `text` holding the lower-case grammar its `CHECK` already enforces (doc 05 §2.4), lower-cased by the application before it is compared (#373). That amends doc 05 §2.4 and §2.6 (`bookmarks.slug`, `slug_preferences.slug`) and any index or query on the slug (doc 05 §4); it is a maintainer decision and a schema change for Phase 3, a follow-up item and not made by the spike. The `jit` setting is a further option for this query and a partial one: `ALTER ROLE` of the application role `SET jit = off` (or `SET LOCAL jit = off` inside `withTenant()`), or a `jit_above_cost` above this plan's cost, which grows with the workspace (273 568, 1 031 788, 1.9 to 2.6 million at 5 000, 20 000, 50 000 bookmarks). It removes the 142 ms of compilation, not the filter (9.6 ms against 0.05 ms), and as a role-wide or threshold setting it changes every query of the role; only this query was measured with it. Other tenant-table columns compared on hot paths (`citext` names, the `GET /go/suggest` prefix match) were not measured and need the same check, including the JIT line, when their tables are built.
