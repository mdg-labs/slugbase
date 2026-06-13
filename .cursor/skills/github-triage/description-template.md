# Triage description template

Use when composing the `body` field for MCP `issue_write` (method: update or create). Replace `{placeholders}`. Keep `## Report` at the top — verbatim reporter text.

**Summary (title):** set separately via MCP `issue_write` → `title` parameter per [summary-patterns.md](summary-patterns.md) — e.g. `Slugs: collision page shown for unambiguous slug` for Bugs.

## Full template

```markdown
## Report

{Original issue description — reporter wording, unchanged}

## Regression

{Only for Regression Bugs. Reference the originating Done/Closed issue: "This is a regression / escaped defect from issue #N which was previously marked Done/Closed. The original fix appears to be incomplete or was re-introduced."}

## Classification

{One paragraph: Frontend / Backend / Infrastructure / cross-cutting. Note if domain label mismatches code ownership. Reference spec section if relevant, e.g. spec §8.2 for Go/redirect issues.}

## {Feature flow or system name}

{How the affected feature works end-to-end — numbered steps, code references by path.
E.g. "Go redirect flow (spec §8)", "Session resolution (spec §5.3)", "Entitlement check (spec §11.5)"}

## Failure modes / gates

| Gate | Effect |
|---|---|
| {condition} | {what breaks} |

## Suspects (ranked)

1. **{Top suspect}** (`{commit}` if known) — {why; what to check}
2. **{Second suspect}** — {why}

## Separate issues

{Unrelated bugs found during investigation — or omit section.}

## Recommended triage

1. {Concrete developer check}
2. …

## Key files

- `{path/to/file.ts}` — {one-line role}
```

## Section guide

| Section | Required | Notes |
|---|---|---|
| `## Report` | **Yes** | Always first. Verbatim original reporter text. |
| `## Classification` | Yes | Scope + ownership mismatch; spec section refs where helpful |
| `## Regression` | When applicable | Only for Regression Bugs (originating issue had board Status Done/Closed). Links to `#N` and notes it's a regression/escaped defect. |
| Flow section | When applicable | Name for domain: `Go redirect flow`, `Session resolution`, `Entitlement check`, etc. |
| `## Failure modes / gates` | When applicable | Table of blocking conditions |
| `## Suspects (ranked)` | Yes | Numbered; deploy commits first when "since deploy" |
| `## Recommended triage` | Yes | Actionable checks before coding |
| `## Key files` | Yes | Paths only |

## Anti-patterns

- Posting the same content as an issue **comment** instead of updating **body**
- Paraphrasing the reporter's `## Report` text
- Setting In Progress / In Review / Done during triage (Ready from Todo only)
- Committing code fixes or editing repo files without an explicit user request
- Leaving triaged Todo issues in Todo when user did not opt out of updates
- Re-opening a Done/Closed issue instead of creating a new Regression Bug with the `regression` label
