# SlugBase — Spec doc index

Quick reference for orchestrator traceability and sub-agent **DOC REFERENCE** blocks.
Sub-agents read these files themselves — never paste content into prompts.

## Precedence (when docs conflict)

1. `docs/internal/slugbase-mvp-spec.md` — **product source of truth**: behaviour, architecture, data model, interface contracts, billing, security, resolved decisions
2. `docs/internal/engineering-decisions.md` — **engineering source of truth**: stack, tooling, conventions, infra, CI commands (spec wins on product conflicts)
3. `docs/internal/defaults-and-constants.md` — pinned default/config values (slug grammar, caps, TTLs, rate limits, archive rule)
4. `docs/internal/design-prototype/V1/` — **visual/interaction source of truth** (spec wins on product conflict; divergences in spec §23.4)

The phased work plan is `docs/internal/slugbase-development-roadmap.md` (pre-GitHub; once converted, GitHub Issues is the execution source of truth). `schema-reference.md` / `api-design.md` grow incrementally with the roadmap — add them here when created.

## Doc shorthand (use in roadmap Doc Ref column)

| Shorthand | File | Covers |
|---|---|---|
| `spec` | `docs/internal/slugbase-mvp-spec.md` | Full product & architecture spec |
| `eng` | `docs/internal/engineering-decisions.md` | Stack, tooling, conventions, infra, CI commands |
| `def` | `docs/internal/defaults-and-constants.md` | Pinned defaults/constants |
| `proto` | `docs/internal/design-prototype/V1/` | Visual/interaction prototype (screen map spec §23.2) |
| `roadmap` | `docs/internal/slugbase-development-roadmap.md` | Phased task plan (pre-Jira) |

Reference sections as `§N` or heading, e.g. `spec §5`, `spec §11.4`, `spec §16`.

### Key spec sections for sub-agents

| Section | Topic |
|---|---|
| `spec §1` | Product vision and identity |
| `spec §2` | Fixed architectural decisions (single repo, pnpm, multi-tenant, interfaces) |
| `spec §3` | Core concepts and glossary (canonical vocabulary) |
| `spec §4` | Multi-tenant workspace model (tenancy, membership, data isolation) |
| `spec §5` | Identity, auth, sessions, TOTP MFA, OIDC, CSRF |
| `spec §6` | Bookmarks (lifecycle, metadata, SSRF-safe fetch, filtering, bulk ops) |
| `spec §7` | Folders and tags |
| `spec §8` | Slugs and link forwarding (`/go`) |
| `spec §9` | Search, command palette, dashboard |
| `spec §10` | Workspace administration and instance-wide admin |
| `spec §11` | External-dependency interface contracts (mail, AI, auth, billing, entitlements, analytics, error reporting, challenge, persistence, egress, crypto) |
| `spec §12` | Billing and plan enforcement (Free/Personal/Team/supporter, limits, downgrade overflow) |
| `spec §13` | Import and export (round-trip-complete, lossless) |
| `spec §14` | Self-hosted deployment story |
| `spec §15` | Configuration model (env, workspace/DB settings, user prefs) |
| `spec §16` | Data model (conceptual entities and relationships) |
| `spec §17` | Internationalization (English + German) |
| `spec §18` | Non-functional requirements (security, privacy, performance, observability, API) |
| `spec §19` | Technology stack + package layout (settled: NestJS, React Router v7, Astro, Drizzle, Zod/ts-rest, Tailwind/Radix/cmdk, Vitest/Playwright, Turborepo) |
| `spec §20` | Explicitly out of scope for v1 (Fast-Follow list) |
| `spec §21` | Resolved decisions log |
| `spec §22` | CI/CD pipeline (GitHub Actions, single workflow file) |
| `spec §23` | Design system + UI prototype reference (`docs/internal/design-prototype/V1/`); §23.4 = divergences where spec wins |

## UI / design source

`docs/internal/design-prototype/V1/` is the **visual & interaction source of truth** (design tokens in `colors_and_type.css`; screens mapped in spec §23.2). The MVP spec is the **product source of truth** — on any conflict, spec wins (catalogued in spec §23.4). Any UI task must reference the matching prototype file(s) **and** check §23.4/§23.5 before building.

## GitHub issue tracking

Issues tracked via GitHub Issues on `mdg-labs/slugbase`. Org-level issue types: Task, Bug, Feature. Org-level issue fields: Priority, Effort, Start date, Target date. Status via Projects v2.

| Field | Purpose |
|---|---|
| Issue number | Commit suffixes, session memory (`#12-20260531-a1b2.md`) |
| Labels | Domain routing (`domain:frontend`, `domain:backend`, etc.) |

**Execution agents** set project Status **In Progress** (+ **In Review** before handoff); **verification agents** set **Done** after PASS — see [github-board.md](github-board.md).

## Default verification commands (settled — spec §19)

Run from the repo root (Turborepo fans out to all packages). Mark a command `n/a` only when a package legitimately has no such task yet — never to skip a defined check.

| Check | Command |
|---|---|
| lint | `pnpm lint` |
| typecheck | `pnpm typecheck` |
| unit | `pnpm test:unit` (Vitest) |
| integration | `pnpm test:integration` (Vitest + Supertest) |
| build | `pnpm build` |
| security audit | `pnpm audit --audit-level=high` |
| e2e (CI only) | `pnpm test:e2e` (Playwright) — runs on the `staging → main` PR, **not** in per-task verification (spec §22.4) |

**Stack note (settled):** backend = NestJS · web = React Router v7 · marketing = Astro · persistence = Drizzle ORM + Drizzle Kit. Local env via Infisical (`infisical run --env=dev`).
