# Triage description template

Use when composing the `description` field for MCP `editJiraIssue` or `createJiraIssue`. Replace `{placeholders}`. Keep `## Report` at the top — verbatim reporter text.

**Summary (title):** set separately via `editJiraIssue` `summary` field per [summary-patterns.md](summary-patterns.md) — e.g. `Map: vehicle icon shown while on scene or at station` for Bugs.

## Full template

```markdown
## Report

{Original issue description — reporter wording, unchanged}

## Classification

{One paragraph: FE-only / BE-only / worker / infra / cross-cutting. Note if Domain field mismatches code ownership.}

## {Domain flow or system name}

{How the affected feature works end-to-end — numbered steps, code references by path.}

## Failure modes / gates

| Gate        | Effect        |
| ----------- | ------------- |
| {condition} | {what breaks} |

## Suspects (ranked)

1. **{Top suspect}** (`{commit}` if known) — {why; what to check}
2. **{Second suspect}** — {why}

## Separate issues

{Unrelated bugs found — or omit section.}

## Recommended triage

1. {Concrete operator/dev check}
2. …

## Key files

- `{path/to/file.ts}` — {one-line role}
```

## Section guide

| Section                    | Required        | Notes                                                |
| -------------------------- | --------------- | ---------------------------------------------------- |
| `## Report`                | **Yes**         | Always first. Verbatim original reporter text.       |
| `## Classification`        | Yes             | Scope + ownership mismatch                           |
| Flow section               | When applicable | Name for domain: `Spawn pipeline`, `Auth flow`, etc. |
| `## Failure modes / gates` | When applicable | Table of blocking conditions                         |
| `## Suspects (ranked)`     | Yes             | Numbered; deploy commits first when "since deploy"   |
| `## Recommended triage`    | Yes             | Actionable checks before coding                      |
| `## Key files`             | Yes             | Paths only                                           |

## Anti-patterns

- Posting the same content as a Jira **comment** instead of updating **description**
- Paraphrasing the reporter's `## Report` text
- Transitioning to In Progress / In Review / Done during triage (Ready from Backlog only — see SKILL.md)
- Committing code fixes or editing repo files without an explicit user request
- Leaving triaged Backlog issues in Backlog when user did not opt out of Jira updates
