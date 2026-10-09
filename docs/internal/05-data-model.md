# SlugBase — Data Model

PostgreSQL is the only database (D6): 17 and 18 are supported (Q3), 18 is the version the compose file ships. The Drizzle schema in TypeScript is the single source; migrations are generated from it (D7). This document is the reviewed design that schema implements: every table, its constraints, indexes and row-level-security policy, the database roles, the few system operations that cross tenants, the migration policy and data lifecycle.

---

## 1. Conventions

| Rule | Value |
|---|---|
| Primary keys | `id uuid` holding a UUIDv7 generated in the application (Q91) — no database default, so PostgreSQL 17 and 18 behave the same and tests can inject a sequence; association tables use composite natural keys |
| Tenant column | `workspace_id uuid NOT NULL` on every tenant-owned table, first column of every composite key and of every index whose queries are workspace-scoped |
| Intra-workspace references | **Composite foreign keys** `(workspace_id, x_id) REFERENCES x (workspace_id, id)` — each referenced table has `UNIQUE (workspace_id, id)`. A row can therefore never point at a row in another workspace, even if application code passes a foreign ID (defence alongside RLS, D8) |
| Timestamps | `timestamptz NOT NULL DEFAULT now()`; `created_at`, `updated_at` (trigger-maintained) on editable tables; nullable `*_at` columns for state (`verified_at`, `revoked_at`, `plan_archived_at`, `deleting_at`) instead of booleans plus a timestamp |
| Optimistic concurrency | `version integer NOT NULL DEFAULT 1`, incremented by the update trigger, on bookmarks, folders, teams, workspaces (API `ETag`/`If-Match`, doc 04 §2.4) |
| Case-insensitive text | `citext` for emails, slugs and names compared case-insensitively |
| Enums | Postgres enum types (`member_role`, `share_target`, …); adding a value is an expand-only migration (§5.4) |
| Secrets | Never stored in plaintext: tokens as `bytea` SHA-256 hashes; MFA secret as `bytea` ciphertext + `key_id` via `SecretBoxPort` |
| Naming | `snake_case` tables (plural) and columns; indexes `<table>_<cols>_idx`, uniques `<table>_<cols>_key`, policies `<table>_tenant` |
| Deletion | Hard delete with FK `ON DELETE CASCADE` along ownership; no soft delete in v1 (doc 00 §4). The one transient state is a workspace marked `deleting` while its background job runs (§7.2) |

### Extensions

`citext`, `pg_trgm`, `btree_gin` (multi-column GIN with `workspace_id`). Created by the first migration as the owner role. Nothing that needs superuser at runtime.

### Schemas

| Schema | Owner of the migration history | Contents |
|---|---|---|
| `public` | CE (`mdg-labs/slugbase`) | Everything in §2 |
| `pgboss` | pg-boss (managed by the library at `migrate` time) | Job queue |
| `cloud` | The private Cloud repository | Cloud-only records (§2.12, Cloud doc 06) |
| `console` | The private Cloud repository (operator console) | Operator accounts, sessions, audit, daily snapshots (Cloud doc 07 §6) |
| `drizzle` | each chain | Migration bookkeeping, one table per chain: `drizzle.migrations_core`, `…_cloud`, `…_console` |

Billing data does **not** live in SlugBase's database: customers, payments and billing documents stay in the external billing service (D29). The `cloud` schema holds only the billing state the Cloud entitlement source needs.

---

## 2. Tables (`public`)

RLS column: **T** = tenant policy (`workspace_id = app_workspace_id()`), **A** = account policy (`account_id = app_account_id()`), **T+A** as stated, **S** = system-only (no app policy; reached through §3 functions only), **—** = no RLS (no tenant or personal data). Every table with RLS has both `ENABLE` and `FORCE ROW LEVEL SECURITY`.

`app_workspace_id()` and `app_account_id()` are `STABLE` SQL functions returning `nullif(current_setting('app.workspace_id', true), '')::uuid` (and the account equivalent) — NULL when unset, so a query outside `withTenant` matches nothing.

### 2.1 Accounts and credentials

**`accounts`** — RLS: own row, or co-members of the active workspace (read-only for others)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `email` | citext NOT NULL UNIQUE | Trimmed and Unicode NFKC-normalised (doc 02 §2.1); case preserved, compared case-insensitively; unique across the deployment |
| `email_verified_at` | timestamptz | NULL = unverified |
| `pending_email` | citext | Target of an in-flight email change |
| `display_name` | text NOT NULL | 1–100 chars |
| `password_hash` | text | argon2id PHC string; NULL for OIDC-only accounts |
| `password_changed_at` | timestamptz | Sessions older than this are invalid |
| `locale` | text NOT NULL DEFAULT `'en'` | CHECK in (`en`,`de`) — extended by migration |
| `theme` | text NOT NULL DEFAULT `'system'` | `light` / `dark` / `system` |
| `accent` | text | Token name from the accent palette (doc 03), never a free hex |
| `default_bookmark_view` | text NOT NULL DEFAULT `'grid'` | `grid` / `table` |
| `single_key_shortcuts` | boolean NOT NULL DEFAULT true | Single-key shortcuts on (Q38); modifier shortcuts always work |
| `signin_alerts` | boolean NOT NULL DEFAULT true | Email the account on a sign-in from a new device (doc 02 §12). A sign-in is from a new device when no live session of the account shares both its user-agent family and its IP prefix; never sent for the account's first session or a `partial` session |
| `ai_opt_out` | boolean NOT NULL DEFAULT false | |
| `analytics_consent` | text NOT NULL DEFAULT `'unset'` | `unset` / `granted` / `denied`; `consent_at` timestamptz alongside |
| `onboarding` | jsonb NOT NULL DEFAULT `'{}'` | Checklist state; Zod-validated shape with exactly the boolean keys `browserSetupDone`, `importDone` and `checklistDismissed`, no free keys — the other checklist items are derived from data |
| `is_instance_admin` | boolean NOT NULL DEFAULT false | CE only in practice |
| `disabled_at` | timestamptz | Set by an instance admin; blocks sign-in (the generic error), deletes the account's sessions and makes its API tokens inert |
| `mfa_enabled_at` | timestamptz | NULL = MFA off |
| `mfa_secret` | bytea | SecretBox ciphertext |
| `mfa_secret_key_id` | text | Key used, for rotation |
| `mfa_last_step` | bigint | Last accepted TOTP time step (replay protection) |
| `last_sign_in_at` | timestamptz | |
| `created_at`, `updated_at` | timestamptz | |

Policy: `USING (id = app_account_id() OR id IN (SELECT account_id FROM workspace_members WHERE workspace_id = app_workspace_id()))`; `WITH CHECK (id = app_account_id())`. Co-members see the row, but the repository's co-member projection selects only `id, display_name, email` — sensitive columns are additionally protected by **column privileges**: `slugbase_app` has no `SELECT` on `password_hash`, `mfa_secret`, `mfa_secret_key_id`, `mfa_last_step`; those are read and written only through §3 functions.

**`account_identities`** — RLS: A

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `account_id` | uuid NOT NULL → accounts ON DELETE CASCADE | |
| `provider` | text NOT NULL | The `OIDC_<SLUG>` slug |
| `subject` | text NOT NULL | IdP `sub` |
| `email_at_link` | citext NOT NULL | For display and audit |
| `created_at`, `last_used_at` | timestamptz | |

`UNIQUE (provider, subject)`; index `(account_id)`.

**`sessions`** — RLS: S (looked up by token hash before any account context exists)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | Exposed to the account for "revoke this session" |
| `token_hash` | bytea NOT NULL UNIQUE | SHA-256 of the 32-byte token |
| `account_id` | uuid NOT NULL → accounts ON DELETE CASCADE | |
| `level` | text NOT NULL | `partial` / `full` |
| `active_workspace_id` | uuid → workspaces ON DELETE SET NULL | Re-derived on next request if NULL or no longer accessible (doc 01 §5.1) |
| `reauth_at` | timestamptz | Sudo mode (doc 04 §4.4) |
| `remember` | boolean NOT NULL | 30 vs 90-day sliding window |
| `created_at`, `last_seen_at`, `expires_at`, `absolute_expires_at` | timestamptz | `last_seen_at` is written at most once a minute per session |
| `ip_prefix` | cidr | The first two octets of an IPv4 address (a /16) or an IPv6 /48 — a coarse network, never a precise location; no location is derived or stored |
| `user_agent` | text | Truncated to 256 chars |

Index `(account_id)`, `(expires_at)`. The account sees its own sessions through `sys_list_sessions` (§3).

**`oidc_login_states`** — RLS: S

`state_hash bytea PK`, `provider text`, `intent text` (`login` / `link` / `reauth` / `invite`), `nonce text`, `code_verifier bytea` (SecretBox), `return_to text` (validated same-origin path), `link_account_id uuid NULL` (the signed-in account for the `link` and `reauth` intents), `invitation_token_hash bytea NULL` (the invitation to accept for the `invite` intent), `expires_at timestamptz` (10 min). Deleted on use.

**`api_tokens`** — RLS: A for management, lookup is S

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `account_id` | uuid NOT NULL | |
| `workspace_id` | uuid NOT NULL | Bound workspace, chosen at creation among the account's workspaces (doc 04 §4.2) |
| — | FK `(workspace_id, account_id)` → `workspace_members` ON DELETE CASCADE | Losing membership deletes the token |
| `name` | text NOT NULL | 1–64 chars |
| `token_hash` | bytea NOT NULL UNIQUE | SHA-256 of the token (`slb_` + 32 random bytes, base62) |
| `token_prefix` | text NOT NULL | First 6 chars after `slb_`, for display and leak scanning |
| `scope` | text NOT NULL | `read` / `read-write` |
| `expires_at` | timestamptz | NULL = no expiry (Q47); the creation dialog defaults to 90 days |
| `last_used_at` | timestamptz | Written at most once a minute |
| `last_used_ip_prefix` | cidr | Same coarse prefix as sessions, written with `last_used_at` |
| `created_at` | timestamptz | |

`UNIQUE (account_id, name)`; the per-account count (10 active tokens, `MAX_API_TOKENS_PER_USER`) is enforced in the service.

**`mfa_backup_codes`** — RLS: S. `id`, `account_id` → accounts CASCADE, `code_hash bytea` (argon2id of the 10-char code — low entropy, so a slow hash), `used_at`. Index `(account_id) WHERE used_at IS NULL`.

**`credential_tokens`** — RLS: S. One table for every emailed single-use token.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `purpose` | text NOT NULL | `email_verify` / `email_change` / `email_change_cancel` (the "this wasn't me" link to the old address) / `password_reset` |
| `account_id` | uuid NOT NULL → accounts CASCADE | |
| `token_hash` | bytea NOT NULL UNIQUE | |
| `target_email` | citext | For `email_change` |
| `expires_at` | timestamptz NOT NULL | 1 hour (verify: 24 hours, Q48) |
| `used_at` | timestamptz | |
| `created_at` | timestamptz | |

Issuing a new token of a purpose invalidates (deletes) older unused ones for the same account.

### 2.2 Workspaces and membership

**`workspaces`** — RLS: rows the account is a member of; writes only on the active workspace

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `name` | text NOT NULL | 1–64 chars |
| `created_by` | uuid → accounts ON DELETE SET NULL | |
| `entitlement_version` | integer NOT NULL DEFAULT 1 | Bumped on any plan/entitlement change (cache key, doc 01 §8.3) |
| `bookmark_count` | integer NOT NULL DEFAULT 0 | Number of the workspace's bookmarks that are not plan-archived. Maintained in the same transaction as every bookmark create, delete, import, archive and restore; the entitlement check reads it under the workspace row lock instead of counting rows (doc 01 §7.5) |
| `deleting_at` | timestamptz | Set when deletion is requested (§7.2); the workspace is then hidden from every product query, the switcher and `GET /workspaces` |
| `version` | integer NOT NULL DEFAULT 1 | |
| `created_at`, `updated_at` | timestamptz | |

Policy: `USING ((id = app_workspace_id() OR id IN (SELECT app_member_workspace_ids())) AND deleting_at IS NULL)` for `SELECT`; `id = app_workspace_id()` for `UPDATE`/`DELETE`, so the deletion job can finish. `app_member_workspace_ids()` is a `SECURITY DEFINER` set-returning function owned by `slugbase_system` that returns the calling account's workspace IDs from `workspace_members`, leaving out workspaces being deleted (avoids recursive policy evaluation). Insert happens through `sys_create_workspace` (§3), which also inserts the owner membership atomically.

No billing columns: in Cloud, billing state lives in the `cloud` schema (§2.12, Cloud doc 06); CE has none (D18). `entitlement_version` and `bookmark_count` are generic and exist on every edition.

**`workspace_members`** — RLS: T, plus the account's own rows

| Column | Type | Notes |
|---|---|---|
| `workspace_id` | uuid NOT NULL → workspaces ON DELETE CASCADE | |
| `account_id` | uuid NOT NULL → accounts ON DELETE CASCADE | |
| `role` | `member_role` NOT NULL | `owner` / `admin` / `member` |
| `joined_at` | timestamptz | |
| `last_active_at` | timestamptz | Written at most once a minute; shown as "last active" in the members list and orders the re-derivation of the active workspace (most recently active, then `joined_at`) |

PK `(workspace_id, account_id)`; index `(account_id)`. **At least one owner** per workspace: a deferred constraint trigger checks after every delete/update that the workspace still has an owner, unless the workspace itself is being deleted (a workspace created for an owner invitation has no member until it is accepted; the trigger does not fire for it). Policy: `USING (workspace_id = app_workspace_id() OR account_id = app_account_id())`; writes only in the active workspace.

**`workspace_invitations`** — RLS: T (inspect/accept by token is S)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `workspace_id` | uuid NOT NULL | |
| `email` | citext NOT NULL | |
| `role` | `member_role` NOT NULL | CHECK `role <> 'owner' OR instance_issued`: the public operations never create an owner invitation |
| `instance_issued` | boolean NOT NULL DEFAULT false | True only for the owner invitation that `sys_instance_create_workspace` writes for a workspace created without an owner account; `slugbase_app` has no `INSERT` privilege on this column |
| `team_ids` | uuid[] NOT NULL DEFAULT `'{}'` | Teams to join on accept; validated on invite and again on accept (deleted teams are skipped) |
| `token_hash` | bytea NOT NULL UNIQUE | Regenerated on resend/link |
| `invited_by` | uuid → accounts ON DELETE SET NULL | |
| `status` | text NOT NULL | `pending` / `accepted` / `revoked` |
| `expires_at` | timestamptz NOT NULL | 7 days |
| `accepted_by` | uuid → accounts ON DELETE SET NULL | |
| `created_at`, `updated_at` | timestamptz | |

Partial unique `(workspace_id, email) WHERE status = 'pending'`. Expiry is evaluated at read time; the purge job deletes non-pending rows after 30 days.

**`workspace_settings`** — RLS: T. One row per workspace, typed columns (no key/value table): `workspace_id` PK → workspaces CASCADE, `ai_enabled boolean NOT NULL DEFAULT true`, `updated_at`, `updated_by`. New settings are new columns.

**`instance_state`** — RLS: — (no personal data). Single row (`id smallint PK CHECK (id = 1)`): `setup_completed_at timestamptz`, `setup_by uuid`, `setup_token_hash bytea` (SHA-256 of the one-time setup token generated at first start while no account exists and printed once to the server log; the token itself is never stored). Written only by `sys_setup_token_set` and `sys_complete_setup`.

**`instance_settings`** — RLS: — (no personal data; the display name and the sign-in notice are public on the sign-in page). Single row (`id smallint PK CHECK (id = 1)`) with typed columns: `allow_workspace_creation boolean` (NULL = use the default the composition root supplies, CE: off; a stored value overrides it on the next request), `display_name text` (the instance name shown on the sign-in page), `sign_in_notice text` (≤ 500 chars, plain text), `updated_at`, `updated_by uuid → accounts ON DELETE SET NULL`. `slugbase_app` has `SELECT` only; the row is written through `sys_instance_update_settings` (§3.3), which writes an instance audit event. New settings are new columns.

### 2.3 Teams

**`teams`** — RLS: T. `id`, `workspace_id`, `name citext` (1–64), `description text` (≤ 280), `version`, timestamps. `UNIQUE (workspace_id, id)`, `UNIQUE (workspace_id, name)`.

**`team_members`** — RLS: T. `workspace_id`, `team_id`, `account_id`; PK `(team_id, account_id)`; FK `(workspace_id, team_id)` → teams CASCADE; FK `(workspace_id, account_id)` → workspace_members CASCADE (leaving the workspace removes team memberships); index `(workspace_id, account_id)`.

### 2.4 Bookmarks, folders, tags

**`bookmarks`** — RLS: T

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `workspace_id` | uuid NOT NULL → workspaces CASCADE | |
| `owner_id` | uuid | FK `(workspace_id, owner_id)` → workspace_members `ON DELETE SET NULL (owner_id)` — a departed member's bookmarks stay with the workspace (doc 02 §3.5) |
| `url` | text NOT NULL | ≤ 2 048 chars; CHECK scheme is `http` or `https` |
| `url_canonical` | text NOT NULL | Lower-cased host, no default port, no fragment, sorted tracking params removed — the metadata/AI cache key |
| `host` | text NOT NULL | Derived; favicon lookup and search facet |
| `title` | text NOT NULL | 1–300 chars |
| `description` | text | ≤ 1 000 chars, from metadata or the user |
| `slug` | citext | CHECK grammar `^[a-z0-9][a-z0-9-]{0,63}$`; there are no reserved words (doc 02 §6.1) |
| `forwarding` | boolean NOT NULL DEFAULT false | CHECK `NOT forwarding OR slug IS NOT NULL` |
| `pinned_at` | timestamptz | NULL = not pinned; pinned lists sort by it |
| `plan_archived_at` | timestamptz | Downgrade overflow (doc 06 §5); archived rows are excluded from every product query |
| `open_count` | bigint NOT NULL DEFAULT 0 | Batched updates (doc 01 §8.1) |
| `last_opened_at` | timestamptz | |
| `search` | tsvector GENERATED ALWAYS AS (…) STORED | `setweight(to_tsvector('simple', slug), 'A') ‖ setweight(to_tsvector('simple', title), 'A') ‖ setweight(to_tsvector('simple', host), 'B') ‖ setweight(to_tsvector('simple', coalesce(description,'')), 'C')` — `simple` config so EN/DE content is matched without stemming surprises (Q49); the host is searchable, the URL path is not |
| `version` | integer | |
| `created_at`, `updated_at` | timestamptz | |

Constraints and indexes:

| Name | Definition | Serves |
|---|---|---|
| `bookmarks_workspace_id_id_key` | UNIQUE `(workspace_id, id)` | Composite FKs |
| `bookmarks_owner_slug_key` | UNIQUE `(workspace_id, owner_id, slug) NULLS NOT DISTINCT WHERE slug IS NOT NULL` | Slug unique per owner; ownerless (departed) bookmarks share one namespace |
| `bookmarks_slug_idx` | `(workspace_id, slug) INCLUDE (id, owner_id, url, forwarding, plan_archived_at) WHERE slug IS NOT NULL` | `/go` candidate lookup, index-only (§4) |
| `bookmarks_slug_trgm_idx` | GIN `(workspace_id, slug gin_trgm_ops)` via `btree_gin` | Palette slug autocomplete / fuzzy |
| `bookmarks_title_trgm_idx` | GIN `(workspace_id, title gin_trgm_ops)` | Typo-tolerant title search |
| `bookmarks_search_idx` | GIN `(workspace_id, search)` | Full-text search |
| `bookmarks_owner_recent_idx` | `(workspace_id, owner_id, created_at DESC, id DESC) WHERE plan_archived_at IS NULL` | `scope=mine`, `sort=recent` keyset |
| `bookmarks_owner_opened_idx` | `(workspace_id, owner_id, last_opened_at DESC NULLS LAST, id DESC) WHERE plan_archived_at IS NULL` | `recently_opened` |
| `bookmarks_owner_popular_idx` | `(workspace_id, owner_id, open_count DESC, id DESC) WHERE plan_archived_at IS NULL` | `most_used`, dashboard quick access |
| `bookmarks_owner_title_idx` | `(workspace_id, owner_id, lower(title), id)` | Alphabetical |
| `bookmarks_pinned_idx` | `(workspace_id, owner_id, pinned_at DESC) WHERE pinned_at IS NOT NULL AND plan_archived_at IS NULL` | Pinned |
| `bookmarks_archived_idx` | `(workspace_id, plan_archived_at) WHERE plan_archived_at IS NOT NULL` | Restore on re-upgrade |

**`folders`** — RLS: T. `id`, `workspace_id`, `owner_id` (FK as bookmarks, `SET NULL (owner_id)`), `name citext` (1–64), `icon text` (a lucide icon name from the curated allowlist of about 60 published in `@slugbase/contracts`, default `folder`, doc 03), `color smallint NOT NULL DEFAULT 1 CHECK (color BETWEEN 1 AND 8)` (the `--folder-1` … `--folder-8` tokens, Q21), `version`, timestamps. `UNIQUE (workspace_id, id)`; `UNIQUE (workspace_id, owner_id, name) NULLS NOT DISTINCT`.

**`folder_bookmarks`** — RLS: T. `workspace_id`, `folder_id`, `bookmark_id`, `added_at`; PK `(folder_id, bookmark_id)`; composite FKs to folders and bookmarks, both CASCADE; index `(workspace_id, bookmark_id)`. Only the owner files a bookmark, and only into their own folders (Q22): the service checks that the folder and the bookmark have the caller as owner, so a shared bookmark is never filed by a recipient.

**`tags`** — RLS: T **and** owner: `USING (workspace_id = app_workspace_id() AND owner_id = app_account_id())` — tags are private to their owner (doc 02 §5), so RLS enforces it directly. `id`, `workspace_id`, `owner_id NOT NULL` (FK to workspace_members **CASCADE** — tags are personal and leave with the member), `name citext` (1–40), `created_at`. `UNIQUE (workspace_id, owner_id, name)`.

**`bookmark_tags`** — RLS: T + tag owner (same predicate via the tag). `workspace_id`, `bookmark_id`, `tag_id`; PK `(bookmark_id, tag_id)`; composite FKs CASCADE; index `(workspace_id, tag_id)`. Only the bookmark's owner tags it, with their own tags (Q22); a recipient of a shared bookmark cannot tag it, and the owner's tags never travel with a share.

### 2.5 Sharing

**`bookmark_shares`** / **`folder_shares`** — RLS: T. Same shape:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `workspace_id` | uuid NOT NULL | |
| `bookmark_id` / `folder_id` | uuid NOT NULL | Composite FK CASCADE |
| `target_account_id` | uuid | Composite FK → workspace_members CASCADE |
| `target_team_id` | uuid | Composite FK → teams CASCADE |
| `granted_by` | uuid | → accounts SET NULL |
| `created_at` | timestamptz | |

CHECK exactly one of `target_account_id`, `target_team_id` is set. Partial uniques per target kind. Indexes `(workspace_id, target_account_id, bookmark_id)` and `(workspace_id, target_team_id, bookmark_id)` (folder equivalents) — the "shared with me" and `/go` access checks.

Sharing grants **read** access only (doc 02 §8). A share whose bookmark owner has left (owner NULL) stays valid.

### 2.6 Slugs and forwarding

**`slug_preferences`** — RLS: T + A (`account_id = app_account_id()`). `workspace_id`, `account_id`, `slug citext`, `bookmark_id`, `created_at`. PK `(workspace_id, account_id, slug)`; composite FK to bookmarks CASCADE (a deleted bookmark forgets the preference); FK to workspace_members CASCADE.

### 2.7 Fetch caches

**`url_metadata`** — RLS: T. Per workspace on purpose: a deployment-wide cache would let one tenant learn by timing whether another tenant saved a URL (doc 10 §5). `workspace_id`, `url_canonical`, `status` (`ok` / `failed` / `blocked`), `title`, `description`, `site_name`, `canonical_url` (the page's own canonical link, stored as text and never fetched), `language`, `fetched_at`, `expires_at` (7 days). PK `(workspace_id, url_canonical)`.

**`favicons`** — RLS: S. Deployment-wide by host (low sensitivity: hosts, not URLs; accepted, doc 10 §5). `host text PK`, `content bytea` (the 64 px PNG) and `content_32 bytea` (the 32 px PNG), both re-encoded server-side from a source of at most 64 KiB; SVG sources are refused and never served, `content_type` (`image/png`), `status` (`ok` / `none` — a host with no usable icon), `fetched_at`, `expires_at` (7 days).

### 2.8 AI

**`ai_suggestions`** — RLS: T + A. Cache keyed by `(workspace_id, account_id, url_canonical, locale)` PK: `result jsonb` (Zod-validated `{ title, slug, tags[], confidence }`), `provider`, `model`, `created_at`, `expires_at` (30 days).

**`ai_suggestion_usage`** — RLS: T. `id`, `workspace_id`, `account_id`, `bookmark_id NULL`, `fields_used text[]` (`title` / `slug` / `tags`, from the optional `aiFields` of bookmark create and update, doc 04 §10.6), `created_at`. Aggregated for the analytics port; purged after 90 days.

### 2.9 Audit

**`audit_events`** — RLS: T for workspace events; instance events (`workspace_id IS NULL`) only through `sys_list_instance_audit` to instance admins.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `workspace_id` | uuid | NULL for deployment-level (instance) events |
| `actor_type` | text NOT NULL | `account` / `api_token` / `system` |
| `actor_account_id` | uuid | → accounts SET NULL; the account deletion keeps the event |
| `actor_label` | text NOT NULL | Display name at the time ("Former member" later is never rewritten) |
| `actor_token_id` | uuid | When `api_token` |
| `action` | text NOT NULL | Dotted catalog name (`bookmark.deleted`, `member.role_changed`, `billing.plan_changed`) — the recorded actions are listed in doc 02 §10 and defined in `packages/core/src/audit/`, each with a category and a Zod schema that validates `metadata` before insert |
| `entity_type`, `entity_id` | text, uuid | |
| `metadata` | jsonb NOT NULL DEFAULT `'{}'` | Before/after of changed fields; never secrets, never full URLs of other members' private bookmarks |
| `ip_prefix` | cidr | |
| `created_at` | timestamptz | |

Index `(workspace_id, created_at DESC, id DESC)`, `(workspace_id, actor_account_id, created_at DESC)`, `(workspace_id, entity_type, entity_id)`. `slugbase_app` has `INSERT` and `SELECT` only — **no `UPDATE`/`DELETE`** grant; purging is a system operation. The event is written by the audit writer in the same transaction as the change it records. Partitioning by month is deferred until the table passes ~50 M rows (Q50).

### 2.10 Infrastructure tables

**`idempotency_keys`** — RLS: A. `account_id`, `key uuid`, `operation text`, `request_hash bytea`, `status` (`in_progress` / `done`), `response_status`, `response_body jsonb`, `created_at`, `expires_at` (24 h). PK `(account_id, key)`.

**`rate_limit_buckets`** — `UNLOGGED`, RLS: S. `key text PK` (bucket + IP/principal hash), `tokens real`, `updated_at timestamptz`. Lost on crash or failover by design — limits reset, nothing else breaks (doc 10 §5).

**`pgboss.*`** — owned by pg-boss. Job payloads carry IDs, never secrets or full documents; the worker re-reads current state.

### 2.11 Entity relationships

```
accounts ─┬─< account_identities
          ├─< sessions, api_tokens, mfa_backup_codes, credential_tokens
          └─< workspace_members >─ workspaces ─┬─< workspace_invitations
                     │                         ├── workspace_settings
                     │                         ├─< teams ─< team_members >─ workspace_members
                     │                         ├─< audit_events
                     ├─ owns ─< bookmarks ─────┼─< folder_bookmarks >─ folders ─< folder_shares
                     ├─ owns ─< folders        ├─< bookmark_tags >─ tags (owner-private)
                     ├─ owns ─< tags           ├─< bookmark_shares (→ member | team)
                     └─< slug_preferences      └─< url_metadata, ai_suggestions
```

---

### 2.12 Cloud tables (`cloud`, Cloud only)

(Cloud) Recorded in the Cloud documentation (Cloud doc 06). The `cloud` chain in the private Cloud repository owns them; CE has none of them. They follow this document's rules: workspace-scoped tables carry the standard RLS policy (§3.2), may reference `public` tables but never the reverse (§5.5), and are written only through system operations defined in the `cloud` chain (§3.3), never from a browser request.

## 3. Roles, grants and system operations

### 3.1 Roles

| Role | Login | Owns | Can |
|---|---|---|---|
| `slugbase_owner` | No | Every object in `public` (and `cloud`, `console` in Cloud) | Everything; never used by a running process |
| `slugbase_migrator` | Yes | — (member of `slugbase_owner`) | DDL; used only by `migrate` (the image entrypoint runs it before the server starts, §5.3). A managed deployment that runs `migrate` as a separate deploy step uses it only there, so its URL never reaches the running containers (Cloud: D25, Cloud doc 07 §5.5) |
| `slugbase_app` | Yes | Nothing | `SELECT/INSERT/UPDATE/DELETE` on tenant tables (minus the column and table exclusions below), `USAGE` on `pgboss`, `EXECUTE` on §3.3 functions; **`NOBYPASSRLS`**, no `TRUNCATE`, no DDL, no `REFERENCES`, `CREATE` revoked on every schema |
| `slugbase_system` | No | The §3.3 functions | `BYPASSRLS`; exists only as the owner of `SECURITY DEFINER` functions, so cross-tenant access happens only inside their reviewed bodies |
| `slugbase_console_ro` (Cloud) | Yes | — | `SELECT` on the `console_mirror` views only (allowlisted columns: IDs, counts, timestamps, plan state; no emails beyond what the console PRD allows, no URLs, no titles) — Cloud doc 07 §6 |

Server and worker both connect as `slugbase_app` (worker pool distinct, same role). In CE, the compose file provisions `slugbase_app` and `slugbase_migrator` through a Postgres init script (`packages/db/provision/roles.sql`, idempotent, passwords supplied as variables) and passes two URLs (`DATABASE_URL`, `DATABASE_MIGRATE_URL`). With only `DATABASE_URL` set and that role owning the database, the server refuses to start in production; `SLUGBASE_ALLOW_OWNER_CONNECTION=true` overrides it, with a warning (Q56).

Exclusions for `slugbase_app`: no column `SELECT` on `accounts.password_hash`, `mfa_*`; no table access to `sessions`, `oidc_login_states`, `mfa_backup_codes`, `credential_tokens`, `favicons`, `rate_limit_buckets`, `instance_state` except through functions; `SELECT` only on `instance_settings`; `INSERT`/`SELECT` only on `audit_events`; no `INSERT` on `workspace_invitations.instance_issued`.

### 3.2 The tenant transaction

`withTenant(ctx, fn)` (doc 01 §5.3) issues, inside `BEGIN`:

```sql
SELECT set_config('app.account_id',   $1, true),
       set_config('app.workspace_id', $2, true),   -- '' when the route is account-level
       set_config('app.request_id',   $3, true);
```

`true` = transaction-local, so the settings vanish at `COMMIT`/`ROLLBACK` and pooled connections never carry them to another request (doc 01 §9.2). Account-level routes (`/me/*`) set only `app.account_id`.

### 3.3 System operations

The complete list of operations that cross the tenant or account boundary. Each is a `SECURITY DEFINER` function owned by `slugbase_system` with `SET search_path = pg_catalog, public`, a narrow signature, no dynamic SQL, `EXECUTE` revoked from `PUBLIC` and granted to `slugbase_app`, and an audit or log line where noted. Every function is listed in the reviewed registry `packages/db/src/system/registry.ts`; `pnpm db:check` fails for a `SECURITY DEFINER` function that is not registered and for a registry entry without a function. Adding one is a risk-flagged change (doc 10).

| Function | Why it must cross the boundary | Returns / does |
|---|---|---|
| `sys_session_lookup(token_hash)` | Runs before any account is known | Session + account principal (id, level, disabled, password_changed_at check, active workspace, membership role) — one round trip per request; a workspace being deleted counts as inaccessible |
| `sys_session_create(account_id, level, remember, ip_prefix, ua, token_hash)` / `sys_session_touch(id)` / `sys_session_rotate(id, new_hash)` / `sys_session_revoke(id, account_id)` / `sys_session_revoke_all(account_id, except_id)` / `sys_list_sessions(account_id)` | Sessions are not readable by the app role | |
| `sys_login_lookup(email)` | Login knows only an email | `account_id, password_hash, disabled_at, mfa_enabled_at`; constant-time behaviour for unknown emails is the caller's job (dummy hash verify) |
| `sys_mfa_get_secret(account_id)` / `sys_mfa_set(account_id, secret, key_id)` / `sys_mfa_accept_step(account_id, step)` / `sys_backup_code_consume(account_id, …)` | MFA material is column-protected | `sys_mfa_accept_step` atomically rejects a step ≤ `mfa_last_step` |
| `sys_password_set(account_id, hash)` | Column-protected | Also sets `password_changed_at` (invalidates other sessions) |
| `sys_api_token_lookup(token_hash)` | Runs before any account is known | Token principal (account, workspace, scope, disabled/expired checks; a workspace being deleted is inert); throttled `last_used_at` and IP-prefix write |
| `sys_credential_token_issue(purpose, account_id, hash, target_email, ttl)` / `sys_credential_token_consume(purpose, hash)` | Redeemed anonymously by token | Consume is single-use (`UPDATE … SET used_at … WHERE used_at IS NULL AND expires_at > now() RETURNING`) |
| `sys_oidc_state_*`, `sys_identity_lookup(provider, subject)` | OIDC callback is anonymous | |
| `sys_create_account(email, display_name, password_hash, locale)` | Registration, setup, invitation accept are anonymous | Unique-violation → generic response upstream |
| `sys_setup_status()` / `sys_setup_token_set(token_hash)` / `sys_complete_setup(...)` | `instance_state` has no app access; first run happens exactly once | Status reports whether setup is pending; the token hash is written at first start; `sys_complete_setup` takes `pg_advisory_xact_lock`, checks the `instance_state` row, the setup token hash when one is set and `NOT EXISTS (SELECT 1 FROM accounts)`, then creates the account (instance admin, verified), workspace, owner membership and settings row; audit |
| `sys_create_workspace(account_id, name)` | The new workspace isn't active yet | Workspace + owner membership + settings in one transaction |
| `app_member_workspace_ids()` | Workspace switcher lists all of the account's workspaces | Account's workspace IDs, without workspaces being deleted |
| `sys_invitation_inspect(token_hash)` / `sys_invitation_accept(token_hash, account_id, seat_limit)` | Invitee isn't a member yet | Accept is row-locked, checks status/expiry/email match, counts members under a lock on the workspace row against `seat_limit` (`NULL` = unlimited; the entitlement engine supplies `seats.max`), inserts membership and team memberships and emits `member.joined`, on which extensions recount seats |
| `sys_flush_open_counts(bookmark_ids[], counts[], last_opened[])` | One batched update across workspaces; each server process flushes its in-memory buffer from an in-process timer (every 10 s and on shutdown) | Adds to `open_count`, keeps the greatest `last_opened_at`; validates array lengths |
| `sys_go_other_workspaces(slug)` | `/go` miss: which of the member's other workspaces resolve the slug | Up to 20 `{ id, name }` of workspaces the calling account (from `app_account_id()`, never an argument) belongs to and where it can access a forwarding, non-archived bookmark with that slug; runs only for results with no candidate |
| `sys_favicon_get(host)` / `sys_favicon_put(...)` | Deployment-wide cache | |
| `sys_rate_limit_take(key, capacity, refill, cost)` | Deployment-wide buckets | One `INSERT … ON CONFLICT DO UPDATE … RETURNING` with the database clock |
| `sys_retention_purge()` | Scheduled, all workspaces | §6 table; returns per-table counts for logs |
| `sys_instance_*` (`list_workspaces`, `create_workspace`, `list_accounts`, `set_admin`, `disable`, `reset_mfa`, `mark_verified`, `delete_workspace`, `delete_account`, `add_membership`, `update_settings`, `list_instance_audit`) | CE instance administration spans workspaces | Each re-checks `is_instance_admin` of `app_account_id()` **inside** the function and writes an instance audit event; `create_workspace` is the only writer of an owner invitation, `add_membership` also writes an event into the workspace's own audit log |
| `sys_delete_account(account_id)` | Touches every workspace the account is in | §7.1 |
| Cloud: system operations of the `cloud` chain | Inbound billing events and their reconciliation have no session | Defined in the `cloud` chain under the same rules as this table (Cloud doc 06); any change to billing state bumps `entitlement_version` in the same transaction |

---

## 4. The `/go` resolution query

Goal: resolve `slug` for `(workspace W, account A)` among bookmarks A can access that have forwarding on and aren't archived — in one round trip, from indexes only.

**Candidate-then-filter.** The number of bookmarks in one workspace carrying the same slug is tiny (at most one per member), so the query first fetches all candidates by `(workspace_id, slug)` from `bookmarks_slug_idx` (index-only thanks to `INCLUDE`), then filters them by access with `EXISTS` probes that each hit a narrow index:

```sql
WITH candidates AS (
  SELECT id, owner_id, url
  FROM bookmarks
  WHERE workspace_id = $W AND slug = $slug AND forwarding AND plan_archived_at IS NULL
), my_teams AS (
  SELECT team_id FROM team_members WHERE workspace_id = $W AND account_id = $A
)
SELECT c.id, c.url, c.owner_id,
       (SELECT bookmark_id FROM slug_preferences
         WHERE workspace_id = $W AND account_id = $A AND slug = $slug) AS preferred_id
FROM candidates c
WHERE c.owner_id = $A
   OR EXISTS (SELECT 1 FROM bookmark_shares s WHERE s.workspace_id = $W AND s.bookmark_id = c.id
                AND (s.target_account_id = $A OR s.target_team_id IN (SELECT team_id FROM my_teams)))
   OR EXISTS (SELECT 1 FROM folder_bookmarks fb JOIN folder_shares fs
                ON fs.workspace_id = fb.workspace_id AND fs.folder_id = fb.folder_id
              WHERE fb.workspace_id = $W AND fb.bookmark_id = c.id
                AND (fs.target_account_id = $A OR fs.target_team_id IN (SELECT team_id FROM my_teams)));
```

RLS adds `workspace_id = app_workspace_id()` to every table reference; it matches the explicit predicate, so the planner keeps the same index paths. The integration suite asserts with `EXPLAIN (FORMAT JSON)` on a seeded 50 000-bookmark workspace that the candidate scan is an `Index Only Scan` on `bookmarks_slug_idx` and that no sequential scan appears (doc 08 §4).

The same access predicate, as a reusable SQL fragment in the repository, backs `scope=shared_with_me` lists, `GET /bookmarks/{id}` for non-owners, search, and `GET /go/suggest` (where the candidate set is `slug LIKE prefix || '%'` on `bookmarks_slug_idx`, capped at 50 candidates before filtering). When the query returns no candidate, `POST /go/resolve` calls `sys_go_other_workspaces` (§3.3) so the not-found page can offer the member's other workspaces; that lookup never runs for a hit and never forwards across workspaces.

---

## 5. Migrations

### 5.1 Generation and review

- The schema lives in `packages/db/src/schema/*.ts` (Drizzle). `pnpm db:generate` runs drizzle-kit and writes `packages/db/migrations/<timestamp>_<name>.sql` plus its snapshot. Names: `add_<thing>`, `index_<thing>`, `drop_<thing>`.
- **RLS policies, grants, functions, triggers and extensions are not expressible in the Drizzle schema** as needed, so they live in `packages/db/src/sql/*.sql` — declarative, idempotent definitions (`CREATE OR REPLACE FUNCTION`, `DROP POLICY IF EXISTS … ; CREATE POLICY …`, `GRANT …`). drizzle-kit is configured to emit them as a **custom migration step** appended to the generated migration whenever those files change (`pnpm db:generate` diffs them against the last applied hash). They are reviewed exactly like generated DDL (Q51).
- A migration file is committed only as the generator's output and **never edited after it is merged to `dev`**. CI verifies: regenerating from the schema produces no new migration (no drift); every committed migration's checksum matches its recorded checksum; the custom-SQL hashes match.
- `drizzle-kit push` is never used anywhere — not locally, not in CI.

### 5.2 Expand / contract

Several server replicas run during a rolling deploy, so every migration must be compatible with the code version **before and after** it:

1. **Expand** (release N): add nullable columns, new tables, new indexes `CONCURRENTLY` (drizzle-kit's generated `CREATE INDEX` is rewritten by the generator wrapper to `CONCURRENTLY` in a non-transactional step for existing tables), new enum values. Code N writes both old and new shapes where needed.
2. **Backfill** (a pg-boss job in release N, batched, idempotent, resumable) — never inside the migration transaction for tables that can be large.
3. **Contract** (release N+1 or later, after N is fully deployed): add `NOT NULL`/constraints `NOT VALID` then `VALIDATE CONSTRAINT`, drop old columns.

CI's migration check rejects in a single migration: dropping or renaming a column or table that existed in the previous release, adding a `NOT NULL` column without default, type changes that rewrite a table, non-concurrent index creation on an existing table — unless the PR carries the `migration:contract` label and the dropped object has been unused for at least one release (Q52). `lock_timeout = '5s'` and `statement_timeout = '15min'` are set for every migration session; a migration that can't take its lock fails rather than queueing traffic behind it.

### 5.3 Applying

- `migrate` takes `pg_advisory_lock(hashtext('slugbase.migrate'))`, applies pending migrations chain by chain (§5.5), each migration in its own transaction (or non-transactional for `CONCURRENTLY` steps), records it, releases the lock. A second concurrent `migrate` waits, then finds nothing to do.
- **CE image:** the entrypoint runs `migrate` with `DATABASE_MIGRATE_URL` first (a failure exits non-zero before anything serves), then starts the server with `DATABASE_MIGRATE_URL` removed from its environment and in-process migration disabled; the worker never receives the migrator URL. Several CE replicas starting at once are safe: one migrates, the others wait on the lock.
- **In-process variant** (`MIGRATE_ON_START=true` without the entrypoint: development, bare `node` runs and the single-container mode of Q11): the server runs the same migration under the same lock before serving application routes, using `DATABASE_MIGRATE_URL`. The probes answer at once, `/ready` stays 503 and every other route returns `503 unavailable` until it finishes.
- **Managed deployments (D25):** with `MIGRATE_ON_START=false` the server never migrates; a deployment may then run the `migrate` command of the **new** image as a separate one-shot step **before** rolling out the new server and worker containers, and roll out only after it exits 0, so the migrator URL is held only by that step (D24; Cloud doc 07 §5.5).
- A server whose build expects a migration level **higher** than the database refuses readiness; one that finds the database **ahead** of it (a newer migration it doesn't know) logs a warning and keeps serving — expand/contract guarantees N−1 code works on N's schema.

### 5.4 Enums and reference data

Adding an enum value is expand-only; removing one is a contract migration after no row uses it. Reference data (plan catalog, accent palette, the folder icon allowlist) is **configuration in code**, not table rows — no data migrations for it.

### 5.5 The cross-repository chain

| Order | Chain | Bookkeeping | May reference |
|---|---|---|---|
| 1 | CE `public` | `drizzle.migrations_core` | itself |
| 2 | pg-boss | its own | — |
| 3 | Cloud `cloud` | `drizzle.migrations_cloud` | `public` |
| 4 | Cloud `console` | `drizzle.migrations_console` | `public` (views only) |

- **FK direction is one-way:** Cloud tables may reference `public` tables (e.g. a `cloud` table keyed by `workspace_id → public.workspaces ON DELETE CASCADE`); `public` never references `cloud` or `console`. Billing data has no foreign keys into SlugBase at all: it lives in the external billing service and is linked only by the workspace id (D29). CE therefore builds, migrates and runs with no knowledge of them.
- A CE contract migration that drops or changes a column Cloud references, or that Cloud's `console_mirror` views read, is a **cross-repo contract change**: the CE item names it, and the Cloud follow-up lands before the CE contract step is released (doc 09 §3).
- Cloud's `migrate` applies CE's chain from the submodule-pinned CE commit, so Cloud never runs an unreleased CE migration by accident.

---

## 6. Retention and purge

`retention.purge` runs hourly (doc 01 §8.1) through `sys_retention_purge()`, in batches of 5 000 rows per table per run.

| Data | Kept for | Then |
|---|---|---|
| `sessions` past `expires_at` or `absolute_expires_at` | 0 | Deleted |
| `oidc_login_states` | 10 min | Deleted |
| `credential_tokens` used or expired | 7 days (forensics) | Deleted |
| `workspace_invitations` not pending | 30 days | Deleted |
| `idempotency_keys` | 24 h | Deleted |
| `rate_limit_buckets` idle | 1 h | Deleted |
| `url_metadata`, `favicons`, `ai_suggestions` past `expires_at` | 0 | Deleted (refetched on demand) |
| `ai_suggestion_usage` | 90 days | Deleted |
| `audit_events` | 1 year (CE: `AUDIT_RETENTION_DAYS`, default 365; `0` = keep forever) | Deleted (Q53) |
| pg-boss completed/failed jobs | 7 / 30 days | pg-boss maintenance |
| Plan-archived bookmarks | Indefinitely while the workspace exists | Restored on re-upgrade (doc 06 §5) |
| `cloud` tables (Cloud) | As Cloud doc 06 sets | — |

---

## 7. Deletion and data subject requests

### 7.1 Account deletion (`DELETE /me`, `sys_delete_account`)

In one transaction:

1. Refused with `409 last_owner` if the account is the **only owner** of any workspace that has other members — the owner must transfer ownership or delete that workspace first; the problem body lists the blocking workspaces by id and name. Refused with `409 billing_active` on Cloud while it owns a workspace with an active paid subscription.
2. Workspaces where the account is the **only member** are deleted entirely (with all content) through the workspace deletion path (§7.2).
3. In shared workspaces: memberships are removed; the account's bookmarks and folders **stay with the workspace** with `owner_id = NULL` (shown as "Former member"; workspace admins can reassign or delete them — doc 02 §3.5); its tags, tag associations, slug preferences, AI cache, API tokens and team memberships are deleted (cascade).
4. Sessions, identities, credential tokens, backup codes, idempotency keys are deleted; the `accounts` row is deleted.
5. Audit events keep `actor_label` but lose `actor_account_id` (SET NULL); `ip_prefix` of that actor's events is nulled.

Keeping the deleted account's bookmarks and folders as ownerless workspace content is decided (Q54): the workspace's other members rely on them. Personal data about the account (name, email, sessions, tags, preferences) is erased.

### 7.2 Workspace deletion

`DELETE /workspace` (owner, re-auth) or instance-admin deletion records the request as an audit event, sets `workspaces.deleting_at` and enqueues the `workspace.delete` job; the request returns `202`. From that moment the workspace is hidden from switchers and APIs: the `workspaces` SELECT policy, `app_member_workspace_ids()`, `sys_session_lookup` and `sys_api_token_lookup` all exclude it, so no member or bound token can read its rows (Q55). Cloud refuses the request while a paid subscription is active (cancel first).

The job is idempotent and resumable: it deletes each tenant table's rows in batches in dependency order, then the workspace row, which cascades whatever is left. The order is a registry in `packages/db`, and `pnpm db:check` fails when a table with a `workspace_id` column is missing from it. `workspace.deleted` is emitted as a domain event when the row is gone.

### 7.3 Access and portability

`GET /export/json` is the member's portable copy of their own content (doc 04 §10.9). A full data-subject access response (account row, memberships, sessions, audit events about them) is produced by the operator: CE instance admin via `/instance/accounts/{id}` + export; Cloud via a console runbook (doc 07 §6).

### 7.4 Backups

Deleted data persists in backups until they age out (Cloud: 30 days of PITR, doc 07 §5). Restores replay deletions recorded since the backup from the audit stream where needed; the privacy policy states the retention (doc 11).

---

## 8. Seed and fixture data

No seed data ships in migrations. Development and tests use `packages/db/src/fixtures/` builders (doc 08): two workspaces, members of each role, shared folders and teams, overlapping slugs across owners, an archived bookmark, an ownerless (departed) bookmark — the cross-tenant matrix (doc 01 §5.5) and `/go` disambiguation run against it.
