---
name: dependabot-triage
description: >-
  Fetch a Dependabot security alert from the slugbase repo via gh CLI, search
  GitHub Issues for a duplicate Bug covering the same package or CVE, and create
  a new Bug if no open duplicate exists. Use when the user references a Dependabot
  alert number, CVE/GHSA ID, GitHub security URL, or asks to triage a dependency
  vulnerability.
---

# Dependabot triage (SlugBase)

Fetch alert details from GitHub, search GitHub Issues for duplicates, create a Bug if none found.

Board constants: [orchestrator/github-board.md](../orchestrator/github-board.md).

## When to use

| User input | Action |
|---|---|
| Alert number `#2`, `alert 2` | Fetch by number → search → create |
| CVE/GHSA ID (`CVE-2026-45736`) | Filter open alerts by CVE → search → create |
| GitHub security alert URL | Extract number → fetch → search → create |
| "Is there a ticket for the ws vulnerability?" | Search only, no creation |

## Hard rules

1. **Never** call `PATCH state=dismissed` on any alert — not even for testing. See `.cursor/rules/08-dependabot-alerts.mdc`.
2. **No code changes** during triage.
3. **Do not change issue status** (leave new bugs at default Todo).
4. Use MCP `issue_write` (method: update) when re-triaging an existing issue; MCP `issue_write` (method: create) for new ones.

## Board constants

```text
Owner: mdg-labs
Repo: slugbase
```

## Workflow

```
- [ ] Phase 1: Resolve alert from GitHub
- [ ] Phase 2: Search GitHub Issues for duplicates
- [ ] Phase 3: Create Bug (if no open duplicate)
- [ ] Phase 4: Summarise in chat
```

---

### Phase 1 — Fetch alert from GitHub

**By alert number:**

```bash
gh api repos/mdg-labs/slugbase/dependabot/alerts/<N>
```

**By CVE or GHSA (scan open alerts):**

```bash
gh api "repos/mdg-labs/slugbase/dependabot/alerts?state=open&per_page=100" \
  | jq '[.[] | select(.security_advisory.cve_id == "<CVE>" or .security_advisory.ghsa_id == "<GHSA>")]'
```

Extract and record:

- `alert_number`
- `alert_url` — `https://github.com/mdg-labs/slugbase/security/dependabot/<alert_number>`
- `package_name` — `dependency.package.name`
- `ecosystem` — `dependency.package.ecosystem`
- `manifest_path` — `dependency.manifest_path`
- `vulnerable_range` — `security_vulnerability.vulnerable_version_range`
- `patched_version` — `security_vulnerability.first_patched_version.identifier`
- `severity` — `security_vulnerability.severity`
- `cvss_score` — `security_advisory.cvss.score`
- `cve_id` — `security_advisory.cve_id`
- `ghsa_id` — `security_advisory.ghsa_id`
- `summary` — `security_advisory.summary`

---

### Phase 2 — GitHub duplicate search

Search open issues for duplicates by package name and CVE/GHSA:

```text
# By package name
MCP search_issues: { query: "<package_name>", owner: "mdg-labs", repo: "slugbase" }

# By CVE/GHSA
MCP search_issues: { query: "<cve_id> OR <ghsa_id>", owner: "mdg-labs", repo: "slugbase" }
```

**Duplicate rules:**

- **Open duplicate found** (Todo / In Progress / In Review) → report the existing issue number; do **not** create.
- **Done/Duplicate duplicate found** → create anyway (potential regression or incomplete fix).
- **No duplicate** → proceed to Phase 3.

---

### Phase 3 — Create Bug

Determine the affected domain:
- `pnpm` / JS / TS packages → `domain:backend` or `domain:frontend` based on `manifest_path`
- Infrastructure / build tooling → `domain:infrastructure`

```text
MCP issue_write (method: create):
- owner: mdg-labs
- repo: slugbase
- title: "dep(<package_name>): vulnerable to <cve_id> — bump to <patched_version>"
- type: "Bug"
- labels: ["domain:backend", "security", "dependabot"]
- body: "<description template below>"
- issue_fields: [{ field_name: "Priority", field_option_name: "Urgent" }, { field_name: "Effort", field_option_name: "Medium" }]
```

Dependabot bugs default to **Priority: Urgent** (security) and **Effort: Medium** (upgrade + test). Override if the advisory severity is low.

**Description template:**

```markdown
## Report

Dependabot alert #<alert_number>: <summary>

## Alert details

- **Package:** `<package_name>` (<ecosystem>)
- **Manifest:** `<manifest_path>`
- **Vulnerable range:** `<vulnerable_range>`
- **Patched version:** `>= <patched_version>`
- **Severity:** <severity> (CVSS <cvss_score>)
- **CVE:** <cve_id>
- **GHSA:** <ghsa_id>
- **Alert URL:** <alert_url>

## Resolution path

Bump `<package_name>` to `>= <patched_version>`.

If transitive: add to `pnpm.overrides` in root `package.json` and run `pnpm install`.
If direct: upgrade in the affected workspace `package.json` directly.

The commit must land on **`staging`** (development integration branch) for GitHub to auto-close the alert when `staging` is the scanned default branch — promote to `main` only via release.
See `.cursor/rules/08-dependabot-alerts.mdc` for the correct fix workflow.
```

Leave status at default (Todo). Do not set In Progress or Done.

---

### Phase 4 — Summarise in chat

Report:

- Alert details (package, CVE, severity)
- Duplicate found? → number + link; or "No duplicate — created #N"
- New issue link if created
- Suggested next step (implement fix via orchestrator, or link existing issue to the alert)

---

## GitHub tools used

| Tool | Purpose |
|---|---|
| CLI `gh api` (REST) | Fetch Dependabot alert (no MCP tool) |
| MCP `search_issues` | Duplicate check |
| MCP `issue_write` (create) | New Bug creation (type + labels + fields) |
| MCP `issue_write` (update) | Re-triage update |

**Forbidden during triage:** setting In Progress / In Review / Done; posting findings as issue comments (use body instead); creating issues via `gh issue create` (use MCP `issue_write` instead).
