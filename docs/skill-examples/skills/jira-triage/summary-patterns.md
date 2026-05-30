# Issue summary patterns

Single source of truth for **issue summary** (title) conventions on project **DO**. Both [jira-triage](SKILL.md) and [jira-intake](../jira-intake/SKILL.md) must follow this table when creating or updating issues.

## Pattern table

| Issue type | Pattern                               | Examples                                                    |
| ---------- | ------------------------------------- | ----------------------------------------------------------- |
| **Bug**    | `{Area}: {observed defect}`           | `Map: vehicle icon shown while on scene or at station`      |
| **Task**   | `{Verb} {target}`                     | `Align jira-triage and jira-intake summary and Ready rules` |
| **Story**  | `{Player-visible outcome}`            | `Show routed ETA in dispatch vehicle picker`                |
| **Epic**   | `{Feature name}` — no `(epic)` suffix | `Routed return legs`                                        |

## Area prefixes

Use for **Bug** summaries and when a prefix clarifies scope on other types:

`Map` · `Web` · `WebSocket` · `Auth` · `Dispatch` · `Incidents` · `Spawn` · `Vehicles` · `Stations` · `Alliance` · `Worker` · `Backend` · `Data` · `CI` · `Infra` · `Agent skills` · `i18n`

Cross-check the Jira **Domain** custom field (`Frontend`, `Backend`, `Infrastructure`, `Operations`) — area prefix and Domain should not contradict.

## Length

≤ **80 characters** where possible.

## Rewrite vs keep

| Situation                                                              | Action                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------- |
| Vague placeholder (`"concise defect title"`, `"concise action title"`) | Rewrite using the pattern row for that issue type |
| Typo, wrong area prefix, or mis-scoped title                           | Rewrite                                           |
| Already matches the pattern and is accurate                            | Keep unchanged                                    |
| User explicitly asked for a specific summary                           | Use user wording (still ≤ 80 chars if practical)  |

## When to update summary

| Skill           | When                                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------- |
| **jira-triage** | After investigation, when rewrite rules apply — include in `editJiraIssue` alongside description    |
| **jira-intake** | On `createJiraIssue` (Epic + leaves); on enrich when draft summary is vague per rewrite rules above |
