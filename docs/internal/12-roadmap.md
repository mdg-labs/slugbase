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

**Starts before any feature code**, the same discipline as Hoserva's Phase 1 foundation: the test harness, the contracts pipeline and the security chain exist before the first product operation, so every later item lands into them.

**Scope (CE, `mdg-labs/slugbase`):** new public repository (the first implementation's repository is retired first, §3); `LICENSE` (AGPL-3.0), `SECURITY.md` (contact `support@slugbase.app` plus private vulnerability reporting, Q86), `CONTRIBUTING.md` with DCO sign-off and the CLA (CLA Assistant check on pull requests; no outside code merged before it, Q80), `TRADEMARK.md`; workflow vendored (full profile), `workflow.json` and `CLAUDE.md` per doc 09 §5; docs moved in (doc 09 §7) with `docs/internal/10-threat-model.md`; labels; CI (doc 08 §6.2); the package skeleton with boundary lint; `contracts` → OpenAPI generation and drift check; API Extractor reports; `db` with roles, `withTenant`, the RLS policy lint and the template-database test harness; the cross-tenant matrix runner (empty, but wired to the contract); `server` with the full middleware chain, config schema, `/health` `/ready` `/version`, graceful shutdown, `server|worker|migrate` commands; pg-boss wiring; the egress adapter with its SSRF suite; secret box; rate-limit adapter; `web` shell with coss ui installed into `@slugbase/ui`, tokens from the V1 prototype, TanStack Router, i18n, the slot system, error pages; MSW mock generation; `apps/slugbase` image; `compose.dev.yml`.

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

Teams, sharing of bookmarks and folders (direct, team, folder-transitive), "shared with me / by me" scopes, the audit log UI, AI suggestions behind the AI port (OpenAI-compatible adapter, operator-configured, per-workspace toggle, per-member opt-out), lossless JSON export and import, Netscape HTML import, the CE backup documentation (export + `pg_dump`).

**Epics:** *Teams and sharing* · *Audit log* · *AI suggestions* · *Import and export* · *CE operations docs*.

**Definition of done:** the v1 scope of doc 00 §4 is complete for CE; export → import into a fresh workspace round-trips byte-equivalent content (e2e); CE `1.0.0-rc.1` image published.

### Phase 5 — Cloud-only — planned in the Cloud roadmap

### Phase 6 — Launch hardening and launch

The CE part: full `/security-audit` against doc 10, with every Critical/High fixed through advisories; dependency and image scanning clean; performance budgets on production-sized data; the CE operations docs; end-user docs at docs.slugbase.app (`/customer-docs`); CE `1.0.0` release and public announcement. The Cloud part of launch hardening is planned in the Cloud roadmap.

**Epics:** *Security audit and fixes* · *Load and performance* · *CE operations docs* · *User documentation* · *CE 1.0.0 release*.

**Definition of done:** CE 1.0.0 image published.

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

Promotions `dev → main` happen at least at the end of every phase, and more often when `/dev-diff` approaches the 100-file promotion budget.

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
| R3 | **RLS performance or pooling pitfalls** (policy subqueries on hot paths; `SET LOCAL` misuse) | Medium | `/go` latency | Policies are simple equality on `workspace_id` with indexes leading on it; budgets measured from Phase 3; `SET LOCAL` only inside transactions (doc 01 §9.2) |
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
| End of Phase 1 | RLS + transaction pooling cannot meet a 30 ms `/go` p95 on a seeded instance | Reconsider: per-request role switch, policy shape, or app-layer-only isolation with stronger tests (would amend D8) |
| Any phase | The CE ↔ Cloud seam requires Cloud to fork CE code to deliver a Cloud feature | Stop; design the missing extension point in CE first (D3) |
