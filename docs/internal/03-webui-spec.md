# SlugBase — Web UI Specification

Complete page inventory of the signed-in application. Every route, what it shows, what it does, and which coss ui component and particle builds each element. Behaviour is doc 02; this document is how it looks and is operated. The marketing site is doc 11; the Cloud operator console is doc 07 §6 (it reuses the patterns below).

The V1 design prototype (`docs/internal/design-prototype/V1/` in this repository) remains the **visual reference** for density, tone and screen anatomy; this document wins where they differ, and doc 02 wins over both on behaviour. Known prototype divergences that are now settled: the paid individual tier is **Personal** (never "Pro"), the Free cap is **50**, there is **no folder cap**, **API tokens are not plan-gated**, there are **no custom domains**, there is **no workspace identifier in URLs**, and the forwarding host is the deployment origin (`/go/…`), not `go.slugbase.app`.

---

## Navigation structure

TanStack Router file routes (D13). `$param` segments are resolved client-side; the server serves the SPA for every path that is not `/api/*`, `/go/*` (resolved by the server, doc 02 §6.2) or a static asset (doc 01 §2).

```
Home (dashboard)                 /
Bookmarks                        /bookmarks                  ?folderId&tag&pinned&hasSlug&forwarding&scope&q&sort&view&size
  └ Archived                     /bookmarks/archived         (only when the workspace has archived bookmarks)
Folders                          /folders                    ?scope&sort&q
Tags                             /tags                       ?tag&sort&q
Forwarding                       /forwarding                 (Q20)
Settings                         /settings
  ├ Account
  │  ├ Profile                   /settings/account
  │  ├ Security                  /settings/account/security  (password, MFA, sessions, linked identities, sign-in alerts)
  │  ├ API tokens                /settings/account/tokens
  │  ├ Preferences               /settings/account/preferences
  │  └ Import & export           /settings/account/data
  └ Workspace                    (admins and owners; members see General read-only and Leave)
     ├ General                   /settings/workspace
     ├ Members                   /settings/workspace/members
     ├ Teams                     /settings/workspace/teams
     ├ Audit log                 /settings/workspace/audit
     ├ AI suggestions            /settings/workspace/ai
     └ (extension routes)        e.g. /settings/workspace/billing — Cloud only, via extensions (doc 01 §7.2)
Instance admin (CE)              /admin                      (instance admins only)
  ├ Overview                     /admin
  ├ Workspaces                   /admin/workspaces
  ├ Accounts                     /admin/accounts
  └ Settings & status            /admin/settings
Go (SPA fallbacks)               /go/$slug                   disambiguation, not found (doc 02 §6.3)
Auth                             /login, /login/mfa, /register, /verify-email, /forgot-password,
                                 /reset-password, /invite/$token, /setup, /no-workspace,
                                 /email-change/confirm, /email-change/cancel   (emailed links; token in the URL fragment)
Errors                           /403, /404 (catch-all), /500 (error boundary), offline state
```

**Sidebar items**: Home, Bookmarks, Folders, Tags, Forwarding — five items, plus a **Folders** section listing the member's folders (and folders shared with them) as quick filters, and **Settings** at the bottom. Instance admins also see **Admin**. Anything more turns the sidebar into a menu nobody reads.

**Overlays that have no route** (they open over the current page and keep it): command palette, bookmark modal, share dialog, workspace switcher, create-workspace dialog, import wizard, keyboard-shortcut sheet. Overlays that must be linkable use a search param instead of a route (`?bookmark=<id>` opens the edit modal; `?new=1&url=…&slug=…` opens the create modal prefilled — used by the not-found page of `/go`, the palette's no-result hint and future extensions). Filters, sort, view and size live in the URL search params of the list; the list has no page parameter because pagination is keyset-based ("load more", doc 02 §5.7).

---

## Global elements

### App shell

- **Workspace switcher** (sidebar header): workspace monogram and name, plan label (Cloud, via slot `sidebar.workspacePlan`), menu with the account's workspaces (check on the active one), "New workspace" (where allowed, doc 02 §3.2) and "Workspace settings".
- **Top bar**: breadcrumb (section → current filter, e.g. "Bookmarks › Dev Tools"), the **command trigger** (search-looking button "Search or run a command…" with `⌘K` hint), the **New bookmark** primary button with its `C` hint, theme toggle, and the account menu (avatar → Account, Preferences, Shortcuts `?`, Sign out; Cloud adds "Plan & billing" through slot `accountMenu.items`).
- **Sidebar footer**: entitlement usage meter and archived-bookmarks notice through slot `sidebar.footer` (Cloud: "37 / 50 bookmarks", "12 archived — upgrade to restore"; CE renders nothing), and "Help & docs" linking to docs.slugbase.app.

**Components:** `app-shell`; switcher: Menu with group label and radio-style items (`p-menu-5`, `p-menu-7`) inside a sidebar header Button with Avatar fallback (`p-avatar-2`); top bar: Breadcrumb (`p-breadcrumb-5`), command trigger `kbd-button` (`p-button-31`), New bookmark Button with Kbd (`p-button-31`), theme toggle icon Button (`p-button-13`) with Tooltip (`p-tooltip-1`), account menu (`p-menu-6`) from Avatar (`p-avatar-6`); sidebar meter `usage-meter` (`p-meter-3`).

### Persistent banners

Shown above page content; dismissible only when the condition clears:

- **Email not verified** (when verification is optional on CE): resend action.
- **MFA required for admin** (instance admins without MFA, on `/admin/*`): link to enrol.
- **At or near the bookmark limit** (Cloud, via slot `banner.entitlement`): upgrade action.
- **Archived bookmarks exist** (Cloud, via slot): link to `/bookmarks/archived`.
- **Mail not configured** (CE instance admins only): explains which flows are degraded, links to the status page.
- **Read-only token / impersonation** — not applicable in v1 (no impersonation exists).

**Components:** `banner`.

### Cross-cutting rules

- **Keyboard first.** Every action reachable by keyboard; the palette is the universal entry point; single-key shortcuts (§12) are discoverable through the `?` sheet and Kbd hints, and can be turned off (Q38).
- **Every destructive action** states its consequence in plain language and needs confirmation: "Delete 14 bookmarks? Their slugs stop forwarding immediately. This cannot be undone." Deleting a workspace or an account needs the typed name/email.
- **Every UI string** comes from the i18n catalogs (D19), English and German, from the first component. Particle text is placeholder.
- **Every action goes through a documented API operation** via the generated client (D12). The SPA has no private endpoints.
- **Entitlements, not editions.** Gated features render through `entitlement-gate` and extension slots; no component checks for "cloud". With an entitlement off, the feature is either absent (preferred) or shows the slot's upgrade affordance — never a broken control.
- **Empty states teach**: an empty Bookmarks page explains slugs and offers New bookmark and Import from browser; an empty Forwarding page explains `go` and the browser setup.
- **Dark-first, light for parity, system by default** (Q35). Both themes are fully designed; screenshots in docs use dark.
- **Responsive**: Home, Bookmarks, the palette, the bookmark modal, `/go` pages and auth must be fully usable on a phone; Settings and Admin are usable but desktop-first (Q39).
- **Optimistic where safe**: pin/unpin, add to folder, tag changes update immediately and roll back with an error toast; deletes and shares wait for the server.

---

## Component system

**Every screen is built from coss ui (D13)**: Base UI primitives styled with Tailwind CSS v4, vendored into `@slugbase/ui` (`packages/ui/src/components/ui/`) with the shadcn CLI from the `@coss` registry (`components.json` registry `"@coss": "https://coss.com/ui/r/{name}.json"`). Particles (`p-*`, catalogued at coss.com/ui/particles; the `coss` and `coss-particles` agent skills are pinned in the repository, doc 09) are starting points adapted into `@slugbase/ui/patterns`, never loaded at runtime. The **Components** line under each page is the decision for that page; changing a choice means changing that line in the same commit.

### Rules

- **coss first, coss only.** No second component library and no hand-rolled version of something coss provides. What coss doesn't cover is limited to: TanStack Table (used through coss Table particles) and the favicon `<img>` — each wrapped once in `@slugbase/ui`.
- **Shared patterns are built once** in `@slugbase/ui/patterns` (table below); pages use the pattern, never re-adapt the particle. The Cloud web extensions and the operator console use the same patterns.
- **Behaviour picks the primitive** (coss segmented-control rule): one value from a set is a RadioGroup, navigation is links, a clearable multi-filter is a ToggleGroup or a multiple Combobox, switching content panels is Tabs.
- **The palette is coss Command** (`p-command-1`), not `cmdk`.
- **Tokens, not colours**: semantic tokens only (`bg-primary`, `text-muted-foreground`, `border-border`), never raw palette classes or hex. Folder colours come from a fixed token set (`--folder-1` … `--folder-8`). Icons are `lucide-react`; decorative icons are `aria-hidden`.
- **Fonts are bundled, never fetched**: IBM Plex Sans and IBM Plex Mono from `@fontsource/ibm-plex-sans` / `@fontsource/ibm-plex-mono` (weights 400/500/600, Latin + Latin-Ext), wired by hand to `--font-sans`, `--font-heading` and `--font-mono` (coss's automatic font setup targets Next.js). A CI check rejects any reference to external font or CDN hosts (doc 08).
- **Mono for machine text**: slugs, `/go` addresses, keyboard hints, token prefixes, hosts in metadata lines use `font-mono`.
- **Mobile**: `form-overlay` becomes a Drawer and `row-actions` a bottom Drawer below the `md` breakpoint.

### Theme tokens

The prototype's design tokens (`colors_and_type.css`) are mapped onto coss's theme variables in `@slugbase/ui/styles/theme.css`. Note the naming trap: the prototype's **`--accent` is the brand colour** and maps to coss **`--primary`**; coss's `--accent` is the subtle hover surface.

| coss variable | Dark (default) | Light | Prototype source |
|---|---|---|---|
| `--background` | `#0a0b10` | `#f4f5f9` | `--canvas` |
| `--sidebar` | `#101220` | `#ffffff` | `--base` |
| `--card`, `--popover` | `#171a2b` / `#1b1f31` | `#ffffff` | `--raised` / `--overlay` |
| `--muted`, `--accent` (hover surface) | `#1e2236` | `#f1f2f7` | `--raised-2` |
| `--foreground` | `#eceef6` | `#14161f` | `--fg` |
| `--muted-foreground` | `#a7adc2` | `#4a4f63` | `--fg-muted` |
| `--primary` | `#7782f7` | `#5b66e8` | `--accent` (periwinkle) |
| `--primary-foreground` | `#0b0c14` | `#ffffff` | `--accent-fg` |
| `--ring` | `#7782f7` | `#5b66e8` | focus ring |
| `--border`, `--input` | `rgba(255,255,255,.10)` | `rgba(16,18,32,.11)` | `--border` |
| `--success` / `--warning` / `--destructive` | `#45c98a` / `#e6b24e` / `#f0686b` | `#1f9d68` / `#b8861f` / `#d6494d` | semantic |
| `--success-text` / `--warning-text` / `--destructive-text` | same as the fills (`#45c98a` / `#e6b24e` / `#f0686b`) | `#17724b` / `#8a6100` / `#b4282d` | AA text variants |
| `--info` | `#56b6e6` | `#2b8fc4` | prototype folder blue |
| `--radius` | `6px` (sm 4, lg 8, xl 12) | same | `--r-*` |

**Semantic colours as text.** The light-theme fills of `--success`, `--warning` and `--destructive` measure 3.45, 3.25 and 4.27 against white, below the 4.5 : 1 that body text needs. The fills keep the values above and are used for icons, dots, borders and badge backgrounds; any text set in a semantic colour (status labels, inline error messages, validation text) uses the `*-text` variant, which measures at least 4.9 : 1 on every light surface. In the dark theme the fills already pass and the variants equal them. A unit test parses the theme CSS and checks every text and background pair for both themes (doc 08).

Type scale follows the prototype's dense tool scale: body 13 px / 18 px, small 12 px, micro 11 px uppercase labels with wide tracking, H1 22 px, H2 18 px, mono 12.5 px. Motion: 110 / 170 / 230 ms with the prototype's easing; all motion respects `prefers-reduced-motion`. A member-chosen **accent** (Q36) swaps `--primary` and `--ring` among six presets; periwinkle is the default.

### Shared patterns

| Pattern | Built from | Particle(s) | Used for |
|---|---|---|---|
| `app-shell` | Sidebar, SidebarInset, SidebarTrigger in SidebarProvider | — (primitive) | Shell, collapse, mobile sidebar drawer |
| `section-nav` | Segmented links; horizontal ScrollArea on mobile | `p-navigation-1`, `p-navigation-2`, `p-scroll-area-2` | Scope tabs on Folders, settings sub-navigation on mobile |
| `settings-nav` | Vertical link list with group labels in a Card | `p-tabs-11` (styling only — links, not Tabs) | Settings and Admin left navigation |
| `kbd-button` | Button with Kbd | `p-button-31`, `p-kbd-1` | Command trigger, New bookmark |
| `status-badge` | Badge | `p-badge-6` success, `p-badge-7` warning, `p-badge-8` error, `p-badge-5` info, `p-badge-2` outline | Verified, MFA on, pending invitation, role, forwarding on/off |
| `slug-chip` | Badge, outline, mono, with copy | `p-badge-2`, `p-button-35` | Slug on cards, rows, palette results |
| `banner` | Alert with action | `p-alert-3`; `p-alert-6` warning, `p-alert-7` error | Persistent banners, inline warnings |
| `inline-note` | Alert, info | `p-alert-4` | Explanations on the page |
| `confirm` | AlertDialog | `p-alert-dialog-1` | Deletes, removals, revocations |
| `typed-confirm` | AlertDialog + Field + Input, confirm enabled on exact match | `p-alert-dialog-1`, `p-field-4` | Delete workspace, delete account, transfer ownership |
| `data-table` | Table + TanStack Table in a CardFrame; card rows on mobile | `p-table-8` (sort), `p-table-7` (selection), `p-table-6` | Bookmarks table, members, tokens, audit, admin lists |
| `card-grid` | Card list in a responsive grid; selection via Checkbox | `p-card-1`, `p-checkbox-1` | Bookmarks grid |
| `table-filters` | InputGroup search, Group with filter Combobox, removable Badges | `p-input-group-20`, `p-group-22`, `p-badge-20` | Filter bar above lists |
| `bulk-bar` | Toolbar shown on selection with count Badge | `p-toolbar-1`, `p-badge-13` | Bulk actions on bookmarks |
| `row-actions` | Menu from an icon Button; Drawer on mobile | `p-menu-1`, `p-button-13`, `p-drawer-13` | Per-row/card actions |
| `context-actions` | ContextMenu with icons | `p-context-menu-6` | Right-click on bookmark rows/cards (same items as `row-actions`) |
| `load-more` | Count line ("Showing 48 of 1,234", "10,000+" above the cap) with a loading Button and a page-size Select | `p-button-18`, `p-select-15` | Every list with keyset pagination (bookmarks, folders, tags, audit) |
| `empty-state` | Empty | `p-empty-1` | Every list with nothing in it |
| `loading` | Skeleton; Button `loading` prop | `p-skeleton-1`, `p-button-18` | Page loads; scoped waits |
| `feedback-toast` | toastManager / anchoredToastManager | `p-toast-2`, `p-toast-4` (undo), `p-toast-5` (promise), `p-toast-7` (after copy), `p-toast-10` (dedup) | Short actions; undo for unpin/remove-from-folder |
| `form` | Form + Field with a Zod schema (shared with the API contract) | `p-form-2`, `p-field-18`, `p-field-4` | Every form |
| `form-overlay` | `form` in a Dialog; Drawer on mobile | `p-dialog-1`, `p-drawer-12` | Create/edit without leaving the page |
| `unsaved-guard` | Dialog close confirmation | `p-dialog-5` | Bookmark modal, import wizard |
| `wizard` | CardFrame with step Progress and Back/Next pair | `p-card-6`, `p-progress-2`, `p-button-33` | Setup, import, MFA enrolment |
| `choice-cards` | RadioGroup cards with description | `p-radio-group-4`, `p-radio-group-3` | Role choice, removal content choice, export format |
| `segmented-choice` | RadioGroup with segmented styling | `p-radio-group-7`, `p-radio-group-8` | Grid/table view, theme, token scope, share audience type |
| `setting-switch` | Switch with description; switch card for consequential toggles | `p-switch-3`, `p-switch-4`, `p-field-15` | AI toggles, sign-in alerts, single-key shortcuts |
| `multi-pick` | Combobox, multiple, chips; creatable | `p-combobox-19`, `p-combobox-12` | Tags in the bookmark modal, folders, teams on invite |
| `picker` | Combobox with search and grouped items | `p-combobox-8`, `p-combobox-10` | Share target (members and teams grouped), folder icon |
| `secret-input` | Password visibility toggle, strength indicator | `p-input-9`, `p-input-group-25` | Passwords |
| `totp` | OTPField with auto validation | `p-otp-field-6` | MFA step, enrolment, disable |
| `copy-value` | Read-only Input with copy button | `p-input-17`, `p-button-35` | `/go` address, search-engine template, invitation link |
| `shown-once` | Card + `copy-value` + acknowledgement Checkbox gating "Done" | `p-card-1`, `p-checkbox-3` | New API token, backup codes |
| `url-input` | InputGroup mimicking a URL bar, end spinner while fetching metadata | `p-input-10`, `p-input-group-16` | Bookmark URL field |
| `slug-input` | InputGroup with start text `/go/`, mono, live validity | `p-input-group-3`, `p-field-5` | Slug field |
| `file-drop` | File Input in a Field with drop zone | `p-input-5` | Import |
| `avatar-stack` | Overlapping Avatar group | `p-avatar-13` | Share audience preview, team members |
| `metric-tile` | Card with value and label | `p-card-1` | Dashboard counts |
| `usage-meter` | Meter with formatted value | `p-meter-3` | Bookmark usage (slot), import progress summary |
| `grouped-results` | Accordion allowing several open, count Badge per group | `p-accordion-3`, `p-badge-13` | Import result (skipped by reason) |
| `side-panel` | Sheet | `p-sheet-1` | Tag preview on mobile, audit event detail |
| `danger-zone` | Frame + destructive-outline Buttons → `confirm`/`typed-confirm` | `p-frame-1`, `p-button-5` | Delete workspace, delete account, leave workspace |
| `entitlement-gate` | Renders children when the entitlement is granted, else slot `entitlement.upgradeAction` or nothing | — (SlugBase component) | Sharing, audit log, AI, invitations, teams |
| `slot` | Named extension point; renders extension components or nothing | — (SlugBase component, doc 01 §7.2) | Plan label, sidebar footer, settings sections, banners, account menu |

### Extension slots

Slots CE's shell renders; with no extensions they render nothing. Cloud fills them (doc 06). Names are a contract (doc 01 §7.4).

| Slot | Where |
|---|---|
| `sidebar.workspacePlan` | Under the workspace name in the switcher |
| `sidebar.footer` | Above "Help & docs" |
| `banner.entitlement` | Persistent banner area |
| `entitlement.upgradeAction` | Inside `entitlement-gate` when a feature is not granted |
| `accountMenu.items` | Account menu, before Sign out |
| `settings.workspace.nav` | Extra items in the Workspace settings navigation |
| `settings.workspace.members.seats` | Seat summary on the Members page |
| `dashboard.top` | Above the dashboard counts |
| `auth.register.footer` | Under the registration form (terms acceptance on Cloud) |

---

## 1. Auth pages

All auth pages use one centred **authentication card** on the canvas background with the SlugBase mark, the card content, and a footer with language switch and (Cloud, via slot) legal links. Copy is non-enumerating everywhere (doc 02 §1).

### 1.1 `/setup` — First-run setup

Only when the deployment has no accounts (doc 02 §2.2). Steps: **(1) setup token** (when `SETUP_TOKEN_REQUIRED`, with an `inline-note` saying where the server logged it); **(2) admin account** — name, email, password with strength; **(3) first workspace** — name; then signed in and taken to Home with the Getting started checklist. A final note recommends enrolling MFA, linking to Security.

**Components:** `wizard`; `form`, `secret-input` with strength, `inline-note`.

### 1.2 `/login` and `/login/mfa`

Email, password, "Remember me", "Forgot password?", OIDC provider buttons (when configured) separated by "or", "Create an account" (only when registration is open). Errors are one generic message. MFA step: 6-digit `totp`, "Use a backup code instead" (switches to a text input), "Back to sign in". A disabled account sees the same generic error (no account-state leakage). Unverified accounts see "Verify your email" with resend.

**Components:** authentication card (`p-card-2`, `p-card-3` with separators); `form`, `secret-input`; provider buttons (`p-button-16` with provider icon); `totp` (`p-otp-field-6`); backup code `form` (`p-input-6`); Checkbox for remember me (`p-checkbox-1`).

### 1.3 `/register`, `/verify-email`

Registration (only when open): name, email, password; Cloud adds terms acceptance through slot `auth.register.footer`. Success → "Check your email" with resend (rate-limited, countdown). `/verify-email#token=…` (the token travels in the URL fragment, so it never reaches server logs or `Referer`) verifies and signs in; an expired token offers resend. Registration closed → a card "Registration is closed — ask an admin for an invitation."

**Components:** authentication card; `form`, `secret-input`; `banner` for expired links; resend Button with `loading`.

### 1.4 `/forgot-password`, `/reset-password`

Request: email → always "If an account exists for that address, we sent a link." Without mail configured: "Ask your instance admin to send you a reset link" (CE). Reset (`/reset-password#token=…`, token in the fragment): new password with strength → signed in, all other sessions revoked (stated); an account with MFA continues at `/login/mfa`.

**Components:** authentication card; `form`; `secret-input`; `inline-note`.

### 1.5 `/invite/$token` — Accept invitation

Shows workspace name, inviter, role. Branches per doc 02 §3.4: signed in as the invitee → "Join <workspace>"; signed in as someone else → explanation and "Sign out and continue"; no account → short sign-up (email fixed) or OIDC buttons; existing account signed out → sign-in form. Expired or revoked → explanation, no detail about why.

**Components:** authentication card; `form`; `status-badge` for role; `banner` for expired.

### 1.6 `/no-workspace`

For accounts with no membership: create a workspace (where allowed) or "Waiting for an invitation" with the account email shown and a sign-out link.

**Components:** `empty-state`; `form-overlay` for create.

### 1.7 `/email-change/confirm`, `/email-change/cancel` — Email-change links

The two pages the emailed links open (doc 02 §2.6). Each reads its token from the URL fragment, calls its operation once and shows a result card: *confirm* (sent to the new address) switches the email and says so, *cancel* (the "this wasn't me" link sent to the old address) cancels the pending change and states that every session was signed out. A used, expired or unknown token shows one generic explanation with a link to `/login`; no copy ever says whether an address is taken.

**Components:** authentication card; `banner` for the failure state; `empty-state` for success.

---

## 2. `/` — Home (dashboard)

One screen on desktop, no scrolling needed for the first three rows.

- **Row 0 — slot `dashboard.top`** (Cloud: limit and archive notices; nothing on CE).
- **Row 1 — counts and search**: four `metric-tile`s (Bookmarks, Folders, Tags, Shared with you — the last only with `sharing.*`), and a large search field that opens the palette.
- **Row 2 — Quick access**: up to 8 most-used slugs as compact tiles (favicon, slug in mono, title), click forwards via `/go`, hover shows the destination.
- **Row 3 — Pinned**: up to 12 pinned bookmarks as compact cards; "View all →" to `/bookmarks?pinned=true`.
- **Row 4 — Most used tags** (tag chips with counts, link to filtered list) and **Sharing** (shared with you / by you counts with links).
- **Getting started** (until dismissed or complete): checklist with five items (doc 02 §9.3), each with its action (New bookmark, Import, Forwarding setup, New folder). Adding a bookmark, giving one a slug and creating a folder complete from real state; the browser setup item is ticked by "Mark as done" on the Forwarding page and the import item by a completed import. "Dismiss" hides the card, a fully complete checklist collapses to a one-line "All set", and Preferences can restore it.

**Components:** `metric-tile`s; search field as `kbd-button` styled as an input (`p-input-group-11`); quick access tiles as Card links (`p-card-1`) with `slug-chip`; pinned as `card-grid` (compact variant); tag chips as Badge with count (`p-badge-15`) links; checklist in a Card with Checkbox items (`p-checkbox-3`, read-only, state-driven) and Progress (`p-progress-2`); `empty-state` when the workspace has no bookmarks yet (replaces rows 2–4).

---

## 3. `/bookmarks` — Bookmarks

### 3.1 Toolbar

- **Filters**: folder (Combobox, single), tags (Combobox multiple with chips, AND), scope (`segmented-choice`: All / Mine / Shared with me / Shared by me — scope options other than All/Mine only with `sharing.*`), toggles "Pinned", "Has slug", "Forwarding on" (ToggleGroup, multiple), text query.
- **Sort** (Select): Recently added, Oldest first, Alphabetical A–Z, Alphabetical Z–A, Most used, Recently accessed.
- **View** (`segmented-choice`): Grid / Table (`V` toggles).
- **Active filter chips** with "Clear filters".
- All state lives in the URL search params (TanStack Router validated search schema), so every view is linkable and back/forward works. There is no page parameter: the list loads further results with a "Load more" button under the last row (keyset pagination, doc 02 §5.7), and a page-size Select (24 / 48 / 96) sets how many each load adds.

### 3.2 Grid view

Cards: favicon (or monogram), title (2 lines), host in mono, `slug-chip` (or "No slug" muted), up to 3 own tags, folder dot(s), pin indicator, shared marker with owner avatar for shared bookmarks, usage ("142 opens · 2 h ago"). Click opens the destination (counts usage); `E` / row action edits; checkbox appears on hover/focus for selection.

### 3.3 Table view

Columns: select, favicon+title, slug, host, folders, tags, opens, last opened, added, actions. Sortable by the sort fields. Per-account column visibility is not part of v1 (the account has no field for it, §16).

### 3.4 Selection and bulk

Selecting shows the `bulk-bar`: count, "Select all <n> matching" (doc 02 §5.7; at most the select-all cap, and the bar says when the filter matches more), Add to folder, Move to folder, Remove from folder, Add tags (with preview popover of the merged set), Remove tags, Pin / Unpin, Share (gated, with the resulting audience previewed), Export selection (SlugBase JSON or Netscape HTML), Delete. The result toast states how many were changed and how many were skipped. Mixed selections with shared bookmarks disable own-only actions with a Tooltip explaining why.

### 3.5 States

Loading: skeleton cards/rows matching the view. Below the list, the count line reads "Showing 48 of 1,234" ("of 10,000+" for very large filtered sets) with the Load more button. Empty (no bookmarks at all): teaching `empty-state` with New bookmark and Import from browser. Empty (filters match nothing): "No bookmarks match these filters" with Clear filters. Error: `banner` with retry.

**Components:** `table-filters` (`p-input-group-20`, folder Combobox `p-combobox-7`, tags `multi-pick` `p-combobox-19`), scope `segmented-choice` (`p-radio-group-7`), ToggleGroup (`p-toggle-group-8`), sort Select (`p-select-15`), view `segmented-choice` with icons (`p-radio-group-7`), filter chips (`p-badge-20`); grid `card-grid`, table `data-table` (`p-table-8`, selection `p-table-7`); `bulk-bar`; `row-actions`, `context-actions`; `load-more`; `loading`; `empty-state`; `feedback-toast` with undo.

### 3.6 `/bookmarks/archived`

Only reachable when archived bookmarks exist (Cloud downgrade, doc 02 §5.6). An `inline-note` explains why they are archived and how they come back (slot `entitlement.upgradeAction`); a read-only `data-table` with Delete and Export actions.

**Components:** `inline-note`, `data-table` (`p-table-7`), `confirm`.

---

## 4. Bookmark modal (overlay)

The single create/edit surface (doc 02 §5.2). Opens from the New bookmark button, `C`, the palette, a pasted URL, row actions, or `?bookmark=<id>`.

**Fields, top to bottom:**

1. **URL** — `url-input`; on blur/paste fetches metadata (spinner inside the field); duplicate warning as `banner` (warning) with "Edit existing" link (Q27).
2. **Title** — prefilled; AI suggestion chip when different.
3. **Slug** — `slug-input` showing `/go/`; live grammar and uniqueness feedback (debounced check); AI suggestion chip; copy of the full address once valid.
4. **Forwarding** — Switch, on by default when a slug is entered; disabled with explanation when no slug.
5. **Folders** — `multi-pick` of own folders, with "Create folder <name>" item.
6. **Tags** — `multi-pick` creatable; AI suggestion chips appended below.
7. **Description** — Textarea, collapsed under "More" by default (Q34).
8. **Pinned** — Switch.
9. **Sharing** — summary line ("Private" / "Shared with Platform team and 2 members") with "Manage" opening the share dialog (only for existing bookmarks, gated).

**Footer**: Delete (edit only, `confirm`), Cancel, Save (`⌘/Ctrl Enter`). **AI**: a "Suggest" button in the header when AI is available (doc 02 §14) with the provider name in its Tooltip; while running, fields show skeleton shimmer only if empty. Closing with unsaved changes asks first.

**Components:** `form-overlay` (`p-dialog-1`, `p-drawer-12` on mobile), `form`; `url-input` (`p-input-10`, `p-input-group-16`); `slug-input` (`p-input-group-3`, `p-field-5`), `copy-value`; Switch fields (`p-field-15`); `multi-pick` (`p-combobox-19`); suggestion chips as selectable Badges (`p-badge-19`); Textarea with counter (`p-textarea-11`) in a Collapsible; AI button with `loading` (`p-button-18`) and Tooltip; `unsaved-guard` (`p-dialog-5`); `confirm`.

---

## 5. Share dialog (overlay)

Opened from a bookmark or folder (own only, gated by `sharing.*`). Header names the object. A `picker` adds members and teams (grouped, searchable, excluding the owner and existing grants). The list shows current grants (avatar or team icon, name, type, remove). Footer shows the effective audience ("Visible to 7 members") with an `avatar-stack`. Read-only sharing is stated in an `inline-note` (Q22). Changes apply immediately per row with toasts.

**Components:** Dialog (`p-dialog-2`); `picker` (`p-combobox-8`); list rows with Avatar (`p-avatar-6`) and remove icon Button (`p-button-14`); `avatar-stack`; `inline-note`; `feedback-toast`.

---

## 6. `/folders` — Folders

Scope `section-nav`: Mine / Shared with me. Sort: Name, Bookmarks, Recently updated. Folder rows/cards: icon and colour, name, bookmark count, sharing label (Private / Shared with … / Shared with you by …), row actions: Open in Bookmarks, Rename, Change icon & colour, Share settings, Delete (`confirm` stating "The 9 bookmarks stay; only the folder goes."). "New folder" opens a small `form-overlay` (name, icon `picker`, colour `segmented-choice` of the 8 folder tokens, stored as a number from 1 to 8). Empty state explains folders.

**Components:** `section-nav` (`p-navigation-1`); sort Select (`p-select-15`); `data-table` (`p-table-6` card-style) with `row-actions`; `form-overlay`; icon `picker` (`p-combobox-10`); colour `segmented-choice` (`p-radio-group-8`); `status-badge` for sharing; `confirm`; `empty-state`.

---

## 7. `/tags` — Tags

Two panes on desktop: left, tag list with counts and a relative-size bar (distribution), search, sort (Name, Count); right, preview of the newest bookmarks for the selected tag (`?tag=`) with "View all in Bookmarks". Tag actions: Rename (offers merge on collision, `confirm`), Delete (`confirm` with count). A note states tags are private to you. On mobile the preview opens as a `side-panel`.

**Components:** list in a Frame (`p-frame-1`) with Meter-styled bars (`p-meter-2`); search `table-filters`; Select sort; preview Card list; `row-actions`; `form-overlay` for rename; `confirm`; `side-panel` (`p-sheet-1`); `inline-note`.

---

## 8. `/forwarding` — Forwarding (Q20)

The home of the slug feature:

- **Set up your browser** — the search-engine template `https://<origin>/go/%s` and keyword `go` as `copy-value`s, per-browser instructions in Tabs (Chrome, Firefox, Safari, Edge), a "Test it" link (`/go/` + a slug the member owns, or a sample), the OpenSearch one-click add where supported (served at `/opensearch.xml`, doc 02 §6.5), and a "Mark as done" control that ticks the browser setup item of the Getting started checklist.
- **Your slugs** — `data-table` of own bookmarks with a slug: slug, destination host, forwarding on/off (inline Switch, rolled back with a toast on failure), opens, last opened; search; row actions Edit, Copy address, Turn off forwarding.
- **Remembered choices** — go preferences (slug → bookmark, owner), with Remove.

**Components:** Card sections; `copy-value`; Tabs with icons (`p-tabs-6`); `data-table` (`p-table-8`) with inline Switch (`p-switch-1`); `row-actions`; `empty-state` for each section.

---

## 9. Command palette (overlay)

Opened by `⌘K`/`Ctrl K` (and `/` on list pages), or the top-bar trigger. Input at top, grouped results below, footer with key hints (↑↓ navigate, ↵ open, ⌘↵ new tab, ⌥↵ edit, esc close).

- **Default**: Recent, Pinned, Navigation, Actions (doc 02 §9.2).
- **Search**: Bookmarks (favicon, title, `slug-chip`, host), Folders, Tags, Commands; "No results" with a hint to create a bookmark with this URL/slug.
- **`go` mode** (`go ` prefix or pasted `/go` URL): header chip "Go", list of matching slugs (own first, then shared with owner avatar); Enter resolves; ambiguity shows the candidates inline with "Always use this" (Checkbox) — same rule as `/go` (doc 02 §6.2).
- Results announce counts to screen readers; focus returns to the trigger on close.

**Components:** Command with Dialog (`p-command-1`); group headings; `slug-chip`; Kbd hints (`p-kbd-1`); Checkbox (`p-checkbox-1`) for "always use"; `empty-state` (compact).

---

## 10. `/go/$slug` — Disambiguation and not found

Rendered by the SPA only when the server cannot forward directly (doc 02 §6.2–6.3).

- **Disambiguation**: "`go/mail` matches 3 bookmarks" — candidate cards (title, destination host, owner, how shared), "Always use this for `mail`" Checkbox, choosing forwards. Link "Manage remembered choices →" to `/forwarding`.
- **Not found**: "No bookmark has the slug `mail` in <workspace>." Actions: "Create a bookmark with this slug" (opens `/bookmarks?new=1&slug=<slug>`, the modal prefilled with the slug), and, when the slug exists in other workspaces of the member, "Found in: <Workspace B> — switch and continue" (Q26).
- A path or query after the slug is not a different address: it shows the not-found page (doc 02 §6.2 step 5).
- Minimal chrome (no sidebar) so it loads fast; respects theme.

**Components:** Card list (`p-card-1`) as RadioGroup-like buttons (`p-radio-group-4`); Checkbox (`p-checkbox-3`); `empty-state` for not found; Button links (`p-button-17`).

---

## 11. Settings

Layout: `settings-nav` on the left (groups **Account** and **Workspace**, plus slot `settings.workspace.nav`), content on the right, each page a stack of titled Cards with their own Save. On mobile the navigation is a Select-driven `section-nav`.

### 11.1 `/settings/account` — Profile

Name, email (change flow with "Pending verification" `status-badge`, resend, cancel change), language (Select: English / Deutsch), avatar preview (initials, Q37). The email row opens the change flow (new address and the shared re-authentication prompt); while a change is pending it shows the "Pending verification" badge with Resend and Cancel, and the confirm and cancel links land on the pages of §1.7. Danger zone: **Delete account** (`typed-confirm` after re-authentication; lists the workspaces that will be deleted with the account and, when a deletion veto refuses, the blocking workspaces with links per doc 02 §2.10).

**Components:** Card sections (`p-card-1`), `form`, Select (`p-select-22`), `status-badge`, `danger-zone`, `typed-confirm`.

### 11.2 `/settings/account/security`

- **Password**: change (current + new with strength); for OIDC-only accounts "Add a password".
- **Two-factor authentication**: state (`status-badge`), enrol `wizard` (re-authentication → the server's SVG QR code shown as an image (an `<img>` with a data URL, never injected as markup) + text key → verify code → `shown-once` backup codes), regenerate backup codes (`totp` then `shown-once`), disable (`totp` + password, `confirm`).
- **Sessions**: `data-table` (device/browser, IP prefix, created, last seen, "This device" badge), Revoke, "Sign out everywhere else" (`confirm`). No location is shown: only the coarse stored IP prefix is known (doc 02 §2.4).
- **Linked sign-in methods**: OIDC providers linked/unlinked (`confirm`), with the rule that one method must remain.
- **Sign-in alerts**: `setting-switch` "Email me when a new device signs in" (default on; the rule for a new device is in doc 02 §12).

**Components:** `form`, `secret-input` (`p-input-group-25`); `wizard` (`p-card-6`) with the QR image in a Card and `copy-value` key; `totp`; `shown-once`; `data-table` (`p-table-7`); `confirm`; `setting-switch` (`p-switch-3`).

### 11.3 `/settings/account/tokens` — API tokens

Token list: name, workspace, scope (`status-badge`), prefix in mono, created, last used, expires, Revoke. "New token" `form-overlay` (asks for re-authentication first): name, workspace (Select of own memberships, the active workspace preselected), scope (`segmented-choice`: Read / Read & write, Q16), expiry (Select: 30, 90 or 365 days or none, default 90, Q47). Result: `shown-once` with the token and a curl example that uses the deployment origin and the placeholder `<your API token>`; the token is dropped from the client cache when the card closes. The 10-token limit is explained inline from the field error.

**Components:** `data-table` (`p-table-7`); `form-overlay`; Select (`p-select-22`); `segmented-choice` (`p-radio-group-8`); `shown-once`; `copy-value`; `confirm` for revoke; `empty-state` ("No tokens yet. Create one to authenticate scripts or integrations.").

### 11.4 `/settings/account/preferences`

Theme (`segmented-choice`: System / Dark / Light, Q35), accent (six swatches, Q36), default bookmark view, single-key shortcuts (`setting-switch`, Q38), AI suggestions opt-out (`setting-switch`, shown only where AI exists), restore Getting started checklist.

**Components:** `segmented-choice` (`p-radio-group-6` theme cards, `p-radio-group-7`), swatch RadioGroup (`p-radio-group-8` styled), `setting-switch` (`p-switch-3`).

### 11.5 `/settings/account/data` — Import & export

- **Import** `wizard`: choose file (`file-drop`: Netscape HTML or SlugBase JSON, up to 5 MiB) → preview (a dry run reports the counts of bookmarks, folders and tags detected; options "Skip duplicates", target: this workspace) → run (Progress while the request runs, then result summary with created/skipped/slugs dropped and a downloadable JSON report; an import that hits the bookmark limit imports up to it and lists the rest as skipped) (Q30). A completed import ticks the Getting started item.
- **Export**: `choice-cards` — SlugBase JSON (lossless, recommended) or Netscape HTML (for browsers, lossy) (Q29); "Include bookmarks shared with me" Checkbox (only with `sharing.*`); Download. Exporting a selection is done from the bulk bar (§3.4); the palette has Import and Export commands that open this page.

**Components:** `wizard`, `file-drop` (`p-input-5`), Checkbox (`p-checkbox-3`), Progress (`p-progress-2`), `grouped-results` as Accordion (`p-accordion-3`) for skipped reasons, `choice-cards` (`p-radio-group-4`), `feedback-toast` (`p-toast-5`).

### 11.6 `/settings/workspace` — General

Name (admins), workspace monogram preview, plan summary through slot. Members see the name read-only and **Leave workspace** (`danger-zone` → `choice-cards` for what happens to their content per doc 02 §3.6, then `confirm`). Owners: **Delete workspace** (`typed-confirm` after re-authentication, offers export first; if a deletion veto of the composition refuses, its explanation is shown in the dialog). After the request is accepted the member leaves the workspace like a removed member (re-derived workspace or `/no-workspace`).

**Components:** `form`, `danger-zone`, `choice-cards`, `typed-confirm`, `slot`.

### 11.7 `/settings/workspace/members`

- **Members** `data-table`: avatar, name, email, role (inline Select for admins; owners can promote to owner), teams (badges), joined, last active, `row-actions` (Change role, Manage teams, Transfer ownership — owners, Remove).
- **Invite** `form-overlay`: emails (several, comma or Enter), role (`choice-cards`: Admin / Member with descriptions), teams (`multi-pick`). Gated by `members.invite`; seat summary via slot `settings.workspace.members.seats` ("4 of 5 seats used — Manage seats →").
- **Pending invitations**: email, role, invited by, expires (expired ones are marked and can be resent), Resend / Revoke; a "Copy invitation link" action (which issues a new link and ends the old one) is offered when mail is not configured. Inviting an email that is already pending resends it; inviting a current member says so.
- **Remove member**: `choice-cards` (transfer content to … / delete content) with recipient `picker`, then `confirm` (doc 02 §3.6).
- **Transfer ownership**: `typed-confirm` on the recipient's name, option "Stay as admin".

**Components:** `data-table` (`p-table-8`) with Select (`p-select-2`); `row-actions`; `form-overlay`; email chips via `multi-pick` creatable (`p-combobox-19`); `choice-cards`; `picker` (`p-combobox-8`); `status-badge` (Owner/Admin/Member, Pending); `typed-confirm`; `entitlement-gate`; `slot`.

### 11.8 `/settings/workspace/teams`

Team list (name, description, member `avatar-stack`, count) with Create, Edit (name, description, members `multi-pick`), Delete (`confirm` stating shares through the team end). Gated by `teams.manage`; empty state "No teams yet. Create one to group members and share access."

**Components:** `data-table` (`p-table-6`), `form-overlay`, `multi-pick` (`p-combobox-19`), `avatar-stack` (`p-avatar-13`), `confirm`, `entitlement-gate`, `empty-state`.

### 11.9 `/settings/workspace/audit` — Audit log

`data-table` newest first: time (relative with absolute in Tooltip), actor (avatar + name, or "deleted account"), action (localised label + `status-badge` category), target. Filters (kept in the URL): actor (Combobox), action category (Combobox multiple), date range (date picker with presets); "Load more" instead of page numbers. Every action has a localised label. Row opens a `side-panel` with the event metadata. Gated by `audit.log`.

**Components:** `data-table` (`p-table-8`), `table-filters` (`p-group-22`), date picker with presets (`p-date-picker-4`), `side-panel` (`p-sheet-1`), Tooltip (`p-tooltip-1`), `entitlement-gate`, `load-more`.

### 11.10 `/settings/workspace/ai` — AI suggestions

`setting-switch` card "Enable AI suggestions for this workspace" with the provider's display name and what is sent (doc 02 §14) in an `inline-note`. When the adapter is not configured: an `inline-note` "Not available on this server" (CE) — no controls. Gated by `ai.suggestions`.

**Components:** `setting-switch` (`p-switch-4`), `inline-note`, `entitlement-gate`.

---

## 12. `/admin` — Instance admin (CE)

Same shell; Admin replaces the sidebar folder section with its own `settings-nav` (Overview, Workspaces, Accounts, Settings & status). Every page shows the `banner` "MFA required" until the admin has enrolled; all actions are disabled until then.

- **Overview**: `metric-tile`s (accounts, workspaces, bookmarks, active sessions), version and migration level, job health (`status-badge`), operator configuration summary (registration, verification, mail, AI, OIDC providers, error reporting) each as `status-badge`.
- **Workspaces**: `data-table` (name, owners, members, bookmarks, created); Create workspace `form-overlay` (name, owner: existing account `picker` or invite email); `row-actions`: Add me as member (`confirm` — visible to owners), Delete (`typed-confirm`).
- **Accounts**: `data-table` (name, email, verified, MFA, instance admin, last sign-in, workspaces, status); `row-actions`: Resend verification, Mark verified, Send/copy reset link, Reset MFA (`confirm`), Disable/Enable (`confirm`), Promote/Demote instance admin (`confirm`), Delete (`typed-confirm`).
- **Settings & status**: `setting-switch` for "Allow members to create workspaces"; instance display name and sign-in notice `form`; "Send test email" with result toast; read-only configuration table.

**Components:** `settings-nav`, `metric-tile`, `status-badge`, `data-table` (`p-table-8`), `form-overlay`, `picker`, `row-actions`, `confirm`, `typed-confirm`, `setting-switch`, `banner`, `feedback-toast`.

---

## 13. Error and edge pages

- **404** (catch-all, in-app variant with shell when signed in; minimal when not): "This page doesn't exist" + Go home / search.
- **403**: "You don't have access" + explanation (not a member / not an admin) + switch workspace.
- **500** (error boundary): "Something went wrong" + Reload + "Report this error" (only when error reporting is configured and consented, doc 11) + request ID in mono for support.
- **Offline**: a `banner` when the browser goes offline; mutations queue nothing — they fail with a toast.
- **Session expired**: any `401` from the API routes to `/login?next=<current path>` with an info toast.

**Components:** `empty-state` (`p-empty-1`) variants; `banner`; `copy-value` for request ID; `feedback-toast`.

---

## 14. Keyboard shortcuts

Global (unless focus is in a text field). Single-key shortcuts can be disabled in Preferences (Q38); modifier shortcuts cannot.

| Keys | Action |
|---|---|
| `⌘K` / `Ctrl K` | Command palette |
| `/` | Palette (list pages) |
| `C` | New bookmark |
| `N` | New folder (Folders page) |
| `G` then `H` / `B` / `F` / `T` / `W` | Go to Home / Bookmarks / Folders / Tags / Forwarding |
| `V` | Toggle grid / table view (Bookmarks) — replaces the prototype's `G`/`T`, which collide with the `G` navigation sequence |
| `J` / `K`, `↑` / `↓` | Move focus in lists |
| `Enter` / `⌘ Enter` | Open / open in new tab |
| `E` | Edit focused bookmark |
| `P` | Pin/unpin focused bookmark |
| `X` | Toggle selection of focused item |
| `⇧ A` | Select all on page |
| `Esc` | Clear selection / close overlay / clear filters (in that order) |
| `?` | Shortcut sheet |

The shortcut sheet is a Dialog listing these with Kbd, in the current language.

**Components:** Dialog (`p-dialog-6`), Kbd (`p-kbd-1`).

---

## 15. Accessibility

- **WCAG 2.2 AA** is the bar: contrast checked for both themes and every accent preset (CI runs axe on the Playwright pages, doc 08); focus visible everywhere (the `--ring` token); no information by colour alone (folder colours always come with names, status always with text).
- Base UI primitives provide roles, labelling and focus management; patterns must not break them (no `div` buttons, overlays return focus to their trigger).
- Lists support keyboard navigation (§14) with `aria-activedescendant` or roving tabindex; the grid view is an ARIA grid only when selection is active, a list otherwise.
- Live regions announce: palette result counts, bulk-action results, import progress, toasts.
- Motion respects `prefers-reduced-motion`; nothing auto-plays.
- Every form error is linked to its field (`Field` wiring) and summarised at the top for long forms.
- Language of the page (`lang`) follows the UI language; the slug and URL text are marked `translate="no"`.

---

## 16. Page priority for implementation

Pages are built in the phases of doc 12, each page with the epic that owns its data.

| Phase (doc 12) | Pages |
|---|---|
| **1 — Foundation** | App shell, extension slots, `/403`, `/404`, `/500`, offline state |
| **2 — Accounts, workspaces, tenancy** | `/setup`, `/login`, `/login/mfa`, `/register`, `/verify-email`, `/forgot-password`, `/reset-password`, `/invite/$token`, `/no-workspace`, `/email-change/*`, the workspace switcher, `/settings/account`, `/settings/account/security`, `/settings/account/tokens`, `/settings/account/preferences` (including accent presets), `/settings/workspace` and `/settings/workspace/members`, `/admin/*` |
| **3 — The core product** | `/`, `/bookmarks`, the bookmark modal, `/folders`, `/tags`, `/forwarding` (including OpenSearch), `/go/$slug`, the command palette, the shortcut sheet |
| **4 — Collaboration, administration, AI, import/export** | Share dialog and shared scopes, `/settings/workspace/teams`, `/settings/workspace/audit`, `/settings/workspace/ai`, AI suggestion chips, `/settings/account/data` |
| **5 — Cloud (planned in the Cloud roadmap)** | Cloud extension routes and slot fillers (billing, plan, seats, upgrade prompts, `/bookmarks/archived`), terms acceptance on registration |

The per-account choice of table columns (§3.3) has no account field yet and is not scheduled for v1.

Phase 3 completes a product the maintainer can live in daily on CE as one person. Phase 4 makes CE feature-complete for teams and releasable to other operators; Phase 5 is what Cloud needs on top.
