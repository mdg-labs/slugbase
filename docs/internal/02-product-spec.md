# SlugBase — Product Specification

What the product does, behaviour by behaviour. This document is written for an implementer: every rule here is something a test can check. It describes **behaviour**, not code; the API shape is doc 04, the schema doc 05, the screens doc 03, and plan packaging and billing doc 06.

Vocabulary is doc 00 §3 and is binding in code, API, database and copy. Decisions are doc 00 §5 (Dn); the settled answers to former open questions are doc 13 (Qn), all decided on 2026-10-08. Where this document names an **entitlement** (`bookmarks.max`, `workspaces.ownMax`, `ai.suggestions`, `sharing.*`, `teams.manage`, `members.invite`, `audit.log`, `seats.max`), its plan mapping and enforcement points live in doc 06; on CE every entitlement is unlimited/on (D18).

---

## 1. Principles

1. **CE and Cloud behave identically** except where this document names configuration (`PUBLIC_REGISTRATION`, `EMAIL_VERIFICATION_REQUIRED`, configured adapters) or an entitlement. No behaviour depends on an edition flag (D4).
2. **Every capability is an API operation** (D12). The UI has no private behaviour; anything the UI can do, an API token can do, within that token's scope.
3. **Non-enumerating by default.** Any flow that could reveal whether an email address has an account (login failure, password reset, registration, resend verification, invitation accept) answers identically for both cases and takes comparable time.
4. **Destructive actions are explicit.** Deletes are hard (no trash in v1, doc 00 §4); every destructive action states its consequence and requires confirmation (doc 03 shared patterns). The only non-destructive "hidden" state is plan-archive (§5.6).
5. **Private by default.** A new bookmark, folder, tag and slug is visible to its owner only. Sharing is an explicit act (§8).
6. **Degrade, don't fail.** With an optional adapter missing (mail, AI, OIDC), the dependent feature is unavailable and says so; nothing else breaks (D22).

---

## 2. Accounts and authentication

### 2.1 Account

An **account** is a global identity, unique by email (compared case-insensitively after Unicode NFKC normalisation; stored as entered, matched lower-cased). It has: display name, email, email-verified flag, optional password credential (absent for OIDC-only accounts), preferred language (`en` / `de`), theme (`system` / `dark` / `light`, Q35), accent (Q36), default bookmark view (`grid` / `table`), single-key-shortcuts flag (Q38), AI opt-out flag, MFA state, instance-admin flag (CE), created/updated timestamps. Accounts exist independently of workspaces; membership is separate (§3).

Avatars are initials on a colour derived from the account ID — no uploads in v1 (Q37).

### 2.2 Entry paths

| Path | When available | Result |
|---|---|---|
| **First-run setup** | Only while the deployment has zero accounts | Creates the first account (instance admin on CE, §11), its first workspace (owner), and signs in. The endpoint is permanently closed once any account exists. On Cloud the composition root never exposes setup — the first account is created through registration and promoted by the operator console |
| **Invitation** | A workspace admin invited the email (§3.4) | Accepting creates the account if needed (email is proven by the token, so it is verified) and adds the membership |
| **Public registration** | `PUBLIC_REGISTRATION=true` (CE default `false`, Cloud default `true`) | Creates an unverified account; with `EMAIL_VERIFICATION_REQUIRED=true` (Cloud default) it cannot sign in until verified. On verification it gets a personal workspace named "<display name>'s workspace", subject to `workspaces.ownMax` |
| **OIDC first login** | A provider with auto-create enabled (§2.8) | Creates a verified account from provider claims; then as registration (personal workspace) or, on CE with registration off, no workspace — the account sees "ask an admin to invite you" until invited |

Setup is protected by possession of the deployment: the setup screen shows only when there are no accounts, and on CE the operator can additionally require a one-time setup token printed to the server log at first start (`SETUP_TOKEN_REQUIRED`, default `true` on CE) so a freshly exposed instance cannot be claimed by a stranger.

### 2.3 Sign-in

- **Password**: email + password. Wrong email and wrong password produce the same error and comparable latency (a dummy argon2id verification runs for unknown emails). Rate-limited per IP and per email (§15).
- **MFA step**: if the account has TOTP enrolled, a successful password check yields a short-lived (5 min) pending-MFA session that can only call the MFA endpoints; a TOTP code or one backup code completes sign-in. A code already used for the current 30 s step is rejected (replay protection). Five failed codes end the pending session.
- **OIDC**: §2.8. A successful OIDC sign-in never asks for SlugBase TOTP (the provider is trusted for that factor).
- **"Remember me"** chooses the 90-day sliding session instead of the 30-day one (§15).
- **Session rotation**: a new session token is issued on sign-in, on MFA completion, on password change, on enabling/disabling MFA and on instance-admin promotion; the previous token is deleted.
- **Unverified accounts** (when verification is required) are told to verify and offered a resend; they get no session.

### 2.4 Sessions

Server-side, as D10 and doc 01 §10 define. The account's **Sessions** list shows each session's created time, last-seen time, approximate location derived from IP **only at display time and never stored** (stored: the first two IPv4 octets / IPv6 /48 and the user-agent family), and lets the member revoke any one or "sign out everywhere else". Password change and MFA reset revoke all other sessions automatically.

### 2.5 Passwords

- Minimum length 12, maximum 256; no composition rules; a strength meter in the UI (zxcvbn-style score, client-side only). Breached-password rejection per Q15.
- **Reset**: request by email → always answers "if an account exists, we sent a link" → single-use token (hashed, 1 h) → set a new password → all sessions revoked → signed in fresh. Available only when mail is configured; otherwise the screen tells the user to ask their instance admin (CE, §11.3) or support (Cloud).
- **Change**: requires the current password (or a fresh re-authentication for OIDC-only accounts adding a password).
- **OIDC-only accounts** may add a password; an account may remove its password only while it has at least one linked OIDC identity.

### 2.6 Email verification and change of email

Two distinct flows, both with hashed single-use tokens (1 h):

- **Signup verification**: sent on registration; resend rate-limited; verifying completes registration (§2.2).
- **Change of email**: the new address receives a confirmation link; the old address receives a notice with a "this wasn't me" link that cancels the change and revokes all sessions. The email switches only when confirmed. A pending change can be cancelled. Changing to an address that already has an account fails at confirmation time with a generic message.

### 2.7 Multi-factor authentication (TOTP)

- **Enrol**: generate a secret (stored through `SecretBoxPort`), show QR (`otpauth://` with issuer `TOTP_ISSUER`, default "SlugBase" plus the deployment host) and the text key; activation requires a valid code. Activation shows **10 backup codes once** (shown-once pattern, doc 03), stored hashed.
- **Regenerate backup codes**: requires a current TOTP code; invalidates the old set; shown once.
- **Disable**: requires a current TOTP code or a backup code plus the password (or OIDC re-auth).
- **Recovery** when a member has lost both: on CE an instance admin can reset MFA for an account (audited, notifies the account by email); on Cloud the operator console does it after a documented support identity check. Neither path reveals or copies the secret.
- **Instance admins** must have MFA enrolled to use any instance-admin operation (doc 01 §10); the admin area prompts enrolment first.

### 2.8 OIDC sign-in

Providers are configured only by the operator through `OIDC_<SLUG>_*` environment variables (`CLIENT_ID`, `CLIENT_SECRET`, `ISSUER_URL`, optional `NAME`, `SCOPES`, `ENABLED`, `AUTO_CREATE`, `ALLOWED_DOMAINS`). Workspace admins cannot add providers. Behaviour (Q32):

- Authorization-code flow with PKCE, `state` and `nonce`, through `IdentityPort`; the handshake state lives in a short-lived server-side record bound to a pre-auth cookie.
- **Linking**: a provider identity (`issuer`, `sub`) links to an account (a) explicitly, from Account settings while signed in, or (b) automatically on first login **only** when the provider asserts `email_verified=true` and the email matches an existing account. Linking by unverified email never happens.
- **Auto-create**: per provider, off by default; when on, `ALLOWED_DOMAINS` (optional) restricts which email domains may be created.
- The sign-in page lists enabled providers as buttons; with none configured, it shows only email + password.
- A linked identity can be unlinked from Account settings if the account keeps another way to sign in.

### 2.9 Personal API tokens

- Created from Account settings with a name and a target **workspace** (one of the member's workspaces) and a scope: `read` or `read-write` (Q16); expiry 30, 90 or 365 days or none, **defaulting to 90 days** in the dialog; unused tokens are not auto-revoked (Q47).
- Format `slb_` + 32 random bytes (base62); stored as a SHA-256 hash with a 6-character display prefix; shown once.
- Last-used time and IP prefix are recorded. Max 10 active tokens per account. Revocable individually.
- A token request runs as the account in the bound workspace with the account's current role there; losing membership makes the token inert (it is revoked automatically). API tokens skip MFA by design (doc 10 §5) and can never call: token management, password/email/MFA changes, session management, instance-admin operations, account deletion, billing checkout.
- Tokens are **not** an entitlement; every account has them on every plan (old §23.4-4).

### 2.10 Account deletion

Self-service from Account settings, with typed confirmation of the email and a fresh password or OIDC re-auth (Q24):

- Blocked while the account is the **only owner** of any workspace that has other members — ownership must be transferred first (§3.3).
- Blocked on Cloud while the account is the billing owner of a workspace with an active paid subscription (doc 06).
- Workspaces where the account is the sole member are deleted with it (listed in the confirmation).
- In other workspaces, the memberships end and the account's **bookmarks and folders stay** with the workspace as ownerless "Former member" content. Workspace admins can reassign or delete them (Q54, decided by the maintainer; doc 05 §7.1). Its tags, tag associations, slug preferences and AI cache are deleted. The leaving rule in §3.6 (transfer or delete, chosen at removal) applies when a member is removed or leaves; it does not apply to account deletion.
- All sessions, tokens, identities and MFA data are deleted. Audit events keep the `actor_label` but lose the account reference (`actor_account_id` set to NULL, doc 05 §7.1); no email is retained.

---

## 3. Workspaces and membership

### 3.1 Workspace

A workspace has a name (1–64 characters), a generated colour and monogram, a plan/entitlement state (doc 06), a billing linkage (Cloud, possibly empty) and timestamps. It owns all bookmarks, folders, tags, teams, slugs, go preferences, settings, invitations and audit events in it. There is no URL identifier for a workspace in v1 (old §23.4-6); the active workspace is carried by the session (doc 01 §5).

### 3.2 Creating workspaces

- **CE**: an instance admin creates workspaces from the admin area (§11) and may also let ordinary accounts create their own via an instance setting (`allow_workspace_creation`, default off).
- **Cloud**: any verified account can create a workspace from the workspace switcher, subject to `workspaces.ownMax` (Free: one owned workspace). The creator becomes owner. Hitting the limit shows the upgrade path (doc 06), not an error.

### 3.3 Roles

| Capability | Owner | Admin | Member |
|---|:-:|:-:|:-:|
| Use the product: own bookmarks, folders, tags, slugs; read what is shared with them | ✓ | ✓ | ✓ |
| Share own bookmarks/folders (subject to `sharing.*`) | ✓ | ✓ | ✓ |
| Invite members, resend/revoke invitations (subject to `members.invite`, `seats.max`) | ✓ | ✓ | — |
| Change a member's role between admin and member; remove members | ✓ | ✓ (not owners) | — |
| Manage teams (subject to `teams.manage`) | ✓ | ✓ | — |
| View the audit log (subject to `audit.log`) | ✓ | ✓ | — |
| Workspace settings (name, AI toggle) | ✓ | ✓ | — |
| Billing: plan and seat changes, billing documents (Cloud) | ✓ | — | — |
| Promote to owner, transfer ownership, demote an owner | ✓ | — | — |
| Delete the workspace | ✓ | — | — |

A workspace always has at least one owner; the last owner cannot leave, be removed or be demoted. Several owners are allowed. **Transfer ownership** promotes another member to owner and, optionally, demotes the transferring owner to admin, with a typed confirmation of the recipient's name.

### 3.4 Invitations

- An admin invites by email with a role (admin or member) and optional teams. On Cloud the invitation requires `members.invite`; a seat is **consumed on acceptance, not on send** (doc 06). The invite list shows pending invitations with resend and revoke.
- The invitation email carries a single-use token (hashed, 7 days). Accepting:
  - if the recipient is signed in as the invited email → membership added;
  - if signed in as a different account → told the invitation is for another address, with "sign out and continue";
  - if no account exists → a short sign-up (name, password, or an OIDC provider) with the email fixed and pre-verified (Q31);
  - if an account exists but is not signed in → sign in, then accept.
- Accepting adds the membership and makes that workspace active. Inviting an email that is already a member is a no-op with a clear message. Invitations require mail; without mail configured the admin sees a copyable invitation link instead (CE only — the link is the same token).

### 3.5 Switching

The workspace switcher lists the account's workspaces. Switching is an explicit operation that verifies membership and updates the session's active workspace; the SPA then reloads its data. If the active workspace becomes inaccessible (removed, deleted), the next request re-derives the active workspace to the most recently used remaining one, or to "no workspace" (a screen offering to create one where allowed, or to wait for an invitation).

### 3.6 Leaving and removal

Leaving (self) and removal (by an admin) both revoke the membership. The member's content does not leave the workspace and never moves to another workspace (tenant isolation, D8). What happens to it (Q23):

- The remover (or, when leaving, the leaving member) chooses: **transfer** the member's bookmarks and folders to another member (default: the acting admin, or the workspace's longest-standing owner when the member leaves on their own), or **delete** them. Transfer keeps slugs; a slug that would collide with one the recipient already owns is cleared on the transferred bookmark and listed in the result.
- The member's **tags** are private, so they are deleted — transferred bookmarks arrive without tags.
- The member's **go preferences** are deleted; shares the member *received* are deleted; shares the member *granted* move with transferred content and are deleted with deleted content.
- API tokens bound to the workspace are revoked.

Users who want their content elsewhere export it first (§13).

### 3.7 Deleting a workspace

Owner only. Typed confirmation of the workspace name. On Cloud, blocked while a paid subscription is active (doc 06). Deletion removes every row of the workspace (bookmarks, folders, tags, teams, shares, invitations, preferences, settings, audit events, AI cache) in one transaction, revokes bound API tokens, and moves every session that had it active to "no active workspace". It is irreversible; the confirmation says so and offers export first.

---

## 4. Teams

A team is a named group of members in a workspace (name 1–64, optional description 0–280). Teams are sharing targets (§8) and nothing else in v1. Managed by admins (subject to `teams.manage`); any member can see the teams they belong to and, when sharing, the list of teams in the workspace. Removing a member from a team immediately removes their access to anything shared only through that team. Deleting a team deletes its shares.

---

## 5. Bookmarks

### 5.1 Fields

| Field | Rules |
|---|---|
| URL | Required. `http` or `https` only; max 2 048 characters; normalised for storage (lower-cased scheme and host, IDN to punycode, default port removed, fragment kept); the canonical form (also without `utm_*`/`fbclid`/`gclid` and trailing slash) is computed for duplicate detection and caching |
| Title | Required, 1–300 characters; prefilled from metadata or AI when available |
| Description | Optional, 0–1 000 characters; prefilled from page metadata, editable (Q34) |
| Slug | Optional; grammar and rules §6.1; at most one per bookmark |
| Forwarding | Boolean; a slug is required when on; default on when a slug is entered |
| Pinned | Boolean |
| Folders | Zero or more of the owner's folders |
| Tags | Zero or more of the owner's tags (created inline by name) |
| Usage | Access count and last-accessed time (§5.5); read-only |
| Plan-archived | Boolean, set only by downgrade handling (§5.6); read-only to users |
| Owner, timestamps | Set by the server |

### 5.2 Create and edit

Creation and editing happen **only in the bookmark modal** — there is no bookmark detail page or route (D1 carry-over). The modal opens from: the "New bookmark" button, the `C` shortcut, the palette, the bookmark row/card action "Edit", and a URL pasted anywhere outside an input on the bookmarks page (opens the modal prefilled). Saving validates server-side; slug conflicts are reported inline on the slug field.

When the URL field loses focus (or on paste) and the URL is valid, the modal requests metadata (§5.4) and, if available, AI suggestions (§14); suggestions never overwrite a field the user has edited.

**Duplicates** (Q27): if the owner already has a bookmark with the same canonical URL in this workspace, the modal shows a warning with a link to edit the existing one; saving a duplicate is allowed.

### 5.3 Delete

Hard delete with confirmation (single) or a count-stating confirmation (bulk). Deletes the bookmark's folder and tag associations, shares and go preferences pointing to it. Its slug becomes free immediately.

### 5.4 Metadata and favicons

- On create or URL change, a `bookmark.fetchMetadata` job (doc 01 §8.1) fetches the page through `EgressPort`: title (`og:title` → `<title>`), description (`og:description` → `meta description`), site name, canonical URL, language. Only the first 512 KiB of HTML is read; non-HTML content types are not parsed. The modal also calls a synchronous metadata endpoint with a 3 s budget so prefill can happen while the modal is open.
- Results are cached per canonical URL for 7 days, shared across workspaces **only** as the fetched public page metadata (never anything user-entered).
- Favicons are fetched per host through `EgressPort` (`/favicon.ico`, then `<link rel=icon>`), size-capped (64 KiB), re-encoded to PNG at 32 and 64 px, stored, and served from our own origin (doc 01 §8.1). Hosts with no favicon get the monogram fallback. The browser never contacts the bookmarked site to render a list.
- A bookmark whose metadata fetch failed shows no error to the user; the fields simply stay as entered.

### 5.5 Usage tracking

Opening a bookmark (from a list, the dashboard, the palette, or `/go`) increments its access count and sets last-accessed time, asynchronously (doc 01 §8.1) — never blocking the navigation. Only the count and the latest timestamp are kept; no per-open history (Q28). Opening a shared bookmark counts on that bookmark (the owner sees the total). Usage powers "most used" sorting, the dashboard's quick access, and the downgrade archive rule (doc 06).

### 5.6 Plan-archived bookmarks

Set only by downgrade-overflow handling (doc 06). An archived bookmark is excluded from lists, counts, search, the palette, the dashboard and slug resolution, but is preserved completely and listed on a dedicated "Archived" view with the reason and the upgrade path. Members can delete archived bookmarks (to make room) and export them; they cannot edit or un-archive them directly. On re-upgrade they are restored automatically (doc 06).

### 5.7 Lists, filtering, sorting

The bookmarks list supports, all reflected in the URL search params (doc 03):

- **Filters**: folder (one), tags (any of several, combined with AND), pinned only, scope (`all`, `mine`, `shared-with-me`, `shared-by-me`), has slug, forwarding on, free-text query (title, URL, slug, description).
- **Sorts**: recently added (default), alphabetical, most used, recently accessed.
- **Pagination**: page sizes 24 / 48 / 96 (grid default 24, table default 48), keyset-based under the hood, presented as pages with a total count.
- **Views**: card grid and table; the choice is remembered per account.
- **Select all across pages**: a companion operation returns the IDs matching the current filters (capped at 5 000) for bulk actions.

### 5.8 Bulk actions

On a selection of **own** bookmarks: delete, add to folder, remove from folder, add tags (with a preview of the resulting tag set), remove tags, pin/unpin, share (subject to `sharing.*`), export selection. Selections containing bookmarks shared with the member allow only "open all" and export of the readable fields; the bar says which actions were limited and why. Bulk operations are atomic per request and report counts.

---

## 6. Slugs and forwarding ("Go")

### 6.1 Slug rules

- Grammar: `^[a-z0-9][a-z0-9-]{0,63}$` — lower-case letters, digits and hyphens, 1–64 characters, not starting with a hyphen. Input is lower-cased and trimmed before validation; anything else is rejected with an explanation (no silent rewriting beyond case).
- **Unique per owner within a workspace.** Two members may each own `mail`; one member cannot have two `mail`s.
- **No reserved words.** Every slug lives under `/go/`, so slugs cannot collide with application routes; the old reserved-word list is dropped.
- A slug is required while forwarding is on; turning forwarding off keeps the slug (it then resolves to nothing but stays the bookmark's handle in search and the palette).
- The bookmark modal shows the resulting address (`https://<origin>/go/<slug>`) with a copy action.

### 6.2 Resolution

`GET /go/<slug>[/<rest>]`:

1. **Authentication required.** Without a session the browser is sent to sign-in and returned to the same `/go` URL afterwards (the return target is validated to be a same-origin `/go/` path). API tokens cannot use `/go` (it is a browser navigation).
2. **Candidates**: bookmarks in the **active workspace** with this slug, forwarding on and not plan-archived, that the member can read (§8): their own, and those shared with them directly, through a team, or through a shared folder.
3. **Choice** (Q25):
   1. a remembered **go preference** for this slug whose bookmark is still a candidate → that bookmark;
   2. the member's **own** bookmark with this slug, if any → that bookmark;
   3. exactly one shared candidate → that bookmark;
   4. several shared candidates → the **disambiguation** page (§6.3);
   5. none → the **not-found** page, which offers to create a bookmark with this slug and, if the slug resolves in another of the member's workspaces, lists those workspaces to switch to and continue (Q26).
4. **Forward**: `302` to the destination with `Referrer-Policy: no-referrer` and `Cache-Control: no-store`; usage is recorded asynchronously (§5.5).
5. **Path passthrough**: `/go/<slug>/<rest>` appends `<rest>` (and the query string) to the destination URL path, so `go gh/mdg-labs/slugbase` works for a `gh` → `https://github.com` bookmark. The joined URL is re-validated as `http(s)`.

The destination is whatever the bookmark owner saved; SlugBase does not interstitial or scan destinations in v1 (doc 10 §5).

### 6.3 Disambiguation

Lists each candidate with title, destination host, owner (for shared ones) and how it is shared (directly, team, folder). Choosing one forwards; a checkbox "Always use this for `<slug>`" stores a go preference first. The page is part of the SPA (`/go/<slug>` serves the SPA when disambiguation is needed; the SPA calls the resolution API to render it).

### 6.4 Go preferences

Per member, per workspace: a mapping slug → bookmark. Listed and removable on the Forwarding page (Q20). A preference whose bookmark is deleted or no longer readable is removed automatically.

### 6.5 Browser and palette integration

- **Browser search engine**: the Forwarding page and the onboarding checklist explain how to register `https://<origin>/go/%s` with a keyword (`go`) in Chrome, Firefox, Safari and Edge, with copy buttons and a "Test it" link. Typing `go mail` in the address bar then forwards.
- **OpenSearch**: the app serves an OpenSearch description so browsers that support it can offer adding SlugBase with one click.
- **Palette `go` mode** (§9.2).

---

## 7. Folders and tags

### 7.1 Folders

- Owned by a member, in a workspace. Name 1–64 characters, unique per owner (case-insensitive); optional lucide icon from a curated set and a colour from the token palette (Q21). Flat — no nesting in v1 (Q33).
- A bookmark can be in many folders; only the bookmark's owner can file it, and only into their own folders.
- Operations: create, rename, change icon/colour, delete (bookmarks stay; only the associations go), share (§8). No folder limit on any plan (old §23.4-3).
- The folders page lists folders with scope (mine / shared with me), bookmark count, sharing summary; sort by name, count, recently updated.

### 7.2 Tags

- Private to the member who created them; never shared, never visible to anyone else (including on shared bookmarks — recipients see shared bookmarks without the owner's tags).
- Name 1–40 characters, unique per owner (case-insensitive), stored as entered. Created inline from the bookmark modal or the tags page.
- Operations: create, rename (merging into an existing tag of that name is offered and requires confirmation), delete (associations removed).
- The tags page shows each tag with its count, a distribution view (relative size), and a preview of the newest bookmarks with the selected tag; sort by name or count.

---

## 8. Sharing

### 8.1 What can be shared with whom

| Object | Shared with | Grants |
|---|---|---|
| Bookmark | a member, or a team | read the bookmark; resolve its slug |
| Folder | a member, or a team | read the folder and every bookmark in it, now and later; resolve their slugs |

Sharing requires `sharing.*` (doc 06); without it the share UI is hidden and the API refuses. Sharing is **read-only** in v1 (Q22). Sharing never crosses a workspace.

### 8.2 Access matrix

For a member **M** and an object owned by **O** in the active workspace:

| Action | M = O | M has read via a share (direct, team, or containing shared folder) | Otherwise |
|---|:-:|:-:|:-:|
| See in lists, search, palette, dashboard "shared with you" | ✓ | ✓ | — |
| Open / resolve slug / count usage | ✓ | ✓ | — |
| Edit fields, slug, forwarding | ✓ | — | — |
| Pin / tag / file into folders | ✓ | — (Q22) | — |
| Delete | ✓ | — | — |
| Share further / change shares | ✓ | — | — |
| See who else it is shared with | ✓ | — (sees only "shared with you by O") | — |
| Export | ✓ (full record) | ✓ (readable fields, flagged as shared) | — |

Workspace admins have **no implicit read** of other members' private content — administration is about members, teams and settings, not content. (A deliberate privacy property; doc 10 §1.)

### 8.3 Behaviour

- Revoking a share, removing M from the team, or removing the bookmark from the shared folder ends access immediately (next request). Go preferences that pointed at a now-unreadable bookmark are removed (§6.4).
- The share dialog lists current shares with remove actions and adds members or teams by search; it shows the effective audience size.
- Bookmarks shared with M show the owner's avatar and a "shared" marker; folders show "Shared with you".

---

## 9. Search, palette and dashboard

### 9.1 Search

A server search operation matches the query across the member's readable bookmarks (title, URL, host, slug, description), their own folders and own tags, returning at most 8 bookmarks, 4 folders and 4 tags by default, ranked: exact slug match → slug prefix → title/description full-text (language-aware) → trigram similarity on title and host. Debounced in the UI (150 ms). Plan-archived bookmarks never match.

### 9.2 Command palette

Opened with `⌘K` / `Ctrl K` from anywhere in the app (and `/` on list pages).

- **Empty**: recent and pinned bookmarks, navigation (Home, Bookmarks, Folders, Tags, Forwarding, Settings), actions (New bookmark, New folder, Import, Export, Switch workspace, Toggle theme, Sign out).
- **Query**: grouped results — Bookmarks, Folders, Tags, Commands — from §9.1 plus command names.
- **`go` mode**: a query starting with `go ` (or a pasted `/go/<slug>` or full `/go` URL) lists matching slugs as the member types (own first, then shared) and Enter resolves exactly as `/go` does (§6.2), including disambiguation inline. Any path after the slug passes through.
- **Modifiers**: Enter opens; `⌘/Ctrl Enter` opens in a new tab; `⌥/Alt Enter` opens the bookmark modal for editing (own bookmarks).
- Fully keyboard-operable; screen-reader announced result counts.

### 9.3 Dashboard (Home)

The post-sign-in landing page:

- **Counts**: bookmarks, folders, tags (own), and "shared with you".
- **Search entry** that opens the palette.
- **Quick access**: the member's most-used slugs (top 8 by usage, readable bookmarks with forwarding on).
- **Pinned**: own pinned bookmarks (up to 12, link to the filtered list).
- **Most used tags**: top 12 own tags by bookmark count.
- **Sharing**: counts shared with you / by you, linking to the scoped lists (shown only with `sharing.*`).
- **Getting started** checklist, dismissible and restorable from Preferences: add a bookmark, give one a slug, set up the browser search engine, create a folder, import from the browser. Items complete themselves from real state.
- **Entitlement surfaces** (Cloud): usage against `bookmarks.max` and upgrade prompts, rendered through the entitlement slot (doc 01 §7.2, doc 06) — never by checking an edition.

---

## 10. Workspace administration

Available to admins and owners in **Settings → Workspace** (doc 03):

- **General**: name; delete workspace (owner).
- **Members**: list with role, teams, joined date, last active; invite; change role; remove (with the §3.6 content choice); transfer ownership; pending invitations with resend/revoke; seat usage (Cloud, via slot).
- **Teams**: create, rename, describe, delete; manage team members.
- **Audit log** (subject to `audit.log`): read-only, newest first, filters by actor, action and date range, paginated. Recorded actions: sign-ins are **not** workspace audit events (they are account security events, shown under Account → Security); workspace events are membership changes, role changes, invitations, team changes, share grants/revocations, bulk deletes, imports, exports, settings changes, workspace deletion request, billing changes (Cloud). Each event: time, actor, action, target type and ID, a small metadata object (never secrets or content beyond names). Retention per doc 05.
- **AI suggestions**: an enable toggle for the workspace (default on when the AI adapter is configured and `ai.suggestions` is granted). No credentials or models in the workspace UI — those are operator configuration (D22).
- **No SMTP or OIDC panels** in the workspace UI on either edition: they are operator configuration. The CE instance admin sees their *status* in the admin area (§11).

---

## 11. CE instance administration

The instance admin is an account flag (D4 carry-over, doc 00 §3); the first account from setup has it. It is used inside the same app at `/admin` (doc 03) and requires MFA (§2.7). It shows only to accounts with the flag; the API enforces the flag on every operation.

### 11.1 Workspaces

List all workspaces (name, owners, member count, bookmark count, created). Create a workspace and invite its first owner (or make an existing account its owner). Delete a workspace (typed confirmation). The instance admin does **not** get content access to workspaces they are not a member of; adding themselves as a member is an explicit, audited action visible to that workspace's owners.

### 11.2 Accounts

List all accounts (name, email, verified, MFA, last sign-in, workspace count). Actions: resend verification, mark verified, reset MFA (§2.7), send a password-reset link (or show a copyable one when mail is not configured), disable/enable an account (disabled accounts cannot sign in; sessions revoked), delete an account (same rules as §2.10, with ownership resolution forced first), promote/demote instance admin (at least one instance admin must remain).

### 11.3 Instance settings and status

- Settings stored in the database: `allow_workspace_creation`, instance display name, the sign-in page notice text.
- Read-only status of operator configuration: public registration, email verification requirement, mail adapter configured (with a "send test email" action), AI adapter configured, OIDC providers detected, error reporting configured, version and migration level, background job health (queue depth, failed jobs).
- No credential is ever displayed or edited here — environment variables only.

---

## 12. Notifications by email

The only notifications in v1 are transactional emails (no notification centre, doc 00 §4): signup verification, email change confirmation and notice, password reset, password changed, MFA enabled/disabled/reset, new sign-in from a new device (optional per account, default on), invitation, ownership transferred to you, account disabled (CE), and the Cloud billing emails (doc 06). Every email is rendered in the recipient's language, has a plain-text part, contains no tracking pixels, and links only to the deployment origin.

---

## 13. Import and export

### 13.1 Import

- **Formats**: SlugBase JSON (§13.3), and Netscape bookmark HTML as exported by Chrome, Firefox, Safari and Edge (max 5 MiB). Browser folders become SlugBase folders by their leaf name (path flattening, Q33); `TAGS` attributes (Firefox) become tags.
- **Limits**: max 5 000 bookmarks per import; subject to `bookmarks.max` — an import that would exceed it imports up to the limit and reports the rest as skipped with the reason.
- **Conflicts** (Q30): folders and tags are matched by name (case-insensitive) or created; a slug that conflicts with an existing own slug, or is invalid, is dropped from that bookmark (the bookmark is still imported) and reported; duplicates by canonical URL are imported unless "skip duplicates" is checked (default checked).
- Imports run as a job with progress; the result reports created, skipped (with reasons), slugs dropped, folders and tags created. An import is recorded in the audit log.

### 13.2 Export

- **SlugBase JSON** — lossless for the member's own content: every own bookmark (including plan-archived ones, flagged), with all fields from §5.1 except usage, plus folder associations (by name, with icon and colour), tags (by name), slug, forwarding and pinned state, and the member's go preferences (by slug and bookmark reference). Optionally includes readable shared bookmarks as a separate, flagged list (read-only fields only). Export → import into an empty workspace reproduces the member's bookmarks, folders, tags, slugs, forwarding and pinned state exactly (a round-trip test enforces this, doc 08).
- **Netscape HTML** — for re-import into browsers; lossy (slugs and forwarding are written as `SHORTCUTURL`, tags as `TAGS`) (Q29).
- Export is generated on demand and streamed; it is not stored on the server.

### 13.3 JSON format

A versioned document: `{ "format": "slugbase-export", "version": 1, "exportedAt", "workspace": { "name" }, "folders": [...], "tags": [...], "bookmarks": [...], "goPreferences": [...], "shared": [...] }`. Doc 04 publishes its JSON Schema; future versions stay importable by later releases.

### 13.4 CE backup story

Per-member export (above) plus the operator's database backup (`pg_dump` / volume snapshot, doc 07 §7). The export's losslessness is a hard requirement because it is the user-facing half of that story.

---

## 14. AI suggestions

- **What**: given a URL (and the fetched metadata), suggest a title, a slug candidate, up to 5 tags (preferring the member's existing tags), and a confidence score per field, in a chosen output language (the member's UI language by default).
- **Availability**: the AI adapter is configured (Q8) **and** the workspace has `ai.suggestions` **and** the workspace toggle is on (§10) **and** the member has not opted out. Otherwise the modal shows no AI affordance (not a disabled one), except on Cloud where the entitlement slot may show an upgrade hint.
- **Where**: the bookmark modal only. A "Suggest" action fills empty fields and offers suggestions for edited fields as chips the member can accept. Suggested slugs are checked for grammar and the member's existing slugs before being shown.
- **Privacy**: only the URL, the fetched public metadata and the member's tag names are sent to the provider — never other bookmarks, never workspace names. The UI states which provider processes the request (operator-configured name). Results are cached per (workspace, account, canonical URL, language) for 30 days. Accepted/ignored fields are counted per workspace for product analytics (no content).
- **Failure**: a timeout (5 s) or provider error silently leaves the fields as they are, with a small "suggestions unavailable" note.

---

## 15. Internationalisation

- English and German for every UI string, email, error message and the marketing site (D19). Language resolution: the signed-in account's preference → the `Accept-Language` header → English.
- Dates, numbers and plurals via `Intl` and ICU plural rules; relative times ("2 h ago") in the active language.
- API error responses carry a stable machine `code` and an English `detail`; the SPA renders localised text from the code (doc 04 §3).
- Search uses language-aware stemming for titles and descriptions (German and English configurations) plus language-neutral matching for slugs and hosts (doc 05).

---

## 16. Constants

Starting values. **Config** values are environment or instance settings (doc 07 lists the keys); **fixed** values are product invariants changed only through a decision.

| Item | Value | Kind | Section |
|---|---|---|---|
| Slug grammar | `^[a-z0-9][a-z0-9-]{0,63}$` | fixed | §6.1 |
| Reserved slugs | none (all slugs under `/go/`) | fixed | §6.1 |
| Slug uniqueness | per owner within a workspace | fixed | §6.1 |
| Bookmark title / description / URL max | 300 / 1 000 / 2 048 chars | fixed | §5.1 |
| Folder name / tag name / team name max | 64 / 40 / 64 chars | fixed | §7, §4 |
| Page sizes | 24 / 48 / 96; max 100 via API | config | §5.7 |
| Select-all cap | 5 000 IDs | config | §5.7 |
| Import max bookmarks / HTML size | 5 000 / 5 MiB | config | §13.1 |
| Metadata cache / AI cache | 7 days / 30 days | config | §5.4, §14 |
| Metadata HTML read cap / sync budget | 512 KiB / 3 s | config | §5.4 |
| Favicon max size | 64 KiB | config | §5.4 |
| Session TTL (sliding) / remember-me / absolute cap | 30 d / 90 d / 180 d | config | §2.4 |
| Pending-MFA session | 5 min, 5 attempts | fixed | §2.3 |
| Password length | 12–256 | config (min) | §2.5 |
| Signup verification / password reset / email-change token TTL | 24 h / 1 h / 1 h | config | §2.5, §2.6 (Q48) |
| Invitation TTL | 7 days | config | §3.4 |
| MFA backup codes | 10, single-use | fixed | §2.7 |
| API tokens per account | 10 | config | §2.9 |
| API token prefix | `slb_` | fixed | §2.9 |
| AI suggestion timeout / max tags | 5 s / 5 | config | §14 |
| Dashboard quick access / pinned / tags | 8 / 12 / 12 | config | §9.3 |
| Free bookmark cap, seat minimum, grace period, archive rule | see doc 06 | — | doc 06 |

### Rate limits

Per IP and, where an account is known, per account; `429` with `Retry-After`. Enforced through `RateLimitPort` (doc 01 §8.2).

| Operation | Limit |
|---|---|
| Sign-in (password) | 10 / min per IP; 20 / hour per email |
| MFA code | 5 per pending session; 30 / hour per account |
| Registration | 5 / hour per IP |
| Password reset request | 5 / hour per IP; 3 / hour per email |
| Verification / email-change resend | 3 / hour per account |
| Invitation accept / setup | 10 / hour per IP |
| API token creation | 20 / hour per account |
| Metadata fetch (sync) | 60 / min per account |
| AI suggestions | 30 / min per account |
| `/go` resolution | 600 / min per account |
| General API (cookie or token) | 1 200 / min per principal |
| Marketing-site forms (Cloud) | 5 / hour per IP (doc 11) |
