# SlugBase — v1 Product & Architecture Specification (Rebuild)

**Status:** Approved as foundation; scoped to v1 launch.
**Author:** Derived from a full scan of the existing `slugbase` (self-hosted core), `slugbase-cloud` (SaaS layer), and the customer-facing and internal documentation, then re-shaped to the new unified architecture and narrowed to a v1-launchable scope.
**Scope of this document:** A complete, prose-only specification for rebuilding SlugBase from scratch as one codebase that launches both hosted and self-hosted. It defines the product, the feature set, the multi-tenant model, the deployment story, the authentication and AI capabilities, billing and plan enforcement, and the interface contracts for everything that depends on the outside world. It contains no code, no schemas, and no implementation snippets. It is the single source a development roadmap is derived from.

This document treats a fixed set of architectural decisions as given (single repository, separate static marketing site, in-repo docs, multi-tenant from day one, everything external behind an interface, pnpm workspace), and a set of now-settled product/architecture decisions (recorded compactly in the final "Resolved Decisions" log). Decisions are integrated into the body so the spec reads as settled.

---

## 1. Product Vision and Identity

SlugBase is a bookmark manager with a distinctive twist: every saved link can be given a short, memorable **slug** that resolves to a personal redirect at a predictable address (today, `/go/<slug>`). This turns a bookmark library into a personal (and team) URL shortener and keyboard-driven launcher: a user types a slug into their browser's address bar — or into an in-app command palette — and is forwarded straight to the destination. The product combines three ideas that normally live in separate tools: a clean bookmark manager, a personal short-link service, and a fast command-palette launcher.

The product identity and core idea are unchanged by this rebuild. What changes is the architecture: instead of an open-source core plus a separate "cloud delta" repository, SlugBase becomes one codebase that is multi-tenant from the first commit and is deployed in two shapes — a managed hosted service and a self-hosted install — using the **same code path** with **different configuration**.

The audiences are:

- **Individuals** who want a private, fast bookmark and short-link tool, either on the hosted service or self-hosted on their own server.
- **Teams** who want to share curated folders and bookmarks and use shared slugs.
- **Operators / self-hosters** who run their own instance and administer it via an instance-wide admin account.
- **The SlugBase operator** (the company running the hosted service), who needs billing, plan enforcement, and (post-launch) an operator console; at v1 launch, hosted operations run via direct database access plus a secret-protected aggregate-statistics endpoint.

The guiding principle for the rebuild: **self-hosted and cloud are the same product**. There is no feature that exists only because of "cloud code." Differences between a hosted deployment and a self-hosted deployment are expressed entirely through configuration and through swappable implementations of the external-dependency interfaces, never through forked behavior in the application logic.

---

## Scope — v1 vs. Fast-Follow (read first)

This rebuild targets a **v1-launchable scope**, not a full-parity reconstruction of everything the old two-repo product did. The goal of v1 is the **smallest coherent product that can launch hosted and self-hosted on one codebase**. Anything that is operationally deferrable is marked **Fast-Follow** (post-launch) and is deliberately excluded from v1 so the first release stays small and coherent. Where the body says "v1" it means "must ship for launch"; where it says "Fast-Follow" it means "explicitly out of the first release."

**In v1 (must ship for launch):**

- Multi-tenant workspaces; membership and roles; session-carried active workspace with an explicit switch endpoint.
- Server-side sessions; password auth; TOTP MFA with backup codes; personal API tokens; password reset; email verification; OIDC sign-in (DB-sourced providers on self-hosted, deployment-config providers on hosted).
- Bookmarks (modal create/edit, hard delete); folders; user-private tags; pinning; usage tracking; SSRF-safe metadata and favicon fetch.
- Slugs and the `/go` redirect (authenticated, per-workspace, collision disambiguation, remembered "go preferences").
- Global search, command palette, dashboard.
- Sharing of bookmarks and folders with teams and members (entitlement-gated on hosted; fully on for self-hosted).
- Workspace administration (members, teams, audit log, OIDC, SMTP, AI) plus a self-hosted instance-wide admin.
- Entitlements engine; Stripe-backed billing on hosted; no-op billing (full entitlements) on self-hosted.
- Plans: Free, Personal, Team (plus a config-driven supporter/lifetime launch promotion that is entitlement-equivalent to Personal).
- Downgrade-overflow handling (archive over-cap bookmarks, do not delete).
- Lossless import/export and the documented self-host backup story.
- One concrete implementation per external interface, with the clean seam in place (SMTP, one AI provider, Stripe, Cloudflare Turnstile, the existing analytics and error-reporting sinks behind no-op-able interfaces).
- Both database engines (embedded file-based and networked) on an identical schema and migration story.
- The separate static marketing site (in the same repo) and its contact form.
- In-repo documentation; English and German UI.

**Fast-Follow (explicitly post-launch, not v1):**

- A dedicated operator / super-admin console (a second authenticated surface). v1 ships no such surface.
- Additional provider implementations per interface (alternative mail, AI, billing, etc.). v1 ships one each.
- Soft-delete / trash for user-initiated deletion.
- Subdomain- or path-based tenancy.
- Browser extension or bookmarklet; public/anonymous share pages; drag-and-drop reordering; a notifications center; first-class backup/restore (beyond export + volume copy); AI features beyond field suggestions.
- Fine-tuning of the Team base-seat count and other config-level pricing/quota details.

---

## 2. Fixed Architectural Decisions

These are the constraints this spec is written against, stated up front so the rest of the document can assume them.

### 2.1 Single repository

Cloud and self-hosted live in one repository. There is no separate "cloud delta" repo, no vendored core tarball, and no build-time copy of the core into a second project. The previous model — where `slugbase-cloud` consumed `@mdguggenbichler/slugbase-core` as a published package and layered SaaS behavior on top — is discarded. All application logic, all tenancy logic, all billing logic, and all admin logic live together.

### 2.2 pnpm workspace

The repository is a **pnpm workspace** (a pnpm monorepo). Internal packages (for example: a shared UI library, a shared types/contracts package, the backend application, the web client, the marketing site, the docs) are workspace members. Package management, installs, and scripts assume pnpm throughout. No npm or yarn lockfiles.

### 2.3 Marketing site is a separate static site within the repo

The public marketing surface (landing page, pricing, contact, legal/terms/privacy/imprint, and similar non-application pages) is a **separate static site** that lives inside the same repository as its own workspace package. It is **separately built and deployed**, independent of the application runtime. The site is built with **Astro** (a static, zero-JS-by-default site generator) and deployed to **Cloudflare Workers** (decisions #28, #40); what is fixed is that it is a static site, in the same repo, built and deployed separately from the application. The application itself contains no marketing pages; the only product-marketing-adjacent surface allowed inside the application is what is strictly needed for sign-in context (for example, a side panel on the login screen), and even that is data-driven, not a marketing page. The marketing site's **contact form** calls a small public endpoint on the application (see Sections 11.1 and 11.8) and is protected by the challenge (bot-protection) interface.

### 2.4 Documentation lives in the source repo

All documentation — both end-user/customer-facing and operator-facing — lives in the same repository. The current split into separate `slugbase-docs` and `slugbase-docs-internal` repositories is collapsed into the single repo. The governing editorial principle is retained: **if a reader would need to be a SlugBase developer to understand a page, it does not belong in the docs.** Internal engineering design notes and architecture decisions are kept distinct from customer/operator documentation (for example, in a clearly separated section or directory), but everything is colocated with the source.

### 2.5 Multi-tenant from day one

The data model, the request lifecycle, and the authorization model are multi-tenant from the first line of code. There is no "single-tenant mode" that is later retrofitted with tenancy. Every tenant-owned record carries a workspace identifier, and every request resolves to a workspace context. A self-hosted install is simply a deployment that happens to have one (or a few) workspaces and a configuration that disables paid billing; it runs the identical multi-tenant code.

### 2.6 Everything externally-dependent is behind an interface

Every capability that reaches outside the application's own database and process is expressed as an **interface (a contract)**, with swappable implementations selected by configuration. This applies to, at minimum: transactional email, AI suggestions, authentication/identity federation (OIDC/SSO), billing, product analytics, error reporting, bot/abuse protection, and object/blob storage if introduced. The spec defines **only the contract** for each — what it is responsible for, what inputs and outputs it has conceptually, and what the self-hosted versus hosted defaults are — not the provider-specific implementation. Each interface has a no-op or local default so that a bare self-hosted install runs with zero external services configured. **v1 ships exactly one concrete implementation per interface** (the seam exists; the choice does not yet); additional implementations are Fast-Follow.

---

## 3. Core Concepts and Glossary

These terms are the canonical product vocabulary and are used consistently throughout the spec.

- **Workspace (tenant):** The top-level container that owns all user-visible data: bookmarks, folders, tags, teams, slugs, settings, and members. Every piece of tenant data belongs to exactly one workspace. A workspace is the unit of billing and plan enforcement. **"Workspace" is the single product term for the tenant; "organization" is deprecated** and is not used in the product, the API, or the docs.
- **Member:** A user account's association with a workspace, carrying a role (owner, admin, member). A single user account may be a member of multiple workspaces.
- **User account:** A globally unique identity (by email) that can sign in. A user account is distinct from a member; the account is the person, the membership is their seat in a given workspace.
- **Bookmark:** A saved destination URL with a title and optional metadata, owned by a user within a workspace. It may have an optional slug and may be organized into folders and labeled with tags.
- **Slug:** A short, memorable keyword attached to a bookmark. When forwarding is enabled, the slug resolves through the redirect endpoint to the bookmark's destination URL. Slugs are unique within a workspace.
- **Forwarding / "Go":** The redirect behavior: visiting the redirect address for a slug forwards the authenticated user to the destination URL. Collision resolution and the "remember my choice" behavior are part of this subsystem.
- **Folder:** A named, optionally icon-bearing container used to organize bookmarks. A bookmark can belong to multiple folders. Folders can be shared with teams or individual members. **"Folder" is the only container term; there is no "collection."**
- **Tag:** A user-private label used to filter and group bookmarks. Tags are not shared across users.
- **Team:** A named group of workspace members used as a sharing target. Bookmarks and folders can be shared with a team.
- **Pinning:** The single mechanism for marking a bookmark as prominent. **There is no separate "favorites" concept** anywhere in the product, the data model, or the UI.
- **Plan / Entitlements:** The set of capabilities and limits granted to a workspace (bookmark limits, AI availability, team sharing, audit log, seats, etc.). Plans are the hosted-facing packaging; entitlements are the internal representation the application checks.
- **Workspace admin:** A member with administrative rights within a workspace (manage members, teams, settings, etc.).
- **Instance-wide admin (self-hosted):** A user account flagged as administrator across the whole deployment, distinct from a per-workspace admin. This is the v1 notion of "operator" for self-hosted; there is no separate operator surface in v1.

---

## 4. Multi-Tenant Workspace Model

This is the backbone of the rebuild and the area where the old architecture is most directly replaced.

### 4.1 Workspaces and ownership

Every tenant-owned entity belongs to exactly one workspace. There is no "default tenant" special case baked into the application logic. A self-hosted install creates its **first workspace as part of first-run setup**; after that, new self-hosted users are **placed into existing workspaces by an admin** (via invitation) rather than each getting a new workspace automatically. A **hosted signup auto-creates a personal workspace** for the new account. The difference is only in which configuration path is active, not in the code that creates and owns data.

**Workspace creation is entitlement-gated on hosted.** The number of workspaces an account may create/own is itself an entitlement checked by the entitlements engine (Section 11.5), not an unbounded action: a hosted Free account may own exactly one workspace, and creating more requires a paid entitlement. On self-hosted, workspace creation is unrestricted (an instance-admin action under full entitlements). See Sections 11.5 and 12.2.

A workspace has: a name, a plan/entitlement state, a billing linkage (which may be empty on self-hosted), an included-seat count, a set of members, and all the bookmarks/folders/tags/teams/slugs/settings scoped to it.

### 4.2 Membership and roles

A user account joins a workspace as a **member** with one of three roles:

- **Owner:** Full control, including billing and workspace deletion. There must always be at least one owner. The owner is typically the creator.
- **Admin:** Manage members, teams, and workspace settings, but not necessarily billing ownership.
- **Member:** Use the product (create and organize bookmarks, use slugs, participate in shared content) without administrative rights.

A user account may belong to multiple workspaces simultaneously and switches between them. Roles are per-workspace: the same person can be an owner of one workspace and a plain member of another.

### 4.3 Tenant resolution (request context)

Every request that touches tenant data resolves to exactly one **active workspace context**. The v1 mechanism is **a session-carried active workspace, changed through an explicit switch endpoint**. The active-workspace selection lives in the server-side session (consistent with the server-side session strategy in Section 5.3). There is **no subdomain- or path-based tenancy in v1**. However, tenant resolution is implemented behind a **resolution interface** so that subdomain or path-prefixed tenancy can be introduced later **without touching application logic** — only the resolution implementation changes.

The resolution rules:

- An authenticated request resolves to the user's currently selected workspace. If the user has selected a workspace they are no longer a member of, the context is cleared and re-derived to a workspace they do belong to.
- A request that has no authenticated user and is not a public endpoint has no tenant context and is rejected for tenant-scoped operations.
- Switching the active workspace is an explicit, authenticated operation that verifies membership before changing context.

### 4.4 Data isolation

Tenant isolation is enforced at the data-access layer: every query for tenant-owned data is scoped by the active workspace identifier, and writes stamp the workspace identifier. Cross-workspace reads or writes are never possible through normal application paths. The authorization layer additionally enforces per-record ownership and sharing rules within a workspace (see Sharing). Isolation is defended by tests that attempt cross-tenant access and confirm denial.

### 4.5 Personal vs. team workspaces; leaving a workspace

A workspace can be a single-person "personal workspace" or a multi-person "team workspace." There is no separate entity for these; the distinction is purely the number of members and the plan.

**Self-hosted is, by design, an admin-curated multi-workspace product.** An instance-wide admin creates and manages workspaces and places users into them by invitation. It is **explicitly not** a model where every new user spins up their own tenant. This is the intended product shape, not a constraint to be relaxed: it keeps tenant isolation clean and puts the instance admin in control of who is placed where. (On hosted, by contrast, accounts self-serve their own personal workspace within the bounds of the workspace-creation entitlement — see Sections 4.1 and 12.2.)

**Leaving a workspace** means the member's **membership is revoked**. Data authored by that member — their bookmarks, folders, and tags — **remains with the workspace**. There is **no spin-off and no cross-workspace data movement**; this preserves tenant isolation (data never crosses a workspace boundary). A user who wants to take their content with them **exports it** (see Section 13) before leaving. (Removing a member is distinct from deleting a workspace, which removes all of that workspace's data.)

### 4.6 Slug namespace and tenancy

Slugs are unique **within a workspace**, not globally. Two different workspaces may each have a slug `mail`. A self-hosted single-workspace install simply has one slug namespace, which reads as "unique across the instance." The redirect subsystem always resolves slugs within the active workspace context.

---

## 5. Identity, Authentication, and Security

Authentication is unified: the same flows run on hosted and self-hosted, with differences expressed only through configuration (which identity providers are enabled, whether public registration is allowed, whether email verification is required).

### 5.1 Account model

A user account is identified by a unique email address and has a display name, a preferred language, a theme preference, an optional password credential (absent for accounts that only sign in via federated identity), an instance-wide admin flag (self-hosted), and security state (MFA enrollment, verification status). Accounts are global to the deployment; membership in workspaces is separate.

### 5.2 Entry paths: first-run setup, invitation, and public registration

How a person gets into a deployment depends on configuration. Self-hosted is an **admin-curated multi-workspace product** (Section 4.5): the instance-wide admin owns onboarding, so **setup + invite-only is the intended self-hosted shape**, not a temporary default.

- **First-run setup:** When a deployment has no users yet, a one-time setup flow creates the first account (as the instance-wide admin and as owner of the first workspace) and creates the first workspace.
- **Invitation:** After setup, additional users are added by an admin inviting them into an existing workspace. This is the **default and only** way to add users on self-hosted unless public registration is explicitly enabled.
- **Public registration:** An **off-by-default configuration flag**. When enabled, anyone can create an account, which triggers email verification and auto-provisions a personal workspace (subject to the workspace-creation entitlement on hosted — Section 12.2). **Self-hosted keeps public registration off by default** (admin-curated invitation is the intended path). **Hosted enables public registration with email verification required.**

These paths are not contradictory: setup creates the very first account; invitations populate workspaces; public registration, where enabled, is an additional open door.

### 5.3 Sessions and tokens

The product uses **server-side sessions** as its single session strategy, **identical on both deployments**. The old model (a JWT access cookie everywhere plus a cloud-only refresh-token flow) is **dropped entirely**. Server-side sessions give immediate revocation and clean multi-device logout, and the active-workspace selection already lives server-side, so the session is the natural home for it.

- **Primary web session:** Established on login, carried in an HTTP-only cookie, backed by a **database-backed** server-side session store (no Redis/external cache, so a bare self-host install needs no extra services — decision #46). Sessions have a configurable lifetime and can be revoked individually (enabling "log out everywhere"). The session also carries transient state such as in-progress federated-login handshakes and the active-workspace selection.
- **Personal API tokens:** Long-lived, user-created tokens (prefixed and stored only as hashes) for programmatic API access. Tokens are limited in number per user, individually named, track last-use, and can be revoked. API tokens bypass the interactive MFA step (they represent an already-trusted credential); this trade-off is documented.

### 5.4 Passwords and credentials

Passwords are hashed with a strong adaptive hashing algorithm. Password policy (minimum length, complexity) is enforced consistently and surfaced in the UI with a strength indicator. Password reset is a tokenized, time-limited, email-delivered flow that always responds generically to avoid account enumeration. A change-email flow verifies the new address before switching it.

### 5.5 Email verification

Two distinct email-verification flows exist and stay distinct:

- **Signup verification:** Confirms a newly registered account's email before it can fully sign in (required on hosted; configurable on self-hosted).
- **Email-change verification:** Confirms a new address when an existing user changes their email, switching the address only once confirmed.

All verification tokens are time-limited and stored as hashes.

### 5.6 Federated identity (OIDC / SSO)

The product supports signing in via external OpenID Connect providers, expressed through the **auth/identity interface** (Section 11.3) so the source of provider configuration is swappable:

- **Self-hosted:** Providers are configured by an admin through the admin UI and stored (secrets encrypted at rest). Custom endpoints can be specified for providers that are not auto-discoverable.
- **Hosted:** Providers are configured by the operator through deployment configuration. **Hosted workspace admins cannot add their own OIDC providers in v1** (federated providers are an operator-level concern on hosted).

Behavioral rules: accounts are linked to a federated identity by verified email; optional auto-creation of accounts on first federated login is configurable; a federated login that lands on an unverified or disallowed state is routed to the appropriate "verify" or "not allowed" outcome; and a successful federated login does not additionally prompt for SlugBase's own MFA step (the external provider is trusted for that factor). The interface supports either "providers from the database" or "providers from deployment configuration" without changing the login UX.

### 5.7 Multi-factor authentication (TOTP)

Accounts can enroll in time-based one-time-password MFA. Enrollment produces a secret (presented as a QR code and as text) and a set of one-time backup codes (shown once, stored only as hashes). After enrollment, password logins require a second-factor step. Users can disable MFA (with verification) and regenerate backup codes. The authenticator "issuer" label is configurable. MFA applies to interactive password logins; federated logins and API tokens do not trigger the second-factor step. A documented recovery procedure exists for locked-out users (self-hosted: a direct administrative reset by an instance-wide admin; hosted: a support-mediated reset).

### 5.8 CSRF, transport, and cookies

Mutating API requests are protected against cross-site request forgery using a token mechanism, with a small, explicit allowlist of exempt endpoints (login, logout, MFA verification, setup, registration, password reset, health, and the CSRF token endpoint itself). Cookies are HTTP-only and secured appropriately for the deployment. The public base URL and the front-end origin are configuration and must agree with the real, externally reachable HTTPS addresses; cross-origin allowances and proxy trust are configurable. (Cookie-domain handling is kept flexible to support related hostnames for a future operator console, but no second authenticated hostname ships in v1.)

### 5.9 Authorization model

Within a workspace:

- **Bookmarks and folders:** Readable by the owner and by anyone they are shared with (directly, via a team, or via a shared containing folder). Modifiable and deletable by the owner only.
- **Tags:** Private to the owning user; not shared.
- **Workspace administration:** Restricted to workspace admins/owners.
- **Instance-wide administration (self-hosted):** Restricted to accounts with the instance-wide admin flag.

The authorization layer is explicit and centralized so that sharing logic is consistent across list, read, redirect, search, and bulk operations.

---

## 6. Bookmarks — Core Domain

### 6.1 What a bookmark is

A bookmark is a saved destination consisting of a title, a destination URL, an optional slug, a forwarding flag, organizational associations (folders and tags), a pinned flag, and usage statistics (access count and last-accessed timestamp). It belongs to a single user within a single workspace. A bookmark may also be in a **plan-archived** state (see Section 12.5), which hides it from active use without deleting it.

### 6.2 Lifecycle and operations

Users create, read, update, and delete bookmarks. **Creation and editing happen through a single in-place modal experience; there is no dedicated bookmark detail page or detail route.** Deletion is a **hard delete** that cascades to organizational and sharing associations. **There is no soft-delete/trash in v1** (it is a Fast-Follow candidate); the only non-deleting "hidden" state is the plan-archived state used by downgrade-overflow handling.

A bookmark can be **pinned**, which surfaces it prominently on the dashboard and as a filter. Pinning is the only prominence mechanism; there is no favorites concept.

### 6.3 Usage tracking

When a bookmark is opened (including via a slug redirect), its access count is incremented and its last-accessed time is updated, asynchronously so it never blocks the redirect or the click. These statistics power "most used" sorting and the dashboard's quick-access section.

### 6.4 Metadata and favicons

When creating a bookmark, the product can fetch page metadata (title, description, site name) from the destination to assist the user and to feed AI suggestions. It can also display the destination's favicon via a server-side proxy. Both fetches are **SSRF-safe**: outbound requests resolve and validate the target host to prevent the server from being used to reach internal/private network addresses, and responses are cached for a reasonable period. These outbound fetches run through the shared, hardened HTTP-egress path (Section 11.10).

### 6.5 Listing, filtering, sorting, pagination

Bookmark lists support: filtering by folder, by one or more tags, by pinned state, and by sharing scope (all, mine, shared with me, shared by me); matching on title/URL/slug via a query parameter; sorting by recently added, alphabetical, most used, and recently accessed; and pagination with selectable page sizes. The list is available both as a card grid and as a table, with the user's view preference remembered. A companion endpoint returns just the matching identifiers to support "select all across pages" bulk operations. Plan-archived bookmarks are excluded from normal lists and counts.

### 6.6 Bulk actions

From the list, users can select bookmarks (including selecting all across pages) and perform bulk delete, bulk move to a folder, bulk add tags (with a preview of the resulting merge), and bulk share (where sharing is available). Bulk actions respect ownership and authorization.

---

## 7. Organization — Folders and Tags

### 7.1 Folders

Folders are named containers with an optional icon (chosen from a searchable icon set). A bookmark can be in multiple folders. Folders support create/read/update/delete, listing with search/sort/pagination, scope filtering (all, mine, shared), and sharing with teams or individual members. Sharing a folder transitively grants read access to the bookmarks it contains. There is no separate "collection" entity; folders are the container.

### 7.2 Tags

Tags are user-private labels. They support create/read/update/delete and are used to filter bookmarks. The product provides a tag overview with a distribution view and a preview of bookmarks for a selected tag, plus a "most used tags" surface on the dashboard. Tags are never shared between users; each user's tag set is their own.

---

## 8. Slugs and Link Forwarding ("Go")

This is SlugBase's signature capability and is specified precisely.

### 8.1 Slugs

A slug is a short keyword attached to a bookmark. A bookmark may have at most one slug. A slug is required when forwarding is enabled and may be empty when forwarding is off. Slugs are unique within a workspace. The UI shows the resulting forwarding address and offers a copy action.

### 8.2 The redirect endpoint

The product exposes a redirect endpoint (today at the `/go/<slug>` path on the deployment's origin) that resolves a slug to a destination and forwards the user. The behavior:

1. The redirect **requires an authenticated user**. An unauthenticated visit is sent to login and returned to the redirect afterward. **Slugs are private to a workspace and its members; there is no public/anonymous slug resolution and no public pages in v1.**
2. The slug is resolved within the visitor's active workspace context, considering only bookmarks the user can access (their own plus shared) that have forwarding enabled.
3. **No match:** a not-found response.
4. **Exactly one match:** an immediate redirect to the destination, with usage tracking updated asynchronously.
5. **Multiple matches** (the same slug accessible via more than one bookmark — possible through sharing): a disambiguation page lets the user choose, with an option to "always use this," which records a per-user preference.

### 8.3 Go preferences

The per-user "remembered choice" for ambiguous slugs is stored and managed: users can list and remove their remembered slug-to-bookmark mappings. A subsequent ambiguous resolution honors the remembered choice and redirects directly.

### 8.4 Browser and command-palette integration

Two integration surfaces make slugs fast to use:

- **Browser custom search engine:** Documentation and an in-app guide help the user register the deployment as a browser search engine with a keyword (e.g. `go`) so that typing the keyword plus a slug in the address bar jumps straight to the redirect endpoint.
- **Command palette "go" mode:** The in-app command palette accepts a `go <slug>` form (or a pasted redirect path) and opens the corresponding destination, including offering matching slugs as the user types.

---

## 9. Search, Command Palette, and Dashboard

### 9.1 Global search and command palette

A keyboard-invoked command palette (Ctrl/Cmd-K) is a central navigation device. Empty, it offers navigation and quick actions (create bookmark, create folder, import, export). With a query, it searches bookmarks, folders, and tags, and supports the "go" slug mode. Results can be opened in a new tab via a modifier key. A dedicated server search endpoint matches across bookmarks, folders, and tags with sensible limits per type, with a client-side fallback.

### 9.2 Dashboard

The post-login home surface presents: counts (bookmarks, folders, tags); a prominent search/command entry; a quick-access section of frequently-used slugs; pinned bookmarks; a "most used tags" section; sharing-related stats (shared with you / by you); and a dismissible onboarding checklist that nudges first-run actions (import, set up the browser search engine, create a folder, create a tag). When a workspace's entitlements include caps or upgrade paths (hosted), the dashboard may surface plan limits and upgrade prompts; these are entitlement-driven, never hard-coded to a deployment mode.

---

## 10. Administration

### 10.1 Workspace administration

Available to workspace admins/owners, scoped to a single workspace:

- **Members:** Invite, add, edit, and remove members; set roles; resend invitations; set or reset passwords (where applicable); assign members to teams.
- **Teams:** Create, edit, and delete teams; manage team membership. Teams are sharing targets.
- **Audit log:** A read-only, paginated record of significant actions (who did what to which entity and when), scoped to the workspace.
- **Identity providers (OIDC):** Configure federated identity providers (self-hosted; DB-sourced). Includes the callback URL to register with the provider. Hidden on hosted, where providers are operator-managed.
- **Email (SMTP) settings:** Configure the workspace/instance's outbound email transport and send a test message (self-hosted). On hosted, email transport is operator-configured and this UI is hidden.
- **AI settings:** On self-hosted, the full form — enable AI suggestions and configure the provider/credential/model. On hosted, an enable-only toggle (the credential is operator-supplied).

Which panels are visible depends on entitlements and on which configuration sources are active (for example, the OIDC and SMTP panels are hidden when those are operator-managed). This visibility is entitlement/config-driven, never a hard-coded deployment-mode branch.

### 10.2 Deployment-level administration

There is **no separate operator / super-admin console in v1**; building a second authenticated surface is **Fast-Follow**.

- **Self-hosted:** Deployment-level administration is performed by an account with the **instance-wide admin flag** (the first account created at setup, and any account an instance admin promotes). This is distinct from per-workspace admin: an instance-wide admin governs the deployment, while a workspace admin governs a single workspace. There is no separate operator tier.
- **Hosted:** At launch, the SlugBase operator runs operations via **direct database access** plus the existing **secret-protected aggregate-statistics endpoint** (Section 18). A dedicated operator console (its own authenticated surface, workspace/account directory, operator invitations, MFA, and richer tooling) is a **Fast-Follow** deliverable, not part of v1.

---

## 11. External-Dependency Interfaces (Contracts)

Each capability that reaches outside the application is defined here **as a contract only**. For every interface: the application depends solely on the contract; implementations are selected by configuration; there is always a default that lets a bare self-hosted install run with no external services; and implementations are swappable without touching application logic. **v1 ships one concrete implementation per interface** (named below as the "v1 implementation"); additional implementations are Fast-Follow.

### 11.1 Transactional email (mail interface)

- **Responsibility:** Deliver transactional messages — signup verification, email-change verification, password reset, member invitation, and contact-form notifications. The contract exposes the ability to send a message (recipient, subject, text/HTML body, and the logical message type) and to report whether the transport is currently configured/available.
- **v1 implementation:** **SMTP, used on both deployments.** Self-hosted admins configure SMTP in the admin UI; hosted configures SMTP via deployment configuration. A "send test email" capability is available where the admin UI applies.
- **Default when unconfigured:** A no-op/log implementation so the app still runs (email-dependent flows degrade gracefully and say so).
- **Swappable:** Yes. The application calls "send" and "is available"; alternative providers are Fast-Follow.

### 11.2 AI suggestions (AI interface)

- **Responsibility:** Given a destination URL (and optionally fetched page metadata) and a desired output language, return suggested bookmark fields — a title, a slug candidate, a set of tags, a detected language, and a confidence indicator. The contract also reports whether AI is available for the current context. Results are cacheable by (workspace, user, canonical URL, output language) for a bounded period, and usage can be recorded for analytics.
- **v1 implementation:** **OpenAI**, behind a vendor-neutral contract (decision #49) — no application code depends on OpenAI specifics; alternative providers are Fast-Follow. **Self-hosted:** admins supply their own credential and model via the admin UI; disabled until configured. **Hosted:** the operator supplies the credential via deployment configuration, and per-workspace availability is gated by entitlements with a per-workspace enable toggle. Users can individually opt out on either deployment.
- **Swappable:** Yes. The contract assumes no particular vendor, model naming, or request shape; the application asks for "suggestions for this URL" and gets a structured result.

### 11.3 Authentication / identity federation (auth-provider interface)

- **Responsibility:** Supply the set of available federated identity providers and drive the OIDC handshake (start, callback, claims extraction), plus the rules for linking/auto-creating accounts. The contract abstracts **where provider configuration comes from**.
- **v1 implementation:** **Self-hosted** reads providers from the database (admin-configured, with custom-endpoint overrides). **Hosted** reads providers from deployment configuration; hosted workspace admins cannot add their own.
- **Swappable:** Yes. The login experience is identical regardless of provider source.

### 11.4 Billing (billing interface)

- **Responsibility:** Translate between the product's plan/entitlement model and an external billing system. The contract covers: starting a checkout to purchase or change a plan (recurring or one-time), opening a self-service billing-management portal, reporting the current subscription/plan state for a workspace, adjusting quantities such as extra seats, and receiving asynchronous billing events (subscription created/updated/cancelled, payment succeeded/failed) that update entitlements. It handles idempotent event processing and tax/VAT collection where relevant.
- **v1 implementation:** **Stripe**, on hosted. **Self-hosted uses the no-op billing implementation** that grants the full/unlimited entitlement set and never charges — no checkout, no portal, no payment, no paid self-host licensing in v1.
- **Swappable:** Yes. Application logic checks **entitlements**, never the billing provider directly. The billing provider's only job is to keep entitlements in sync with the external system.

### 11.5 Plan / entitlements engine

The **entitlements engine** is the linchpin that replaces the old deployment-mode branching. Every feature that was previously gated by an "is this cloud?" check is instead gated by an **entitlement check** on the active workspace — or, in one case, on the acting **account**. The engine answers: how many bookmarks may this workspace hold; is AI available; is team sharing available; is the audit log available; how many seats are included and used; and **how many workspaces an account may create/own**. The last of these is an account-scoped entitlement (not workspace-scoped) because it gates the creation of new workspaces themselves: it closes the otherwise-obvious bypass of the per-workspace bookmark cap (without it, an account could create N workspaces to obtain 50×N free bookmarks). **On self-hosted the entitlement set is full/unlimited by default — all features on, no caps, and unrestricted workspace creation** (audit log, team sharing, and AI-if-a-key-is-present are all available; there is no artificial gating on self-hosted). On hosted it is derived from the account's/workspace's plan via the billing interface. Application code asks the entitlements engine, not the deployment mode.

### 11.6 Product analytics (analytics interface)

- **Responsibility:** Record product-usage and conversion events (consent-gated) for understanding behavior. The contract exposes event recording and is a no-op when analytics is not configured or consent is not granted.
- **v1 implementation:** The existing analytics sink, behind the no-op-able interface. **Self-hosted default:** off (no-op). **Hosted:** operator-configured, gated behind user consent (cookie/consent banner).
- **Swappable:** Yes.

### 11.7 Error reporting (error-reporting interface)

- **Responsibility:** Capture and report runtime errors/exceptions (front-end and back-end) for diagnostics, consent-gated and privacy-aware (control over whether personally-identifying data is attached). The contract exposes error capture and is a no-op when unconfigured.
- **v1 implementation:** The existing Sentry-compatible error sink, behind the no-op-able interface. **Self-hosted default:** off; optionally enabled via configuration. **Hosted:** operator-configured, consent-gated.
- **Swappable:** Yes; the contract assumes no specific vendor.

### 11.8 Bot / abuse protection (challenge interface)

- **Responsibility:** Provide human-verification / bot mitigation for abuse-prone unauthenticated surfaces (notably the marketing site's contact form, and potentially registration). The contract exposes "verify this challenge token" and a way to skip verification in development.
- **v1 implementation:** **Cloudflare Turnstile**, behind the contract. **Self-hosted default:** no-op/disabled. **Hosted:** operator-configured.
- **Swappable:** Yes.

### 11.9 Persistence (database interface)

- **Responsibility:** Provide relational persistence for all application data via a single internal data-access abstraction, supporting more than one engine on an **identical schema and migration story**.
- **v1 implementation:** **Both engines ship in v1.** An **embedded file-based engine** is the self-hosted default (zero external dependency, single-node) and is a **deliberate self-hosting selling point**. A **networked relational engine** is the hosted default. Both run the same schema and the same forward-only migrations. The data-access abstraction is implemented with **Drizzle ORM** plus a **thin in-house dialect layer** that keeps embedded **SQLite** (the self-host default, for users who prefer a single-file DB) and **Neon Postgres** (hosted) on one logical schema; **Drizzle Kit** owns the single forward-only migration history (decision #41).
- **Swappable:** Yes — application code targets the data-access abstraction, not a specific engine.

### 11.10 Outbound HTTP egress (fetch interface)

- **Responsibility:** Centralize all server-initiated outbound HTTP (metadata fetch, favicon fetch, any future webhooks) behind one hardened, SSRF-safe path with host validation, timeouts, size limits, and caching. This is a single chokepoint for safety; it is the boundary to the outside world and must not be bypassed.

### 11.11 Secret encryption (crypto interface)

- **Responsibility:** Encrypt and decrypt sensitive at-rest values (email credentials, AI credentials, federated-identity client secrets, MFA secrets) using a configured key. The contract exposes encrypt/decrypt and a strict mode that refuses to silently fail in production. This boundary is consistent across all secret-bearing fields.

---

## 12. Billing and Plan Enforcement

This section specifies the hosted-facing packaging and how it maps to entitlements. On self-hosted, none of the paid mechanics apply (the billing interface is the no-op implementation and the workspace has the full/unlimited entitlement set), but the entitlement checks themselves still run — they simply always pass.

### 12.1 Plans

The hosted service offers:

- **Free:** A capped tier. Up to **50 bookmarks per workspace**; AI suggestions unavailable; no team sharing or team administration; no audit log; **an account may own exactly one workspace**. The entry point.
- **Personal:** A paid individual tier. Unlimited bookmarks; AI suggestions available; single-user (no team sharing/administration); **a paid entitlement is required to create/own more than one workspace**.
- **Team:** A paid collaborative tier. Unlimited bookmarks; AI suggestions available; team sharing and team administration; member invitations; audit log; a base number of included seats with the ability to purchase additional seats.
- **Supporter / lifetime:** **Not a separate hard-coded plan.** It is a **config-driven launch promotion** (a one-time purchase, time-boxed) whose entitlement effect is **"Personal, permanent."** There is no separate code path: a supporter purchase simply grants the Personal entitlement set permanently to the workspace.

Pricing specifics (amounts, monthly/yearly, extra-seat pricing, the supporter price and deadline, and the **exact Team base-seat count**) are configuration and live in deployment configuration and the marketing site, not hard-coded in application logic. The Free bookmark cap of 50 is a concrete starting value and is confirmable later as configuration.

### 12.2 Limits and quotas (entitlements)

The entitlements the application checks, with their plan mapping:

- **Bookmark limit:** Free is capped at **50 bookmarks per workspace**; Personal, Team, and supporter-granted workspaces are unlimited. Reaching the cap blocks creation with a clear, actionable message (including on import). See Section 12.5 for what happens to existing over-cap bookmarks on a downgrade.
- **Workspaces per account (account-scoped entitlement):** On hosted, a **Free account may create/own exactly one workspace**; creating additional workspaces requires a paid entitlement (Personal, Team, or supporter-granted). This is what makes the per-workspace 50-bookmark Free cap meaningful — without it, an account could create N free workspaces for 50×N free bookmarks. **On self-hosted, workspace creation is unrestricted** (an instance-admin action under full entitlements, consistent with the admin-curated multi-workspace shape in Section 4.5).
- **AI availability:** Off on Free; on for Personal, Team, and supporter-granted (subject to the AI interface being configured and the user not having opted out).
- **Team sharing (bookmarks and folders):** Team plan only on hosted. On other hosted plans the sharing UI is hidden and the API refuses. Always on for self-hosted.
- **Team administration (Members and Teams admin):** Team plan only on hosted; always on for self-hosted.
- **Member invitations:** Team plan only on hosted; always on for self-hosted.
- **Audit log:** Team plan only on hosted; always on for self-hosted.
- **Seats:** Team includes a base number of seats (the exact number is a configuration detail, finalized as a Fast-Follow tuning step) and supports purchasable extra seats. **An invitation consumes a seat on acceptance, not on send.** The seat count **cannot be reduced below the current member count.**

### 12.3 Lifecycle

Workspaces start on Free. A workspace owner/admin can start a checkout to move to a paid plan or to take the supporter promotion, can open a self-service portal to manage or cancel, and can adjust extra seats. All of these flow through the billing interface; the application reacts to billing events by updating the workspace's plan/entitlement state idempotently. Deleting an account/workspace is blocked when the actor is the billing owner of an active paid workspace until billing is resolved.

### 12.4 Enforcement points

Enforcement is centralized through the entitlements engine and applied at: bookmark creation and import (bookmark limit), the **workspace-creation endpoint** (workspaces-per-account entitlement — a hosted Free account is held to one workspace; self-hosted is unrestricted), AI suggestion requests (AI availability), share operations and sharing UI (team sharing), member/team admin endpoints and UI (team administration), invitation endpoints and acceptance (seats and team plan), and audit-log access (audit availability). The UI reflects entitlements (hides or disables gated features and shows upgrade prompts — including offering an upgrade when a Free account tries to create a second workspace) while the API independently enforces them (never trusting the client).

### 12.5 Downgrade overflow (cancellation or expiry)

When a workspace **downgrades to Free** — by cancellation or by a paid subscription expiring — the change takes effect **at billing-period-end, after a grace period** (so a user who re-subscribes or whose payment recovers within the grace period is never disrupted). When the downgrade finally takes effect and the workspace holds more bookmarks than the Free cap allows:

- The over-cap bookmarks are **archived, not deleted** — moved into the plan-archived state. They are **hidden from active use** (excluded from lists, search, counts, slug resolution, and the dashboard) but **fully preserved**.
- Which bookmarks are archived versus kept active follows a deterministic, documented rule (for example, keeping the most recently used or most recently created up to the cap, archiving the remainder). The selection rule is configuration-adjacent and documented to the user.
- New-bookmark creation is blocked while the workspace is at or over the Free cap (the creation-blocking behavior from Section 12.2 still applies), **but creation-blocking is not the only cap behavior** — existing data is archived and preserved, never destroyed.
- On **re-upgrade** to a plan with a higher (or unlimited) cap, archived bookmarks are **restored** to active use automatically (up to the new cap; any still-over-cap remainder stays archived under the same deterministic rule).

The plan-archived state is distinct from a user-facing trash/soft-delete (which is out of scope for v1); it exists solely to make downgrades non-destructive and reversible.

---

## 13. Import and Export

- **Import:** Users can import bookmarks from a JSON array (objects with at least title and URL, optionally slug, forwarding flag, pinned flag, folder names, and tag names) and from a browser-exported Netscape-format HTML file (parsed with a reasonable size cap). Folder and tag names referenced on import are created-or-matched by name. Invalid or duplicate slugs are skipped rather than failing the whole import. Imports are bounded (a maximum number of bookmarks per request) and report success/failure counts. On capped (Free) workspaces, import respects the bookmark limit.
- **Export:** Export is **round-trip-complete (lossless)**. A user's export includes, for each accessible bookmark, the full record needed to recreate it: title, URL, slug, forwarding flag, pinned state, and the bookmark's **folder and tag associations** (by name). Because export is the documented self-host backup mechanism, it **must not be lossy** — an export followed by an import into a fresh workspace reproduces the user's bookmarks, folders, and tags faithfully. (Sharing grants and other workspace-level relationships are out of the personal export's scope; the export is the user's own content.)

---

## 14. Self-Hosted Deployment Story

Self-hosted is a first-class deployment of the identical codebase, not a stripped-down fork. It is, by design, an **admin-curated multi-workspace product**: an instance-wide admin creates and manages workspaces and invites users into them. It is explicitly not a self-serve "every user gets their own tenant" model.

### 14.1 Shape

A self-hosted install is a single deployable application (the API/back-end plus the bundled web client) backed by the **embedded file-based database by default** (a deliberate selling point — no external database to operate), or a networked relational database if configured. It runs the same multi-tenant code as the hosted service; it simply has the no-op billing implementation (full entitlements, including **unrestricted workspace creation** by the instance admin), admin-configured email/AI/identity, and the admin-curated set of workspaces.

### 14.2 Packaging and run

The product ships as a container image (with a documented compose example) and can also be run directly from a build. There is a combined image (API plus web client) and the option of an API-only image. The default exposes a single port, persists data to a mounted volume (for the embedded database), and exposes a health endpoint and a version endpoint.

### 14.3 First run and lifecycle

On first start with an empty database, the setup flow creates the first account (instance-wide admin and owner of the first workspace) and the first workspace. After setup, the instance admin creates any additional workspaces (unrestricted, under full entitlements) and adds users by invitation into existing workspaces (public registration stays off by default unless explicitly enabled). Database migrations run automatically on startup as a single forward-only history. Upgrades are performed by deploying a newer image; migrations apply forward automatically.

### 14.4 Backup story (v1)

The v1 backup story is: the **enriched, lossless JSON export** (Section 13) for per-user content, plus, for the embedded database, **copying the data volume** for a full-instance snapshot. There is **no first-class backup/restore feature in v1** (that is a Fast-Follow candidate). The export's losslessness is a hard requirement precisely because it is the documented backup path.

### 14.5 Configuration

Self-hosted behavior is entirely configuration-driven (see Section 15): required secrets, the public addresses, the database choice, whether public registration is open (off by default), whether email verification is required, and which external interfaces are wired up (SMTP for email, an AI credential, identity providers via the admin UI). With nothing optional configured, the install still runs: email-dependent flows degrade gracefully, AI is simply unavailable, and there is no billing.

### 14.6 Reverse proxy and TLS

The deployment is expected to sit behind a reverse proxy terminating TLS. The configured public base URL and front-end origin must match the externally reachable HTTPS addresses, the app must be told how many proxy hops to trust, and cross-origin allowances are configurable. Documentation provides proxy examples.

### 14.7 Hosted Deployment Topology (settled)

The hosted service uses a split deployment: the **web client** is served from the edge, the **API/back-end** runs as a container in EU-Frankfurt, and the **database** is Neon Postgres in the same region.

| Layer | Platform | Region / notes |
|---|---|---|
| **Web client (frontend)** | Cloudflare Workers | Global edge; static assets + SSR served from CF network |
| **API / back-end** | Fly.io (`fra` — Frankfurt, DE) | Container image (API-only variant from §14.2); ~600 km from Vienna; primary EU serving region |
| **Database (hosted)** | Neon Postgres (`aws-eu-central-1` — Frankfurt, DE) | Same AWS region as Fly.io `fra`; colocation keeps query latency sub-1 ms within the DC |
| **Marketing site** | Cloudflare Workers (static, separately built, §19, decision 28) | Global edge; independently deployable from the app |

**Rationale for Fly.io over Railway:** Railway's only EU region is Amsterdam (`europe-west4-drams3a`, ~1200 km from Vienna). Neon Postgres has no Amsterdam region; colocating API and DB on Railway EU would require cross-region hops on every query. Fly.io Frankfurt is the closest EU region to Austria and shares the same Frankfurt AWS zone as Neon.

**Self-hosted is unaffected:** self-hosted users continue to run the combined container image (§14.2) on their own infrastructure. The split topology described here is exclusively for the operator-run hosted service.

**CORS and origin configuration:** `APP_BASE_URL` points to the Fly.io app URL (or a custom domain in front of it); `FRONTEND_ORIGIN` points to the Cloudflare Workers frontend origin. Both are required secrets (§15) validated at startup.

---

## 15. Configuration Model

Configuration is layered and explicit. Three kinds of settings exist:

1. **Deployment configuration (environment):** Set by the operator at deploy time. Includes required security secrets (session-signing secret, at-rest encryption key), the public base URL and front-end origin, database selection and connection details, deployment flags (public registration on/off, email-verification required on/off), the selection and credentials for each external interface implementation (SMTP transport, AI credential, deployment-config identity providers on hosted, Stripe keys and price identifiers on hosted, analytics, error reporting, Turnstile), CORS allowances, proxy trust, cookie domain, and the secret for the aggregate-statistics endpoint. The application validates required secrets at startup and refuses to run insecurely in production.

2. **Workspace/instance settings (database):** Set by admins through the UI and stored (secrets encrypted at rest). Includes admin-managed SMTP settings, admin-managed AI settings, and admin-managed identity providers — on self-hosted, where those sources are active.

3. **User preferences:** Per-account settings such as language, theme, accent color, default bookmark view, and AI opt-out.

A guiding rule: a setting that distinguishes a hosted deployment from a self-hosted deployment is expressed as configuration or as an interface-implementation choice — **never** as a code branch on "which product is this." The old `SLUGBASE_MODE`/`isCloud` branching is replaced by (a) the entitlements engine and (b) interface selection.

---

## 16. Data Model (Conceptual)

Described in prose, as conceptual entities and relationships, generalized so that **every tenant-owned entity carries a workspace identifier from the start**. This is a **greenfield rebuild with a single new forward-only migration history**; the previously-separate core and cloud migration chains are unified. **Migrating data from existing instances is a separate workstream not covered by this spec.**

- **Workspace:** The tenant. Has name, plan/entitlement state, billing linkage (possibly empty), included- and extra-seat counts, and timestamps. Owns all the entities below.
- **User account:** Global identity by email, with name, optional password credential, language, theme, verification state, instance-wide admin flag, MFA state (enrollment flag, encrypted secret, enrollment time), and AI-opt-out preference.
- **Membership:** Associates a user account with a workspace and a role (owner/admin/member).
- **Workspace invitation:** A pending invitation to join a workspace (email, hashed token, status, expiry). A seat is consumed on acceptance, not on send.
- **Bookmark:** Belongs to a user within a workspace. Has title, URL, optional slug (unique within the workspace), forwarding flag, pinned flag, **plan-archived flag** (for downgrade overflow), access count, last-accessed time, and timestamps. Associated many-to-many with folders and tags; optionally shared with teams and members.
- **Folder:** Belongs to a user within a workspace. Has name, optional icon, timestamps. Shareable with teams/members.
- **Tag:** Belongs to a user within a workspace. Has name. User-private.
- **Bookmark–folder and bookmark–tag associations:** Many-to-many link records, workspace-scoped.
- **Team:** A named group within a workspace, with a description. Has members.
- **Team membership:** Associates accounts with teams.
- **Sharing records:** Bookmark-to-team, bookmark-to-user, folder-to-team, folder-to-user share grants.
- **Slug preference:** Per-user remembered choice resolving an ambiguous slug to a specific bookmark, workspace-scoped.
- **Identity provider configuration:** Federated provider definitions (key, client id, encrypted client secret, issuer, optional explicit endpoints, scopes, auto-create flag, default role), workspace/instance-scoped where database-sourced (self-hosted).
- **Workspace/instance settings (key-value):** Settings such as SMTP and AI configuration, workspace-scoped, secrets encrypted.
- **Credential tokens:** Password-reset tokens, signup-verification tokens, and email-change tokens — all hashed and time-limited. (No refresh tokens; sessions are server-side.)
- **Personal API tokens:** Per-user named tokens, hashed, with last-use and revocation.
- **MFA backup codes:** Per-user one-time codes, hashed.
- **AI suggestion cache:** Cached suggestions keyed by workspace, user, canonical URL, and output language, with the suggested fields and a confidence value.
- **AI suggestion usage:** Records of which suggested fields were actually used, for analytics.
- **Audit events:** Workspace-scoped records of significant actions (actor, action, entity type/id, metadata, time).
- **Billing/subscription state:** On the workspace (plan, external customer/subscription linkage, subscription status, current period end, included and extra seats) plus an idempotency ledger of processed billing events. Empty/no-op on self-hosted.
- **Server-side session store and migration bookkeeping:** The session store backing the server-side session strategy, and a single schema-migration tracking record.

(No operator-console entities ship in v1; if a future operator console is built, its operator accounts/invitations are a Fast-Follow addition.)

Relationship summary: a workspace has many members, bookmarks, folders, tags, teams, slugs, settings, and audit events; a user account has many memberships, and within a workspace owns many bookmarks/folders/tags and may belong to many teams; bookmarks relate many-to-many to folders and tags and may be shared with teams and members; folders may be shared and transitively expose their bookmarks.

---

## 17. Internationalization

The product is multilingual. v1 ships **English and German**; the rebuild keeps an internationalization layer with externalized message catalogs and a translation-management workflow. Language is auto-detected and overridden by the signed-in user's preference. The AI suggestion feature respects a desired output language. New UI is authored against the message catalog rather than with hard-coded strings.

---

## 18. Non-Functional Requirements

- **Security:** Strong password hashing; encrypted at-rest secrets; hashed tokens; CSRF protection on mutations; SSRF-safe outbound fetches with host validation, timeouts, and size limits; strict transport and cookie settings; rate limiting on sensitive endpoints (login, token creation, registration, password reset); enforced tenant isolation defended by tests; server-side sessions with immediate revocation; a clear MFA recovery procedure. Security is a first-class requirement, and a periodic security audit is part of the operating rhythm.
- **Privacy and consent:** Analytics and error reporting are consent-gated and privacy-aware, with control over personally-identifying data. A cookie/consent mechanism governs optional tracking on the hosted service. Self-hosted defaults to no external telemetry.
- **Performance:** Bookmark lists, search, and the command palette feel instant for typical libraries; redirects are fast (usage tracking is asynchronous and never blocks the redirect); AI suggestions are cached.
- **Observability:** Health and version endpoints; an aggregate operational-statistics endpoint protected by a shared secret for external monitoring (this is the hosted operator's primary observability hook at launch); consent-gated error reporting via the error-reporting interface.
- **Accessibility and UX quality:** A polished, accessible, keyboard-friendly experience (the command palette, confirmations for destructive actions, toasts, empty states, and loading skeletons are part of the expected baseline). Theming includes light/dark/auto and an accent color.
- **API and integration:** A documented REST API covering auth (and MFA), bookmarks (CRUD, search, import/export, AI suggest), folders, tags, teams, tokens, workspace administration, identity providers, slug/go preferences, configuration/entitlements, and the hosted-only workspace/billing endpoints. An OpenAPI description is published, with optional interactive docs that can be disabled. The API is authenticated by session or by personal API token (Bearer), and CSRF applies to cookie-authenticated mutations.

---

## 19. Technology Stack and Package Layout (settled)

The stack below is fixed for v1 (recorded compactly as decisions #37–#50 in §21). It names tool/framework choices only — no code or schemas — consistent with the rest of this document.

### 19.1 Stack

| Concern | v1 choice | Notes |
|---|---|---|
| Language | **TypeScript** (strict, no `any`) | All packages. |
| Backend | **NestJS** | Its module/DI system hosts the config-selected interface implementations (§2.6, §11) — interface swapping replaces deployment-mode branching; OpenAPI is generated from the contracts (§18). Runs as a Node container on Fly.io (§14.7). |
| Web client | **React Router v7** (framework mode) | The same app runs on Cloudflare Workers (hosted edge SSR, §14.7) **and** as a Node server inside the combined self-host image (§14.2) — one codebase, two adapters (§1, §15). |
| Marketing site | **Astro** (static) | Zero-JS-by-default; deployed to Cloudflare Workers; separately built (§2.3, decision #28). |
| Persistence | **Drizzle ORM** (+ **Drizzle Kit**) | Behind the data-access abstraction (§11.9); a thin in-house dialect layer keeps embedded **SQLite** (self-host default) and **Neon Postgres** (hosted) on one logical schema and one forward-only migration history (§16, decisions #25/#26/#32). |
| Validation / contracts | **Zod** + **ts-rest** | Server-side validation and env schemas (Zod, rule `05-env-vars`); a single typed REST contract in `shared-types` generates the OpenAPI description (§18) and is consumed by both backend and web client. |
| UI | **Tailwind** + **Radix** + **cmdk** | Tailwind bridged to the prototype design tokens (§23.1); components consume token variables only (rule `11-design-system`). `cmdk` realises the `⌘K` palette + `go` mode (§9). |
| Tests | **Vitest** + **Supertest** + **Playwright** | Unit/integration (Vitest/Supertest) and e2e (Playwright, §22.4); these pin the CI-gate commands (§22.3). |
| Build | **Turborepo** | Cached lint/typecheck/test/build pipelines over the pnpm workspace (`turbo.json`). |
| Sessions | **DB-backed** server-side store | No Redis/external cache (§5.3, §14.5). |
| Security primitives | **argon2id** · **otplib** TOTP · **double-submit CSRF** | §5.4, §5.7, §5.8. |
| Background work | **In-process** (no separate worker/broker) | §22.10, §6.3. |
| AI provider (v1) | **OpenAI** | Behind the vendor-neutral AI interface (§11.2); swapping providers is Fast-Follow. |

### 19.2 Packages

As a pnpm workspace in a single repository:

- **`packages/backend`** — the NestJS API: tenancy, auth/sessions, domain logic, entitlements, and all external-interface implementations (§11).
- **`packages/web`** — the React Router v7 signed-in web application. *(Canonical web-package name; `web-client` is not used.)*
- **`packages/marketing`** — the Astro static marketing site, independently built and deployed (§2.3).
- **`packages/shared-types`** — cross-cutting Zod/ts-rest contracts, the external-interface contracts, and the generated API/OpenAPI types, consumed by both backend and web.
- **`packages/ui`** — the shared component library and the design tokens (§23.1).
- **`docs/`** — customer/operator documentation plus a clearly separated internal-engineering section.
- *(Fast-Follow)* an **operator console** package, if and when it is built (§10.2, §20).

All members live in one repo, use pnpm, and the marketing site and the application are separately buildable.

---

## 20. Explicitly Out of Scope for v1

The following are explicitly **not** part of v1. Items marked Fast-Follow are intended for after launch:

- A dedicated operator / super-admin console — *Fast-Follow*.
- Additional provider implementations per interface (alternative mail/AI/billing/etc.) — *Fast-Follow*.
- Soft-delete / trash for user deletions — *Fast-Follow candidate*.
- Subdomain- or path-based tenancy — *Fast-Follow* (the resolution interface already allows it).
- First-class backup/restore beyond enriched export + volume copy — *Fast-Follow candidate*.
- Browser extension or bookmarklet; public/unauthenticated bookmark or folder pages or public share links; drag-and-drop reordering; a notifications center; AI features beyond field suggestions (no summaries, no auto-categorization, no chat); QR codes for anything other than MFA enrollment; languages beyond English and German at launch.

---

## 21. Resolved Decisions (log)

Every item below was previously an open question and is now **settled** and integrated into the body above. One line each.

**Scope framing**
- v1 is the smallest coherent product to launch hosted + self-hosted on one codebase; deferrable work is marked Fast-Follow (see "Scope — v1 vs. Fast-Follow").

**Terminology**
1. Tenant term is **workspace** throughout; "organization" is deprecated.
2. Container term is **folder**; no "collection."
3. Prominence mechanism is **pinning**; "favorites" removed entirely.

**Tenancy**
4. Tenant resolution = **session-carried active workspace + explicit switch endpoint**; no subdomain/path tenancy in v1, but the resolution interface allows them later without touching app logic.
5. Self-hosted does **not** auto-create a workspace per user — first-run setup creates the first workspace; later users are admin-invited into existing workspaces. Hosted auto-creates a personal workspace on signup.
6. On leave, authored bookmarks **remain with the workspace**; no spin-off, no cross-workspace data movement; leaving = membership revoked; users export to take data.
7. Slugs are unique **per workspace**.
29. **Self-host vision (settled):** self-hosted is officially an **admin-curated multi-workspace product** — an instance-wide admin creates/manages workspaces and invites users into them; explicitly not a "every user spins up their own tenant" model. First-run setup + invite-only stays the default; public registration is an off-by-default config flag. (Sections 4.5, 5.2, 14.)

**Auth & accounts**
8. Self-hosted = **full/unlimited entitlements** by default (audit log, team sharing, AI-if-key-present all on); no artificial gating.
9. Session strategy = **server-side sessions**, identical on both deployments; the JWT-access + cloud-only-refresh model is dropped (immediate revocation, clean multi-device logout).
10. Self-hosted is **setup + invite-only by default**; public open registration is a config flag (off self-hosted; on for hosted with email verification required).
11. AI config: same AI interface — self-hosted admins supply their own credential/model in the admin UI; hosted uses an operator-supplied credential + per-workspace enable toggle.
12. OIDC config: same auth interface — self-hosted configures providers in the admin UI (DB-sourced); hosted via deployment config; hosted workspace admins cannot add their own providers in v1.

**Administration / operator**
13. Operator console is **Fast-Follow**, not v1. v1 "operator" = first admin (instance-wide admin flag); hosted operations run via direct DB access + the secret-protected aggregate-stats endpoint. Self-hosted has an instance-wide admin distinct from per-workspace admins; **no second authenticated surface in v1**.

**Billing & plans**
14. Free bookmark cap = **50 per workspace** (concrete starting value, confirmable as config later).
15. Supporter/lifetime is a **config-driven launch promotion**, entitlement-equivalent to "Personal, permanent"; no separate code path.
16. Self-hosted has **no billing** (no-op billing impl, full entitlements); no paid self-host licensing in v1.
17. Team: base included seats + purchasable extras; seat count cannot drop below current member count; invitations consume a seat **on acceptance**; exact base-seat number is a Fast-Follow config detail.
18. **Downgrade overflow:** downgrade to Free takes effect at period-end with a grace period; over-cap bookmarks are **archived (preserved, hidden), not deleted**, and restored on re-upgrade (Section 12.5). Creation-blocking is not the only cap behavior.
30. **Workspace-creation entitlement (settled):** "workspaces an account may create/own" is an entitlement checked by the engine. Hosted Free = exactly one workspace; additional workspaces require a paid entitlement (closes the 50×N free-cap bypass). Self-hosted = unrestricted. (Sections 4.1, 11.5, 12.2, 12.4.)

**Data & features**
19. Bookmark editing stays **modal-only**; no detail route.
20. **Soft-delete/trash out of scope** for v1 (Fast-Follow candidate).
21. Export is **round-trip-complete** (folders, tags, slugs, forwarding flags) — lossless, because it is the documented self-host backup mechanism.
22. v1 backup story = **enriched JSON export + data-volume copy** for the embedded DB; no first-class backup/restore in v1.
23. Slugs remain **private to the workspace**; no anonymous `/go` resolution and no public pages in v1.
24. The **contact form lives with the marketing static site**, calling a small public endpoint on the app; the challenge interface (bot protection) applies there.

**Architecture & infrastructure**
25. **Greenfield rebuild** with a single new **forward-only migration history**; migrating existing instance data is a separate workstream, out of scope here.
26. **Both DB engines** ship on an identical schema/migration story; the embedded file-based engine is a deliberate self-host selling point.
27. **One concrete implementation per interface in v1**, with the seam in place: SMTP (mail, both deployments), one AI provider, Stripe (billing), Cloudflare Turnstile (challenge), the existing analytics/error-reporting sinks behind no-op-able interfaces. Multiple providers per interface is Fast-Follow.
28. **Marketing site** is a static site, separately built and deployed, in the same repo; deployed to **Cloudflare Workers** (same platform as the web client).
31. **Hosted deployment topology (settled):** web client on Cloudflare Workers (edge); API/back-end on Fly.io Frankfurt (`fra`); database on Neon Postgres Frankfurt (`aws-eu-central-1`). Railway was rejected — its only EU region (Amsterdam) has no collocated Neon region, causing cross-region DB latency. Self-hosted uses the combined container image (§14.2) and is unaffected. (Section 14.7.)
32. **Hosted database engine (settled):** Neon Postgres (`aws-eu-central-1`) for the hosted deployment. Self-hosted defaults to the embedded file-based database with an optional networked Postgres path (§14.1, decision 26). The application schema and migration history are identical across both engines.
33. **i18n tooling (settled):** Tolgee is the translation-management platform. Message catalogs are externalized through the Tolgee SDK; `TOLGEE_API_KEY` and `TOLGEE_PROJECT_ID` are Infisical-managed secrets. (Section 17, rule 10-i18n.mdc.)
34. **Secrets management tooling (settled):** Infisical is the secrets manager for all environments (`development` / `staging` / `production`). Operators set `staging` and `production` secrets via the Infisical UI or OIDC sync; developers use `infisical run --env=development` locally. (Section 15, rule 05-env-vars.mdc.)

35. **CI/CD pipeline (settled):** GitHub Actions on hosted runners; single workflow file (`.github/workflows/ci-cd.yml`); branches `staging` and `main`. (Section 22.)
36. **Design system and UI prototype (settled):** A clickable V1 design prototype in `docs/design-prototype/V1/` is the **visual and interaction-design source of truth** (design language, screen anatomy, states, copy tone). The MVP spec remains the **product source of truth** — where the prototype conflicts with the spec, the spec wins. Design tokens (periwinkle accent `#7782f7`, dark-first, IBM Plex Sans/Mono) are defined in `docs/design-prototype/V1/colors_and_type.css`. (Section 23.)

**Technology stack**
37. **Language (settled):** TypeScript everywhere, strict mode, no `any`. (Section 19.)
38. **Backend framework (settled):** NestJS — its module/DI system hosts the config-selected external-interface implementations (§2.6, §11), replacing deployment-mode branching, and generates the OpenAPI description (§18); runs as a Node container on Fly.io (§14.7). (Section 19.)
39. **Web client (settled):** React Router v7 (framework mode) — the same app runs on Cloudflare Workers (hosted edge SSR) and as a Node server inside the combined self-host image (§14.2). (Sections 14.7, 19.)
40. **Marketing site framework (settled):** Astro (static, zero-JS-by-default), deployed to Cloudflare Workers, separately built (§2.3, decision #28). (Section 19.)
41. **Persistence (settled):** Drizzle ORM behind the data-access abstraction (§11.9), with a thin in-house dialect layer keeping embedded SQLite (self-host default) and Neon Postgres (hosted) on one logical schema; Drizzle Kit owns the single forward-only migration history (decisions #25/#26/#32). (Sections 11.9, 16, 19.)
42. **Validation & API contracts (settled):** Zod for all server-side validation and env schemas (rule `05-env-vars`); ts-rest contracts in `shared-types` generate the OpenAPI description (§18) and are consumed by backend and web client. (Section 19.)
43. **UI system (settled):** Tailwind CSS bridged to the prototype design tokens (`colors_and_type.css`, §23.1) + Radix UI primitives + cmdk for the command palette; components consume token variables only. (Sections 19, 23, rule `11-design-system`.)
44. **Tests (settled):** Vitest (unit + integration) + Supertest (API) + Playwright (e2e, §22.4); these pin the CI-gate commands (§22.3). (Section 19.)
45. **Build orchestration (settled):** Turborepo over the pnpm workspace (`turbo.json`). (Sections 2.2, 19.)
46. **Session store (settled):** database-backed server-side sessions — no Redis/external cache — so a bare self-host install needs no extra services. (Sections 5.3, 14.5.)
47. **Security primitives (settled):** argon2id (password hashing, §5.4), otplib TOTP + QR (MFA, §5.7), double-submit-token CSRF over the §5.8 exempt allowlist.
48. **Background work (settled):** in-process within the API — no separate worker process or external broker (§22.10, §6.3).
49. **AI provider, v1 (settled):** OpenAI behind the vendor-neutral AI interface (§11.2); swapping providers is Fast-Follow.
50. **Package layout (settled):** pnpm workspace packages `backend`, `web`, `marketing`, `shared-types`, `ui`, plus `docs`; the canonical web-package name is `web` (not `web-client`); marketing and app are separately buildable. (Section 19.)

---

## 22. CI/CD Pipeline

A single GitHub Actions workflow file (`.github/workflows/ci-cd.yml`) covers the full lifecycle from pull-request checks through production deployment. The design follows the Dispatch One pipeline pattern, adapted for SlugBase's package layout and the hosted GitHub Actions runners (the repo is public).

### 22.1 Runners and concurrency

**GitHub-hosted runners** (`ubuntu-latest`) are used throughout. Because each job runs in a fresh ephemeral VM, Docker cleanup and concurrency group protection for self-hosted runners are unnecessary and are omitted.

Concurrency: in-progress runs are cancelled for PR and `staging`-push triggers; production deploys (triggered by a published release) are never cancelled.

### 22.2 Triggers

| Event | Branches / types | Jobs fired |
|---|---|---|
| `pull_request` | targeting `staging` or `main` | CI checks (+ E2E when `staging → main`) |
| `push` | `staging` | CI checks → staging deploy |
| `push` | `main` | CI checks → prepare release |
| `release` published | — | Production deploy |
| `workflow_dispatch` | — | Manual trigger (full run) |

### 22.3 CI checks (all PRs and pushes)

Run on every trigger before any deployment gate. Order within the job:

1. `pnpm install --frozen-lockfile`
2. **Fast-fail checks (no secrets, no build):** lint → typecheck → unit tests
3. Fetch secrets from Infisical (`development` env, OIDC method)
4. Build
5. Pack and upload build artifacts (retention: 1 day)
6. Integration tests (using the development-env secrets)
7. `pnpm audit --audit-level=high` (dependency audit)

### 22.4 E2E (Playwright)

Runs only on the `staging → main` pull request (i.e. the release-candidate PR). Depends on CI checks passing. Downloads the CI build artifacts rather than rebuilding. Runs against a managed local stack. Timeout: 45 minutes.

### 22.5 Staging deploy (push to `staging`)

Ordered pipeline, with server and web/marketing builds running **in parallel** for speed:

| Step | Description |
|---|---|
| 1 | GitHub Deployment record — start |
| 2a (parallel) | Build API/back-end with `staging` Infisical secrets |
| 2b (parallel) | Build web client + marketing site bundles with `staging` Infisical secrets |
| 3 | Database migration (`migrate:deploy`) — after 2a, before Fly deploy |
| 4a | Deploy API to **Fly.io** `fra` (`flyctl deploy --remote-only`) |
| 4b | Deploy web client to **Cloudflare Workers** via `wrangler deploy` (with retry) — after migration + 2b |
| 4c | Deploy marketing site to **Cloudflare Workers** via `wrangler deploy` (with retry) — after migration + 2b |
| 5 | Smoke: `GET /health` and `/version` endpoints on all deployed surfaces |
| 6 | GitHub Deployment record — finish (success/failure) |

### 22.6 Prepare release (push to `main`)

Runs after CI checks pass. Only proceeds if `package.json` version is greater than the latest git tag.

1. Check version bump (compare `package.json` version against latest `v*` tag).
2. Fetch `staging` Infisical secrets.
3. Verify translations: `tolgee pull --check` — fails the job if any default-locale key is missing a translation.
4. Generate changelog from `git log` since last tag (conventional commits).
5. Create annotated git tag `vX.Y.Z` and push.
6. Create **draft** GitHub Release (changelog as body) — a human publishes it to trigger production.

### 22.7 Production deploy (release published)

Triggered when a draft release is manually published. Idempotent: compares the release tag against `DEPLOYED_VERSION` (a repository Actions variable); skips the deploy if already deployed.

| Step | Description |
|---|---|
| 1 | Idempotency check |
| 2 | GitHub Deployment record — start |
| 3 | Build all packages from the release tag with `production` Infisical secrets; upload Sentry source maps (if `SENTRY_AUTH_TOKEN` is set) |
| 4 | Database migration against production Neon |
| 5a | Deploy API to **Fly.io** `fra` |
| 5b | Deploy web client to **Cloudflare Workers** |
| 5c | Deploy marketing site to **Cloudflare Workers** |
| 6 | Smoke: health endpoint on Fly API + web client health check on Workers |
| 7 | GitHub Deployment record — finish |
| 8 | Write release tag to `DEPLOYED_VERSION` repository variable |

### 22.8 Self-hosted container image

On `release` published (same trigger as the hosted production deploy), the workflow also builds and pushes the **combined container image** (API + bundled web client) to the GitHub Container Registry (`ghcr.io`), tagged `vX.Y.Z` and `latest`. This is the artefact self-hosters pull and run.

### 22.9 Secrets in CI

All environment secrets are fetched from Infisical via the `Infisical/secrets-action` using **OIDC** (no long-lived tokens in GitHub Actions secrets). The only GitHub Actions secrets stored in the repository are:
- `INFISICAL_DOMAIN` — the Infisical instance URL
- `INFISICAL_OIDC_IDENTITY_ID` — the machine identity for OIDC auth

### 22.10 What is not in this pipeline

- Self-hosted runner Docker cleanup (not needed on ephemeral hosted runners)
- Concurrency guards for runner disk space (not needed)
- A separate admin console deploy (no admin console in v1 — Fast-Follow)
- A background worker service deploy (SlugBase has no separate worker process; background work is handled within the API process)

---

## 23. Design System and UI Prototype Reference

A clickable HTML/React design prototype lives in `docs/design-prototype/V1/`. It is the **visual and interaction-design source of truth**: it defines the design language, the anatomy of every screen, component states, micro-interactions, and the intended copy tone. It is *not* the product source of truth — feature scope, entitlements, tenancy, security, and data model are governed by Sections 1–22 of this spec. **Where the prototype and this spec disagree, this spec wins** (the known conflicts are catalogued in §23.4).

The prototype is a static, data-mocked artefact (React via CDN + Babel-in-browser, `localStorage` for demo state, fake data in `prototype/data.js`). It must be re-implemented in the real stack against the Tolgee message catalog (§17) — never by copying its hard-coded English strings.

### 23.1 Design tokens (authoritative)

Defined in `docs/design-prototype/V1/colors_and_type.css`. These are the canonical design tokens for the rebuild:

- **Accent:** periwinkle `#7782f7` (dark) / `#5b66e8` (light). This is the spec's "accent color" (§18, §15 user preferences) default.
- **Mode:** **dark-first** — dark is the primary product theme; light is defined for parity. Theme options are light / dark / auto (matches §18 and the user theme preference in §15).
- **Surfaces:** layered hierarchy `--canvas` → `--base` → `--raised` → `--raised-2` → `--overlay`, with hairline borders rather than heavy shadows.
- **Semantic colors:** success `#45c98a`, warning `#e6b24e`, danger `#f0686b`.
- **Typography:** **IBM Plex Sans** for UI; **IBM Plex Mono** for slugs, shortcuts, code, and metadata. Compact, dense, developer-tool type scale (13px UI body default).
- **Spacing:** 4px base scale (`--sp-1` … `--sp-12`). **Radii:** modest 4–12px. **Motion:** 110/170/230ms easing tokens.
- **Brand assets:** `docs/design-prototype/V1/assets/slugbase_icon.svg` (and `.png`).

Implementation note: these tokens become the foundation of the shared UI package (§19). Components must consume token variables, never hard-coded hex values.

### 23.2 Screen and flow inventory (prototype → spec)

| Surface | Prototype file(s) | Spec section |
|---|---|---|
| Design tokens / theming | `colors_and_type.css` | §18 |
| App shell (sidebar, workspace switcher, entitlement meter) | `prototype/Sidebar.jsx`, `App.jsx`, `app.css` | §4, §10, §12 |
| Bookmarks list (card grid + table, bulk actions, pager, skeleton, empty) | `prototype/BookmarkViews.jsx`, `App.jsx`, `Bookmarks.html` | §6 |
| Dashboard / Home (stats, quick-access slugs, pinned, tag cloud, sharing, onboarding checklist) | `prototype/DashboardApp.jsx`, `Dashboard.html` | §10 |
| Folders (scopes, sharing labels, row actions) | `prototype/FoldersApp.jsx`, `Folders.html` | §6, §9 |
| Tags | `prototype/TagsApp.jsx`, `Tags.html` | §6 |
| Command palette (default / search / no-results / go-mode / disambiguation) | `prototype/PaletteApp.jsx`, `Palette.jsx`, `Palette.html` | §7, §8 |
| Slug resolution + disambiguation | `prototype/PaletteApp.jsx` (go-mode), `EdgePages.jsx` (`SlugDisambig`) | §8 |
| Auth (sign-in, MFA, register, verify email, password reset, set-password, first-run setup) | `prototype/AuthApp.jsx`, `AuthKit.jsx`, `auth.css` | §5 |
| Onboarding flow + workspace create/switch | `prototype/EdgeFlows.jsx` | §5.2, §10 |
| Settings shell + nav | `prototype/SettingsApp.jsx`, `SettingsShell.jsx`, `settings.css` | §10 |
| Account settings (profile, password, MFA enroll/backup codes, API tokens, preferences) | `prototype/SettingsAccount.jsx` | §5 |
| Workspace settings (general, SMTP, AI, OIDC; hosted vs self-hosted variants) | `prototype/SettingsWorkspace.jsx` | §10, §11.1, §11.3, §11.6, §15 |
| Members & teams (roles, invites, seats, ownership transfer) | `prototype/SettingsMembers.jsx` | §9, §12 |
| Audit log (filters, pagination, entitlement gate) | `prototype/SettingsAudit.jsx` | §12 |
| Plans & billing (plan table, supporter offer, cancel/downgrade, seats, invoices) | `prototype/SettingsBilling.jsx` | §12 |
| Error pages (404 / 403 / 500), app + marketing variants | `prototype/EdgePages.jsx`, `EdgeStates.html` | §18 |
| Marketing site (landing, pricing, contact + Turnstile, legal: Impressum/AGB/Datenschutz) | `marketing/*.jsx`, `marketing/Marketing.html`, `marketing.css` | §2.3, §11.8, §17 |

### 23.3 Patterns to carry into the build

These prototype conventions are endorsed as the intended UX baseline (they realise §18's "polished, accessible, keyboard-friendly" requirement):

- **Keyboard-first:** `⌘K`/`Ctrl-K` palette everywhere; single-key shortcuts (`C` new bookmark, `N` new folder, `G`/`T` grid/table, `Esc` clear). The palette's **`go <slug>` mode** is the in-app expression of the redirect feature (§8).
- **Slug disambiguation:** when a slug resolves to multiple accessible bookmarks, present a chooser with an "always use this one" option that persists a slug preference (§8, data model "Slug preference").
- **Entitlement surfacing:** sidebar usage meter, approaching-cap and at-cap banners, upsell modal, and plan gates — all entitlement-driven, never deployment-mode-driven (§12.4, §15).
- **Shown-once secrets:** backup codes and freshly created API tokens use the "store this now, shown once" pattern (§5).
- **Security-aware copy:** auth screens use non-enumerating language ("we always respond the same way") for reset/verify (§5).
- **Self-hosted vs hosted variants:** SMTP and OIDC panels are hidden when operator-managed; first-run setup screen for empty instances (§5.2, §14.3, §15) — driven by config/interface selection, not a code branch.
- **Destructive-action confirmations**, toasts, loading skeletons, and empty states are part of the baseline (§18).

### 23.4 Known prototype↔spec divergences (spec wins)

The prototype was designed before some decisions were finalised. When building, **follow the spec, not the prototype**, on these points:

1. **Plan name: "Pro" → "Personal".** Parts of the prototype app shell (`Sidebar.jsx`, `App.jsx` upsell, `data.js`, `EdgeFlows.jsx`) label the paid individual tier **"Pro"**; the billing and marketing screens correctly call it **"Personal"**. The canonical name is **Personal** (§12.1). Use "Personal" everywhere.
2. **Free bookmark cap = 50, not 100.** `data.js`/`DashboardApp.jsx` mock a 100-bookmark cap (94/100). The canonical Free cap is **50 per workspace** (§12.1, decision 14) — as the billing/marketing screens correctly show.
3. **No folder cap.** The prototype pricing tables list "Folders: Free 3 / unlimited". Folders are **not an entitlement** (§12.2); there is no folder limit on any plan. Drop the folder cap.
4. **API tokens are not plan-gated.** Pricing tables show "API access" as Personal+ only. Personal API tokens are a **core authentication feature for all authenticated users** (§5); they are not in the entitlements list (§12.2). Do not gate them by plan.
5. **No custom domains / "custom slug domains" entitlement in v1.** Marketing and upsell copy advertise "custom slug domains" / "custom forwarding domain". Custom domains and subdomain-/path-based addressing are **out of scope / Fast-Follow** (§20, decision 4). Slugs themselves are available to everyone; there is no custom-domain plan feature in v1.
6. **No workspace identifier in URLs (v1).** `SettingsWorkspace.jsx` shows a "Workspace identifier — used in URLs" field and an error page uses a `/workspaces/acme/...` path. v1 resolves the active workspace **via the session**, not via URL path/subdomain (decision 4). Treat URL-based tenancy as a Fast-Follow-only forward hook; do not ship the URL-identifier field in v1.
7. **"Up to 25 members" is illustrative.** The exact Team base-seat count is a **Fast-Follow config detail** (§12.2, decision 17), not a fixed 25.
8. **Prices are illustrative and config-driven.** `$4` / `$9` / `$59` and the supporter deadline are placeholders; concrete pricing lives in deployment configuration and the marketing site, never hard-coded in application logic (§12.1).
9. **Subprocessor copy in legal pages.** The prototype's Datenschutz lists "Hetzner Cloud (Hosting)". The settled hosted infrastructure is **Fly.io (Frankfurt) + Neon Postgres + Cloudflare Workers** (§14.7); the legal/subprocessor copy must be updated to match actual subprocessors before launch.
10. **Forwarding domain string.** `go.slugbase.app` is the prototype's placeholder redirect host; the real value is deployment configuration (the public base URL, §15), not a hard-coded constant.

### 23.5 Spec features under-represented in the prototype (build with the prototype's design language)

These v1 requirements are either stubbed or absent in the prototype. They must still be built for v1, using the prototype's established design language and components:

- **Bookmark create/edit modal** (modal-only editing, decision 19) — the prototype stubs "New bookmark" as a toast. Build the full create/edit modal including URL, title, slug, folder, tags, pin, forwarding flag, and sharing (§6).
- **AI suggestions inline UI** — the prototype exposes AI *settings* but not the in-modal "suggest slug/tags/folder" experience, language-aware, with the per-user opt-out honoured (§6, §11.3, §17).
- **Import / export surface** — beyond the onboarding drop-zone, build the Settings import (JSON + Netscape HTML, success/failure counts, cap-aware) and the **lossless export** (§13).
- **Slug-preference management screen** — the disambiguation UI links to "manage remembered slug preferences"; build that management view (§8, data model "Slug preference").
- **Forwarding management surface** — the sidebar has a "Forwarding" item with no page; define/build it or remove it to match the spec's slug/redirect model (§8). 
- **Full internationalisation (EN/DE)** — the prototype has a language preference control but hard-coded English strings. All UI text must come from the Tolgee catalog with a German translation (§17).
- **Consent / cookie mechanism** — the privacy/consent gating for analytics and error reporting on the hosted service (§18) is not in the prototype.
- **Contact-form backend wiring** — the prototype renders the Turnstile widget and form; wire it to the public contact endpoint behind the challenge interface (§2.3, §11.1, §11.8).

---

## Assumptions carried forward

- **Operator console timing (re. decision 13):** Running hosted operations via direct database access plus the aggregate-stats endpoint is accepted as sufficient **for launch only**. The operator console is expected to be an early Fast-Follow because direct DB access does not scale operationally; it is deferred, not dismissed.
- **Free cap value (re. decision 14):** 50 bookmarks/workspace is used so the spec is concrete; it is expressed as configuration so it can be tuned without code changes.
