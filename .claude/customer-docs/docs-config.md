# Customer docs config — SlugBase

Configuration for the `customer-docs` skill in this repo, written by its bootstrap mode and owned by the repo — the skill itself is vendored and never edited here. Edit this file when the docs site or the app layout changes. Paths are relative to the repo root.

## Product

| Field | Value |
| ----- | ----- |
| Product name | SlugBase |
| Core use case | A keyboard-driven bookmark manager where any bookmark can carry a short, private slug that forwards through `/go/<slug>`, with a ⌘K command palette that also accepts `go <slug>`. |
| Audience | People who save and open links every day, alone or in a team: individuals, workspace members, workspace admins and owners, and operators who run a self-hosted instance as instance admins. Readers know a browser and settings pages, not code. Operator material (install, backup) is in `docs/self-hosting/`, outside this content root. |
| Deployment model | Two ways: **self-hosted Community Edition** (open source, AGPL-3.0, run by the operator on their own server) and **SlugBase Cloud** (managed, EU-hosted, built from the same code). Docs name no other way to run it. |
| Accounts and roles | An account is a global identity by email, and joins workspaces as a **member**. Workspace roles are **owner**, **admin** and **member** (doc 02 §3.3). A self-hosted install also has an **instance admin** (`/admin`). Self-hosted starts with first-run setup, then invitations (public registration is off by default). Cloud has public registration with email verification. Password plus optional two-step verification, and OIDC where the operator configures it. |
| Behaviour source of truth | `docs/internal/02-product-spec.md` and `docs/internal/03-webui-spec.md` (see CLAUDE.md `### Design docs`), then app code. Never document behaviour that is in neither. |

## Docs site

The content is published by a site that is built elsewhere and owns its framework, sidebar and navigation. This repo holds only the content and its contract (doc 09 §3.5), so no framework, base URL, deploy or sidebar setting is recorded here, and the skill never writes one.

| Field | Value |
| ----- | ----- |
| Content root | `docs/user` |
| Build check | `pnpm docs:check` (the same command as `.claude/workflow.json` `docs.build`) |
| Language | English only |
| Other roots | `docs/self-hosting/` and `docs/releases/` are outside the content root; the skill neither writes nor reports on them |

### Synced files — never hand-edit

none

| Generated file | Edit this source instead |
| -------------- | ------------------------ |

### Customer doc layout

A page that uses a component (`Callout`, `EditionBadge`, `Screenshot` and the rest of the allow-list) is an `.mdx` file; any other page is `.md`. The route is the path below the content root without the extension, so the choice does not change it.

| Doc type | Path | Folder |
| -------- | ---- | ------ |
| Landing page | `docs/user/index.md` | content root |
| Getting started / first steps | `docs/user/getting-started.mdx` | content root (the app links to `/docs/getting-started`) |
| Page docs (one per in-app page) | `docs/user/<page>.mdx` | content root for the main app pages; `access/` (sign-in and account entry pages), `account/` (account settings), `workspace/` (workspace settings and switching) and `admin/` (instance admin) mirror the navigation |
| Concept pages | `docs/user/concepts/<concept>.md` | `concepts/` |
| FAQ | `docs/user/faq.md` | content root |

Planned concept pages: `concepts/slugs.md`, `concepts/workspaces-and-roles.md`, `concepts/sharing.md`, `concepts/editions.md`.

File names: kebab-case. The first path segment is never `cloud`, `self-hosting` or `releases`, in any case. A new page needs no navigation entry: the site orders pages by the `order` field.

### Frontmatter

```yaml
title: "Page title"     # required
description: "One line" # required
edition: both           # required: ce, cloud or both
since: 1.0.0            # optional: the first version that has it
order: 10               # optional: an integer
```

No other field is allowed. The site renders `title` as the page's H1, so the body has none. Links between pages are relative file paths (`../concepts/slugs.md`) or `/docs/...` routes; the skill never writes a base path or a root-absolute link outside `/docs/`.

## App page inventory

| Field | Value |
| ----- | ----- |
| App | `packages/web` (React 19, TanStack Router file routes) |
| Routes dir | `packages/web/src/routes/` — `_app/` holds the signed-in routes; the files at the root are the public and auth routes |
| Navigation source | `docs/internal/03-webui-spec.md` "Navigation structure", and the sidebar in `packages/web/src/shell/app-layout.tsx` |
| UI labels | `packages/web/src/i18n/locales/en.json` — quote labels from here, never invent them |
| Feature components | `packages/web/src/<feature>/` (`bookmarks`, `folders`, `tags`, `forwarding`, `go`, `dashboard`, `palette`, `sharing`, `teams`, `audit`, `account`, `setup`) and `packages/web/src/shell/` for the settings and admin pages |

### Route → doc map

The Edition column is the `edition` the page takes. Overlays are listed because doc 03 lists them with the navigation tree. A row with no page stays in the map, so a re-scan does not report it as new.

| Route | Page (UI title) | Doc path | Edition |
| ----- | --------------- | -------- | ------- |
| `/` | Home | `home.mdx` | both |
| `/bookmarks` | Bookmarks | `bookmarks.mdx` | both |
| bookmark modal (`?bookmark`, `?new`) | New bookmark / edit | `add-and-edit-bookmarks.mdx` | both |
| `/bookmarks/archived` | Archived bookmarks | none here: Cloud-only, documented in the private Cloud repository; the Bookmarks page points to it with an edition note | cloud |
| share dialog (overlay) | Share | `sharing.mdx` | both |
| `/folders` | Folders | `folders.mdx` | both |
| `/tags` | Tags | `tags.mdx` | both |
| `/forwarding` | Forwarding | `forwarding.mdx` | both |
| `/go/$slug`, `/go/$` | go/<slug> matches N bookmarks, not found | `go.mdx` | both |
| command palette (overlay) | Command palette | `command-palette.mdx` | both |
| keyboard shortcut sheet (overlay) | Keyboard shortcuts | `keyboard-shortcuts.mdx` | both |
| workspace switcher, create-workspace dialog | Workspace switcher | `workspace/switching-workspaces.mdx` | both |
| `/settings` | none (redirects to `/settings/account`) | no page | n/a |
| `/settings/account` | Profile | `account/profile.mdx` | both |
| `/settings/account/security` | Security | `account/security.mdx` | both |
| `/settings/account/tokens` | API tokens | `account/api-tokens.mdx` | both |
| `/settings/account/preferences` | Preferences | `account/preferences.mdx` | both |
| `/settings/account/data` (import wizard) | Import & export | `account/import-and-export.mdx` | both |
| `/settings/workspace` | General | `workspace/general.mdx` | both |
| `/settings/workspace/members` | Members | `workspace/members.mdx` | both |
| `/settings/workspace/teams` | Teams | `workspace/teams.mdx` | both |
| `/settings/workspace/audit` | Audit log | `workspace/audit-log.mdx` | both |
| `/settings/workspace/ai` | AI suggestions | `workspace/ai-suggestions.mdx` | both |
| `/settings/workspace/billing` (extension route) | Plan and billing | none here: Cloud-only, documented in the private Cloud repository | cloud |
| `/admin` | Overview | `admin/overview.mdx` | ce |
| `/admin/workspaces` | Workspaces | `admin/workspaces.mdx` | ce |
| `/admin/accounts` | Accounts | `admin/accounts.mdx` | ce |
| `/admin/settings` | Settings & status | `admin/settings-and-status.mdx` | ce |
| `/setup` | Set up SlugBase | `access/first-run-setup.mdx` | ce |
| `/login`, `/login/mfa` | Sign in, Two-step verification | `access/sign-in.mdx` | both |
| `/register`, `/verify-email` | Create an account, Verify your email | `access/create-an-account.mdx` | both |
| `/forgot-password`, `/reset-password` | Forgot your password?, Choose a new password | `access/reset-your-password.mdx` | both |
| `/invite/$token` | You are invited | `access/accept-an-invitation.mdx` | both |
| `/no-workspace` | You are not in a workspace yet | `access/no-workspace.mdx` | both |
| `/email-change/confirm`, `/email-change/cancel` | Confirm your new email address, Cancel an email change | `access/email-change-links.mdx` | both |
| `/403`, `/404`, `/500`, offline banner | You don't have access, This page doesn't exist, Something went wrong, You are offline | `error-pages.md` | both |

Re-scan the routes dir on every run: a route without a row here is a new page (missing doc).

## Screenshots

| Field | Value |
| ----- | ----- |
| Policy | PLACEHOLDERS |
| Format | `<Screenshot alt="short description" />` without a `src`, in an `.mdx` page — the skill never captures images, and never writes an HTML comment, which the docs contract refuses |
| Theme | A screenshot a person adds later is taken in the dark theme (doc 03) |

## Edition callouts

| Case | Use |
| ---- | --- |
| A part of a `both` page that exists on SlugBase Cloud only | `<Callout>` or `<EditionBadge edition="cloud" />`, worded "Available on SlugBase Cloud." |
| A part of a `both` page that applies to a self-hosted installation only | `<EditionBadge edition="ce" />` or a `Callout`, worded "Self-hosted only." |

- Only the components of the docs contract's allow-list, never a component of the page's own.
- Never write a price: link `https://slugbase.app/pricing`. Plan names may be named, their prices may not.
- Signup for SlugBase Cloud is linked as `https://cloud.slugbase.app`.
- No Cloud internals: no billing provider, hosting platform or registry names (doc 09 §4).
- A page that is wholly Cloud-only is not written in this repository.

## Glossary (internal term → customer term)

One customer term per concept across all pages. Extend this table (after approval) when a new term appears; ask the user when a mapping is unclear.

| Internal / code term | Customer-facing term |
| -------------------- | -------------------- |
| tenant, organization, org | workspace |
| link, item | bookmark |
| alias, shortlink, keyword (for a slug) | slug |
| redirect, redirection | forwarding, or "go" (as in `go/mail`) |
| collection | folder |
| favorite, star | pin, pinning |
| group | team |
| user (meaning membership) | member |
| org admin | workspace admin |
| super admin, site admin | instance admin |
| plan limits, entitlement | what your plan includes (Cloud); not mentioned for self-hosted |
| go preferences | remembered choices (the UI label) |
| `/go/<slug>` | `go/<slug>` in prose; the URL form only in the forwarding setup steps |

## Coverage tracking

File: `.claude/customer-docs/coverage.md` (table format in the skill).

## Commits

| Field | Value |
| ----- | ----- |
| Subject | `docs(<scope>): <summary>` |
| Scope | `docs` |
| Trailer | `Fixes #<n>` when the work belongs to a tracked item (its trailer number — see `.claude/trackers/`), otherwise none |
