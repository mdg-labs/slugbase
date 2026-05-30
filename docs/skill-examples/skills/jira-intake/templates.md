# Jira description templates

Copy and fill for MCP `description` fields. Replace `{placeholders}`. Use Jira browse URLs once issues exist: `https://mdg-labs.atlassian.net/browse/DO-N`.

**Summaries** (issue titles) are set on `createJiraIssue` / `editJiraIssue` separately — follow [summary-patterns.md](../jira-triage/summary-patterns.md):

| Type  | Example summary                                     |
| ----- | --------------------------------------------------- |
| Epic  | `Routed return legs`                                |
| Story | `Show routed ETA in dispatch vehicle picker`        |
| Task  | `Add Redis lock helper for spawn scheduler`         |
| Bug   | `Spawn: duplicate incidents when player reconnects` |

## Epic parent template

```markdown
## Epic: {Feature name}

**Fix version:** {MVP Alpha | Closed Beta | Public Launch v1.0.0}

**Background:** {Current behaviour + why we're changing it}. {Link to related Done issues, e.g. [DO-12](https://mdg-labs.atlassian.net/browse/DO-12) ✅}.

---

### Subtasks

| Issue                                                | Domain   | Description |
| ---------------------------------------------------- | -------- | ----------- |
| [DO-XX](https://mdg-labs.atlassian.net/browse/DO-XX) | Backend  | {one line}  |
| [DO-YY](https://mdg-labs.atlassian.net/browse/DO-YY) | Frontend | {one line}  |

---

### Goal

{One paragraph: what players/operators can do when this epic is done.}

---

### Product rules (epic-level)

- {Rule 1 — e.g. endpoint behaviour, error codes}
- {Rule 2 — e.g. no tokens until verified}
- {Grandfather / migration rule if any}

---

### Suggested implementation order

1. **DO-XX** + **DO-YY** (parallel)
2. **DO-ZZ**
3. **DO-WW**

---

See child issue descriptions for acceptance criteria, file paths, and tests.
```

## Backend subtask template

```markdown
## {Title}

**Parent epic:** [DO-XX {Epic title}](https://mdg-labs.atlassian.net/browse/DO-XX)

**Depends on:** [DO-YY Schema](https://mdg-labs.atlassian.net/browse/DO-YY)

**Blocks:** [DO-ZZ UI task](https://mdg-labs.atlassian.net/browse/DO-ZZ)

---

### Prisma / schema

- `{Model.field}` — {type, purpose}

---

### Endpoints / services

**{METHOD} {path}** — {behaviour summary}

---

### Acceptance criteria

- [ ] {Concrete, testable outcome}
- [ ] Migration via `pnpm migrate:dev` only (no hand-written SQL)
- [ ] Update `docs/dispatch-one-schema.md` if schema changed

---

### Files
```

apps/backend/prisma/schema.prisma
apps/backend/src/modules/{module}/

```

---

### Tests

- `pnpm test:integration --filter backend -- {scope}`
- Unit: `{file}.spec.ts`
```

## Frontend subtask template

```markdown
## {Title}

**Parent epic:** [DO-XX {Epic title}](https://mdg-labs.atlassian.net/browse/DO-XX)

**Depends on:** [DO-YY API task](https://mdg-labs.atlassian.net/browse/DO-YY)

---

### Pages / routes

- `{/route}` — {purpose}

---

### Acceptance criteria

- [ ] {UI outcome}
- [ ] All player-facing strings via `next-intl` + Tolgee

---

### Files
```

apps/web/src/...

```

---

### Tests

- `pnpm test:unit --filter web -- {scope}`
```

## Single-issue template (no epic)

Use for Bugs, chores, or one-shot Stories — include full AC, Files, Tests; omit parent epic section.
