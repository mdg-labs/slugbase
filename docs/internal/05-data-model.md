# SlugBase — Data Model

PostgreSQL is the only database (D6): 17 and 18 are supported (Q3), 18 is the version the compose file ships. The Drizzle schema in TypeScript is the single source; migrations are generated from it (D7). This document is the reviewed design that schema implements: every table, its constraints, indexes and row-level-security policy, the database roles, the few system operations that cross tenants, the migration policy and data lifecycle.

---

## 1. Conventions

| Rule | Value |
|---|---|
| Primary keys | `id uuid` holding a UUIDv7 generated in the application (Q91) — no database default, so PostgreSQL 17 and 18 behave the same and tests can inject a sequence; association tables use composite natural keys |
| Tenant column | `workspace_id uuid NOT NULL` on every tenant-owned table, first column of every composite key and of every index whose queries are workspace-scoped |
| Intra-workspace references | **Composite foreign keys** `(workspace_id, x_id) REFERENCES x (workspace_id, id)` — each referenced table has `UNIQUE (workspace_id, id)`. A row can therefore never point at a row in another workspace, even if application code passes a foreign ID (defence alongside RLS, D8) |
| Timestamps | `timestamptz NOT NULL DEFAULT now()`; `created_at`, `updated_at` on editable tables, where `updated_at` is maintained by the trigger function `public.set_updated_at()` (declared once in `packages/db/src/sql/090-updated-at-trigger.sql`), which each such table attaches as a `BEFORE UPDATE` row trigger named `<table>_set_updated_at` in `packages/db/src/sql/`; nullable `*_at` columns for state (`verified_at`, `revoked_at`, `plan_archived_at`, `deleting_at`) instead of booleans plus a timestamp |
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
| `pgboss` | pg-boss (installed and upgraded by `migrate` with the library's own plans, §5.5) | Job queue |
| `cloud` | The private Cloud repository | Cloud-only records (§2.12, Cloud doc 06) |
| `console` | The private Cloud repository (operator console) | Operator accounts, sessions, audit, daily snapshots (Cloud doc 07 §6) |
| `drizzle` | each chain | Migration bookkeeping, one table per chain: `drizzle.migrations_core`, `…_cloud`, `…_console`; and `drizzle.pgboss_pending_builds`, the record of the pg-boss index builds an upgrade still owes (§5.5; owner-only) |

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
| `accent` | text | One of the six preset names `periwinkle`, `violet`, `rose`, `amber`, `green`, `teal` (doc 03, Q36), never a free hex; NULL = the default (periwinkle) |
| `default_bookmark_view` | text NOT NULL DEFAULT `'grid'` | `grid` / `table` |
| `single_key_shortcuts` | boolean NOT NULL DEFAULT true | Single-key shortcuts on (Q38); modifier shortcuts always work. The API field is `singleKeyShortcuts` |
| `signin_alerts` | boolean NOT NULL DEFAULT true | Email the account on a password sign-in from a new device (doc 02 §12). A sign-in is from a new device when no live session of the account shares both its user-agent family and its IP prefix; never sent for the account's first session (no earlier `last_sign_in_at`) or for a `partial` session itself; an account with a second factor is alerted when the code completes the sign-in. The API field is `signinAlerts`, changed by `PATCH /me` (`slugbase_app` holds the column privilege) |
| `ai_opt_out` | boolean NOT NULL DEFAULT false | |
| `analytics_consent` | text NOT NULL DEFAULT `'unset'` | `unset` / `granted` / `denied`; `consent_at` timestamptz alongside |
| `onboarding` | jsonb NOT NULL DEFAULT `'{}'` | Checklist state; Zod-validated shape with exactly the boolean keys `browserSetupDone`, `importDone` and `checklistDismissed`, no free keys — the other checklist items are derived from data |
| `is_instance_admin` | boolean NOT NULL DEFAULT false | CE only in practice |
| `disabled_at` | timestamptz | Set by an instance admin; blocks sign-in (the generic error), deletes the account's sessions and makes its API tokens inert |
| `mfa_enabled_at` | timestamptz | NULL = MFA off (also while an enrolment is pending: a secret with this NULL) |
| `mfa_secret` | bytea | SecretBox ciphertext, bound to its row by the additional data `accounts.mfa_secret:<account id>`; both columns below are NULL exactly when it is (CHECK), and `mfa_enabled_at` needs it (CHECK) |
| `mfa_secret_key_id` | text | Key used, for rotation |
| `mfa_last_step` | bigint | Last accepted TOTP time step (replay protection); NULL until a code was accepted, and reset by a new enrolment |
| `last_sign_in_at` | timestamptz | |
| `created_at`, `updated_at` | timestamptz | |

Policy: `USING (id = app_account_id() OR id IN (SELECT account_id FROM workspace_members WHERE workspace_id = app_workspace_id()))`; `WITH CHECK (id = app_account_id())`. Co-members see the row, but the repository's co-member projection selects only `id, display_name, email` — sensitive columns are additionally protected by **column privileges**: `slugbase_app` has no `SELECT` on `password_hash`, `mfa_secret`, `mfa_secret_key_id`, `mfa_last_step`; those are read and written only through §3 functions. The policy is the own-row branch alone until the members list needs the co-member branch, and `slugbase_app` is granted `SELECT` on the other columns only, and `INSERT`, `UPDATE` and `DELETE` with the operations that need them.

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
| `active_workspace_id` | uuid → workspaces ON DELETE SET NULL | Re-derived on next request if NULL or no longer accessible (doc 01 §5.1); the tenant resolver does so per request and does not write the derived value back |
| `reauth_at` | timestamptz | Sudo mode (doc 04 §4.4) |
| `remember` | boolean NOT NULL | 30 vs 90-day sliding window |
| `created_at`, `last_seen_at`, `expires_at`, `absolute_expires_at` | timestamptz | `last_seen_at` is written at most once a minute per session |
| `ip_prefix` | cidr | The first two octets of an IPv4 address (a /16) or an IPv6 /48 — a coarse network, never a precise location; no location is derived or stored |
| `user_agent` | text | Truncated to 256 chars |
| `mfa_failures` | smallint NOT NULL DEFAULT 0 | Codes refused while the session is `partial`; the fifth deletes the session (doc 04 §4.3). CHECK ≥ 0 |

Index `(account_id)`, `(expires_at)`. The account sees its own sessions through `sys_list_sessions` (§3).

**`oidc_login_states`** — RLS: S

`state_hash bytea PK` (SHA-256 of the `state` value), `provider text`, `intent text` (`login` / `link` / `reauth` / `invite`), `nonce text`, `code_verifier bytea` (SecretBox) with `code_verifier_key_id text` (the key that sealed it), `return_to text` (validated same-origin path), `link_account_id uuid NULL` (the signed-in account for the `link` and `reauth` intents), `invitation_token_hash bytea NULL` (the invitation to accept for the `invite` intent), `expires_at timestamptz` (10 min). Deleted on use.

**`api_tokens`** — RLS: A for management, lookup is S

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `account_id` | uuid NOT NULL | |
| `workspace_id` | uuid NOT NULL | Bound workspace, chosen at creation among the account's workspaces (doc 04 §4.2) |
| — | FK `(workspace_id, account_id)` → `workspace_members` ON DELETE CASCADE | Losing membership deletes the token |
| `name` | text NOT NULL | 1–64 chars |
| `token_hash` | bytea NOT NULL UNIQUE | SHA-256 (32 bytes) of the whole token as the bearer presents it (`slb_` + 32 random bytes as 43 base64url characters); `slugbase_app` has no SELECT on the column |
| `token_prefix` | text NOT NULL | First 6 chars after `slb_`, for display and leak scanning |
| `scope` | text NOT NULL | `read` / `read-write` |
| `expires_at` | timestamptz | NULL = no expiry (Q47); the creation dialog defaults to 90 days |
| `last_used_at` | timestamptz | Written at most once a minute |
| `last_used_ip_prefix` | cidr | Same coarse prefix as sessions, written with `last_used_at` |
| `revoked_at` | timestamptz | Set by `DELETE /me/api-tokens/{id}`, keeping the first time; the row stays, so a repeated revocation is answered as the first one (doc 04 §2.4), and the token lookup treats it as inert |
| `created_at` | timestamptz | |

Unique `(account_id, name)` among the rows with `revoked_at IS NULL` (a partial unique index), so a revoked token's name can be used again; CHECKs on the name length, the hash length (32), the prefix length (6) and the scope. The per-account count (10 tokens that are neither revoked nor expired, `MAX_API_TOKENS_PER_USER`) is enforced in the service, under a lock on the account's row so two creations at once cannot both pass it. Management uses the account policy `account_id = app_account_id()` in an account-level transaction; `slugbase_app` may read every column but `token_hash`, insert and update `revoked_at` alone, and holds no DELETE (a token leaves with its membership or account, or when `sys_retention_purge()` deletes it 30 days after it was revoked or expired, §6).

**`mfa_backup_codes`** — RLS: S (enabled and forced, no policy; `slugbase_app` has no privilege on it). `id`, `account_id` → accounts CASCADE, `code_hash bytea` (the argon2id PHC string, as bytes, of the 10-char code — low entropy, so a slow hash), `used_at`. Partial index `(account_id) WHERE used_at IS NULL`.

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

Policy: `USING ((id = app_workspace_id() OR id IN (SELECT app_member_workspace_ids())) AND deleting_at IS NULL)` for `SELECT` (`workspaces_tenant`); `id = app_workspace_id()` for `UPDATE`/`DELETE` (`workspaces_tenant_update`, `_delete`), so the deletion job can finish. `app_member_workspace_ids()` is a `SECURITY DEFINER` set-returning function owned by `slugbase_system` that returns the calling account's workspace IDs (the account is `app_account_id()`, never an argument) from `workspace_members`, leaving out workspaces being deleted (avoids recursive policy evaluation). `slugbase_app` may `SELECT` the table; the operations that rename or delete a workspace grant what they need. `updated_at` is maintained by the `workspaces_set_updated_at` trigger (§1). Insert happens through `sys_create_workspace` (§3), which also inserts the owner membership atomically.

No billing columns: in Cloud, billing state lives in the `cloud` schema (§2.12, Cloud doc 06); CE has none (D18). `entitlement_version` and `bookmark_count` are generic and exist on every edition.

**`workspace_members`** — RLS: T, plus the account's own rows

| Column | Type | Notes |
|---|---|---|
| `workspace_id` | uuid NOT NULL → workspaces ON DELETE CASCADE | |
| `account_id` | uuid NOT NULL → accounts ON DELETE CASCADE | |
| `role` | `member_role` NOT NULL | `owner` / `admin` / `member` |
| `joined_at` | timestamptz | |
| `last_active_at` | timestamptz | NULL = never active. Written at most once a minute by the tenant resolver, for a session request in the workspace it resolved; shown as "last active" in the members list and orders the re-derivation of the active workspace: most recently active first (never active last), then newest `joined_at`, then `workspace_id` |

PK `(workspace_id, account_id)`; index `(account_id)`. **At least one owner** per workspace: a deferred constraint trigger checks after every delete/update that the workspace still has an owner, unless the workspace itself is being deleted (a workspace created for an owner invitation has no member until it is accepted; the trigger does not fire for it); it ships with the operations that remove or demote a member. Policies: `SELECT` `USING (workspace_id = app_workspace_id() OR account_id = app_account_id())` (`workspace_members_tenant`); `UPDATE` and `DELETE` only `USING (workspace_id = app_workspace_id())` (`workspace_members_tenant_update`, `_delete`), so writes happen only in the active workspace, and there is no `INSERT` policy: a membership is added by a system operation. `slugbase_app` may `SELECT` the table and `UPDATE (last_active_at)`; the membership changes grant what they need.

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

**`instance_state`** — RLS: — (no personal data). Single row (`id smallint PK CHECK (id = 1)`): `setup_completed_at timestamptz`, `setup_by uuid`, `setup_token_hash bytea` (SHA-256 of the setup token the server generates at each start while no account exists and prints to its log; a start replaces the hash, so only the latest token works; the token itself is never stored). Written only by `sys_setup_token_set` and `sys_complete_setup`.

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

**`rate_limit_buckets`** — `UNLOGGED` (defined in `packages/db/src/sql/`, because the Drizzle schema cannot express it), RLS: S. `key text PK` (bucket + IP/principal hash), `tokens real`, `updated_at timestamptz`. Lost on crash or failover by design — limits reset, nothing else breaks (doc 10 §5).

**`pgboss.*`** — owned by pg-boss. Job payloads carry IDs, never secrets or full documents; the worker re-reads current state. The one exception is the "new sign-in" `mail.send` job, which also carries the time of the sign-in, the browser family and the coarse network prefix (none is a secret; never a full address, a user agent or a token): the alert was decided while the account's switch was on, so it is sent whatever becomes of the session or the switch before the worker runs or between attempts.

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
| `slugbase_owner` | No | Every object in `public` (and `cloud`, `console` in Cloud) | Everything; never used by a running process. A member of `slugbase_system` (`INHERIT`, `SET`), so a migration can hand a function to it |
| `slugbase_migrator` | Yes | — (member of `slugbase_owner`) | DDL; used only by `migrate` (the image entrypoint runs it before the server starts, §5.3). A managed deployment that runs `migrate` as a separate deploy step uses it only there, so its URL never reaches the running containers (Cloud: D25, Cloud doc 07 §5.5) |
| `slugbase_app` | Yes | Nothing | `SELECT/INSERT/UPDATE/DELETE` on tenant tables (minus the column and table exclusions below), `USAGE` on `pgboss`, `EXECUTE` on §3.3 functions; **`NOBYPASSRLS`**, no `TRUNCATE`, no DDL, no `REFERENCES`, `CREATE` revoked on every schema |
| `slugbase_system` | No | The §3.3 functions | `BYPASSRLS`; exists only as the owner of `SECURITY DEFINER` functions, so cross-tenant access happens only inside their reviewed bodies |
| `slugbase_console_ro` (Cloud) | Yes | — | `SELECT` on the `console_mirror` views only (allowlisted columns: IDs, counts, timestamps, plan state; no emails beyond what the console PRD allows, no URLs, no titles) — Cloud doc 07 §6 |

`slugbase_owner` is a member of `slugbase_system` (`WITH INHERIT TRUE, SET TRUE`): a migration creates a §3.3 function as the owner and runs `ALTER FUNCTION … OWNER TO slugbase_system`, granting `CREATE` on the schema to `slugbase_system` only for the length of that statement block. `slugbase_system` holds no privilege the owner lacks, and `BYPASSRLS` is a role attribute that membership does not pass on, so the owner does not bypass row-level security. An existing install and a managed provisioning need the same grant. Server and worker both connect as `slugbase_app` (worker pool distinct, same role). In CE, the compose file provisions `slugbase_app` and `slugbase_migrator` through a Postgres init script (`packages/db/provision/roles.sql`, idempotent, passwords supplied as variables) and passes two URLs (`DATABASE_URL`, `DATABASE_MIGRATE_URL`). With only `DATABASE_URL` set and that role owning the database, the server refuses to start in production; `SLUGBASE_ALLOW_OWNER_CONNECTION=true` overrides it, with a warning (Q56).

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

The complete list of operations that cross the tenant or account boundary. Each is a `SECURITY DEFINER` function owned by `slugbase_system` with `SET search_path = pg_catalog, public, pg_temp` (`pg_temp` last, so the session's temporary schema, which PostgreSQL otherwise searches first for table and type names, cannot shadow an unqualified name), a narrow signature, no dynamic SQL, `EXECUTE` revoked from `PUBLIC` and granted to `slugbase_app`, and an audit or log line where noted. Every function is listed in the reviewed registry `packages/db/src/system/registry.ts`; `pnpm db:check` fails for a `SECURITY DEFINER` function that is not registered and for a registry entry without a function. Adding one is a risk-flagged change (doc 10). A migration creates the function as `slugbase_owner` and hands it to `slugbase_system` as §3.1 describes.

| Function | Why it must cross the boundary | Returns / does |
|---|---|---|
| `sys_session_lookup(token_hash)` | Runs before any account is known | Session + account principal (session id, account id, level, active workspace as stored, `reauth_at`, instance-admin flag) — one round trip per request. The membership role is not part of it: the tenant resolver reads the account's memberships under row-level security, once per request (doc 01 §5.2). A row comes back only for a session that is not past its sliding or absolute expiry, whose account is not disabled and which was not created before the account's `password_changed_at`; a deleted session is gone, so revocation holds on the next request. A full session last seen more than a minute ago has `last_seen_at` and its sliding expiry (30 days, 90 with `remember`, never past `absolute_expires_at`) moved forward in the same call, so there is no separate touch function. A workspace being deleted is inaccessible: the memberships the resolver reads leave it out |
| `sys_session_create(id, account_id, level, remember, ip_prefix, ua, token_hash, replaced_token_hash)` / `sys_session_rotate(id, account_id, new_token_hash)` / `sys_session_revoke(id, account_id)` / `sys_session_revoke_all(account_id, except_id)` / `sys_list_sessions(account_id, after_id, max_rows)` | Sessions are not readable by the app role | `create` takes the id the application generated (Q91) and, in one call, inserts a session of the level given (`full`, or `partial` with the 5-minute sliding and absolute expiry of doc 02 §2.3, which a lookup does not extend), deletes the session of `replaced_token_hash` when given (the cookie the sign-in request carried, whichever account it belonged to), sets the account's `last_sign_in_at` for a `full` session and answers `false`, changing nothing, for an unknown or disabled account and for a level that does not fit the account's second factor (`partial` only for an account whose MFA is on, `full` only for one whose MFA is off, doc 10 T17); the expiries are set from the database clock; `revoke` deletes one session of the account named and says whether it existed; `revoke_all` deletes every session of the account except `except_id` (all of them when it is null), whatever their level or expiry, and answers how many; `list` returns one page of the account's sessions that are valid now (full, within both expiries, not created before `password_changed_at`, the account not disabled): id, created and last-seen time, coarse IP prefix and user agent, never the token hash; ordered by identifier descending (UUIDv7, so newest first), resuming after `after_id` for at most `max_rows` rows. Every call names the account, so another account's session is neither listed nor deleted. `rotate` gives one full session of the account a new token hash and counts the session as created now, so that a `password_changed_at` set earlier in the same transaction does not invalidate it, and says whether the account had such a session (a partial session is left as it is) |
| `sys_signin_alert_context(account_id, ip_prefix)` | Sessions are not readable by the app role | Asked by a password sign-in before its session is made full (at the password step for an account without a second factor, at the code step for one with it): for a live account it answers one row, `signin_alerts`, whether the account has signed in before (`last_sign_in_at` is set, which a full session's creation or a second-factor completion does) and the user agent of every live session of the account (the same conditions as `list`) whose stored prefix equals `ip_prefix` (null equals null), each once, an empty string for a session without one; no row for an unknown or disabled account. The user-agent families are compared by the application |
| `sys_login_lookup(email)` | Login knows only an email | `account_id, password_hash, disabled_at` (the second-factor state joins with the MFA columns); the email is compared case-insensitively and the caller passes it trimmed and NFKC-normalised; constant-time behaviour for unknown emails is the caller's job (dummy hash verify) |
| `sys_mfa_get_secret(account_id)` / `sys_mfa_set(account_id, action, secret, key_id, expected_secret)` / `sys_mfa_accept_step(account_id, step)` / `sys_backup_codes_replace(account_id, ids, hashes)` / `sys_backup_code_consume(account_id, code_id)` | MFA material is column-protected and `mfa_backup_codes` has no app access | `get_secret` returns the sealed secret, its key id, `enabled_at` and `last_step` of an account that exists, is not disabled and has a secret (pending or active); no row otherwise. `set` is the one writer of the secret and of `mfa_enabled_at`: `start` stores a pending secret (replacing an earlier one, resetting `mfa_last_step`) and refuses an account whose MFA is on; `reseal` stores the same secret under another key only while the stored ciphertext is still `expected_secret`; `activate` sets `mfa_enabled_at` only while MFA is off, the stored ciphertext is `expected_secret` and a step was accepted for it. `sys_mfa_accept_step` atomically rejects a step ≤ `mfa_last_step`, so one code is accepted once. `sys_backup_codes_replace` gives an account whose MFA is on exactly the given set of 1 to 20 codes (application-generated UUIDv7 ids and argon2id hashes), deleting the old set in the same call; `sys_backup_code_consume` marks one unused code of the account as used and says whether it did, so a code presented twice at once is accepted once. Enrolment confirmation runs `accept_step`, `set(activate)`, `backup_codes_replace` and `sys_session_rotate` in one transaction; a failure at any step leaves the pending enrolment, no codes and the old token. The second-factor sign-in adds three: `sys_backup_codes_unused(account_id)` lists the id and argon2id hash of each unused code of an account whose MFA is on (the database cannot verify a salted hash, so the application verifies the typed code against each and consumes the matching one by id); `sys_session_promote(id, account_id, new_token_hash)` turns one live, unexpired `partial` session of an account whose MFA is on into a `full` one under the new token (created now, the sliding window of its `remember` flag, the 180-day cap from now, `mfa_failures` cleared, `last_sign_in_at` set) and answers whether it did; `sys_session_mfa_failure(id, account_id)` counts one refused code against a `partial` session, deletes it at the fifth and answers whether the session is over. The sign-in runs `sys_mfa_accept_step` (a TOTP code) or `sys_backup_code_consume` (a backup code) and then `sys_session_promote` in one transaction, so a failure at either leaves the code unused and the session partial. Managing the factor adds two: `sys_mfa_lock(account_id)` takes the row locks a change of the whole second factor needs, in the one order every writer of these rows uses (the account's backup-code rows by id, then the account row, then the session row) and answers false for an account that does not exist, is disabled or has MFA off; `sys_mfa_disable(account_id)` clears `mfa_secret`, `mfa_secret_key_id`, `mfa_enabled_at` and `mfa_last_step` and deletes every backup code of the account, used ones included, and answers false, changing nothing, when MFA was not on. Regenerating the backup codes runs `sys_mfa_lock`, `sys_mfa_accept_step` and `sys_backup_codes_replace` in one transaction; turning MFA off runs `sys_mfa_lock`, then `sys_mfa_accept_step` or `sys_backup_code_consume`, then `sys_mfa_disable` and `sys_session_rotate`; re-authenticating with a code runs `sys_mfa_accept_step` and `sys_session_reauth`. A sign-in with a backup code locks its code row and then the account row, so the management paths lock the code rows before the account row: taking the account row first (as `sys_mfa_accept_step` does) would let the two wait for each other. A failure at any step of any of them leaves the old codes, the factor on, the old token and the step unspent |
| `sys_account_password_hash(account_id)` | The password hash is column-protected and the application verifies it | The argon2id hash of an account that exists, is not disabled and has a password; NULL for every other case, which callers treat alike |
| `sys_session_reauth(id, account_id)` | `sessions` is not readable by the app role | Sets `reauth_at` of one full session of the account to the database clock's now and says whether there was one (doc 04 section 4.4) |
| `sys_password_set(account_id, hash)` | Column-protected | Stores a hash that has the shape of an argon2id PHC string (the `$argon2id$` prefix, an optional version field, the `m`, `t` and `p` parameters, and a non-empty base64 salt and hash; any other string, one with leading or trailing whitespace included, is refused) and sets `password_changed_at` to now (invalidates the account's sessions created before it); false, changing nothing, for an unknown or disabled account. It does not check the lengths of the salt or hash or that the hash decodes: the application's hasher is the only writer. The password change runs it, `sys_session_rotate` and `sys_session_revoke_all(account_id, current session)` in one transaction, in that order: the account row is locked first, so two changes made at once queue instead of deadlocking, and a failure at any step leaves the old password, the old sessions and the old token |
| `sys_api_token_lookup(token_hash, ip_prefix)` | Runs before any account is known; `slugbase_app` has no SELECT on `token_hash` | Token principal (token id, account id, bound workspace id, scope) in one round trip, one row at most: a row comes back only for a token that is not revoked and not expired, whose account is not disabled and whose workspace is not being deleted, and a token whose membership ended is already gone (the composite foreign key), so an unknown, revoked, expired, disabled-account and membership-less token are one answer and cause no write. The role is not part of it: the tenant resolver reads the account's membership in the bound workspace for each request (doc 01 §5.2). A token last used more than a minute ago has `last_used_at` (database clock) and `last_used_ip_prefix` (`ip_prefix`, the coarse prefix of the request, null when unknown) written in the same call, conditioned on the same interval in the update, so a concurrent request finds the time fresh and does not write it again; `slugbase_app` cannot write either column |
| `sys_credential_token_issue(id, purpose, account_id, hash, target_email, ttl_seconds)` / `sys_credential_token_consume(purpose, hash)` | `credential_tokens` has no app access, and a token is redeemed anonymously by possession of the link | `issue` takes the id the application generated (Q91) and the SHA-256 of the token, locks the account's row, deletes the account's older unused tokens of the purpose and stores the new one with an expiry `ttl_seconds` (1 second to 7 days) after now on the database clock, so two issues made at once leave one unused token; it answers false, changing nothing, for an unknown or disabled account. Consume is single-use (`UPDATE … SET used_at … WHERE purpose = … AND token_hash = … AND used_at IS NULL AND expires_at > now() RETURNING account_id, target_email`): no row comes back for an unknown, used, expired or other-purpose token, which a caller does not tell apart |
| `sys_oidc_state_create(state_hash, provider, intent, nonce, code_verifier, key_id, return_to, link_account_id)` / `sys_oidc_state_consume(state_hash, provider)` / `sys_identity_sign_in(provider, subject, session_id, ip_prefix, ua, token_hash, replaced_token_hash)` | OIDC callback is anonymous, and `oidc_login_states` has no app access | `create` stores the handshake for 10 minutes on the database clock (the intents `login`, `link` and `reauth`; `invite` arrives with its operation) and refuses a return path that is not relative; `consume` deletes the record and returns it in one statement, so a state is answered once, and returns nothing for an unknown, expired, already consumed or other-provider state. `sys_identity_sign_in` finds the account an identity is linked to and, in one call, inserts a `full` session (30-day sliding window, 180-day cap), deletes the session of `replaced_token_hash` when given, and sets the account's `last_sign_in_at` and the identity's `last_used_at`; it answers `false`, changing nothing, for an identity nobody linked and for a disabled account. The session is `full` whether or not the account's MFA is on: a successful OIDC sign-in never asks for SlugBase TOTP (doc 02 §2.3), the one case where a `full` session is created for an account with MFA on |
| `sys_identity_link(account_id, id, provider, subject, email)` / `sys_identity_unlink(account_id, id)` / `sys_identity_reauth(session_id, account_id, provider, subject)` / `sys_password_set_initial(account_id, hash)` | `account_identities` has no app write privilege, `sessions` is not readable by the app role, and the password hash is column-protected | `link` adds the identity the provider asserted to the account under the id the application generated (Q91), after locking the account's row; it answers `linked`, `already_linked` (the account holds it; nothing changes), `taken` (another account holds it; nothing moves) or `no_account` (unknown or disabled), and stores the asserted address cut at 320 characters. `unlink` locks the account's row, deletes the account's identity with that id and answers `unlinked`; `not_found` for an id the account does not hold, another account's included (a caller does not tell them apart); `last_sign_in_method`, changing nothing, when the account has no password and no other identity, the check made under the lock so two unlinks made at once cannot both pass. `reauth` sets `reauth_at` of the account's full session to the database clock's now and the identity's `last_used_at`, and answers `false`, changing nothing, unless the account holds the (provider, subject) the provider asserted, is not disabled and has that full session. `sys_password_set_initial` stores the first password of an account that has none by locking the account's row and calling `sys_password_set`; it answers `false`, changing nothing, for an unknown or disabled account and for one that has a password. Setting a first password runs it, `sys_session_rotate` and `sys_session_revoke_all(account_id, current session)` in one transaction, like the password change |
| `sys_create_account(id, email, display_name, password_hash, locale, email_verified)` | Registration, setup, invitation accept are anonymous | Inserts the account under the id the application generated (Q91); never an instance admin. A unique violation (the email, case-insensitively, or the id) inserts nothing and answers `false`, so the caller responds generically |
| `sys_setup_status()` / `sys_setup_token_set(token_hash)` / `sys_complete_setup(...)` | `instance_state` has no app access; first run happens exactly once | Status reports whether setup is pending: no account exists and `instance_state` records no completed setup (so an instance whose accounts were all deleted stays closed). `sys_setup_token_set` replaces the stored token hash at each server start while setup is pending, in one statement, so the previous token stops working with no instant without a valid one, and answers whether it stored it; of several servers starting together the last to store wins, and the others' tokens are invalid. `sys_complete_setup` takes `pg_advisory_xact_lock`, then answers `setup_completed` when setup is no longer pending and `forbidden` when the deployment requires a setup token (a flag the caller passes from `SETUP_TOKEN_REQUIRED`) and the presented hash is not the stored one, writing nothing in either case; otherwise it creates the verified account with `is_instance_admin`, its workspace with the owner membership and the settings row (through `sys_create_account` and `sys_create_workspace`), records `setup_completed_at` and `setup_by`, clears the token hash and creates the full session with the new workspace active, all in the one call; audit arrives with the instance audit stream |
| `sys_create_workspace(account_id, workspace_id, name)` | The new workspace isn't active yet | Workspace + owner membership + settings in one transaction; the application generates the workspace id (Q91) and names the account it authenticated; answers `false`, changing nothing, for an unknown or disabled account |
| `sys_email_verify(token_hash, password_hash, session_id, session_token_hash, ip_prefix, user_agent, replaced_token_hash)` | A signup verification token is redeemed anonymously, and the redemption changes `accounts` and `sessions`, which `slugbase_app` cannot write | Consumes the `email_verify` token through `sys_credential_token_consume` (no row for an unknown, used, expired or foreign token, nor for a disabled account), locks the account's row, and, when the address was never verified, stores the new password hash (`sys_password_set`), deletes every session of the account (`sys_session_revoke_all`), clears the second factor (secret, key id, enabled time and last step, pending or not) and deletes its backup codes, the account's API tokens, linked identities and pending link handshakes, and sets `email_verified_at`; an account that is already verified keeps its password, sessions, second factor, tokens and identities. It then creates the session (`partial` for an account whose second factor is on, `full` otherwise; the session of the token the request carried is deleted) and answers the account and the level. All in the one call, so a failure leaves the token unused |
| `sys_create_personal_workspace(account_id, workspace_id, name_suffix)` | A registered account's first workspace is created before any is active | Locks the account's row, answers `exists` without writing when the account already owns a workspace, otherwise calls `sys_create_workspace` with `<display name><suffix>`, the display name cut so the name fits 64 characters, and answers `created`; `unavailable` for an unknown or disabled account. The application calls it in the transaction that verifies the address or, when verification is not required, registers the account |
| `app_member_workspace_ids()` | Workspace switcher lists all of the account's workspaces; the `workspaces` policy reads it | The calling account's (`app_account_id()`) workspace IDs, without workspaces being deleted |
| `sys_account_has_password()` | `slugbase_app` cannot read `accounts.password_hash` | Whether the calling account (`app_account_id()`, never an argument) has a password, for the profile (`GET /me`); NULL when no account is set |
| `sys_account_mfa_enabled()` | `slugbase_app` cannot read `accounts.mfa_enabled_at` | Whether the calling account (`app_account_id()`, never an argument) has `mfa_enabled_at` set, for the profile (`GET /me`, `account.mfaEnabled`); false while an enrolment is only pending; NULL when no account is set; returns no secret, key id or step |
| `sys_invitation_inspect(token_hash)` / `sys_invitation_accept(token_hash, account_id, seat_limit)` | Invitee isn't a member yet | Accept is row-locked, checks status/expiry/email match, counts members under a lock on the workspace row against `seat_limit` (`NULL` = unlimited; the entitlement engine supplies `seats.max`), inserts membership and team memberships and emits `member.joined`, on which extensions recount seats |
| `sys_flush_open_counts(bookmark_ids[], counts[], last_opened[])` | One batched update across workspaces; each server process flushes its in-memory buffer from an in-process timer (every 10 s and on shutdown) | Adds to `open_count`, keeps the greatest `last_opened_at`; validates array lengths |
| `sys_go_other_workspaces(slug)` | `/go` miss: which of the member's other workspaces resolve the slug | Up to 20 `{ id, name }` of workspaces the calling account (from `app_account_id()`, never an argument) belongs to and where it can access a forwarding, non-archived bookmark with that slug; runs only for results with no candidate |
| `sys_favicon_get(host)` / `sys_favicon_put(...)` | Deployment-wide cache | |
| `sys_rate_limit_take(key, capacity, refill, cost)` | Deployment-wide buckets | One `INSERT … ON CONFLICT DO UPDATE … RETURNING` with the database clock |
| `sys_retention_purge()` | Scheduled, all workspaces | §6 table, one statement per table, each epic adding the rule of the tables it creates; takes no argument, deletes at most 5 000 rows per table per call (rows another statement holds are skipped for the next call) and returns one `(table_name, deleted)` row per table for the job to log, counts only. It covers `sessions`, `api_tokens`, `oidc_login_states` and `credential_tokens` so far |
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

RLS adds `workspace_id = app_workspace_id()` to every table reference; it matches the explicit predicate, so the planner keeps the same index paths **for a predicate whose operator is leakproof**. In the plans measured for this query on PostgreSQL 17.11 and 18.6, a condition of the query on a table with a policy is an index condition only when its operator is leakproof; otherwise it is a filter over everything the index returns for the workspace. `texteq` and `uuid_eq` are leakproof, `citext_eq` is not (`pg_proc.proleakproof`, read on 18.6). Measured on a seeded 50 000-bookmark workspace (`pnpm perf:go`, doc 12 §5; 18.6, one request at a time through PgBouncer): with `slug citext` the plan is still an `Index Only Scan` on `bookmarks_slug_idx` with no sequential scan, but its index condition is only `workspace_id` and 45 255 index entries are removed by the slug filter. That filter takes about 9.6 ms of execution at p50 (against 0.05 ms with the slug in the index condition) and grows with the workspace (0.94 ms at 5 000 bookmarks, 3.7 ms at 20 000). The plan's estimated cost, 1.9 to 2.6 million, is also far above PostgreSQL's `jit_above_cost` (100 000), so with the default `jit = on` every request is JIT-compiled: execution p50 152 ms, of which 142 ms is compilation, and a client-observed p95 of 181 ms (14.9 ms with `jit = off`; 2.5 ms with RLS off). With `slug text` the slug is in the index condition, the plan costs about 45, nothing is compiled, and the p95 is 2.5 ms with `jit` on or off. The column the candidate lookup compares therefore needs a leakproof equality, which `slug citext` in §2.4 and §2.6 does not have; the amendment to `text` (lower-case by the grammar and by the application) is a follow-up item (#373, doc 12 §5). Setting `jit = off` for the application role removes the compilation and not the filter.

The integration suite asserts with `EXPLAIN (FORMAT JSON)` on a seeded 50 000-bookmark workspace that the candidate scan is an `Index Only Scan` on `bookmarks_slug_idx` **whose index condition contains `slug`** (not only `workspace_id`), and that no sequential scan appears (doc 08 §4). An `Index Only Scan` alone proves nothing: the slow plan above is one. The guard against sequential scans stays for the share, folder and team tables too, and it depends on the fixture. In the spike's fixture the planner read `bookmark_shares` sequentially for a slug with dozens of candidates, and the scan read the whole table (283 rows kept, 6 716 removed by its filter; 0.6 ms): the table held 6 999 rows across 2 000 workspaces, 5 000 of them (71 %) in the one large workspace. That scan is cheap only because one workspace dominates the table, and on a table of many workspaces it is a read of every tenant's rows, which is what the guard exists to catch. The suite's fixture therefore has to spread the share, folder and team rows over many workspaces so that no workspace dominates them; whether the planner then keeps the index paths on those tables was not measured, because the spike's fixture is dominated by the large workspace by design.

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

1. **Expand** (release N): add nullable columns, new tables, new indexes `CONCURRENTLY` (drizzle-kit's generated `CREATE INDEX` is rewritten by the generator wrapper to `CONCURRENTLY` for existing tables, each build in a non-transactional migration of its own), new enum values. Code N writes both old and new shapes where needed.
2. **Backfill** (a pg-boss job in release N, batched, idempotent, resumable) — never inside the migration transaction for tables that can be large.
3. **Contract** (release N+1 or later, after N is fully deployed): add `NOT NULL`/constraints `NOT VALID` then `VALIDATE CONSTRAINT`, drop old columns.

CI's migration check rejects in a single migration: dropping or renaming a column or table that existed in the previous release, adding a `NOT NULL` column without default, adding a column that rewrites an existing table under an `ACCESS EXCLUSIVE` lock (a serial type, an identity column, or a generated column not marked `VIRTUAL`, since PostgreSQL 17 has stored ones only; a nullable column or one with a constant or stable `DEFAULT`, such as `now()`, does not rewrite, unless its type is a domain with a `CHECK` or `NOT NULL` constraint, which validates every existing row and which the check also rejects: it reads the domains from every `CREATE DOMAIN` of the migration chain, accepts built-in and array types, enums and domains without constraints, and rejects a type name it cannot show to be one of those; it also rejects a column of a domain whose default, from `CREATE DOMAIN … DEFAULT` or a later `ALTER DOMAIN … SET DEFAULT`, is not a constant or a call it accepts as stable, such as `random()`, because every existing row then takes its own value and the table is rewritten, unless the column states a default of its own; a domain with a constant default, one whose default was dropped, and an array of the domain are accepted, and a domain over a domain takes its base's default when it is created), adding `NOT NULL` to a column of an existing table (`SET NOT NULL` or a `NOT NULL` table constraint), dropping the default of one (`DROP DEFAULT` or `SET DEFAULT NULL`), type changes that rewrite a table, non-concurrent index creation on an existing table (which includes adding a `PRIMARY KEY`, `UNIQUE` or `EXCLUDE` constraint, also as the inline constraint of an added column, and attaching an existing index as the primary key with `PRIMARY KEY USING INDEX`; only `UNIQUE USING INDEX` attaches an index without being rejected), adding a `CHECK` or `FOREIGN KEY` constraint to an existing table without `NOT VALID` (including an inline `CHECK` on an added column and an inline `REFERENCES` on an added column that has a default) — unless the file is the marked contract half of an expand/contract pair (below) and the dropped object has been unused for at least one release (Q52). The statements that add a system operation (§3.3) are accepted in an unmarked migration, and nothing broader: `CREATE FUNCTION` in any language, with or without `SECURITY DEFINER`, and `CREATE OR REPLACE FUNCTION` of a function the migration chain declares with the same argument types and return type, or of one the chain does not declare (provided the check read every earlier statement), whose body is a string that is not analysed as migration statements; `ALTER FUNCTION … OWNER TO slugbase_system` and `REVOKE ALL ON FUNCTION … FROM PUBLIC` for a function the same file creates; `GRANT EXECUTE ON FUNCTION … TO slugbase_app`; and `GRANT CREATE ON SCHEMA … TO slugbase_system` with the `REVOKE CREATE ON SCHEMA … FROM slugbase_system` that takes it back in the same file, with only `CREATE FUNCTION` and `ALTER FUNCTION … OWNER TO` statements between the two. It rejects, unless the file is the marked contract half of a pair, a replacement that changes a function's return type or that it cannot show is a new function, `DROP FUNCTION`, any other owner or action of `ALTER FUNCTION`, a schema `CREATE` grant to another role or one the file does not revoke, a statement other than those two between the grant and the revoke, and `GRANT EXECUTE` to `PUBLIC` or to any role other than `slugbase_app`; a function named like a built-in the check lets a migration call is not accepted, and the tenant context functions stay one `LANGUAGE sql` `SELECT` of built-ins. Because a function body runs when a statement calls the function, which a default, a policy or an index expression can do, also without a parenthesis (`(t).f` is `f(t)` for a row type `t`), the check rejects any statement outside those function statements and the trigger form below that mentions the name of a function the chain declares (as a word or a quoted identifier, compared on the text as written, as PostgreSQL compares names: only the letters A to Z folded to lower case, with no Unicode case mapping, a quoted name read as the unquoted one, and both cut to 63 bytes at a character boundary; qualified or not; a column named like it is rejected too). It does not read a `CREATE FUNCTION` whose name, quoted or not, has a character outside printable ASCII (so every function name the check holds is ASCII), nor one named with more than 63 bytes, which PostgreSQL stores under a shorter name, nor one that can be called with a single argument of a type that is not a built-in (a first input argument of such a type whose later input arguments all have a default, or a `VARIADIC` one), since field-selection notation can call it. The one trigger form it reads is `CREATE [OR REPLACE] TRIGGER <name> BEFORE UPDATE ON <table> FOR EACH ROW EXECUTE FUNCTION <function>()`, with no column list, `WHEN` condition, argument, other timing or event, and no constraint or event trigger; it is accepted only when the function is one an earlier statement of the chain declares without arguments as `RETURNS trigger`, because a trigger function runs on a row write, which a migration does not make, and not when the trigger is created. It also rejects every data-changing statement, `INSERT` (also `INSERT … SELECT`), `UPDATE`, `DELETE`, `TRUNCATE`, `MERGE` and `COPY … FROM`, whether it stands alone or sits in a CTE or in the query of a `CREATE TABLE … AS`; the label never licenses one, and none is allowed on a table the migration creates, because migrations stay schema-only and a backfill is a worker job (step 2, D25). `lock_timeout = '5s'` and `statement_timeout = '15min'` are set for every migration session; a migration that can't take its lock fails rather than queueing traffic behind it. A non-transactional `CONCURRENTLY` step runs with `lock_timeout` off and `statement_timeout` as its bound: its lock queues no application traffic, and the build waits for transactions that could write to its table (holding a lock that conflicts with its SHARE lock, such as an uncommitted INSERT, UPDATE or DELETE) and, after its second scan, for every transaction in the same database whose snapshot predates that scan, whatever table it reads. `migrate` sets `client_connection_check_interval` (1 s), which needs a PostgreSQL server that supports it (a server on Windows rejects it, and `migrate` then fails while setting up its session, before it takes the lock or applies anything). A build whose client closes its connection, a killed `migrate` or a stopped container, is then cancelled by PostgreSQL instead of finishing unrecorded. A client host that vanishes without closing its connection (power loss, a network partition) sends the server no FIN or RST, so `migrate` also sets `tcp_keepalives_idle` (60 s), `tcp_keepalives_interval` (10 s) and `tcp_keepalives_count` (6) for its session: the server then reports such a connection closed after about two minutes, a small fraction of `statement_timeout`, and the connection check cancels the build. These settings apply to a TCP connection; over a Unix-domain socket the peer is on the same host and cannot vanish alone. Because each build is its own migration, a failed build (the `statement_timeout`, a duplicate in a unique index, a cancelled client) leaves at most its own INVALID index and no record; the next run drops that index and rebuilds it, with no manual step. A valid index of the same name is never dropped. One window remains, which can leave a valid index with no record, which the operator drops: a crash between the end of a build and the insert of its bookkeeping row (milliseconds).

**Writing and landing a contract migration.** A step the check rejects is accepted only with both of:

- **A contract header** in the leading comment block of the migration file, exactly one line: `-- slugbase:contract expand=<migration tag> release=<version>`. `<migration tag>` is a migration of the journal (for example `20260301000000_add_name`), and `<version>` is a release tag of this repository, written `MAJOR.MINOR.PATCH` with an optional pre-release suffix and an optional leading `v` (`1.2.0`, `v1.2.0`, `1.2.0-rc.1`). The named release must already contain the expand migration, so the expand step has shipped in a release before the one that carries the contract file (Q52). No header, a second header, a malformed one, an unknown migration or release, or an expand migration the release does not contain is rejected.
- **The contract marker**, the variable `SLUGBASE_DB_CHECK_CONTRACT` in the environment of `pnpm db:check`. It takes `true`, `false` or `pending`, and any other value (the empty string included) makes the command exit 2 without checking anything. CI sets it per event: for a pull request, `true` when the pull request carries the maintainer-applied `migration:contract` label and `false` when it does not; for a push, `pending`. It is a flag of the check and not a product environment variable (D24). The workflow runs again when the label is added or removed (`labeled` and `unlabeled` are among the `pull_request` types), so a label applied after the last push takes effect at once.

`pnpm db:generate` writes the header, so the checksum recorded by `pnpm db:record-checksums` covers it from the start and the file is never edited after generation (§5.1): `pnpm db:generate --name drop_<thing> --contract expand=<migration tag> release=<version>`. The generator refuses a malformed value, an expand migration that is not in the journal, and a run that writes no file able to hold a contract step (an index build alone), and in each case writes nothing. Whether the release exists and contains the expand migration is read from git by `pnpm db:check`, which also needs the release tags: it fails in a shallow clone, where the history and tags are not there, so CI checks out the full history and every tag, and a local clone runs `git fetch --unshallow --tags` first. A repository with no release tag has nothing to compare with, and every object then counts as unreleased.

A contract migration lands on `dev` by cherry-pick, which has no pull request and so no label. On a push the marker is `pending`: a destructive step with a valid header is printed as `AWAIT` ("awaiting the `migration:contract` label") and does not fail the run, while the same step with no header or an invalid one fails exactly as it does on a pull request. The summary line of an `AWAIT` run does not report the rule as passed. The gate is the promotion pull request from `dev` to `main`: its run carries the label decision, so a marked step passes only if the maintainer labelled that pull request `migration:contract`, and an unlabelled one fails and blocks `main`. While a marked contract migration awaits its label (on `dev`, before a release tag contains it), a local `pnpm gate` or `pnpm db:check` is run with `SLUGBASE_DB_CHECK_CONTRACT=pending`, which reports the step as awaiting rather than passing it, the same state CI uses on a push; with the variable unset the check fails closed. The variable reaches `db:check` through `pnpm gate` (the `db:check` task passes it through in `turbo.json`). A data-changing statement and a `lock_timeout` or `statement_timeout` setting are rejected on every event, with or without header, marker or label.

### 5.3 Applying

- `migrate` takes the advisory lock `hashtext('slugbase.migrate')` by polling `pg_try_advisory_lock`, so a waiting `migrate` holds no snapshot that a concurrent index build would wait on. It applies pending migrations chain by chain (§5.5), each migration in its own transaction (or non-transactional for `CONCURRENTLY` steps), records it, releases the lock. A second concurrent `migrate` waits, then finds nothing to do.
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
| 2 | pg-boss | its own version table; `drizzle.pgboss_pending_builds` while an upgrade's index builds are still owed (owner-only, no grant to `slugbase_app`) | — |
| 3 | Cloud `cloud` | `drizzle.migrations_cloud` | `public` |
| 4 | Cloud `console` | `drizzle.migrations_console` | `public` (views only) |

- **FK direction is one-way:** Cloud tables may reference `public` tables (e.g. a `cloud` table keyed by `workspace_id → public.workspaces ON DELETE CASCADE`); `public` never references `cloud` or `console`. Billing data has no foreign keys into SlugBase at all: it lives in the external billing service and is linked only by the workspace id (D29). CE therefore builds, migrates and runs with no knowledge of them.
- A CE contract migration that drops or changes a column Cloud references, or that Cloud's `console_mirror` views read, is a **cross-repo contract change**: the CE item names it, and the Cloud follow-up lands before the CE contract step is released (doc 09 §3).
- **The pg-boss chain** is run by `migrate` as `slugbase_owner`, under the `migrate` advisory lock: it installs the schema when the database has none, upgrades an older one to the version this build runs with pg-boss's own migration plan, and refuses a newer one (or one older than pg-boss can upgrade from). The plan's transaction runs as one statement; the concurrent index builds it appends run one at a time outside a transaction, with `lock_timeout` off and `statement_timeout` as their bound (§5.2). pg-boss stamps the new version before those builds, so they are first recorded in `drizzle.pgboss_pending_builds`, which `slugbase_app` has no grant on; a later `migrate` run under the lock finishes what the record still owes. The worker never installs or upgrades the schema.
- Cloud's `migrate` applies CE's chain from the submodule-pinned CE commit, so Cloud never runs an unreleased CE migration by accident.

---

## 6. Retention and purge

`retention.purge` runs hourly (doc 01 §8.1) through `sys_retention_purge()`, in batches of 5 000 rows per table per run. It is a pg-boss schedule, so one worker runs each tick whatever the number of workers; a backlog of more than one batch is finished by the next runs.

| Data | Kept for | Then |
|---|---|---|
| `sessions` past `expires_at` or `absolute_expires_at` | 0 | Deleted |
| `api_tokens` revoked (`revoked_at`) or expired (`expires_at`) | 30 days | Deleted (a token with no expiry that is not revoked is kept) |
| `oidc_login_states` | 10 min | Deleted |
| `credential_tokens` used or expired | 7 days (forensics) | Deleted |
| `workspace_invitations` not pending | 30 days | Deleted |
| `idempotency_keys` | 24 h | Deleted |
| `rate_limit_buckets` idle | 1 h | Deleted |
| `url_metadata`, `favicons`, `ai_suggestions` past `expires_at` | 0 | Deleted (refetched on demand) |
| `ai_suggestion_usage` | 90 days | Deleted |
| `audit_events` | 1 year (CE: `AUDIT_RETENTION_DAYS`, default 365; `0` = keep forever) | Deleted (Q53) |
| pg-boss completed and failed jobs | 30 days (one `deleteAfterSeconds` per queue, which pg-boss applies to both states; payloads carry IDs, and the new-sign-in alert also carries its time, browser family and network prefix, §2.10) | pg-boss maintenance |
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
