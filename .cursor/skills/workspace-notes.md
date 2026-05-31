# SlugBase — Workspace Notes

Durable project memory for orchestrator and sub-agents. Transient task notes belong in local session memory (gitignored), not here.

## Jira SB project — live constants (verified 2026-05-31)

Site: `mdg-labs.atlassian.net` · cloudId: `mdg-labs.atlassian.net` (hostname shorthand)
Transitions: Backlog `11` · Ready `2` · In Progress `21` · In Review `31` · Done `41` · Paused `4` · Cancelled `3`
Domain field: `customfield_10081` → Frontend `10092` · Backend `10093` · Infra `10094` · Ops `10095`
Roadmap ID: `customfield_10082` · Legacy Key: `customfield_10083` (unused on greenfield SB)
Fix versions: `MVP Alpha` · `Public Launch v1.0.0`
Depends link type id: `10006` (outward: `depends on`, inward: `is required by`)
Probe issue SB-1 was created to resolve transitions — it can be deleted or left as a backlog item.
_added: 2026-05-31_

## Session memory — local + Jira handoff

`.cursor/skills/agent-memory/` is **gitignored**. Execution/verifier agents write session files locally during a run; **never commit** them. Verifier → **Done** posts a structured summary via `addCommentToJiraIssue` on the leaf issue; **Ready** (FAIL) posts layer failures. One implementation commit per task. See orchestrator SKILL.md + jira-board.md § Verifier Done comment.
_added: 2026-05-31_

## Jira Depends link type

Site link type **Depends**: outward `depends on`, inward `is required by` (id `10006`). MCP: `inwardIssue` = prerequisite, `outwardIssue` = dependent. JQL: `issue in linkedIssues("SB-N", "depends on")`.
_added: 2026-05-31_

## Security model — server-side sessions only (spec §5.3, decision #9)

SlugBase uses **server-side sessions**, not JWT access + refresh. Never introduce JWT cookies, `localStorage` token storage, or refresh-token rotation. Active-workspace selection lives in the session (spec §4.3). Personal API tokens are long-lived, hashed, bypass MFA. All mutations are CSRF-protected except the explicit allowlist in spec §5.8.
_added: 2026-05-31_

## No deployment-mode branches (spec §15, §1)

Never introduce `isCloud`, `SLUGBASE_MODE`, or any deployment-mode conditional in application logic. Differences between hosted and self-hosted are expressed via (a) the entitlements engine (spec §11.5) and (b) interface implementation selection. Verifier Layer 3e fails on any deployment-mode branch found in committed code.
_added: 2026-05-31_

## CI/CD pipeline (2026-05-31)

Single file: `.github/workflows/ci-cd.yml`. GitHub-hosted runners (`ubuntu-latest`). Modelled on Dispatch One pattern.
Triggers: PR → `staging`/`main` · push `staging` (staging deploy) · push `main` (prepare release) · release published (production deploy) · `workflow_dispatch`.
Secrets: Infisical OIDC via `Infisical/secrets-action` — only two GHA secrets: `INFISICAL_DOMAIN` + `INFISICAL_OIDC_IDENTITY_ID`.
Key differences from Dispatch One: hosted runners (no Docker cleanup), no worker service, no admin package in v1, self-hosted GHCR image build on release.
Spec: §22. Resolved decision #35.
_added: 2026-05-31_

## Design system + UI prototype (2026-05-31)

`docs/design-prototype/V1/` = **visual/interaction source of truth**; MVP spec = **product source of truth** (spec wins on conflict). Spec §23 documents it; §23.2 maps screens→files, §23.4 lists divergences, §23.5 lists under-built v1 features. Rule: `11-design-system.mdc`.
Tokens (`colors_and_type.css`): accent periwinkle `#7782f7`, dark-first, IBM Plex Sans/Mono, 4px spacing, semantic success/warn/danger. Consume token vars — never hard-code.
**Spec-wins divergences:** paid tier = "Personal" (not "Pro"); Free cap = 50 (not 100); no folder cap; API tokens not plan-gated; no custom-domain entitlement v1; no workspace-id-in-URL v1; prices/seats/`go.slugbase.app` are config-driven.
Prototype is React-via-CDN/Babel/localStorage/mock data — demonstrates design only, not the build target. Re-implement against Tolgee catalog (no copying English strings).
_added: 2026-05-31_

## Stack decisions (settled 2026-05-31 — spec §19, decisions #37–#50)

| Concern | Choice |
|---|---|
| Language | TypeScript (strict, no `any`) |
| Backend | NestJS (DI hosts the config-selected external interfaces) |
| Web client | React Router v7 (framework mode) — CF Workers (hosted) + Node (self-host image) |
| Marketing | Astro (static) on CF Workers |
| Persistence | Drizzle ORM + Drizzle Kit; thin dialect layer over SQLite (self-host) + Neon Postgres (hosted) |
| Contracts/validation | Zod + ts-rest (in `shared-types`) → OpenAPI |
| UI | Tailwind (token-bridged) + Radix + cmdk |
| Tests | Vitest + Supertest (unit/integration) + Playwright (e2e, CI only) |
| Build | Turborepo over the pnpm workspace |
| Sessions | DB-backed server-side (no Redis) |
| Security | argon2id · otplib TOTP · double-submit CSRF |
| AI provider (v1) | OpenAI behind the AI interface |
| Packages | `backend` · `web` · `marketing` · `shared-types` · `ui` · `docs` |

DB migrations: **Drizzle Kit** (`drizzle-kit generate` to create, `drizzle-kit migrate` to apply) — one forward-only history; never hand-write SQL or use `drizzle-kit push`. Rules/skills updated to match: `00-project.mdc`, `06-local-ci-before-commit.mdc`, `10-i18n.mdc`, `11-design-system.mdc`, orchestrator `doc-index.md` + `prompt-templates.md` + `SKILL.md`.
_added: 2026-05-31_

## Confirmed tooling decisions (2026-05-31)

| Concern | Tool | Notes |
|---|---|---|
| Secrets management | **Infisical** | Same setup as Dispatch One; envs: `development` / `staging` / `production`; OIDC sync for prod |
| Translations | **Tolgee** | v1: en + de (spec §17); externalized message catalogs; Tolgee React SDK in the `web` (React Router v7) app + shared Tolgee project for Astro marketing |

Rules touched: `00-project.mdc` (tech-stack section), `05-env-vars.mdc` (Infisical workflow), `10-i18n.mdc` (new — Tolgee rule).
Once Tolgee project is initialized, add `TOLGEE_PROJECT_ID` to the key inventory in `05-env-vars.mdc`.
_added: 2026-05-31_

## Hosted infrastructure topology (2026-05-31)

| Layer | Platform | Region |
|---|---|---|
| Web client (frontend) | **Cloudflare Workers** | Global edge |
| API / back-end | **Fly.io** app — `fra` | Frankfurt, DE |
| Database | **Neon Postgres** — `aws-eu-central-1` | Frankfurt, DE (same AWS zone as Fly `fra`) |
| Marketing site | **Cloudflare Workers** | Global edge; separately built — spec §19 |

Fly.io `fra` chosen over Railway because Railway's only EU region (Amsterdam) has no collocated Neon Postgres region → cross-region DB latency on every query.
Self-hosted: combined container image, unaffected by hosted topology.
Key env vars: `APP_BASE_URL` = Fly.io app domain (or custom), `FRONTEND_ORIGIN` = CF Workers domain.
Spec: §14.7, resolved decisions 31–32.
_added: 2026-05-31_
