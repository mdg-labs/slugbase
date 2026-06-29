# Issue summary patterns

Single source of truth for **issue summary** (title) conventions on the SlugBase Linear team (`SB-N`). Both `linear-triage` and `linear-intake` must follow this table.

## Pattern table

| Issue type | Pattern | Examples |
|---|---|---|
| **Bug** | `{Area}: {observed defect}` | `Slugs: collision page shown for unambiguous slug` |
| **Task** | `{Verb} {target}` | `Add SSRF-safe egress service for metadata fetch` |
| **Feature** | `{Feature name}` — no "(epic)" suffix | `Server-side session infrastructure` |

## Area prefixes

`Bookmarks` · `Slugs` · `Go` · `Folders` · `Tags` · `Workspaces` · `Auth` · `MFA` · `OIDC` · `Sessions` · `Billing` · `Entitlements` · `Admin` · `Dashboard` · `Search` · `Import` · `Export` · `Marketing` · `i18n` · `CI` · `Infra` · `API`

Cross-check the **domain label** — area prefix and domain should not contradict.

## Length

≤ **80 characters** where possible.

## Rewrite vs keep

| Situation | Action |
|---|---|
| Vague placeholder | Rewrite using pattern row |
| Typo or wrong area | Rewrite |
| Already matches pattern | Keep |
| User explicit summary | Use user wording |

## When to update summary

| Skill | When |
|---|---|
| **linear-triage** | After investigation — `save_issue` with `title` + `description` |
| **linear-intake** | On create; on enrich when draft is vague |
