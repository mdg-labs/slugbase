# Issue description templates

Copy and fill for Linear issue descriptions (`save_issue` → `description`). Replace `{placeholders}`. Reference issues with `SB-N` and synced `#N`.

**Summaries** (titles) follow [../linear-triage/summary-patterns.md](../linear-triage/summary-patterns.md).

Every created issue description should start with:

```markdown
**Linear:** SB-{N} · **GitHub:** #{N}
```

(Add GitHub line after sync settles; update description once `#N` is known.)

## Feature (epic) parent template

```markdown
**Linear:** SB-{N} · **GitHub:** #{N}

## Feature: {Feature name}

**Background:** {Current behaviour + why we're changing it}. {spec § refs or Related: SB-X / #X ✅}.

---

### Sub-issues

| Linear | GitHub | Domain | Description |
|---|---|---|---|
| SB-XX | #XX | Backend | {one line} |
| SB-YY | #YY | Frontend | {one line} |

---

### Goal

{One paragraph: what users can do when done.}

---

### Product rules (epic-level)

- {Rule 1 — spec §…}
- {Defer/Fast-Follow — spec §20}

---

### Suggested implementation order

1. **SB-XX** + **SB-YY** (parallel)
2. **SB-ZZ**

---

See child descriptions for acceptance criteria, file paths, and tests.
```

## Backend subtask template

```markdown
**Linear:** SB-{N} · **GitHub:** #{N}

## {Title}

**Parent feature:** SB-XX / #XX {Feature title}

**Depends on:** SB-YY / #YY {dependency}

**Spec refs:** {e.g. spec §5.3}

---

### Acceptance criteria

- [ ] {Concrete, testable outcome}
- [ ] DB changes use Drizzle Kit only
- [ ] No deployment-mode branches — entitlements only (spec §15)
- [ ] New env vars fully registered (05-env-vars.mdc)

---

### Files

```
packages/backend/src/{module}/
```

---

### Tests

- Unit: `{file}.spec.ts`
- Integration: `{feature}.e2e-spec.ts`
```

## Frontend subtask template

Same structure as backend; include i18n AC (spec §17) and modal-only bookmark editing (spec §6.2).

## Single-issue template (no epic)

Use for Bugs, chores, or one-shot Tasks — full AC; omit parent section.
