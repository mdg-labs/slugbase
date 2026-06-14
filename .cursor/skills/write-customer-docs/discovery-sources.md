# Discovery sources

Read these **in order** before drafting or refreshing customer docs. Never guess product behaviour — if a source is silent and the feature is not observable in the app, stop and ask.

**Workspace:** discovery reads from `slugbase/` (monorepo); published MDX lives in `slugbase-docs/`. Open both via `slugbase/slugbase.code-workspace`.

## Ordered read list

| Order | Source | Path | What to extract |
|---|---|---|---|
| 1 | **App routes** | `slugbase/packages/web/app/routes.ts` | URL paths, feature areas, auth vs app shell vs settings |
| 2 | **UI copy (English)** | `slugbase/packages/web/app/i18n/locales/en.json` | Labels, button text, errors, empty states — use as terminology anchor |
| 3 | **Settings navigation** | `slugbase/packages/web/app/routes/settings/settings-nav-config.ts` | Settings sections, entitlement-gated items (SMTP, OIDC, billing, members) |
| 4 | **Product spec** | `slugbase/docs/internal/slugbase-mvp-spec.md` | Authoritative behaviour, limits, security copy, entitlement rules |
| 5 | **Existing public MDX** | `slugbase-docs/**/*.mdx` | Current published content |
| 6 | **Site navigation** | `slugbase-docs/documentation.json` | Product dimensions, tabs, groups, registered paths, OpenAPI wiring |

### Supplementary sources (as needed)

| Source | Path | When |
|---|---|---|
| Settings layout | `slugbase/packages/web/app/routes/settings/settings-layout.tsx` | How settings groups render; interface config filtering |
| Route modules | `slugbase/packages/web/app/routes/**` | Component structure, loader behaviour, visible fields |
| Design prototype | `slugbase/docs/internal/design-prototype/V1/` | Screen layout, interaction patterns (spec §23 wins on conflict) |
| Defaults | `slugbase/docs/internal/defaults-and-constants.md` | Caps, limits, TTLs for accurate numbers in docs |
| Public README | `slugbase-docs/README.md` | Repo layout, path conventions, image workflow |

**Do not** treat `slugbase/packages/web/app/i18n/locales/de.json` as a public docs source — German is in-app UI only.

## Greenfield discovery (0 MDX)

Use when `slugbase-docs/` has no `.mdx` files for the target area.

### Steps

1. **Map routes to doc topics** — walk `slugbase/packages/web/app/routes.ts` app-layout children (`/`, `/bookmarks`, `/folders`, `/tags`, `/go`, `/settings/*`).
2. **Harvest UI strings** — for each route area, `rg '"<prefix>\.' slugbase/packages/web/app/i18n/locales/en.json` (e.g. `bookmarks.`, `folders.`, `go.`, `settings.`).
3. **Read spec sections** — use [doc-index.md](../orchestrator/doc-index.md) § key sections (§5 auth, §6 bookmarks, §7 folders/tags, §8 slugs/go, §12 billing, §14 self-hosted).
4. **Note entitlement gates** — from `slugbase/packages/web/app/routes/settings/settings-nav-config.ts` and spec §12.4 (e.g. billing group hidden on self-hosted, members gated on hosted non-Team).
5. **Check `slugbase-docs/documentation.json`** — confirm product dimension (`Self-hosted` / `Cloud`) and empty groups ready for new `path` entries.
6. **Build behaviour notes table** before IA proposal:

```text
| Feature | Route | Key en.json prefixes | Spec § | Entitlement / config gate |
```

## Maintenance discovery (existing MDX)

Use when updating or extending pages that already exist in `slugbase-docs/`.

### Steps

1. **Inventory current pages** — list `slugbase-docs/**/*.mdx` and cross-check every `path` in `slugbase-docs/documentation.json`.
2. **Diff routes** — compare page claims against current `slugbase/packages/web/app/routes.ts` (new settings sections, renamed paths).
3. **Diff UI copy** — spot terminology drift between MDX and `slugbase/packages/web/app/i18n/locales/en.json` labels.
4. **Diff spec** — re-read relevant spec sections; flag behaviour that changed since the page was written.
5. **Link audit** — verify root-absolute internal links still resolve (`/selfhosted/...`, `/cloud/...`).
6. **Produce a change list** — stale · missing · incorrect · new — before editing.

## Route → doc area map (starter)

| App route | Typical doc topics | en.json prefixes |
|---|---|---|
| `/` (dashboard) | Getting started, command palette | `dashboard.`, `command_palette.` |
| `/bookmarks` | Create, edit, pin, bulk actions | `bookmarks.` |
| `/folders` | Organize, share folders | `folders.` |
| `/tags` | Private tags, filtering | `tags.` |
| `/go`, `/go/:slug` | Forwarding, disambiguation | `go.` |
| `/settings/account` | Profile, password, MFA, API tokens | `settings.account.`, `settings.nav.item.*` |
| `/settings/workspace` | General, SMTP, AI, OIDC | `settings.workspace.` |
| `/settings/billing` | Plan, seats, history (cloud) | `settings.billing.` |
| `/settings/members` | Members, teams, sharing | `settings.members.` |
| `/settings/audit` | Audit log (entitlement-gated) | `settings.audit.` |
| `/login`, `/register`, … | Auth flows | `auth.` |
| `/setup` | First-run (self-hosted) | `setup.` |

Auth and setup routes sit outside the app layout — document them under operator or getting-started groups.

## Settings nav entitlement notes

From `slugbase/packages/web/app/routes/settings/settings-nav-config.ts` — document visibility, not implementation:

| Item | Hidden when |
|---|---|
| SMTP | `mailAdminUi` false (operator-managed mail on cloud) |
| OIDC | `oidcAdminUi` false (operator-managed SSO on cloud) |
| Billing group | `billingEnabled` false (self-hosted) |
| Members | `billingEnabled` true and plan is not Team (hosted) |

Public docs should explain **what the reader sees in their deployment**, not internal config flag names.
