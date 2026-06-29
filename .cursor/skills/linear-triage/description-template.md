# Triage description template

Use when composing the `description` field for Linear `save_issue`. Replace `{placeholders}`. Keep `## Report` at the top — verbatim reporter text.

**Summary (title):** set via `save_issue` → `title` per [summary-patterns.md](summary-patterns.md).

Header after sync:

```markdown
**Linear:** SB-{N} · **GitHub:** #{N}
```

## Full template

```markdown
## Report

{Original description — reporter wording, unchanged}

## Regression

{Regression Bugs only: "Regression from SB-N / #N (Done/Closed). Original fix incomplete or re-introduced."}

## Classification

{Scope paragraph + spec § refs}

## {Feature flow name}

{Numbered steps, code paths}

## Failure modes / gates

| Gate | Effect |
|---|---|
| {condition} | {what breaks} |

## Suspects (ranked)

1. **{Top suspect}** — {why}

## Recommended triage

1. {Concrete check}

## Key files

- `{path}` — {role}
```

## Anti-patterns

- Posting findings as **comments** instead of updating **description**
- Paraphrasing `## Report`
- Setting In Progress / In Review / Done during triage
- Re-opening Done/Closed issues — create new Regression Bug with `regression` label
