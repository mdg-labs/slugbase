# SlugBase Design Gap Analysis — Page-by-Page Explicit Differences

**Status:** Draft  
**Date:** 2026-06-01  
**Compares:** `docs/design-prototype/V1/` → `packages/web/` + `packages/marketing/`  
**Product authority:** Spec wins on product conflicts (§23.4). This doc is visual / layout / component anatomy only.

**Legend**

- **Prototype:** design mockup in `docs/design-prototype/V1/`
- **Built:** current React Router web app or Astro marketing site
- Items marked **[spec]** are intentional product divergences — do not copy the prototype

---

## 0. Cross-cutting — shared auth shell

Applies to all auth routes (`/login`, `/register`, `/mfa`, `/mfa/enroll`, `/forgot-password`, `/reset-password`, `/setup`).

| # | Prototype | Built | Notes |
|---|---|---|---|
| 0.1 | CSS grid: `grid-template-columns: minmax(440px, 0.9fr) 1fr` | Flex row: fixed `w-[400px]` aside + `flex-1` form pane | Brand rail does not grow with viewport |
| 0.2 | Brand rail min width 440px; ~47% of viewport at 1440px | Brand rail fixed 400px; ~28% at 1440px | Form pane visually dominates |
| 0.3 | Brand padding `var(--sp-11)` (48px) | Brand padding `p-sp-8` (32px) | Less breathing room |
| 0.4 | Brand border `var(--border-subtle)` | Brand border `var(--border)` | Stronger separator |
| 0.5 | Radial periwinkle wash via `.brand::before` pseudo | No gradient decoration | Flat brand rail |
| 0.6 | Brand logo 30×30px | Brand logo 28×28px | 2px smaller |
| 0.7 | Brand wordmark `--text-h2` (18px semi) | Brand wordmark `--text-h3` (15px semi) | Smaller wordmark |
| 0.8 | Brand hero h1 uses `--text-display` (28px) | Brand hero h1 uses `--text-h2` (18px) | Headline much smaller |
| 0.9 | Brand hero max-width 30ch | No max-width constraint | Line length differs |
| 0.10 | Slug rows: `.slug-row` pills — `bg-raised`, border, `--r-lg`, padding | Plain flex text rows, no pill chrome | Weaker product demo |
| 0.11 | Slug row arrow: Lucide `arrow-right` icon | Text character `→` | Different icon treatment |
| 0.12 | Slug row opacity: 1.0 / 0.55 / 0.28 (`.ghost` / `.ghost2`) | Opacity 1.0 / 0.5 / 0.25 | Slightly different fade |
| 0.13 | Brand footer: dot-separated segments + mono `go.slugbase.app` | Single i18n footer string | Less structured footer |
| 0.14 | Form pane padding `var(--sp-9) var(--sp-8)` (36px / 32px) | Form pane `p-sp-8` (32px) | Slightly tighter |
| 0.15 | Form card: `.card { width: min(404px, 100%) }` on raised surface | Form `max-w-[360px]`, no card wrapper | 44px narrower, no depth |
| 0.16 | Card entrance animation: `card-in` 230ms slide-up | No route transition animation | Abrupt screen changes |
| 0.17 | Mobile breakpoint: brand hidden below **920px** | Brand hidden below **1024px** (`lg:`) | Rail visible 104px wider on tablets |
| 0.18 | Mobile: `.card-mark` hidden on desktop, shown below 920px | `.card-mark` always visible above form | Mark shown on desktop too |
| 0.19 | Auth fields: `.field--lg` fixed **42px** height | Padding-based height (~40px), `--text-body` | Slightly shorter fields |
| 0.20 | Auth field font: `--text-body-lg` (14px) | `--text-body` (13px) | Smaller input text |
| 0.21 | Auth fields: leading Lucide icon (mail, lock, user, etc.) | No leading icons on any field | Major visual gap |
| 0.22 | Auth submit: `.btn--lg` fixed **44px**, `--text-body-lg` | Padding-based button, `--text-body` | Shorter CTA |
| 0.23 | Password reveal: Lucide eye icon in `.reveal` span | Inline SVG eye button | Functionally same, different markup |
| 0.24 | Hard-coded slug demo URLs in brand rail | Hard-coded slug demo URLs in brand rail | Both need config/i18n — not a prototype delta |

---

## 1. Sign in (`/login`)

**Prototype:** `AuthApp.jsx` → `SignIn` · **Built:** `routes/auth/login.tsx`

| # | Prototype | Built |
|---|---|---|
| 1.1 | Heading h2 only ("Sign in to SlugBase") | h2 + subtitle paragraph below |
| 1.2 | "Keep me signed in on this device" checkbox with custom `Check` component | No remember-me checkbox |
| 1.3 | Federated SSO: Google + GitHub buttons below "or" divider (when open registration) | No federated provider buttons |
| 1.4 | Closed-registration info box with info icon when registration disabled | No login-only-mode info box on login page |
| 1.5 | Footer: "New to SlugBase? Create an account" link below SSO | Footer: "No account?" + register link only (no SSO block) |
| 1.6 | Password reset success: not shown on sign-in screen | Green success banner when `?reset=success` |
| 1.7 | Error display: inline form error (prototype harness) | Red `role="alert"` danger banner |
| 1.8 | Submit loading state: not shown in prototype | Disabled button + loading label while submitting |

---

## 2. Registration (`/register`)

**Prototype:** `AuthApp.jsx` → `Register` · **Built:** `routes/auth/register.tsx`

| # | Prototype | Built |
|---|---|---|
| 2.1 | Name field with user icon | Name field, no icon |
| 2.2 | Strength meter always visible below password; shows "8+ chars · mixed case · number" requirements text | Strength meter conditional on password length; no requirements hint text |
| 2.3 | Strength scoring: 8-char threshold for first bar | Scoring uses 8-char minimum but labels differ (very_weak at <8) |
| 2.4 | Federated "Sign up with Google/GitHub" below divider | No federated buttons |
| 2.5 | Registration closed: lock icon block + back button | Full-page centred card on canvas (no two-pane) |
| 2.6 | Email verify pending: dedicated verify screen in auth flow | Inline verify-email card state after successful register |
| 2.7 | Verify state: see §3 Email verification | See §3 |

---

## 3. Email verification

**Prototype:** `AuthApp.jsx` → `VerifyEmail` · **Built:** inline state in `register.tsx`

| # | Prototype | Built |
|---|---|---|
| 3.1 | Large info icon block (56×56 accent-subtle box, mail-check icon) | No icon block |
| 3.2 | Email address shown bold in body copy | Generic message, no email displayed |
| 3.3 | `sent-to` pill: mono email in styled pill with mail icon | Not present |
| 3.4 | "Back to sign in" secondary full-width button | Link or redirect only (no styled back button) |
| 3.5 | Resend link with 30-second countdown (`Resend` component) | No resend link or countdown |
| 3.6 | Non-enumeration privacy note with shield icon | Not present |

---

## 4. MFA verification (`/mfa`)

**Prototype:** `AuthApp.jsx` → `Mfa` · **Built:** `routes/auth/mfa.tsx`

| # | Prototype | Built |
|---|---|---|
| 4.1 | Back link with arrow-left icon above heading | Back arrow link present (verify icon match) |
| 4.2 | TOTP: 6 cells in `.code` grid, each **56px** tall, mono **22px**, gap `var(--sp-4)` | `TotpInput`: cells ~48×40px, gap `sp-2` |
| 4.3 | TOTP cells: `.filled` class when digit entered | Filled styling may differ |
| 4.4 | Backup code field: `key-round` icon, mono, `XXXX-XXXX-XXXX` placeholder | Backup input present, mono; icon absent |
| 4.5 | Mode toggle link below form ("Use a backup code instead") | Toggle link present |
| 4.6 | Submit: `.btn--lg btn--block` | Standard full-width button |

---

## 5. MFA enroll (`/mfa/enroll`)

**Prototype:** `SettingsAccount.jsx` MFA enroll flow · **Built:** `routes/auth/mfa-enroll.tsx`

| # | Prototype | Built |
|---|---|---|
| 5.1 | QR in bordered frame placeholder (prototype uses placeholder box) | Real QR image in white `bg-white` container |
| 5.2 | Setup key in `CopyField` (read-only + copy button) | Collapsible mono secret block |
| 5.3 | Backup codes in `ShownOnce` with warning header, 4-col grid, Copy all + Download | 2-col grid, copy button, confirmation checkbox before continue |
| 5.4 | WarnBox before backup codes | Warning banner with warning tokens |
| 5.5 | No checkbox gate before continuing after backup codes | Must check "I saved my codes" before Continue |

---

## 6. Forgot password (`/forgot-password`)

**Prototype:** `AuthApp.jsx` → `ResetRequest` · **Built:** `routes/auth/forgot-password.tsx`

| # | Prototype | Built |
|---|---|---|
| 6.1 | Request state: back link + email field with mail icon | Back link + email field, no icon |
| 6.2 | Request state: shield + non-enumeration note below form | Security note with shield — **present** |
| 6.3 | Success: mail-check icon block (56×56) | Success circle with MailCheck icon — **similar** |
| 6.4 | Success: email bold in body + `sent-to` pill | Email shown in mono pill — **similar** |
| 6.5 | Success: "expires in 30 minutes" copy | Expiry mention may differ — verify i18n key |
| 6.6 | Success: `Resend` link with 30s countdown | **No resend link** |
| 6.7 | Success: "Back to sign in" secondary button | Back link present |

---

## 7. Reset password (`/reset-password`)

**Prototype:** `AuthApp.jsx` → `ResetSet` · **Built:** `routes/auth/reset-password.tsx`

| # | Prototype | Built |
|---|---|---|
| 7.1 | Body mentions email bold: "Choose a new password for **email**" | Similar copy via i18n |
| 7.2 | New password field with lock icon + inline `Strength` | Password + `PasswordStrength` component (4 bars) |
| 7.3 | Confirm field with lock-keyhole icon | Confirm field, no icon |
| 7.4 | Match hint inline below confirm: green "Passwords match" / red mismatch | Match/mismatch hint with semantic colours — **similar** |
| 7.5 | Submit disabled until passwords match | Submit disabled until match — **same** |
| 7.6 | Back link centred below form | Back to login link |
| 7.7 | Success state: not in prototype (redirects to sign-in) | Dedicated success card → link to login |

---

## 8. First-run setup (`/setup`)

**Prototype:** `AuthApp.jsx` → `Setup` · **Built:** `routes/setup/setup.tsx`

| # | Prototype | Built |
|---|---|---|
| 8.1 | Step breadcrumb: "1 Admin account → 2 First workspace" with accent-filled step numbers | **No step indicator** |
| 8.2 | Eyebrow badge: "Self-hosted setup" pill with terminal icon | **No eyebrow badge** |
| 8.3 | Brand rail: no slug row showcase | Brand rail without slug rows |
| 8.4 | Fields: name, email, password with icons | Same fields, no icons |
| 8.5 | `setup-divider` labelled "First workspace" between password and workspace name | **No section divider** |
| 8.6 | Workspace name field only (no slug field) | Workspace name + **auto-derived slug field** (spec-correct extra) |
| 8.7 | Strength meter with requirements text | Strength meter, no requirements text |
| 8.8 | Owner security note with shield-check icon | **No owner security note** |
| 8.9 | CTA: "Create account & finish setup" | Similar CTA via i18n |

---

## 9. App shell — sidebar, top bar, layout

**Prototype:** `Sidebar.jsx`, `TopBar.jsx`, `app.css` · **Built:** `AppShell.tsx`, `AppChrome.tsx`

### 9.1 Sidebar

| # | Prototype | Built |
|---|---|---|
| 9.1.1 | Width **248px** (`.app { grid-template-columns: 248px 1fr }`) | Width **224px** (`w-56`) |
| 9.1.2 | `WorkspaceSwitcher`: logo, name, plan label, chevrons-up-down, dropdown with all workspaces | Static `brandLabel` + `workspaceLabel` text only |
| 9.1.3 | Workspace dropdown: coloured letter avatars per workspace | Not present |
| 9.1.4 | Dropdown items: "New workspace", "Workspace settings" | Not present |
| 9.1.5 | Nav: Home, Bookmarks (count badge), Folders, Tags, Forwarding | **Empty `<nav>` — no items** |
| 9.1.6 | Folder sub-nav: per-folder rows with colour dot + count | Not present |
| 9.1.7 | Account sub-section: Settings, Members nav items | Not present |
| 9.1.8 | Sidebar footer: archived bookmarks banner (conditional) | Not present |
| 9.1.9 | Sidebar footer: Free-plan usage meter (progress bar + upgrade link) | Not present |
| 9.1.10 | Sidebar footer: "Help & docs" link | Not present |
| 9.1.11 | Active nav item: `accent-subtle` background highlight | Not applicable (no nav) |
| 9.1.12 | Upgrade link text says "Upgrade to Pro" **[spec: should be Personal]** | N/A until meter built |

### 9.2 Top bar

| # | Prototype | Built |
|---|---|---|
| 9.2.1 | Fixed height **52px** | Padding-based height (`py-sp-5`), not locked to 52px |
| 9.2.2 | Breadcrumbs: accent icon + bold label + chevron + sub-label + optional count badge | **No breadcrumbs** |
| 9.2.3 | Centre: `.cmd-trigger` search bar (max 420px) with search icon, placeholder, ⌘K badge | **No visible search trigger** |
| 9.2.4 | Right: archived count chip (conditional) | Not present |
| 9.2.5 | Right: theme toggle (2-way dark/light icon button) | `ThemeSwitcher` (3-way: light/dark/auto) in header |
| 9.2.6 | Right: notifications bell icon button | Not present |
| 9.2.7 | Right: "New bookmark" primary button with plus icon + `C` kbd | Not present |
| 9.2.8 | Right: account avatar circle → dropdown menu (Account, Preferences, Shortcuts, Upgrade, Sign out) | Not present |

### 9.3 Main layout

| # | Prototype | Built |
|---|---|---|
| 9.3.1 | Shell: `height: 100vh; overflow: hidden` — scroll in content only | `min-h-screen` — page-level scroll |
| 9.3.2 | Main content padding `var(--sp-7)` (28px) | Main padding `p-sp-8` (32px) |
| 9.3.3 | Top bar background: `color-mix(base 60%, transparent)` frosted effect | Solid `bg-base` |
| 9.3.4 | List pages: dedicated `.toolbar` row below top bar | Toolbar inline inside page content |
| 9.3.5 | Global shortcuts: `C`, `G`, `T`, `Escape` (App.jsx) | Only `⌘K` via CommandPaletteProvider |
| 9.3.6 | `UpsellModal` at bookmark cap | Not present |

---

## 10. Dashboard (`/`)

**Prototype:** `DashboardApp.jsx`, `pages.css` · **Built:** `routes/dashboard/` + components

| # | Prototype | Built |
|---|---|---|
| 10.1 | No page h1 title — content starts with optional banner | h1 title + workspace subtitle in page header |
| 10.2 | TopBar crumb: home icon → "Home" | No top bar crumbs |
| 10.3 | `DashboardSearchEntry` widget | **Not in prototype** — built adds full-width search button above stats |
| 10.4 | Entitlement banner: zap / alert-triangle Lucide icons | Text chars `↑` / `!` in styled squares |
| 10.5 | Entitlement banner: "Upgrade" button wired | Upgrade button **rendered but no action/href** |
| 10.6 | Stats row: icon per tile (bookmark, folder, hash) | Text labels only, no icons |
| 10.7 | Stats numbers: `.stat-num` CSS class | Explicit `font-mono 28px` |
| 10.8 | Grid: `1fr 340px` | `lg:grid-cols-[1fr_340px]` — **width matches** |
| 10.9 | Quick access: 24px favicon per row | **No favicons** |
| 10.10 | Quick access: flame icon before hit count | Raw count number only |
| 10.11 | Quick access: arrow-up-right trailing icon | No trailing icon |
| 10.12 | Pinned: 2-col mini-grid with 22px favicons | 1–2 col grid; **inset accent left stripe** instead of favicon |
| 10.13 | Recent bookmarks section | **`DashboardRecent` — not in prototype** |
| 10.14 | Checklist items: bookmark, folder, shortcut, import | Items: import, browser_shortcut, folder, **tag** (different set) |
| 10.15 | Checklist: manual checkbox toggling only | Auto-completes from real workspace data |
| 10.16 | Checklist dismissed: shows "Show again" inside card | Dismissed + incomplete → component returns **null** (hidden) |
| 10.17 | Tag cloud: clickable chips filter bookmarks | Tags link to `/tags` (404 today) |
| 10.18 | Sharing rows: users/share-2 icons + chevron-right | `↗` glyph header; rows use `→` text |
| 10.19 | Sharing rows: link to bookmarks with scope filter | Links to `/` unfiltered |
| 10.20 | `DashboardFoldersOverview` section | **Not in prototype** |

---

## 11. Bookmarks (`/bookmarks`)

**Prototype:** `App.jsx`, `BookmarkViews.jsx`, `Toolbar.jsx` · **Built:** `BookmarkListPage.tsx`

| # | Prototype | Built |
|---|---|---|
| 11.1 | Grid view: `repeat(auto-fill, minmax(300px, 1fr))` cards | Single-column `<ul>` list only |
| 11.2 | Table view: 7-column sticky header grid | **No table view** |
| 11.3 | View toggle: grid / table segmented control in toolbar | **Not present** |
| 11.4 | Toolbar: folder filter dropdown (colour dots) | **Not present** |
| 11.5 | Toolbar: tags multi-select dropdown (checkboxes) | **Not present** |
| 11.6 | Toolbar: pinned-only toggle chip | **Not present** |
| 11.7 | Toolbar: scope dropdown | `ScopeFilter` component — **present** |
| 11.8 | Toolbar: sort dropdown (4 options) | **Not present** |
| 11.9 | Toolbar: inline result count ("N results") | Count in page subtitle only |
| 11.10 | Toolbar: "Clear filters" danger chip when filtered | Clear via empty-state button only |
| 11.11 | Search: instant client-side filter | GET form requiring submit button |
| 11.12 | Card: 32px favicon monogram | **No favicon** |
| 11.13 | Card: pinned left inset accent stripe | **Not in list view** |
| 11.14 | Card: slug line as `go.slugbase.app/<slug>` accent pill | `/go/<slug>` mono text |
| 11.15 | Card: "No slug" empty state with link-2-off icon | Nothing shown when no slug |
| 11.16 | Card: folder dot + name, up to 2 tag chips, relative time, scope icon | Scope icon + sharing label only |
| 11.17 | Card: hover-reveal checkbox for bulk select | **No checkboxes** |
| 11.18 | Card: pin button | **Not present** |
| 11.19 | Pinned section header ("Pinned" + count) on first page | **Not present** |
| 11.20 | Pagination: Showing X–Y of Z, rows-per-page, page numbers | Server pagination params exist; **no UI** |
| 11.21 | Bulk bar: floating bottom-centre pill with Move/Tag/Pin/Share/Delete | **Not present** |
| 11.22 | Inline share controls on each row | `ShareControls compact` — **extra vs prototype list** |
| 11.23 | Skeleton: 9 card-shaped shimmer blocks | Generic `SkeletonList` horizontal rows |
| 11.24 | Empty (unfiltered): logo art 80×80, "Press **C** anywhere", New + Import buttons | EmptyState with New button only; no import; no C hint |
| 11.25 | Empty (filtered): "No bookmarks match" + clear filters | **Present** |
| 11.26 | Upsell inline banner when ≤10 bookmarks remaining on Free | **Not on bookmarks page** |
| 11.27 | Page container: full-width in app content area | `max-w-6xl` centred container |
| 11.28 | TopBar: "Bookmarks / All" crumb + count badge | Page h1 + subtitle instead |

---

## 12. Folders (`/folders`)

**Prototype:** `FoldersApp.jsx` · **Built:** `FolderListPage.tsx`

| # | Prototype | Built |
|---|---|---|
| 12.1 | Row: 8px colour dot before name | **No colour dot** |
| 12.2 | Row: bookmark count in mono subtle text | i18n count string |
| 12.3 | Row: scope badge (`ScopeLabel`) | `ScopeIcon` + `SharingLabel` |
| 12.4 | Row: owner name when shared-with-me | **Not shown** |
| 12.5 | Row: modified time (e.g. "2h ago") | **Not shown** |
| 12.6 | Row: Open / Edit / Share icon buttons on hover | **Not present** |
| 12.7 | Row: More (⋯) menu → Rename, Delete, etc. | **Not present** |
| 12.8 | Row: double-click opens bookmarks filtered to folder | **No row click action** |
| 12.9 | Inline `ShareControls` | **Present** (extra) |
| 12.10 | Toolbar: search field 240px | GET search form — similar |
| 12.11 | Toolbar: scope dropdown | `ScopeFilter` — present |
| 12.12 | Toolbar: sort dropdown (3 options) | **Not present** |
| 12.13 | Toolbar: inline folder count | Subtitle count only |
| 12.14 | Toolbar: "New folder" primary button + `N` kbd | **Not present** |
| 12.15 | TopBar: "New folder" via `onNew` prop | **Not wired** |
| 12.16 | Skeleton: 4 row-shaped shimmers matching row layout | Generic `SkeletonList` |
| 12.17 | Empty (unfiltered): folder icon + "New folder" CTA | **No create CTA** |
| 12.18 | Empty (filtered): clear filters | Present |
| 12.19 | Keyboard: `N` opens new folder | **Not present** |

---

## 13. Tags — **page missing in built app**

**Prototype:** `TagsApp.jsx`, `Tags.html` · **Built:** no route

| # | Prototype | Built |
|---|---|---|
| 13.1 | Route `/tags` with full page | **Route does not exist** — palette links 404 |
| 13.2 | Layout: `1fr` or `1fr 360px` when tag selected | N/A |
| 13.3 | Tag table: 4 columns (Tag, Usage bar, Count, Actions) | N/A |
| 13.4 | Sortable header (alpha / most used) | N/A |
| 13.5 | Usage bar: relative-width `--accent` fill | N/A |
| 13.6 | Inline rename (pencil → input) | N/A |
| 13.7 | Delete with inline confirmation strip | N/A |
| 13.8 | Detail panel: tag name pill, bookmark list, View all / Rename / Delete | N/A |
| 13.9 | Toolbar: search, sort, count, "New tag" button | N/A |
| 13.10 | Skeleton: 8 shimmer rows | N/A |
| 13.11 | Empty states: no tags / no search match | N/A |
| 13.12 | Escape deselects tag / closes rename | N/A |

---

## 14. Command palette (overlay)

**Prototype:** `Palette.jsx`, `PaletteApp.jsx` · **Built:** `components/command-palette/`

| # | Prototype | Built |
|---|---|---|
| 14.1 | Panel width `min(640px, 92vw)` | `max-w-[640px]` — **matches** |
| 14.2 | Overlay: vertically **centred** in viewport | `pt-[12vh]` — opens from **top** |
| 14.3 | Scrim: `backdrop-filter: blur(3px)` | `backdrop-blur-[3px]` — **matches** |
| 14.4 | Open animation: 230ms scale 0.97→1 + translateY | No entrance animation |
| 14.5 | Input row: search icon + 15px input + Esc kbd | cmdk input + Esc kbd — similar |
| 14.6 | Default actions: Lucide icon per item | **Text only — no icons** |
| 14.7 | Active row: corner-down-left icon on right | Highlight via aria-selected only |
| 14.8 | Search results: `<Favicon>` 22px | `<BookmarkGlyph>` letter initial |
| 14.9 | Go mode slug display: `go.slugbase.app/<slug>` | Internal `/go/<slug>` path |
| 14.10 | Go mode disambiguation: radio cards + "always use this" checkbox + CTA | **Not implemented** |
| 14.11 | No-results hint: "Press **C** to create" | Generic i18n hint, no C mention |
| 14.12 | Switch workspace action | Registered but **no switcher UI** on select |
| 14.13 | Footer: SlugBase SVG icon + brand text | Text brand label only — **no icon** |
| 14.14 | Footer kbd order: hints then brand at end | Esc at `ml-auto`, brand after |
| 14.15 | List max-height: none explicit in prototype CSS | `max-h-[46vh]` cap in built |
| 14.16 | Tag result navigation to `/tags/<name>` | Route 404 |
| 14.17 | Uses custom keyboard handler | Uses `cmdk` — better a11y, different filter behaviour |

---

## 15. Bookmark modal (create/edit)

**Prototype:** implied in App.jsx modals · **Built:** `components/bookmark-modal/`

| # | Prototype | Built |
|---|---|---|
| 15.1 | Modal width ~560px (prototype dialogs) | `DialogContent` 560px — **matches** |
| 15.2 | Folder/tag assignment: rich multi-select UI | Scrollable checkbox panels (max-h 144px) |
| 15.3 | AI suggestion pills | **Present** — may exceed prototype (spec feature) |
| 15.4 | Sharing section in modal | `ShareControls` when editing — present |
| 15.5 | Forwarding toggle with `/go/slug` preview | Present |

---

## 16. Settings — layout shell

**Prototype:** `SettingsApp.jsx`, `settings.css` · **Built:** all `/settings/*` routes

| # | Prototype | Built |
|---|---|---|
| 16.1 | Layout: `212px` vertical `.settings-nav` + fluid content | Each page: `max-w-[680px]` centred column |
| 16.2 | Nav groups: Account / Workspace / Billing / Administration | Horizontal tab strip **per route** (repeated) |
| 16.3 | All settings in one shell with shared left nav | Split across 4 routes (`account`, `workspace`, `billing`, `members`) |
| 16.4 | Content scrolls in wide column | Narrow centred form |
| 16.5 | SaveBar sticky bottom when dirty | `SaveBar` component — **present** on sections |

---

## 17. Settings — Account → Profile

**Prototype:** `SettingsAccount.jsx` · **Built:** `ProfileSection.tsx`

| # | Prototype | Built |
|---|---|---|
| 17.1 | Avatar 64px (`av-lg`) with "Change photo" ghost button | Avatar 56px (`h-14`); text hint only — **no change photo button** |
| 17.2 | Email field editable with mail icon | Email **read-only/disabled** |
| 17.3 | Pending email verification flow (badge, resend, cancel) | **Not implemented** |
| 17.4 | Display name field in `FF` wrapper with icon slot | Standard `Input` — no icon |

---

## 18. Settings — Account → Password

| # | Prototype | Built |
|---|---|---|
| 18.1 | "Federated only" variant with InfoBox | May differ — verify `PasswordSection` |
| 18.2 | Current + new + confirm with lock icons | Fields present; icons absent |
| 18.3 | Strength meter + requirements text | Strength meter present |
| 18.4 | Match hint on confirm field | Present |

---

## 19. Settings — Account → MFA

| # | Prototype | Built |
|---|---|---|
| 19.1 | Not enrolled: InfoBox + setup CTA | Similar flow |
| 19.2 | Enrolling: QR placeholder + CopyField + 6-digit input | QR + secret + TotpInput |
| 19.3 | Enrolled: shield-check + "N backup codes remaining" | Similar |
| 19.4 | Disable/regenerate without re-auth in prototype | Built requires live TOTP to disable/regenerate |
| 19.5 | Backup codes: ShownOnce 4-col grid + Download | ShownOncePanel 2-col + copy |

---

## 20. Settings — Account → API tokens

| # | Prototype | Built |
|---|---|---|
| 20.1 | Token list: key icon, name, created, last used, Revoke | Similar list |
| 20.2 | ShownOnce for new token with warning | `ShownOncePanel` — similar |
| 20.3 | Inline create form: name + Create/Cancel | Similar |

---

## 21. Settings — Account → Preferences

| # | Prototype | Built |
|---|---|---|
| 21.1 | Language: select (English / Deutsch) | Select en/de — **matches** |
| 21.2 | Theme: visual swatch previews (Dark / Light / Auto mini previews) | Segmented text buttons — no preview swatches |
| 21.3 | Accent colour: shown as **locked** (non-configurable) | **User-selectable colour swatches** — verify spec |
| 21.4 | Default bookmark view: Card grid / Table segmented control | **Not present** |
| 21.5 | AI suggestions opt-out toggle | Toggle — **present** |
| 21.6 | SaveBar when dirty | Present |

---

## 22. Settings — Workspace → General

| # | Prototype | Built |
|---|---|---|
| 22.1 | Workspace name field | Present |
| 22.2 | Workspace identifier (slug) field | **Removed** — spec §23.4 (no identifier in UI) **[spec]** |
| 22.3 | DangerZone: delete workspace with type-to-confirm | `ConfirmDialog` — similar intent |
| 22.4 | SaveBar | Present |

---

## 23. Settings — Workspace → SMTP

| # | Prototype | Built |
|---|---|---|
| 23.1 | Self-hosted only section | Gated by `mailAdminUi` config |
| 23.2 | Host + port two-column; Security select | Similar layout |
| 23.3 | Username + password two-column | Similar |
| 23.4 | From address + From name two-column | Similar |
| 23.5 | "Send test email" with loading/ok/fail states | Verify `SmtpSection` parity |

---

## 24. Settings — Workspace → AI suggestions

| # | Prototype | Built |
|---|---|---|
| 24.1 | Enable toggle | Present |
| 24.2 | Self-hosted: provider select + API key + model | `AiSection` — similar |
| 24.3 | Hosted: InfoBox "managed by SlugBase" | Operator-managed gate — similar |

---

## 25. Settings — Workspace → Identity providers (OIDC)

| # | Prototype | Built |
|---|---|---|
| 25.1 | Provider list with edit/delete | List with toggle/delete |
| 25.2 | Add form: callback URL CopyField | Present |
| 25.3 | Auto-create accounts toggle | **Verify — may be absent** |
| 25.4 | Default role select on add form | Verify parity |

---

## 26. Settings — Members & teams

**Prototype:** `SettingsMembers.jsx` · **Built:** `MembersSettingsPage.tsx`

| # | Prototype | Built |
|---|---|---|
| 26.1 | PlanGate on Free/Personal | `MembersPlanGate` — present |
| 26.2 | Tab row: Members (N) / Teams (N) | Verify tab structure |
| 26.3 | Seat progress bar | Present in built |
| 26.4 | Member row: avatar, crown Owner badge, role select, remove | Similar |
| 26.5 | Remove confirm: inline danger strip below row | `ConfirmDialog` modal instead |
| 26.6 | Owner transfer: inline warning panel | Confirm dialog pattern |
| 26.7 | Invite form: email + role + Send | Similar |
| 26.8 | Pending invitations section | Verify parity |
| 26.9 | Teams tab: expandable team cards, member pills | Verify parity |

---

## 27. Settings — Audit log — **missing in built app**

**Prototype:** `SettingsAudit.jsx` · **Built:** not implemented

| # | Prototype | Built |
|---|---|---|
| 27.1 | Full audit log page under Administration | **No route or UI** |
| 27.2 | Filter bar: search, actor dropdown, entity type chips | N/A |
| 27.3 | Log rows: timestamp, actor avatar, action, entity, type badge | N/A |
| 27.4 | Pagination (8 per page) | N/A |
| 27.5 | PlanGate on Free/Personal | N/A |

---

## 28. Settings — Billing

**Prototype:** `SettingsBilling.jsx` · **Built:** `BillingSettingsPage.tsx` + components

| # | Prototype | Built |
|---|---|---|
| 28.1 | Prototype harness to cycle 8 billing states | No dev harness (correct) |
| 28.2 | Current plan card + bookmark usage meter | Present |
| 28.3 | Archived bookmarks post-downgrade banner | Verify parity |
| 28.4 | Plan comparison table (Free / Personal / Team) | `PlanComparisonTable` — present |
| 28.5 | Plan names/prices: prototype hard-coded | Config-driven — **[spec]** |
| 28.6 | Cancel subscription 2-step inline flow | `CancelSubscriptionPanel` + ConfirmDialog |
| 28.7 | Seats section: tile breakdown, add/remove forms | `SeatManagementSection` |
| 28.8 | Billing history + Stripe portal link | `BillingHistorySection` |
| 28.9 | Supporter/lifetime offer + countdown | `SupporterOfferCard` — present |
| 28.10 | Monthly → yearly upsell strip | Verify parity |
| 28.11 | Upgrade CTAs say "Pro" in prototype **[spec: Personal]** | Built uses Personal — correct |

---

## 29. Edge state — Onboarding wizard — **missing in built app**

**Prototype:** `EdgeFlows.jsx` → `OnboardingFlow` · **Built:** checklist widget only

| # | Prototype | Built |
|---|---|---|
| 29.1 | Fullscreen 4-step overlay (welcome, import, shortcut, done) | No fullscreen wizard |
| 29.2 | Faint app shell visible at 0.08 opacity behind overlay | N/A |
| 29.3 | Dot progress indicator (4 dots) | N/A |
| 29.4 | Step 1: workspace stats mini-grid | N/A |
| 29.5 | Step 2: import drop-zone (HTML/JSON) | Checklist item only |
| 29.6 | Step 3: browser shortcut with chrome-bar mockup | Checklist item only |
| 29.7 | Step 4: checklist summary + "Go to dashboard" | N/A |
| 29.8 | "Skip for now" on each step | Dismiss entire checklist widget |

---

## 30. Edge state — Workspace switcher — **missing in built app**

**Prototype:** `EdgeFlows.jsx` → `WorkspaceSwitcherOverlay` · **Built:** palette action stub

| # | Prototype | Built |
|---|---|---|
| 30.1 | Backdrop + `.ws-panel` popup | Not implemented |
| 30.2 | Workspace list with avatar, name, role, plan badge | Not implemented |
| 30.3 | Active workspace check icon | Not implemented |
| 30.4 | Loading state: spinner + "Switching to …" | Not implemented |
| 30.5 | Create workspace inline form | Not implemented |
| 30.6 | Create blocked: upgrade-to-Personal CTA | Not implemented |

---

## 31. Edge state — Slug disambiguation — **missing in built app**

**Prototype:** `EdgePages.jsx` → `SlugDisambig` · **Built:** not implemented

| # | Prototype | Built |
|---|---|---|
| 31.1 | Centred `.disambig-card` (no main content) | N/A |
| 31.2 | git-fork icon + h2 + slug pill in description | N/A |
| 31.3 | Option cards: radio, favicon, title, URL, owner, folder | N/A |
| 31.4 | "Always open X's bookmark" checkbox | N/A |
| 31.5 | "Open this bookmark" CTA → confirmation state | N/A |
| 31.6 | "Manage remembered slug preferences" link | N/A |

---

## 32. App error pages (404 / 403 / 500)

**Prototype:** `EdgePages.jsx` → `AppError` · **Built:** `AppErrorPage.tsx`, error boundaries

| # | Prototype | Built |
|---|---|---|
| 32.1 | Rendered inside app shell (sidebar + topbar visible) | `AppShellErrorBoundary` keeps shell — **matches** |
| 32.2 | SlugBase logo 80×80 faint | Faded icon — similar |
| 32.3 | Large gradient status code (`--text-display` scale) | Gradient mono code — **similar** |
| 32.4 | Optional path pill | Verify per status |
| 32.5 | 404: Go to Bookmarks + Go back | Link to bookmarks — similar |
| 32.6 | 500: Reload + Report error | Reload + Sentry report — **similar** |
| 32.7 | TopBar still shows on error pages in prototype | Built shell header minimal (theme only) |

---

## 33. Marketing — shared shell (nav + footer)

**Prototype:** `MarketingShell.jsx` · **Built:** `MarketingNav.astro`, `MarketingFooter.astro`

| # | Prototype | Built |
|---|---|---|
| 33.1 | Nav height 60px, sticky, blur backdrop | **Matches** |
| 33.2 | Logo 24px + wordmark 16px semi | Logo 26px — 2px larger |
| 33.3 | Links: Features / Pricing / Contact | **Matches** |
| 33.4 | Sign in ghost + Get started primary CTAs | **Matches** |
| 33.5 | Language switcher | DE/EN toggle — **present** (prototype EN only) |
| 33.6 | Footer 3-col grid 1.4fr 1fr 1fr | **Matches** |
| 33.7 | GDPR badge with success checkmark | **Matches** |
| 33.8 | Docs link disabled/muted | **Matches** |
| 33.9 | Analytics consent banner | **Built only** — spec-required, not in prototype |

---

## 34. Marketing — Landing (`/`)

**Prototype:** `MarketingLanding.jsx` · **Built:** `LandingSections.astro`

### 34.1 Hero

| # | Prototype | Built |
|---|---|---|
| 34.1.1 | Tag pill + h1 two-line + subtitle | **Matches** |
| 34.1.2 | Two CTAs: Get started + Self-host | **Matches** |
| 34.1.3 | `HeroPalette` animated typewriter demo cycling 3 go-queries | **Missing entirely** |
| 34.1.4 | Hero radial glow pseudo | **Present** in CSS |

### 34.2 Slug forwarding section

| # | Prototype | Built |
|---|---|---|
| 34.2.1 | Two-column split text + demo | **Present** |
| 34.2.2 | `AddressBarDemo`: cycles Navigating → Redirecting → Arrived every 2.2s | **Static** single-state browser mockup |
| 34.2.3 | Demo URL: `go.slugbase.app/react19` | `go.example.app/react19` (non-branded) |
| 34.2.4 | Checklist with success icons | **Present** |

### 34.3 Bookmark manager features

| # | Prototype | Built |
|---|---|---|
| 34.3.1 | 4-column feature grid | **Present** |
| 34.3.2 | Feature icons: Lucide-style icons in accent boxes | Placeholder `◆` character |
| 34.3.3 | Section eyebrow + h2 + body | **Present** |

### 34.4 Command palette section — **missing in built**

| # | Prototype | Built |
|---|---|---|
| 34.4.1 | Reversed split: code block left, text right | **Section not rendered** |
| 34.4.2 | Terminal-style `.mk-code` block listing palette commands | CSS exists; no markup |

### 34.5 Team sharing section — **missing in built**

| # | Prototype | Built |
|---|---|---|
| 34.5.1 | Folder list mockup (3 rows, dots, counts, sharing icons) | **Section not rendered** |

### 34.6 Self-hosted Docker section — **missing in built**

| # | Prototype | Built |
|---|---|---|
| 34.6.1 | `.mk-code` docker run command block | **Section not rendered** |
| 34.6.2 | Final CTA section anchors `#self-host` | CTA section present but **no docker block above it** |

### 34.7 Pricing teaser — **missing in built**

| # | Prototype | Built |
|---|---|---|
| 34.7.1 | 3 plan cards on landing (Free / Personal featured / Team) | **Not on landing** — pricing is separate page |
| 34.7.2 | "See full pricing comparison →" link | N/A on landing |

### 34.8 Final CTA

| # | Prototype | Built |
|---|---|---|
| 34.8.1 | Centred h2 + body + two buttons | **Present** |

---

## 35. Marketing — Pricing (`/pricing`)

**Prototype:** `MarketingPages.jsx` → `PricingPage` · **Built:** `_PricingPage.astro`

| # | Prototype | Built |
|---|---|---|
| 35.1 | Monthly/Yearly billing toggle | **Present** |
| 35.2 | 3 plan cards in shared border container; Personal featured | **Present** |
| 35.3 | Hard-coded prices ($0 / $4 / $9) | Config-driven env vars — **[spec]** |
| 35.4 | Feature comparison table 4 columns | **Present** |
| 35.5 | Folder cap in plan table | **Removed** — spec: no folder cap **[spec]** |
| 35.6 | API tokens gated to Personal+ in prototype | **All plans** in built — **[spec]** |
| 35.7 | Supporter lifetime card + live countdown | **Present** |
| 35.8 | Self-hosted callout strip | **Present** |
| 35.9 | FAQ accordion (6 items) | `<details>` native accordion — **present** (different interaction) |
| 35.10 | FAQ uses React `useState` expand | Native HTML — no JS required |

---

## 36. Marketing — Contact (`/contact`)

**Prototype:** `MarketingPages.jsx` → `ContactPage` · **Built:** `_ContactPage.astro`

| # | Prototype | Built |
|---|---|---|
| 36.1 | Two-column: form + aside cards | **Present** |
| 36.2 | Name + email side-by-side | **Present** |
| 36.3 | Topic select (5 options) | **Present** |
| 36.4 | Message textarea | **Present** |
| 36.5 | Turnstile widget mock (spinner → check) | Real Cloudflare Turnstile integration |
| 36.6 | Success state: check icon + confirmation | **Present** |
| 36.7 | Aside: support email + GitHub links | **Present** |
| 36.8 | Unconfigured endpoint state | **Present** (prototype always shows form) |

---

## 37. Marketing — Legal (`/legal/*`)

**Prototype:** `MarketingPages.jsx` → `LegalPage` (client tab switch) · **Built:** `_LegalPage.astro` (separate routes)

| # | Prototype | Built |
|---|---|---|
| 37.1 | Tab row switches Impressum / AGB / Datenschutz client-side | Tab links navigate to **separate URLs** (better SEO) |
| 37.2 | Narrow container max 720px | `mk-c--narrow` — **matches** |
| 37.3 | Prose sections with h2 dividers | **Present** via i18n |
| 37.4 | Hard-coded English legal text | i18n keys en + de |
| 37.5 | Active tab underline accent | **Present** on current route |

---

## 38. Marketing — Error pages (`/404`, `/403`, `/500`)

**Prototype:** `EdgePages.jsx` → `MkError` · **Built:** `MarketingErrorPage.astro`

| # | Prototype | Built |
|---|---|---|
| 38.1 | Marketing nav + footer wrapper | **Present** |
| 38.2 | Faded brand icon | **Present** |
| 38.3 | Gradient code number clamp(64px–112px) | **Present** |
| 38.4 | 404/403: Home + Sign in + Get started buttons | Home + Sign in + Get started — **similar** |
| 38.5 | 500: Reload button | **Present** |
| 38.6 | min-height fills viewport minus nav/footer | **Present** |

---

## 39. Shared UI components (`@slugbase/ui` vs prototype primitives)

| Component | Prototype | Built | Key differences |
|---|---|---|---|
| `Button` | `.btn--primary/secondary/ghost/sm/lg/block` | `Button` variants | Built lacks `--lg` fixed 44px auth size |
| `Input` | `.field` with icon slot | `Input` | No icon slot |
| `Check` | Custom 3-state checkbox | Native checkbox in places | Different visual |
| `Kbd` | 11px mono, canvas bg, bottom border 3D | 10px mono pill | Slightly smaller |
| `Tag` | `#` prefix via CSS, mono micro | Inline chips | Similar intent |
| `Favicon` | Coloured monogram circle | `BookmarkGlyph` letter only | Less rich |
| `Menu` / `MenuItem` | Custom overlay menu | Radix dropdowns | Different primitive |
| `EmptyState` | Custom centred layout | `@slugbase/ui EmptyState` | Similar |
| `Skeleton` | Shimmer cards/rows matching content | Generic list/card skeletons | Less shape-accurate |
| `Toast` | Bottom-right 3.2s slide-in | `ToastProvider` 3200ms | **Similar** |
| `Dialog` | Overlay modals | Radix Dialog 560px | **Similar** |
| `ConfirmDialog` | Inline confirm patterns in prototype | Modal ConfirmDialog | Interaction model differs |

---

## 40. Priority summary for restyle work

### P0 — structural (blocks prototype fidelity)

1. Sidebar 248px with full nav + workspace switcher + usage meter (§9)
2. TopBar 52px with breadcrumbs, cmd-trigger, new-bookmark, avatar menu (§9)
3. Tags page `/tags` (§13)
4. Auth grid proportions + brand rail treatment (§0)
5. Bookmarks grid/table + toolbar + pagination + bulk bar (§11)

### P1 — high-visibility polish

6. Auth field icons, card wrapper, animations, federated buttons (§0–§8)
7. Folders row list with actions (§12)
8. Settings vertical nav layout (§16)
9. Command palette disambiguation + vertical centre + icons (§14)
10. Workspace switcher overlay (§30)

### P2 — marketing landing completeness

11. Hero palette demo (§34.1.3)
12. Animated address bar (§34.2.2)
13. Command palette + team sharing + Docker sections (§34.4–§34.6)
14. Feature icon SVGs instead of ◆ (§34.3.2)

### P3 — missing pages / edge flows

15. Audit log settings (§27)
16. Onboarding wizard overlay (§29)
17. Slug disambiguation page (§31)

---

## 41. Spec divergences — do not copy prototype

| Item | Prototype | Correct (spec) |
|---|---|---|
| Paid tier label | "Pro" | **Personal** |
| Free bookmark cap shown | 100 | **50** |
| Folder cap in pricing | Implied | **No cap** |
| API tokens plan gate | Personal+ | **All plans** |
| Custom domain | In plan table | **Not v1** |
| Workspace slug in settings | Editable field | **Hidden** |
| Prices / go domain | Hard-coded | **Config-driven** |
| Legal tabs | Client-side SPA | **Separate routes OK** |

---

*Generated from exhaustive re-scan of `docs/design-prototype/V1/`, `packages/web/`, and `packages/marketing/`.*
