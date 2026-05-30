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

## Stack decisions pending

Tech stack (framework, ORM, migration tool) not yet decided — see spec §19 and §11.9. The DB MIGRATIONS block in prompt-templates.md is currently generic. Once stack is chosen, update: prompt-templates.md MIGRATIONS block, doc-index.md verification commands, 00-project.mdc tech stack section, and add framework-specific rules (e.g. prisma.mdc, backend.mdc, typescript.mdc).
_added: 2026-05-31_

## Confirmed tooling decisions (2026-05-31)

| Concern | Tool | Notes |
|---|---|---|
| Secrets management | **Infisical** | Same setup as Dispatch One; envs: `development` / `staging` / `production`; OIDC sync for prod |
| Translations | **Tolgee** | v1: en + de (spec §17); externalized message catalogs; Tolgee SDK integration (framework TBD) |

Rules touched: `00-project.mdc` (tech-stack section), `05-env-vars.mdc` (Infisical workflow), `10-i18n.mdc` (new — Tolgee rule).
Once Tolgee project is initialized, add `TOLGEE_PROJECT_ID` to the key inventory in `05-env-vars.mdc`.
_added: 2026-05-31_
