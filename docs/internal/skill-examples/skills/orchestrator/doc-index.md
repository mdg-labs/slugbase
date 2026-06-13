# Dispatch One — Spec Doc Index

Quick reference for orchestrator traceability and sub-agent **DOC REFERENCE** blocks.
Sub-agents read these files themselves — never paste content into prompts.

## Precedence (when docs conflict)

1. `docs/dispatch-one-decisions.md` — product behaviour
2. `docs/dispatch-one-mvp-implementation-spec.md` — implementation contract
3. `docs/dispatch-one-engineering-decisions.md` — engine / time / spawn / routing
4. `docs/dispatch-one-architecture.md` — infra, security, Infisical, CI/CD
5. `docs/dispatch-one-design-system.md` — UI / UX (frontend tasks)
6. `docs/dispatch-one-api-design.md` — WebSocket events (backend realtime)
7. `docs/dispatch-one-schema.md` — Prisma schema
8. `docs/dispatch-one-testing.md` — test commands and required coverage
9. Content sources (transcribe to `packages/data/`): `dispatch-one-incidents.md`, `vehicles-*.md`, `dispatch-one-skill-tree.md`
10. `docs/claude_design/V1/` — visual reference only, never feature spec

## Doc shorthand (use in roadmap Doc Ref column)

| Shorthand           | File                                           |
| ------------------- | ---------------------------------------------- |
| `decisions`         | `docs/dispatch-one-decisions.md`               |
| `impl-spec`         | `docs/dispatch-one-mvp-implementation-spec.md` |
| `engineering`       | `docs/dispatch-one-engineering-decisions.md`   |
| `architecture`      | `docs/dispatch-one-architecture.md`            |
| `design-system`     | `docs/dispatch-one-design-system.md`           |
| `api-design`        | `docs/dispatch-one-api-design.md`              |
| `schema`            | `docs/dispatch-one-schema.md`                  |
| `testing`           | `docs/dispatch-one-testing.md`                 |
| `incidents-content` | `docs/dispatch-one-incidents.md`               |
| `vehicles-fire`     | `docs/vehicles-fire-service.md`                |
| `vehicles-ems`      | `docs/vehicles-ems.md`                         |
| `vehicles-police`   | `docs/vehicles-police.md`                      |
| `vehicles-thw`      | `docs/vehicles-technical-relief.md`            |
| `skill-tree`        | `docs/dispatch-one-skill-tree.md`              |
| `osm-poi-ingest`    | `docs/dispatch-one-osm-poi-ingest.md`          |

Reference sections as `§N` or heading name, e.g. `impl-spec §4`, `impl-spec §5.2.1` (onboarding), `architecture §6.3`, `testing §6.4`.

Jira issue descriptions often cite the same shorthands — pass them through to sub-agents unchanged.

## Jira issue keys (board tracking)

Primary keys: `DO-*` on project **DO** (`https://mdg-labs.atlassian.net/browse/DO-N`).

| Field                            | Purpose                                                                    |
| -------------------------------- | -------------------------------------------------------------------------- |
| Issue key                        | Commit suffixes, session memory for new work (`DO-47-20260601-a1b2.md`)    |
| Legacy Key (`customfield_10044`) | Original t0ggles key on migrated issues — search when user cites `(FE-32)` |
| Roadmap ID (`customfield_10045`) | Plan-file task ID when mirrored (`P2-01`)                                  |

Not in the roadmap plan file: board-only work tracked in Jira. **Execution agents** set Jira **In Progress** (+ **In Review** before handoff) on leaf and epic parent when subtask; **verification agents** set **Done** after PASS — see [jira-board.md](jira-board.md).

## Default verification commands (from repo root)

Use after Phase 0 scaffold exists. Run inside `infisical run --env=development --` when secrets are required.

| Check           | Command                 |
| --------------- | ----------------------- |
| unit            | `pnpm test:unit`        |
| integration     | `pnpm test:integration` |
| lint            | `pnpm lint`             |
| typecheck       | `pnpm typecheck`        |
| data validation | `pnpm test:data`        |
| build           | `pnpm build`            |

If a command is not yet defined for the task's phase, verifier marks Layer 2 as `n/a` and notes which commands were skipped.

## Infisical

| Context                          | Environment   |
| -------------------------------- | ------------- |
| Local dev / CI integration tests | `development` |
| Staging deploy workflows         | `staging`     |
| Production deploy workflows      | `production`  |

Local: `infisical run --env=development -- <command>`
