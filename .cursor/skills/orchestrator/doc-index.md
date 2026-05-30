# SlugBase — Spec doc index

Quick reference for orchestrator traceability and sub-agent **DOC REFERENCE** blocks.
Sub-agents read these files themselves — never paste content into prompts.

## Precedence (when docs conflict)

1. `docs/slugbase-mvp-spec.md` — product behaviour, architecture, data model, interface contracts, billing, security, resolved decisions

*(Additional docs will be added as the roadmap is drafted. Update this index when new spec docs are created.)*

## Doc shorthand (use in roadmap Doc Ref column)

| Shorthand | File | Covers |
|---|---|---|
| `spec` | `docs/slugbase-mvp-spec.md` | Full product & architecture spec |

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
| `spec §19` | Repository and package layout |
| `spec §20` | Explicitly out of scope for v1 (Fast-Follow list) |
| `spec §21` | Resolved decisions log |
| `spec §22` | CI/CD pipeline (GitHub Actions, single workflow file) |
| `spec §23` | Design system + UI prototype reference (`docs/design-prototype/V1/`); §23.4 = divergences where spec wins |

## UI / design source

`docs/design-prototype/V1/` is the **visual & interaction source of truth** (design tokens in `colors_and_type.css`; screens mapped in spec §23.2). The MVP spec is the **product source of truth** — on any conflict, spec wins (catalogued in spec §23.4). Any UI task must reference the matching prototype file(s) **and** check §23.4/§23.5 before building.

## Jira issue keys (board tracking)

Primary keys: `SB-*` on project **SB** (`https://mdg-labs.atlassian.net/browse/SB-N`).

| Field | Purpose |
|---|---|
| Issue key | Commit suffixes, session memory (`SB-12-20260531-a1b2.md`) |
| Roadmap ID (`customfield_10082`) | Plan-file task ID when mirrored (`P2-01`) |
| Legacy Key (`customfield_10083`) | Unused on greenfield SB — leave empty |

**Execution agents** set Jira **In Progress** (+ **In Review** before handoff) on leaf and epic parent when subtask; **verification agents** set **Done** after PASS — see [jira-board.md](jira-board.md).

## Default verification commands (update once stack is chosen)

Run from the repo root. Mark as `n/a` when not yet defined for the current phase.

| Check | Command |
|---|---|
| lint | `pnpm lint` |
| typecheck | `pnpm typecheck` |
| unit | `pnpm test:unit` |
| integration | `pnpm test:integration` |
| build | `pnpm build` |
| security audit | `pnpm audit --audit-level=high` |

**Stack note:** Exact commands depend on the tech stack decision (spec §19). Verifier marks Layer 2 as `n/a` for commands not yet defined.
