---
name: dependabot-triage
description: >-
  Fetch a Dependabot security alert from mdg-labs/dispatch-one via gh CLI, search
  Jira for duplicate Bug issues covering the same package or CVE, and create a new
  Bug if no open duplicate exists. Use when the user references a Dependabot alert
  number, CVE/GHSA ID, GitHub security URL, or asks to triage a dependency
  vulnerability.
---

# Dependabot triage (Dispatch One)

Fetch alert details from GitHub, search Jira for duplicates, create a Bug if none found.

Board constants: [orchestrator/jira-board.md](../orchestrator/jira-board.md).

## When to use

| User input                                                       | Action                                      |
| ---------------------------------------------------------------- | ------------------------------------------- |
| Alert number `#2`, `alert 2`                                     | Fetch by number → search → create           |
| CVE/GHSA ID (`CVE-2026-45736`)                                   | Filter open alerts by CVE → search → create |
| `https://github.com/mdg-labs/dispatch-one/security/dependabot/2` | Extract number → fetch → search → create    |
| "Is there a ticket for the ws vulnerability?"                    | Search only, no creation                    |

## Hard rules

1. **Never** call `PATCH state=dismissed` on any alert — not even for testing. See `.cursor/rules/08-dependabot-alerts.mdc`.
2. **No code changes** during triage.
3. **Do not change Jira issue status** (leave new bugs at default Backlog).
4. Use `editJiraIssue` when re-triaging an existing issue; `createJiraIssue` for new ones.
5. Read MCP tool schemas under `mcps/plugin-atlassian-atlassian/tools/` before calling.

## Board constants

```text
MCP server: plugin-atlassian-atlassian
cloudId:    mdg-labs.atlassian.net
projectKey: DO
repo:       mdg-labs/dispatch-one
```

## Workflow

```
- [ ] Phase 1: Resolve alert from GitHub
- [ ] Phase 2: Search Jira for duplicates
- [ ] Phase 3: Create Bug (if no open duplicate)
- [ ] Phase 4: Summarise in chat
```

---

### Phase 1 — Fetch alert from GitHub

**By alert number:**

```bash
gh api repos/mdg-labs/dispatch-one/dependabot/alerts/<N>
```

**By CVE or GHSA (scan open alerts):**

```bash
gh api "repos/mdg-labs/dispatch-one/dependabot/alerts?state=open&per_page=100" \
  | jq '[.[] | select(.security_advisory.cve_id == "<CVE>" or .security_advisory.ghsa_id == "<GHSA>")]'
```

Extract and record:

- `alert_number` — used to build the alert URL
- `alert_url` — always `https://github.com/mdg-labs/dispatch-one/security/dependabot/<alert_number>`
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

### Phase 2 — Jira duplicate search

Run two JQL queries in parallel:

```text
# By package name
project = DO AND issuetype = Bug AND summary ~ "<package_name>" ORDER BY created DESC

# By CVE/GHSA
project = DO AND issuetype = Bug AND (description ~ "<cve_id>" OR description ~ "<ghsa_id>") ORDER BY created DESC
```

**Duplicate rules:**

- **Open duplicate found** (Backlog / Ready / In Progress / In Review) → report the existing issue key; do **not** create.
- **Done/Closed duplicate found** → create anyway (potential regression or incomplete fix).
- **No duplicate** → proceed to Phase 3.

---

### Phase 3 — Create Bug

```text
CallMcpTool plugin-atlassian-atlassian / createJiraIssue
  cloudId: mdg-labs.atlassian.net
  projectKey: DO
  issueTypeName: Bug
  summary: "dep(<package_name>): vulnerable to <cve_id> — bump to <patched_version>"
  labels: ["security", "dependabot"]
  description: <see template below>
```

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

The commit must land on `main` for GitHub to auto-close the alert.
See `.cursor/rules/08-dependabot-alerts.mdc` for the correct fix workflow.
```

Leave status at default (Backlog). Do not set In Progress or Done.

---

### Phase 4 — Summarise in chat

Report:

- Alert details (package, CVE, severity)
- Duplicate found? → key + link; or "No duplicate — created `DO-N`"
- New issue link if created: `https://mdg-labs.atlassian.net/browse/DO-N`
- Suggested next step (orchestrate fix, or link existing ticket to the alert)

---

## MCP tools used

| Tool                       | Purpose                                        |
| -------------------------- | ---------------------------------------------- |
| `searchJiraIssuesUsingJql` | Duplicate check                                |
| `createJiraIssue`          | New Bug creation                               |
| `editJiraIssue`            | Re-triage update                               |
| `getJiraIssue`             | Optional — read existing duplicate for context |

**Forbidden during triage:** `transitionJiraIssue`; `addCommentToJiraIssue` for findings (use description instead).
