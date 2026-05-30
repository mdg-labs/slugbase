# Issue summary patterns

Single source of truth for **issue summary** (title) conventions on project **SB**. Both `jira-triage` and `jira-intake` must follow this table when creating or updating issues.

## Pattern table

| Issue type | Pattern | Examples |
|---|---|---|
| **Bug** | `{Area}: {observed defect}` | `Slugs: collision page shown for unambiguous slug` |
| **Task** | `{Verb} {target}` | `Add SSRF-safe egress service for metadata fetch` |
| **Story** | `{User-visible outcome}` | `Redirect to bookmark destination via /go/<slug>` |
| **Epic** | `{Feature name}` — no `(epic)` suffix | `Server-side session infrastructure` |

## Area prefixes

Use for **Bug** summaries and when a prefix clarifies scope on other types:

`Bookmarks` · `Slugs` · `Go` · `Folders` · `Tags` · `Workspaces` · `Auth` · `MFA` · `OIDC` · `Sessions` · `Billing` · `Entitlements` · `Admin` · `Dashboard` · `Search` · `Import` · `Export` · `Marketing` · `i18n` · `CI` · `Infra` · `API`

Cross-check the Jira **Domain** custom field (`Frontend`, `Backend`, `Infrastructure`, `Operations`) — area prefix and Domain should not contradict.

## Length

≤ **80 characters** where possible.

## Rewrite vs keep

| Situation | Action |
|---|---|
| Vague placeholder (`"concise defect title"`, `"fix the bug"`) | Rewrite using the pattern row for that issue type |
| Typo, wrong area prefix, or mis-scoped title | Rewrite |
| Already matches the pattern and is accurate | Keep unchanged |
| User explicitly asked for a specific summary | Use user wording (still ≤ 80 chars if practical) |

## When to update summary

| Skill | When |
|---|---|
| **jira-triage** | After investigation, when rewrite rules apply — include in `editJiraIssue` alongside description |
| **jira-intake** | On `createJiraIssue` (Epic + leaves); on enrich when draft summary is vague per rewrite rules |
