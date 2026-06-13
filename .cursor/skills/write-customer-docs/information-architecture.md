# Information architecture

SlugBase public docs use Documentation.AI's **Dimensions → Views → Content** model. Source: `docs/public/documentation.json`.

## Product dimensions

Two top-level products — separate nav trees, shared concepts where behaviour matches:

| Product key | `documentation.json` product | Audience | Typical content |
|---|---|---|---|
| `selfhosted` | Self-hosted | Instance operators + workspace users on private installs | Install, upgrade, SMTP/OIDC operator config, first-run setup, unrestricted entitlements |
| `cloud` | Cloud | Hosted subscribers | Sign-up, billing, plan limits, cloud-specific operator-managed panels |

**Prefer separate pages** when cloud and self-hosted behaviour diverges (billing, SMTP, OIDC, workspace creation limits). **Shared concept pages** are acceptable when text is identical — but each product still needs its own `path` under the correct dimension if navigation differs.

Published URL: `selfhosted/quick-start.mdx` → `/selfhosted/quick-start`

## Tabs and groups

Current structure (greenfield):

```text
navigation.products[]
  └── product: "Self-hosted" | "Cloud"
        └── tabs[]
              └── tab: "Guides" (primary) | "API" (OpenAPI-generated, later)
                    └── groups[]
                          └── pages[]  OR  openapi: "…/api-reference/*.yaml"
```

### Suggested Guides groups (v1 starter)

Adapt per IA proposal — these are starting points, not mandatory names:

**Self-hosted**

| Group | Example pages | Audience |
|---|---|---|
| Getting started | `introduction`, `quick-start`, `first-run-setup` | Operator + end user |
| Using SlugBase | `bookmarks`, `folders`, `tags`, `slugs-and-forwarding`, `command-palette` | End user |
| Workspace administration | `members-and-teams`, `sharing`, `workspace-settings` | Workspace admin |
| Operator guide | `installation`, `configuration`, `smtp`, `oidc`, `upgrades`, `backup` | Operator |
| Troubleshooting | `common-issues`, `logs-and-health` | Operator |

**Cloud**

| Group | Example pages | Audience |
|---|---|---|
| Getting started | `introduction`, `create-account`, `quick-start` | End user |
| Using SlugBase | (mirror self-hosted user topics where identical) | End user |
| Plans and billing | `plans`, `upgrade`, `seats`, `billing-history` | Workspace owner |
| Workspace administration | `members-and-teams`, `sharing` | Workspace admin |
| Troubleshooting | `common-issues`, `account-access` | End user |

**API tab** — wire later via group-level `openapi` paths (see `docs/public/README.md`).

## Page inventory template

Produce this table in Phase 3 (IA proposal) before bulk writing:

```markdown
| path | title | type | audience | product | prerequisites |
|------|-------|------|----------|---------|---------------|
| selfhosted/introduction | Introduction to self-hosted SlugBase | concept | end-user | selfhosted | — |
| selfhosted/quick-start | Quick start | how-to | operator | selfhosted | introduction |
| cloud/plans | Plans and limits | concept | workspace-admin | cloud | cloud/introduction |
```

### Column rules

- **path** — lowercase-with-hyphens, matches future `.mdx` filename, no suffix
- **type** — `how-to` · `concept` · `operator-runbook` · `troubleshooting` · `reference`
- **audience** — `end-user` · `workspace-admin` · `operator`
- **product** — which dimension owns the page
- **prerequisites** — comma-separated paths readers should complete first (or `—`)

## Path naming conventions

| Rule | Good | Bad |
|---|---|---|
| Lowercase, hyphenated | `slugs-and-forwarding` | `SlugsAndForwarding` |
| Product prefix in path | `selfhosted/quick-start` | `quick-start` at repo root |
| No version in path | `installation` | `installation-v1` |
| Operator vs user split | `operator/smtp` or group label "Operator guide" | Mixing install steps with bookmark how-to on one page |

## `documentation.json` wiring checklist

For each new page:

1. Create `docs/public/{path}.mdx` with `title` and `description` frontmatter.
2. Add to the correct chain:

```json
{
  "title": "Quick start",
  "path": "selfhosted/quick-start",
  "icon": "zap"
}
```

3. Set `initialRoute` when adding the first page in a product (e.g. `selfhosted/introduction`).
4. Run `pnpm validate:docs-public`.

## Greenfield vs maintenance IA

| State | IA action |
|---|---|
| **Greenfield** (no MDX) | Propose full group structure + page inventory; get approval before writing |
| **New group in existing product** | Propose group name, icon, and page list; wire new `groups[]` entry |
| **Single page** | Confirm correct group; no full inventory required |
| **Maintenance** | Diff inventory against existing `documentation.json`; add/remove/rename paths explicitly |

## Cross-linking strategy

- **Within product:** root-absolute links — `[Folders](/selfhosted/folders)`
- **Across products:** only when behaviour is truly shared — prefer duplicating with product-specific examples
- **External:** `href` in `documentation.json` for GitHub, cloud app URL — not inline secrets

## English-only scope

All `docs/public/` content is **English only**. The web app ships German UI (`de.json`), but public documentation does not include a German locale. Do not plan `de` MDX variants or translation workflows in this skill.
