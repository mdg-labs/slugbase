# Jira description templates

Copy and fill for MCP `description` fields. Replace `{placeholders}`. Use Jira browse URLs once issues exist: `https://mdg-labs.atlassian.net/browse/SB-N`.

**Summaries** (issue titles) are set on `createJiraIssue` / `editJiraIssue` separately — follow [summary-patterns.md](../jira-triage/summary-patterns.md):

| Type | Example summary |
|---|---|
| Epic | `Server-side session infrastructure` |
| Story | `Redirect to bookmark destination via /go/<slug>` |
| Task | `Add SSRF-safe egress service for metadata fetch` |
| Bug | `Slugs: collision page shown for unambiguous slug` |

## Epic parent template

```markdown
## Epic: {Feature name}

**Fix version:** {MVP Alpha | Public Launch v1.0.0}

**Background:** {Current behaviour + why we're changing it}. {Link to related Done issues or spec sections, e.g. [spec §8](docs/slugbase-mvp-spec.md#8-slugs-and-link-forwarding) or [SB-5](https://mdg-labs.atlassian.net/browse/SB-5) ✅}.

---

### Subtasks

| Issue | Domain | Description |
|---|---|---|
| [SB-XX](https://mdg-labs.atlassian.net/browse/SB-XX) | Backend | {one line} |
| [SB-YY](https://mdg-labs.atlassian.net/browse/SB-YY) | Frontend | {one line} |

---

### Goal

{One paragraph: what users or operators can do when this epic is done.}

---

### Product rules (epic-level)

- {Rule 1 — from spec, e.g. spec §5.3: server-side sessions, no JWT cookies}
- {Rule 2 — e.g. spec §4.3: active workspace carried in session}
- {Defer/Fast-Follow note if relevant — spec §20}

---

### Suggested implementation order

1. **SB-XX** + **SB-YY** (parallel)
2. **SB-ZZ**
3. **SB-WW**

---

See child issue descriptions for acceptance criteria, file paths, and tests.
```

## Backend subtask template

```markdown
## {Title}

**Parent epic:** [SB-XX {Epic title}](https://mdg-labs.atlassian.net/browse/SB-XX)

**Depends on:** [SB-YY {dependency}](https://mdg-labs.atlassian.net/browse/SB-YY)

**Blocks:** [SB-ZZ {dependent}](https://mdg-labs.atlassian.net/browse/SB-ZZ)

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
- [ ] All new env vars registered (Phase + .env.example + schema + docs) (05-env-vars.mdc)

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

**Parent epic:** [SB-XX {Epic title}](https://mdg-labs.atlassian.net/browse/SB-XX)

**Depends on:** [SB-YY API task](https://mdg-labs.atlassian.net/browse/SB-YY)

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

Use for Bugs, chores, or one-shot Stories — include full AC, Files, Tests; omit parent epic section. Always include spec refs where applicable.
