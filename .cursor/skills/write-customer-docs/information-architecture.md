# Information architecture

SlugBase public docs use Documentation.AI's **Dimensions → Views → Content** model. Source: `slugbase-docs/documentation.json`.

## Product dimensions

Two top-level products — separate nav trees, shared concepts where behaviour matches:

| Product key | `documentation.json` product | Audience | Typical content |
|---|---|---|---|
| `selfhosted` | Self-hosted | Instance operators + workspace users on private installs | Install, upgrade, SMTP/OIDC operator config, first-run setup, unrestricted entitlements |
| `cloud` | Cloud | Hosted subscribers | Sign-up, billing, plan limits, cloud-specific operator-managed panels |

**Prefer separate pages** when cloud and self-hosted behaviour diverges (billing, SMTP, OIDC, workspace creation limits). **Shared concept pages** are acceptable when text is identical — but each product still needs its own `path` under the correct dimension if navigation differs.

Published URL: `selfhosted/quick-start.mdx` → `/selfhosted/quick-start`

Default route: `initialRoute` → `selfhosted/introduction`

## Tabs and groups

Current structure (wired in #409):

```text
navigation.products[]
  └── product: "Self-hosted" | "Cloud"
        └── tabs[]
              └── tab: "Guides" (primary) | "API" (OpenAPI-generated, later)
                    └── groups[]
                          └── pages[]  OR  openapi: "…/api-reference/*.yaml"
```

### Self-hosted Guides groups

| Group | Pages | Audience |
|---|---|---|
| Getting started | `introduction`, `quick-start`, `first-workspace-setup` | Operator + end user |
| Using SlugBase | `bookmarks`, `slugs-and-go`, `folders`, `tags`, `command-palette`, `search-and-import` | End user |
| Workspaces | `workspaces-overview`, `members-and-teams`, `sharing` | Workspace admin |
| Settings | `account-settings`, `workspace-settings`, `smtp`, `oidc`, `ai-suggestions`, `api-tokens` | End user + operator |
| Administration | `instance-admin`, `audit-log`, `backup-and-export` | Operator |
| Help | `troubleshooting`, `faq` | Operator + end user |

### Cloud Guides groups

| Group | Pages | Audience |
|---|---|---|
| Getting started | `introduction`, `sign-up`, `first-workspace` | End user |
| Using SlugBase | `bookmarks`, `slugs-and-go`, `folders`, `tags`, `command-palette`, `search-and-import` | End user |
| Workspaces | `workspaces-overview`, `members-and-teams` | Workspace admin |
| Account & billing | `account-settings`, `plans-and-billing`, `mfa-and-security` | Workspace owner |
| Help | `troubleshooting`, `faq`, `support` | End user |

**API tab** — wire later via group-level `openapi` paths (see `slugbase-docs/README.md`).

## Page inventory

| path | title | type | audience | product | prerequisites |
|------|-------|------|----------|---------|---------------|
| selfhosted/introduction | Introduction to self-hosted SlugBase | concept | end-user | selfhosted | — |
| selfhosted/quick-start | Quick start | how-to | operator | selfhosted | introduction |
| selfhosted/first-workspace-setup | First workspace setup | how-to | end-user | selfhosted | quick-start |
| selfhosted/bookmarks | Bookmarks | how-to | end-user | selfhosted | introduction |
| selfhosted/slugs-and-go | Slugs and go | how-to | end-user | selfhosted | bookmarks |
| selfhosted/folders | Folders | how-to | end-user | selfhosted | bookmarks |
| selfhosted/tags | Tags | how-to | end-user | selfhosted | bookmarks |
| selfhosted/command-palette | Command palette | how-to | end-user | selfhosted | bookmarks |
| selfhosted/search-and-import | Search and import | how-to | end-user | selfhosted | bookmarks |
| selfhosted/workspaces-overview | Workspaces overview | concept | workspace-admin | selfhosted | introduction |
| selfhosted/members-and-teams | Members and teams | how-to | workspace-admin | selfhosted | workspaces-overview |
| selfhosted/sharing | Sharing | how-to | workspace-admin | selfhosted | workspaces-overview |
| selfhosted/account-settings | Account settings | how-to | end-user | selfhosted | introduction |
| selfhosted/workspace-settings | Workspace settings | how-to | workspace-admin | selfhosted | workspaces-overview |
| selfhosted/smtp | SMTP | operator-runbook | operator | selfhosted | quick-start |
| selfhosted/oidc | OIDC | operator-runbook | operator | selfhosted | quick-start |
| selfhosted/ai-suggestions | AI suggestions | how-to | operator | selfhosted | workspace-settings |
| selfhosted/api-tokens | API tokens | how-to | end-user | selfhosted | account-settings |
| selfhosted/instance-admin | Instance admin | operator-runbook | operator | selfhosted | quick-start |
| selfhosted/audit-log | Audit log | reference | operator | selfhosted | instance-admin |
| selfhosted/backup-and-export | Backup and export | operator-runbook | operator | selfhosted | instance-admin |
| selfhosted/troubleshooting | Troubleshooting | troubleshooting | operator | selfhosted | — |
| selfhosted/faq | FAQ | reference | end-user | selfhosted | — |
| cloud/introduction | Introduction to SlugBase Cloud | concept | end-user | cloud | — |
| cloud/sign-up | Sign up | how-to | end-user | cloud | introduction |
| cloud/first-workspace | First workspace | how-to | end-user | cloud | sign-up |
| cloud/bookmarks | Bookmarks | how-to | end-user | cloud | introduction |
| cloud/slugs-and-go | Slugs and go | how-to | end-user | cloud | bookmarks |
| cloud/folders | Folders | how-to | end-user | cloud | bookmarks |
| cloud/tags | Tags | how-to | end-user | cloud | bookmarks |
| cloud/command-palette | Command palette | how-to | end-user | cloud | bookmarks |
| cloud/search-and-import | Search and import | how-to | end-user | cloud | bookmarks |
| cloud/workspaces-overview | Workspaces overview | concept | workspace-admin | cloud | introduction |
| cloud/members-and-teams | Members and teams | how-to | workspace-admin | cloud | workspaces-overview |
| cloud/account-settings | Account settings | how-to | end-user | cloud | introduction |
| cloud/plans-and-billing | Plans and billing | concept | workspace-admin | cloud | account-settings |
| cloud/mfa-and-security | MFA and security | how-to | end-user | cloud | account-settings |
| cloud/troubleshooting | Troubleshooting | troubleshooting | end-user | cloud | — |
| cloud/faq | FAQ | reference | end-user | cloud | — |
| cloud/support | Support | reference | end-user | cloud | — |

### Column rules

- **path** — lowercase-with-hyphens, matches `.mdx` filename, no suffix
- **type** — `how-to` · `concept` · `operator-runbook` · `troubleshooting` · `reference`
- **audience** — `end-user` · `workspace-admin` · `operator`
- **product** — which dimension owns the page
- **prerequisites** — comma-separated paths readers should complete first (or `—`)

## Path naming conventions

| Rule | Good | Bad |
|---|---|---|
| Lowercase, hyphenated | `slugs-and-go` | `SlugsAndGo` |
| Product prefix in path | `selfhosted/quick-start` | `quick-start` at repo root |
| No version in path | `installation` | `installation-v1` |
| Operator vs user split | dedicated groups (Settings, Administration) | Mixing install steps with bookmark how-to on one page |

## `documentation.json` wiring checklist

For each new page:

1. Create `{path}.mdx` under `slugbase-docs/` with `title` and `description` frontmatter.
2. Add to the correct chain:

```json
{
  "title": "Quick start",
  "path": "selfhosted/quick-start",
  "icon": "zap"
}
```

3. Set `initialRoute` when adding the first page in a product (e.g. `selfhosted/introduction`).
4. Push to `slugbase-docs` `main` — Documentation.AI validates on build.

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

All customer MDX in `slugbase-docs` is **English only**. The web app ships German UI (`de.json`), but public documentation does not include a German locale. Do not plan `de` MDX variants or translation workflows in this skill.
