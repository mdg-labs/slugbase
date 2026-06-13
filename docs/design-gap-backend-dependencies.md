# Design Gap — Backend Dependencies Map

**Status:** Draft  
**Date:** 2026-06-01  
**Companion to:** `docs/design-gap-analysis.md`  
**Purpose:** For each prototype-aligned frontend change, state whether the backend already supports it, what API exists today, and what (if anything) must be added on the server.

---

## 1. Backend snapshot (what exists today)

The NestJS API exposes **~110 endpoints** across 30 controllers. Core domains are largely implemented at the service/repository layer; several areas have **services without HTTP controllers**, and the web app **already calls some routes that do not exist**.

### 1.1 Fully wired (controller + service + used or usable by web)

| Domain | Key endpoints | Notes |
|---|---|---|
| **Setup** | `GET /setup/status`, `POST /setup/complete` | First-run wizard |
| **Auth** | login, logout, register, forgot/reset password, verify-email, resend-verification | Session cookie model |
| **MFA** | enrol/start, enrol/confirm, challenge, disable, backup-codes/regenerate | TOTP + backup codes |
| **OIDC sign-in** | `GET /auth/oidc/:id/authorize`, `…/callback` | Login flow only — no admin CRUD |
| **Account** | `GET/PATCH /auth/account/*` (profile, password, preferences) | Name, password, language, theme, accent, aiOptOut |
| **API tokens** | `POST/GET/DELETE /auth/api-tokens` | Shown-once plaintext on create |
| **Session workspace** | `POST /workspaces/:id/activate`, `GET /workspaces/active` | Active workspace in session |
| **Bookmarks** | full CRUD, list filters (q, folderId, tagIds, pinned, scope, sort, page) | Cap enforced server-side |
| **Bookmark bulk** | delete, pin, move-to-folder, add/remove-tags, add-tags/preview | **Frontend does not call these yet** |
| **Bookmark metadata** | `GET /bookmarks/metadata`, `GET /bookmarks/favicon` | SSRF-safe — **frontend does not use favicon URL yet** |
| **Folders** | CRUD, list (q, scope, sort, page), bookmark assignment | Paginated list |
| **Tags** | CRUD, list (q, sort, page), bookmark assignment | Paginated list; `bookmarkCount` for usage bars |
| **Go / slugs** | `GET /go/:slug` (redirect or disambiguation JSON), `POST /go/:slug/choose`, preferences CRUD | Disambiguation **backend exists** — **frontend palette/page missing** |
| **Search** | `GET /search` | Used by command palette via web BFF |
| **Sharing** | grants on bookmarks/folders, targets list | Plan-gated |
| **Teams** | full CRUD + member management | Members settings UI partially wired |
| **Members** | list, patch role, delete, transfer-ownership | Under `/members` (active workspace) |
| **Invitations** | create, list, resend, revoke, public accept | |
| **Import** | JSON + Netscape HTML | **Onboarding/import UI not wired** |
| **Export** | JSON only | |
| **Billing** | checkout, portal, seats, Stripe webhook | No inline invoice list — portal redirect |
| **Audit log** | `GET /audit/events` (filtered, paginated) | **No frontend route** |
| **Analytics consent** | config, get/set consent | Marketing + web |
| **Contact** | `POST /contact` | Marketing form |

### 1.2 Implemented in services but **missing HTTP controllers**

| Capability | Service layer | Contract / frontend expectation | Gap |
|---|---|---|---|
| **List user workspaces** | `WorkspacesService.listUserWorkspaces()` | Workspace switcher needs `GET /workspaces` | **Controller missing** |
| **Create workspace** | `WorkspacesService.createWorkspace()` | Switcher "New workspace" | **Controller missing** |
| **Update workspace** | `WorkspacesService.updateWorkspace()` | Web calls `PATCH /workspace` | **Controller missing** (wrong path too) |
| **Delete workspace** | `WorkspacesService.deleteWorkspace()` | Web calls `DELETE /workspace` | **Controller missing** |
| **AI suggestions** | `AiService` + cache | Web calls `POST /ai/suggest` | **Controller missing**; `ai.contract.ts` empty |
| **OIDC provider admin** | `OidcService.createProvider()` etc. | Web calls `/workspace/settings/oidc/providers` | **Controller missing** |
| **SMTP / mail settings** | `SmtpMailService` (env + encrypted settings pattern) | Web calls `/workspace/settings/mail` | **Controller missing**; `AdminModule` empty |
| **AI workspace settings** | Config via env + preferences | Web calls `/workspace/settings/ai` | **Controller missing** |
| **Instance admin console** | `AdminModule` (empty) | Prototype SMTP/AI/OIDC admin in settings | **Not started** |

### 1.3 Frontend calls endpoints that **404 today**

These are active mismatches — the web app already expects them:

| Frontend caller | Expected route | Backend status |
|---|---|---|
| `bookmark-modal-ai-api.ts` | `POST /ai/suggest` | **No controller** |
| `workspace-api.ts` | `PATCH /workspace`, `DELETE /workspace` | **No controller** (only `/workspaces/:id/activate`, `/workspaces/active`) |
| `workspace-api.ts` | `GET/PATCH /workspace/settings/mail`, `POST …/mail/test` | **No controller** |
| `workspace-api.ts` | `GET/PATCH /workspace/settings/ai` | **No controller** |
| `workspace-api.ts` | CRUD `/workspace/settings/oidc/providers` | **No controller** |

Workspace settings pages may **silently fail** (loaders return null / gates show placeholders).

---

## 2. Classification legend

| Tag | Meaning |
|---|---|
| **UI only** | Restyle/recompose existing data — no API change |
| **Wire existing API** | Backend ready; frontend needs to call endpoints that exist but are unused |
| **Backend add** | New or exposed endpoint, schema field, or behaviour required |
| **Blocked** | Product/spec decision needed before backend work |
| **N/A** | Marketing/static or prototype-only decoration |

---

## 3. Design gap areas → backend dependency

Cross-reference to sections in `design-gap-analysis.md`.

### 3.0 Cross-cutting auth shell (§0)

| Change | Backend need |
|---|---|
| Grid proportions, brand rail gradient, slug-row pills, form card, animations | **UI only** |
| Field icons, button sizes, typography | **UI only** |
| Federated SSO buttons (Google/GitHub) on login/register | **Wire existing API** — OIDC authorize URLs exist; need provider records + UI. **Backend add** if providers must be configured via API (OIDC admin CRUD missing) |
| "Keep me signed in" checkbox | **Backend add** — no `rememberMe` on login; session TTL is fixed today |
| Registration closed info box | **UI only** — `POST /register` returns 403; frontend already handles |
| Email verify screen (resend, email display) | **Wire existing API** — `POST /auth/resend-verification` exists; UI doesn't call it |
| Auth slug demo URLs (`cloud.slugbase.app`) | **UI only** — use public config (`APP_BASE_URL` / env), not hard-coded strings |

### 3.1 Sign in / Register / MFA / Setup (§1–§8)

| Change | Backend need |
|---|---|
| MFA cell sizing, backup code UI | **UI only** |
| Setup step breadcrumb, eyebrow, owner note | **UI only** |
| Setup workspace slug field | **Already supported** — `POST /setup/complete` accepts `workspaceSlug` |
| Password strength requirements hint | **UI only** — validation rules already on server (min 12 on password change) |
| Profile email change + pending verification | **Backend add** — account PATCH is **name only**; no email-change flow |
| Avatar / "Change photo" | **Backend add** — no upload/storage endpoint (Fast-Follow unless scoped) |

### 3.2 App shell — sidebar & top bar (§9)

| UI element | Backend need |
|---|---|
| Sidebar width, nav styling, breadcrumbs, cmd-trigger, theme toggle layout | **UI only** |
| Workspace switcher dropdown | **Backend add** — expose `GET /workspaces` (list mine). **Wire** `POST /workspaces/:id/activate` (exists) |
| "New workspace" in switcher | **Backend add** — expose `POST /workspaces` + entitlement check (`multi-workspace`) |
| Nav bookmark count badge | **Wire existing API** — already loaded on dashboard; reuse count |
| Folder sub-nav in sidebar | **Wire existing API** — `GET /folders?pageSize=…` |
| Usage meter / upgrade CTA | **Wire existing API** — `GET /workspaces/active` + bookmark total; entitlements client-side |
| Archived bookmarks banner | **Wire existing API** — `planArchived` + bookmark counts on workspace record |
| "New bookmark" header button | **UI only** — opens modal; `POST /bookmarks` exists |
| Account avatar menu (sign out) | **Wire existing API** — `POST /auth/logout` |
| Notifications bell | **N/A** — prototype decorative; no v1 backend |
| Global shortcuts `C`, `G`, `T` | **UI only** |

### 3.3 Dashboard (§10)

| Change | Backend need |
|---|---|
| Stats row icons, section chrome, pinned mini-grid layout | **UI only** |
| Quick access favicons | **Wire existing API** — `GET /bookmarks/favicon?url=` (or proxy in web) |
| Tag cloud links to filtered bookmarks | **Wire existing API** — `GET /bookmarks?tagIds=…` |
| Sharing rows pre-filtered | **Wire existing API** — `GET /bookmarks?scope=shared-with-me` etc. |
| Entitlement banner upgrade action | **Wire existing API** — billing checkout endpoint exists |
| Onboarding checklist auto-complete | **Wire existing API** — dashboard loader already fetches counts; no new API |
| `DashboardRecent`, `DashboardFoldersOverview` | **Already wired** — loader fetches recent bookmarks + folders |

### 3.4 Bookmarks page (§11)

| Change | Backend need |
|---|---|
| Grid/table views, toolbar layout, pagination UI, bulk bar UI | Mostly **UI only** |
| Folder filter dropdown | **Wire existing API** — `GET /folders` + `GET /bookmarks?folderId=` |
| Tags multi-select filter | **Wire existing API** — `GET /tags` + `GET /bookmarks?tagIds=` |
| Pinned toggle | **Wire existing API** — `?pinned=true` |
| Sort dropdown | **Wire existing API** — `?sort=` (4 values supported) |
| Pagination controls | **Wire existing API** — list already returns `page`, `pageSize`, `total`; UI missing |
| Bulk select + bulk bar actions | **Wire existing API** — `/bookmarks/bulk/*` + `GET /bookmarks/select-all-ids` |
| Pin button on cards | **Wire existing API** — `POST /bookmarks/:id/pin` |
| Favicon on cards/rows | **Wire existing API** — favicon endpoint |
| Folder dot + name on card | **Backend add (optional)** — list returns bare `BookmarkRecord` without folder/tags. Options: (a) enrich list DTO, or (b) frontend batch-fetch — prefer **enriched list DTO** for performance |
| Tag chips on card (up to 2) | Same as above — **enrich list DTO** or N+1 |
| Slug line `go.example.app/…` | **UI only** — compose from public base URL config |
| Import button in empty state | **Wire existing API** — `POST /import/netscape-html` |
| Upsell inline banner | **UI only** — entitlement data already available |

### 3.5 Folders page (§12)

| Change | Backend need |
|---|---|
| Row layout, actions menu, context menu UI | Mostly **UI only** |
| Colour dot per folder | **Blocked / minor add** — schema has `icon` text, not `color`. Prototype uses hex dots. Either map `icon` → colour in UI or **add `color` column** |
| Modified date on row | **Wire existing API** — `updatedAt` on `FolderRecord`; frontend loader doesn't map it yet |
| Owner name when shared-with-me | **Backend add (optional)** — folder list doesn't include owner display name; may need enriched DTO |
| New folder button + `N` shortcut | **Wire existing API** — `POST /folders` |
| Double-click → filtered bookmarks | **UI only** — navigate with `?folderId=` |
| Sort toolbar | **Wire existing API** — `?sort=` on folders list |

### 3.6 Tags page (§13) — **frontend missing, backend ready**

| Change | Backend need |
|---|---|
| Entire `/tags` route + master–detail UI | **Wire existing API** — all CRUD exists |
| Tag table with usage bar | **Wire existing API** — `bookmarkCount` on each tag; sort `usage-desc` |
| Tag detail bookmark list | **Wire existing API** — `GET /bookmarks?tagIds=<id>` |
| Inline rename / delete | **Wire existing API** — `PATCH /tags/:id`, `DELETE /tags/:id` |
| New tag button | **Wire existing API** — `POST /tags` |

**No new backend work required** for tags page — frontend-only gap.

### 3.7 Command palette (§14)

| Change | Backend need |
|---|---|
| Layout, icons, animation, vertical centering | **UI only** |
| Go-mode disambiguation panel | **Wire existing API** — `GET /go/:slug` returns `{ kind: "disambiguation", options }`; `POST /go/:slug/choose` with `remember` |
| Switch workspace action | **Backend add** — list/create workspace endpoints + **wire** activate |
| Tag navigation to `/tags/:name` | **UI only** — use tag id from search results (`GET /search` returns tag ids) |
| Search grouping | **Wire existing API** — `/search` already returns bookmarks, folders, tags |

### 3.8 Bookmark modal (§15)

| Change | Backend need |
|---|---|
| Layout, folder/tag checkbox panels | **UI only** |
| AI suggestion pills | **Backend add** — expose `POST /ai/suggest` (service exists) |
| Create/edit bookmark | **Already wired** |

### 3.9 Settings layout (§16)

| Change | Backend need |
|---|---|
| Vertical nav vs horizontal tabs | **UI only** |
| Route structure | **UI only** — may add `/settings/audit` route |

### 3.10 Settings — Account (§17–§21)

| Section | Backend need |
|---|---|
| Profile layout, avatar styling | **UI only** |
| Change photo | **Backend add** (unless deferred) |
| Email edit + pending verification | **Backend add** — not in account API today |
| Password section layout | **UI only** |
| MFA layout | **UI only** — re-auth on disable/regenerate is **intentional** server behaviour |
| API tokens layout | **UI only** |
| Theme swatch previews | **UI only** |
| Accent colour picker | **Already supported** — `PATCH /auth/account/preferences` |
| Default bookmark view preference (grid/table) | **Backend add** — not in preferences schema; store per-user pref |
| AI opt-out toggle | **Already supported** |

### 3.11 Settings — Workspace (§22–§25)

| Section | Backend need |
|---|---|
| General: rename workspace | **Backend add** — expose `PATCH /workspaces/:id` or `/workspace`; service exists |
| General: delete workspace | **Backend add** — expose DELETE; service exists |
| General: workspace slug field | **Blocked** — spec §23.4 hides identifier in UI |
| SMTP section | **Backend add** — full settings CRUD + test send HTTP API (service exists) |
| AI section (self-hosted keys) | **Backend add** — workspace/instance AI settings API |
| OIDC providers admin | **Backend add** — CRUD HTTP API (service partial) |

### 3.12 Settings — Members & teams (§26)

| Change | Backend need |
|---|---|
| Inline confirm strips → modals | **UI only** |
| Teams tab UI | **Wire existing API** — `/teams/*` fully implemented |
| Members, invites, seats | **Mostly wired** — `/members`, `/workspace/invitations` |

### 3.13 Settings — Audit log (§27)

| Change | Backend need |
|---|---|
| Entire audit log settings page | **Wire existing API** — `GET /audit/events` with filters + pagination |
| Richer audit actions (invites, sharing, slugs) | **Backend add (optional)** — only bookmark + team events logged today |

### 3.14 Settings — Billing (§28)

| Change | Backend need |
|---|---|
| Plan cards, comparison table, meters | **UI only** — data from workspace + counts |
| Inline cancel flow vs portal | **UI only** — checkout/portal/seats APIs exist |
| Invoice table with PDF downloads | **Blocked / defer** — prototype shows inline table; built app uses Stripe portal (spec-aligned). No `GET invoices` endpoint |
| Supporter countdown | **UI only** — config-driven |

### 3.15 Edge states (§29–§31)

| Flow | Backend need |
|---|---|
| Onboarding wizard overlay | **Wire existing API** for import step — `POST /import/*`; rest is **UI only** |
| Workspace switcher overlay | **Backend add** — list + create workspace HTTP |
| Slug disambiguation full page | **Wire existing API** — same as palette go-mode |
| App error pages | **UI only** |

### 3.16 Marketing (§33–§38)

| Change | Backend need |
|---|---|
| All landing/pricing/contact/legal layout | **UI only** (Astro static) |
| Hero palette demo, animated browser | **UI only** — no API |
| Contact form | **Already wired** — `POST /contact` + Turnstile |
| Pricing values | **UI only** — `PUBLIC_*` env at build time |
| Error pages | **UI only** |

---

## 4. Recommended backend work packages

Grouped for Jira epics. Ordered by **unblocking frontend** and **fixing existing 404s**.

### P0 — Fix frontend/backend contract breaks (already broken today)

1. **Expose AI suggestions HTTP API** — `POST /ai/suggest` wrapping `AiSuggestionCacheService.suggestWithCache`; fill `ai.contract.ts`; entitlement + aiOptOut checks.
2. **Expose workspace CRUD on HTTP** — at minimum:
   - `GET /workspaces` — list for current user
   - `PATCH /workspaces/active` or `PATCH /workspace` — rename (web already calls this)
   - `DELETE /workspace` — delete active workspace (web already calls this)
   - `POST /workspaces` — create (for switcher + entitlement gate)
3. **Align path naming** — web uses `/workspace` singular; contract uses `/workspaces/:id`. Pick one and update web or backend together.

### P1 — Unblock settings pages (frontend already built against these)

4. **Workspace mail settings API** — GET/PATCH settings + POST test (encrypt SMTP password at rest).
5. **Workspace AI settings API** — GET/PATCH (self-hosted operator config).
6. **OIDC provider admin API** — list/create/update/delete/toggle providers.

### P2 — Enrich list payloads (avoid N+1 in bookmark grid/table UI)

7. **Bookmark list enrichment** — optional `include=folders,tags` or always embed primary folder + tag names in list DTO for grid/table/card UI.
8. **Folder list enrichment** — expose `updatedAt` to frontend; decide `color` vs `icon` for dots.

### P3 — Prototype parity features needing new backend behaviour

9. **Login remember-me** — extended session TTL when opted in.
10. **Email change flow** — request change, pending state, verify, cancel (account API extension).
11. **Default bookmark view preference** — add to `PATCH /auth/account/preferences`.
12. **Audit log coverage** — extend logged actions (members, invitations, sharing, slug preferences) if settings UI needs them.

### P4 — Defer / product decision

| Item | Recommendation |
|---|---|
| Avatar upload | Fast-Follow unless v1 requires it |
| Notifications center | Out of scope (prototype decorative) |
| Inline billing invoices | Keep Stripe portal — UI restyle only |
| Instance-wide admin console | Separate epic; `AdminModule` is empty |
| Netscape/HTML export | Import exists; export JSON only today |

---

## 5. UI-only work (no backend ticket needed)

These design-gap items can proceed in frontend/marketing alone:

- Auth layout proportions, animations, brand rail styling
- App shell dimensions (248px sidebar, 52px top bar)
- Top bar breadcrumbs, cmd-trigger widget, header button placement
- Dashboard layout polish, stat icons, pinned mini-grid
- Bookmarks grid/table **UI** once wiring to existing list/bulk APIs
- Folders row UI + wire to existing CRUD
- **Tags page** (entire page — backend ready)
- Command palette styling + wire go disambiguation to existing `/go` API
- Settings vertical nav layout
- Audit log **page** (wire to existing `GET /audit/events`)
- Slug disambiguation page (wire to existing `/go` API)
- Onboarding overlay (import step uses existing import API)
- All marketing section gaps (static Astro + existing CSS classes)
- Error page styling
- Most auth screen visual treatment (except SSO, remember-me, email change)

---

## 6. Matrix — design gap section → backend ticket?

| Design gap § | Primary backend work |
|---|---|
| §0 Auth shell | Optional: remember-me, OIDC provider config |
| §1–§2 Login/Register | Optional: remember-me; wire resend-verification |
| §3 Email verify UI | Wire resend-verification |
| §4–§5 MFA | None |
| §6–§7 Password reset | None |
| §8 Setup | None |
| §9 App shell | **List/create workspace APIs** |
| §10 Dashboard | Optional: favicon proxy usage |
| §11 Bookmarks | Wire bulk/pagination; optional list enrichment |
| §12 Folders | Optional: color field; expose updatedAt |
| §13 Tags | **None — frontend only** |
| §14 Command palette | Wire go disambiguation; workspace list for switch |
| §15 Bookmark modal | **AI suggest HTTP API** |
| §16 Settings layout | None |
| §17 Profile | Email change, avatar (if in scope) |
| §18–§20 Account sections | None |
| §21 Preferences | Default view pref (optional) |
| §22 Workspace general | **Workspace PATCH/DELETE HTTP** |
| §23 SMTP | **Mail settings HTTP API** |
| §24 AI settings | **AI settings HTTP API** |
| §25 OIDC admin | **OIDC CRUD HTTP API** |
| §26 Members | None (wire teams UI) |
| §27 Audit log | Wire existing API; optional richer events |
| §28 Billing | None (portal pattern) |
| §29 Onboarding | Wire import API in wizard |
| §30 Workspace switcher | **List/create workspace APIs** |
| §31 Slug disambiguation | None (wire `/go`) |
| §32 App errors | None |
| §33–§38 Marketing | None |

---

## 7. Suggested Jira epic split (preview)

When you move to tickets, a sensible split:

| Epic | Scope |
|---|---|
| **E1: API contract fixes** | AI suggest, workspace CRUD HTTP, path alignment |
| **E2: Workspace operator settings API** | SMTP, AI keys, OIDC admin |
| **E3: App shell & navigation UI** | Sidebar, top bar, switcher (depends E1) |
| **E4: Bookmarks experience UI** | Grid/table, bulk bar, pagination (depends optional E5) |
| **E5: List DTO enrichment** | Bookmark/folder list payloads |
| **E6: Tags & audit pages UI** | Wire-only frontend |
| **E7: Auth & palette polish UI** | Mostly frontend |
| **E8: Marketing landing completeness** | Astro-only |
| **E9: Account enhancements** | Email change, remember-me, default view (if product-approved) |

---

*Cross-checked against `packages/backend/src/**` controllers and `packages/web/app/**` API clients.*
