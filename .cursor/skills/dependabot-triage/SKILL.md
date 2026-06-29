---
name: dependabot-triage
description: >-
  Fetch a Dependabot security alert from the slugbase repo via gh CLI, search
  Linear/GitHub for a duplicate Bug, and create a Linear Bug if no open duplicate
  exists. Records both SB-N and #N after sync. Use when the user references a
  Dependabot alert number, CVE/GHSA ID, or asks to triage a dependency vulnerability.
---

# Dependabot triage (SlugBase)

Fetch alert details from GitHub, search Linear for duplicates, create a Linear Bug if none found. Two-way sync creates GitHub mirror.

Board: [orchestrator/linear-board.md](../orchestrator/linear-board.md). Intake patterns: [linear-intake/SKILL.md](../linear-intake/SKILL.md).

## When to use

| User input | Action |
|---|---|
| Alert number `#2` | Fetch → search → create |
| CVE/GHSA ID | Filter open alerts → search → create |
| Security alert URL | Extract number → fetch → search → create |
| "Ticket for ws vulnerability?" | Search only |

## Hard rules

1. **Never** dismiss alerts via GitHub API — see `08-dependabot-alerts.mdc`.
2. **No code changes** during triage.
3. **Do not** set In Progress or Done — leave at Ready or default Backlog after create.
4. **Linear-first** create via `save_issue`; record `SB-N` + synced `#N`.

## Constants

```text
Linear MCP: plugin-linear-linear
Team: SlugBase
GitHub: mdg-labs/slugbase
```

## Workflow

```
- [ ] Phase 1: Fetch alert (gh api REST)
- [ ] Phase 2: Search Linear duplicates (list_issues)
- [ ] Phase 3: Create Linear Bug (if no open duplicate)
- [ ] Phase 4: Summarise SB-N + #N in chat
```

### Phase 1 — Fetch alert

```bash
gh api repos/mdg-labs/slugbase/dependabot/alerts/<N>
```

Record: package, CVE, GHSA, severity, patched version, alert URL.

### Phase 2 — Duplicate search

```text
list_issues: { team: "SlugBase", query: "<package_name>" }
list_issues: { team: "SlugBase", query: "<cve_id>" }
```

- **Open duplicate** (not Done/Closed) → report `SB-N` / `#N`; do not create.
- **Done/Closed duplicate** → create anyway (regression or incomplete fix).
- **No duplicate** → Phase 3.

### Phase 3 — Create Bug

```text
save_issue:
  title: "dep(<package>): vulnerable to <cve> — bump to <patched>"
  team: "SlugBase"
  labels: ["domain:backend", "security", "dependabot"]
  priority: 1
  assignee: "me"
  description: "<template below>"
```

Poll `get_issue` for GitHub `#N`. Update description header:

```markdown
**Linear:** SB-{N} · **GitHub:** #{N}
```

**Description template:**

```markdown
## Report

Dependabot alert #<alert_number>: <summary>

## Alert details

- **Package:** `<package_name>`
- **Patched version:** `>= <patched_version>`
- **CVE:** <cve_id> · **GHSA:** <ghsa_id>
- **Alert URL:** <alert_url>

## Resolution path

Bump `<package_name>` per `08-dependabot-alerts.mdc`. Land fix on **`staging`**.
```

Optional: `save_issue { id: "SB-N", state: "Ready" }`.

### Phase 4 — Summarise

Report alert details, duplicate status, new `SB-N` / `#N` links, suggested next step (orchestrator implement).

## Tools

| Tool | Purpose |
|---|---|
| `gh api` REST | Dependabot alerts |
| `list_issues` | Duplicate check |
| `save_issue` | Create Bug |
| `get_issue` | Resolve synced GitHub # |

**Forbidden:** setting Done; posting findings as comments only; GraphQL project board.
