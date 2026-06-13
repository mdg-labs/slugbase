# Issue description templates

Copy and fill for GitHub issue bodies. Replace `{placeholders}`. Reference issues with `#N` syntax.

**Summaries** (issue titles) are set on creation or update — follow [summary-patterns.md](../github-triage/summary-patterns.md):

| Type | Example summary |
|---|---|
| Feature (epic) | `Server-side session infrastructure` |
| Task | `Add SSRF-safe egress service for metadata fetch` |
| Bug | `Slugs: collision page shown for unambiguous slug` |

**Milestone must be set on every issue creation.** Agents must fetch available milestones first and pick the earliest open one by due date unless the user specifies otherwise (see [github-intake § Milestones](../github-intake/SKILL.md)).

## Feature (epic) parent template

```markdown
## Feature: {Feature name}

**Background:** {Current behaviour + why we're changing it}. {Link to related completed issues or spec sections, e.g. [spec §8](docs/internal/slugbase-mvp-spec.md#8-slugs-and-link-forwarding) or #5 ✅}.

---

### Sub-issues

| Issue | Domain | Description |
|---|---|---|
| #XX | Backend | {one line} |
| #YY | Frontend | {one line} |

---

### Goal

{One paragraph: what users or operators can do when this feature is done.}

---

### Product rules (epic-level)

- {Rule 1 — from spec, e.g. spec §5.3: server-side sessions, no JWT cookies}
- {Rule 2 — e.g. spec §4.3: active workspace carried in session}
- {Defer/Fast-Follow note if relevant — spec §20}

---

### Suggested implementation order

1. **#XX** + **#YY** (parallel)
2. **#ZZ**
3. **#WW**

---

See child issue descriptions for acceptance criteria, file paths, and tests.
```

## Backend subtask template

```markdown
## {Title}

**Parent feature:** #XX {Feature title}

**Depends on:** #YY {dependency}

**Spec refs:** {e.g. spec §5.3 — server-side sessions; spec §11.9 — persistence interface}

---

### Schema / data model

- `{Entity.field}` — {type, purpose} — spec §16 {entity name}

---

### Endpoints / services

**{METHOD} {path}** — {behaviour summary per spec}

---

### Acceptance criteria

- [ ] {Concrete, testable outcome}
- [ ] DB changes use migration tooling only (no hand-written SQL) — see DB MIGRATIONS block
- [ ] No deployment-mode branches (`isCloud`) — entitlements engine only (spec §15)
- [ ] All new env vars registered (Infisical + .env.example + schema + docs) (05-env-vars.mdc)

---

### Files

```
packages/backend/src/{module}/
packages/shared-types/src/
```

---

### Tests

- Unit: `{file}.spec.ts`
- Integration: `{feature}.e2e-spec.ts`
```

## Frontend subtask template

```markdown
## {Title}

**Parent feature:** #XX {Feature title}

**Depends on:** #YY API task

**Spec refs:** {e.g. spec §9 — command palette; spec §6.5 — bookmark list UI}

---

### Pages / routes / components

- `{/route}` or `{ComponentName}` — {purpose}

---

### Acceptance criteria

- [ ] {UI outcome}
- [ ] All user-facing strings via the i18n layer — no hardcoded English or German (spec §17)
- [ ] Modal-only editing for bookmarks — no separate detail route (spec §6.2)

---

### Files

```
packages/web/src/...
```

---

### Tests

- Unit: `{Component}.spec.ts`
```

## Single-issue template (no epic)

Use for Bugs, chores, or one-shot Tasks — include full AC, Files, Tests; omit parent feature section. Always include spec refs where applicable.
