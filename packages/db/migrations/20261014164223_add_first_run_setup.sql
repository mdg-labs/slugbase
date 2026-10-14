CREATE TABLE "instance_state" (
	"id" smallint PRIMARY KEY NOT NULL,
	"setup_completed_at" timestamp with time zone,
	"setup_by" uuid,
	"setup_token_hash" "bytea",
	CONSTRAINT "instance_state_id_check" CHECK ("instance_state"."id" = 1),
	CONSTRAINT "instance_state_setup_token_hash_check" CHECK (length("instance_state"."setup_token_hash") = 32)
);
--> statement-breakpoint
CREATE TABLE "workspace_settings" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"ai_enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "instance_state" ADD CONSTRAINT "instance_state_setup_by_accounts_id_fk" FOREIGN KEY ("setup_by") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_updated_by_accounts_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- slugbase:custom-sql sha256=e4b08eb251b67e0a3dbc9a6467ce68f61e450c7fe0adcf48225615947a222a72
-- src/sql/010-extensions.sql
-- Extensions of doc 05 section 1. All three are trusted extensions, so the
-- owner role creates them; nothing here needs a superuser at runtime.
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;
--> statement-breakpoint
-- src/sql/020-tenant-context.sql
-- The tenant settings withTenant() sets per transaction (doc 05 section 2).
-- NULL when a setting is unset or empty, so a query outside withTenant()
-- matches no row of a table whose policy compares against these.
CREATE OR REPLACE FUNCTION public.app_workspace_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.workspace_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION public.app_account_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.account_id', true), '')::uuid $$;
--> statement-breakpoint
-- src/sql/030-pgboss-grants.sql
-- The pgboss schema of doc 05 section 1 and the rights the worker needs on it.
-- The schema is created here so the grants can name it; the tables, functions
-- and sequences pg-boss installs into it are created by `migrate` as the owner
-- role (doc 05 section 5.5), and the default privileges below give slugbase_app
-- the same rights on each of them as they appear, also after a pg-boss upgrade.
-- slugbase_app gets no CREATE on the schema: queues are created unpartitioned,
-- which is a row in pgboss.queue and no DDL.
CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION slugbase_owner;
GRANT USAGE ON SCHEMA pgboss TO slugbase_app;
ALTER DEFAULT PRIVILEGES FOR ROLE slugbase_owner IN SCHEMA pgboss
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO slugbase_app;
ALTER DEFAULT PRIVILEGES FOR ROLE slugbase_owner IN SCHEMA pgboss
  GRANT USAGE, SELECT ON SEQUENCES TO slugbase_app;
ALTER DEFAULT PRIVILEGES FOR ROLE slugbase_owner IN SCHEMA pgboss
  GRANT EXECUTE ON FUNCTIONS TO slugbase_app;
--> statement-breakpoint
-- src/sql/040-rate-limit.sql
-- The token buckets of doc 01 section 8.2 (doc 05 sections 2.10 and 3.3).
--
-- The table is UNLOGGED, which the Drizzle schema cannot express, so it is
-- defined here: a crash or a failover empties it, and every limit then starts
-- full, by design (doc 10 section 5). Row-level security is enabled and forced
-- and the table has no policy, so no role that is subject to it sees a row;
-- slugbase_system, which bypasses it, is the only role with privileges on it,
-- and it reaches the table only through sys_rate_limit_take and
-- sys_rate_limit_purge (050-rate-limit-purge.sql).
CREATE UNLOGGED TABLE IF NOT EXISTS public.rate_limit_buckets (
  key text PRIMARY KEY,
  tokens real NOT NULL,
  updated_at timestamptz NOT NULL
);
ALTER TABLE public.rate_limit_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rate_limit_buckets FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.rate_limit_buckets FROM PUBLIC, slugbase_app;
GRANT SELECT, INSERT, UPDATE ON TABLE public.rate_limit_buckets TO slugbase_system;

-- sys_rate_limit_take(key, capacity, refill_per_second, cost): takes `cost`
-- tokens from the bucket `key` if it holds that many, and says whether it did.
--
-- A bucket holds at most `capacity` tokens and gains `refill_per_second` of
-- them per second since its updated_at; a bucket that does not exist yet is
-- full. The take is one INSERT ... ON CONFLICT DO UPDATE ... RETURNING, so the
-- decision and the new balance are made on the locked, latest version of the
-- row: two takes of one key never both see the same tokens. The time is the
-- database clock, read once per call, and a take whose clock reading is
-- older than the row's updated_at (it waited for the row lock behind a newer
-- take) refills nothing and does not move updated_at back.
--
-- The returned `remaining` is the balance after the take, or the balance a
-- refused take left alone; `retry_after_seconds` is 0 for an allowed take and
-- otherwise the time the refill needs to make up the missing tokens, always
-- above 0 for a refused take. A cost above the capacity is never allowed and
-- never writes a row; its delay is the time the missing tokens would take at
-- the refill rate, which the capacity cap means the bucket never reaches. A
-- refused take reads the bucket in a second statement of the function: the row
-- lock the upsert took is still held, so that read sees the version the
-- refusal was judged on, and it refills to the same clock reading.
--
-- It is entered in src/system/registry.ts. slugbase_owner creates it and hands
-- it to slugbase_system (a member role of the owner, see provision/roles.sql),
-- which needs CREATE on the schema for the length of that statement.
GRANT CREATE ON SCHEMA public TO slugbase_system;

CREATE OR REPLACE FUNCTION public.sys_rate_limit_take(
  p_key text,
  p_capacity double precision,
  p_refill_per_second double precision,
  p_cost double precision
) RETURNS TABLE (allowed boolean, remaining double precision, retry_after_seconds double precision)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_now timestamptz;
  v_tokens real;
  v_available double precision;
BEGIN
  -- A NaN compares greater than every number, so the upper bounds refuse it too.
  IF NOT coalesce(
    p_key IS NOT NULL
    AND p_capacity > 0 AND p_capacity <= 1e9
    AND p_refill_per_second > 0 AND p_refill_per_second <= 1e9
    AND p_cost > 0 AND p_cost <= 1e9,
    false
  ) THEN
    RAISE EXCEPTION 'sys_rate_limit_take needs a key and a capacity, refill and cost between 0 and 1e9'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_now := clock_timestamp();

  INSERT INTO public.rate_limit_buckets AS b (key, tokens, updated_at)
  SELECT p_key, (p_capacity - p_cost)::real, v_now
  WHERE p_cost <= p_capacity
  ON CONFLICT (key) DO UPDATE
    SET tokens = (
          least(p_capacity, b.tokens + p_refill_per_second
            * greatest(0, extract(epoch FROM excluded.updated_at - b.updated_at))::double precision)
          - p_cost)::real,
        updated_at = greatest(b.updated_at, excluded.updated_at)
    WHERE least(p_capacity, b.tokens + p_refill_per_second
            * greatest(0, extract(epoch FROM excluded.updated_at - b.updated_at))::double precision) >= p_cost
  RETURNING b.tokens INTO v_tokens;

  IF FOUND THEN
    RETURN QUERY SELECT true, v_tokens::double precision, 0::double precision;
    RETURN;
  END IF;

  SELECT least(p_capacity, coalesce(
    (SELECT b.tokens + p_refill_per_second
        * greatest(0, extract(epoch FROM v_now - b.updated_at))::double precision
     FROM public.rate_limit_buckets b WHERE b.key = p_key),
    p_capacity))
  INTO v_available;
  RETURN QUERY SELECT false, v_available, (p_cost - v_available) / p_refill_per_second;
END
$$;

ALTER FUNCTION public.sys_rate_limit_take(text, double precision, double precision, double precision) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;
REVOKE ALL ON FUNCTION public.sys_rate_limit_take(text, double precision, double precision, double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_rate_limit_take(text, double precision, double precision, double precision) TO slugbase_app;
--> statement-breakpoint
-- src/sql/050-rate-limit-purge.sql
-- sys_rate_limit_purge(): deletes the buckets that have been idle for more
-- than an hour and returns how many it deleted (doc 05 section 6).
--
-- Every bucket refills from empty within an hour at most (the registry's
-- longest window is one hour), so a bucket idle for longer holds what a bucket
-- that does not exist yet holds, and deleting it changes no limit. The cut-off
-- is fixed in the function, not an argument, so a caller cannot use it to
-- reset a bucket that is still limiting. A take that locks a bucket the purge
-- would delete moves its updated_at first, and the purge re-checks the row
-- after the lock, so it keeps that bucket.
--
-- slugbase_system, the owner of the function, gets DELETE on the table for it;
-- slugbase_app has no privilege on the table and reaches it only through this
-- function and sys_rate_limit_take. It is entered in src/system/registry.ts.
GRANT DELETE ON TABLE public.rate_limit_buckets TO slugbase_system;
GRANT CREATE ON SCHEMA public TO slugbase_system;

CREATE OR REPLACE FUNCTION public.sys_rate_limit_purge()
  RETURNS bigint
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_deleted bigint;
BEGIN
  DELETE FROM public.rate_limit_buckets
  WHERE updated_at < clock_timestamp() - interval '1 hour';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END
$$;

ALTER FUNCTION public.sys_rate_limit_purge() OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;
REVOKE ALL ON FUNCTION public.sys_rate_limit_purge() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_rate_limit_purge() TO slugbase_app;
--> statement-breakpoint
-- src/sql/060-accounts-sessions.sql
-- Row-level security and privileges of accounts and sessions (doc 05 sections
-- 2.1, 3.1 and 3.3). The tables themselves are defined in src/schema/.
--
-- accounts: forced row-level security with the own-row policy. The policy
-- stays own-row only until the members list needs a co-member branch.
-- slugbase_app may read
-- every column but password_hash, which only the system operations return; it
-- holds no INSERT, UPDATE or DELETE yet. slugbase_system gets the table
-- privileges its functions need (it bypasses row-level security).
ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS accounts_tenant ON public.accounts;
CREATE POLICY accounts_tenant ON public.accounts
  USING (id = public.app_account_id())
  WITH CHECK (id = public.app_account_id());
REVOKE ALL ON TABLE public.accounts FROM PUBLIC, slugbase_app;
GRANT SELECT (
  id, email, email_verified_at, pending_email, display_name, password_changed_at, locale, theme, accent,
  default_bookmark_view, single_key_shortcuts, signin_alerts, ai_opt_out, analytics_consent, consent_at,
  onboarding, is_instance_admin, disabled_at, last_sign_in_at, created_at, updated_at
) ON TABLE public.accounts TO slugbase_app;
GRANT SELECT, UPDATE ON TABLE public.accounts TO slugbase_system;

-- sessions: looked up by token hash before any account is known, so the table
-- has forced row-level security and no policy, and slugbase_app holds no
-- privilege on it. The sys_session_* functions and sys_login_lookup
-- (070-session-functions.sql), owned by slugbase_system, are its only users.
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.sessions FROM PUBLIC, slugbase_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.sessions TO slugbase_system;
--> statement-breakpoint
-- src/sql/070-session-functions.sql
-- The system operations behind sign-in and the session cookie (doc 05 section
-- 3.3, doc 01 section 4 stage 4). All four are entered in
-- src/system/registry.ts. slugbase_owner creates each function and hands it to
-- slugbase_system (a member role of the owner, see provision/roles.sql), which
-- needs CREATE on the schema for the length of those statements.
--
-- Session lifetime: a session slides 30 days from its last request (90 with
-- "remember me") and is never valid past 180 days after it was created. The
-- clock is the database's.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_login_lookup(email): the account a sign-in names, with the password hash
-- the application verifies. Login knows only an email. The match is case-
-- insensitive (the column is citext); the caller passes the trimmed, NFKC-
-- normalised address. No row for an unknown address: the caller runs a dummy
-- verification so both outcomes take the same time.
CREATE OR REPLACE FUNCTION public.sys_login_lookup(p_email text)
  RETURNS TABLE (account_id uuid, password_hash text, disabled_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT a.id, a.password_hash, a.disabled_at
    FROM public.accounts a
    WHERE a.email = p_email::public.citext
  $$;

-- sys_session_create(...): signs the account in. It inserts the session, then
-- deletes the session of the token the request carried (p_replaced_token_hash,
-- when not null), in one call, so a sign-in never leaves both rows or neither.
-- Answers false, and changes nothing, when the account does not exist or is
-- disabled. Only a full session can be created here; the second-factor step
-- adds the pending one. The account's last sign-in time is set with it.
CREATE OR REPLACE FUNCTION public.sys_session_create(
  p_id uuid,
  p_account_id uuid,
  p_level text,
  p_remember boolean,
  p_ip_prefix cidr,
  p_user_agent text,
  p_token_hash bytea,
  p_replaced_token_hash bytea
) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
BEGIN
  IF NOT coalesce(
    p_id IS NOT NULL AND p_account_id IS NOT NULL AND p_remember IS NOT NULL
    AND p_level = 'full'
    AND octet_length(p_token_hash) = 32
    AND (p_replaced_token_hash IS NULL OR octet_length(p_replaced_token_hash) = 32),
    false
  ) THEN
    RAISE EXCEPTION 'sys_session_create needs an id, an account, a full level, a remember flag and 32-byte token hashes'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO public.sessions AS s (
    id, token_hash, account_id, level, remember, created_at, last_seen_at, expires_at, absolute_expires_at,
    ip_prefix, user_agent
  )
  SELECT p_id, p_token_hash, a.id, p_level, p_remember, v_now, v_now,
         v_now + CASE WHEN p_remember THEN interval '90 days' ELSE interval '30 days' END,
         v_now + interval '180 days',
         p_ip_prefix, left(p_user_agent, 256)
  FROM public.accounts a
  WHERE a.id = p_account_id AND a.disabled_at IS NULL;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF p_replaced_token_hash IS NOT NULL THEN
    DELETE FROM public.sessions WHERE token_hash = p_replaced_token_hash;
  END IF;
  UPDATE public.accounts SET last_sign_in_at = v_now WHERE id = p_account_id;
  RETURN true;
END
$$;

-- sys_session_lookup(token_hash): the principal behind a session cookie, one
-- round trip per request. A row comes back only for a session that exists,
-- has not expired (sliding or absolute), belongs to an account that is not
-- disabled and was not created before the account's password_changed_at; any
-- other token gets no row, and a revoked session is gone from the table, so
-- revocation holds on the very next request. A full session that was last seen
-- more than a minute ago has its last_seen_at and its sliding expiry moved
-- forward in the same call, never past its absolute expiry.
CREATE OR REPLACE FUNCTION public.sys_session_lookup(p_token_hash bytea)
  RETURNS TABLE (
    session_id uuid,
    account_id uuid,
    level text,
    active_workspace_id uuid,
    reauth_at timestamptz,
    is_instance_admin boolean
  )
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_row record;
BEGIN
  IF p_token_hash IS NULL OR octet_length(p_token_hash) <> 32 THEN
    RETURN;
  END IF;

  SELECT s.id AS id, s.account_id AS account, s.level AS level, s.active_workspace_id AS workspace,
         s.reauth_at AS reauth, s.remember AS remember, s.last_seen_at AS last_seen,
         s.absolute_expires_at AS absolute_expires, a.is_instance_admin AS admin
  INTO v_row
  FROM public.sessions s
  JOIN public.accounts a ON a.id = s.account_id
  WHERE s.token_hash = p_token_hash
    AND s.expires_at > v_now
    AND s.absolute_expires_at > v_now
    AND a.disabled_at IS NULL
    AND (a.password_changed_at IS NULL OR s.created_at >= a.password_changed_at);
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF v_row.level = 'full' AND v_row.last_seen <= v_now - interval '1 minute' THEN
    UPDATE public.sessions s
    SET last_seen_at = v_now,
        expires_at = least(
          v_now + CASE WHEN v_row.remember THEN interval '90 days' ELSE interval '30 days' END,
          v_row.absolute_expires)
    WHERE s.id = v_row.id AND s.last_seen_at <= v_now - interval '1 minute';
  END IF;

  RETURN QUERY SELECT v_row.id, v_row.account, v_row.level, v_row.workspace, v_row.reauth, v_row.admin;
END
$$;

-- sys_session_revoke(id, account_id): deletes one session of an account and
-- says whether it existed. The account is part of the key, so a session id of
-- another account deletes nothing.
CREATE OR REPLACE FUNCTION public.sys_session_revoke(p_id uuid, p_account_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  DELETE FROM public.sessions WHERE id = p_id AND account_id = p_account_id;
  RETURN FOUND;
END
$$;

ALTER FUNCTION public.sys_login_lookup(text) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_session_create(uuid, uuid, text, boolean, cidr, text, bytea, bytea) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_session_lookup(bytea) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_session_revoke(uuid, uuid) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_login_lookup(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_session_create(uuid, uuid, text, boolean, cidr, text, bytea, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_session_lookup(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_session_revoke(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_login_lookup(text) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_session_create(uuid, uuid, text, boolean, cidr, text, bytea, bytea) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_session_lookup(bytea) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_session_revoke(uuid, uuid) TO slugbase_app;
--> statement-breakpoint
-- src/sql/080-session-management.sql
-- The system operations behind the account's session list (doc 05 section 3.3,
-- doc 04 section 10.3). Both are entered in src/system/registry.ts. The
-- application role reaches `sessions` only through them and the functions of
-- 070-session-functions.sql; the account is a parameter of each, so a session of
-- another account is never listed and never deleted.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_list_sessions(account_id, after_id, max_rows): one page of the sessions of
-- the account that are valid now, newest first by identifier (a UUIDv7, so
-- creation order, and unique, so a page boundary never repeats or skips a
-- session): a full session that has not expired (sliding or absolute) and was
-- not created before the account's password_changed_at, the same conditions
-- sys_session_lookup applies, so the list shows what a request could still use.
-- after_id is the last identifier of the previous page, null for the first.
-- The account filter does not depend on after_id. The token hash is never part
-- of the answer.
CREATE OR REPLACE FUNCTION public.sys_list_sessions(p_account_id uuid, p_after_id uuid, p_max_rows integer)
  RETURNS TABLE (
    id uuid,
    created_at timestamptz,
    last_seen_at timestamptz,
    ip_prefix cidr,
    user_agent text
  )
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF p_account_id IS NULL OR p_max_rows IS NULL OR p_max_rows < 1 THEN
    RAISE EXCEPTION 'sys_list_sessions needs an account and a positive page size'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
    SELECT s.id, s.created_at, s.last_seen_at, s.ip_prefix, s.user_agent
    FROM public.sessions s
    JOIN public.accounts a ON a.id = s.account_id
    WHERE s.account_id = p_account_id
      AND (p_after_id IS NULL OR s.id < p_after_id)
      AND s.level = 'full'
      AND s.expires_at > clock_timestamp()
      AND s.absolute_expires_at > clock_timestamp()
      AND a.disabled_at IS NULL
      AND (a.password_changed_at IS NULL OR s.created_at >= a.password_changed_at)
    ORDER BY s.id DESC
    LIMIT p_max_rows;
END
$$;

-- sys_session_revoke_all(account_id, except_id): deletes every session of the
-- account, whatever its level or expiry, except the one named by except_id
-- (null deletes them all), and answers how many it deleted. A session of
-- another account is not touched whatever id is given.
CREATE OR REPLACE FUNCTION public.sys_session_revoke_all(p_account_id uuid, p_except_id uuid)
  RETURNS bigint
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_deleted bigint;
BEGIN
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'sys_session_revoke_all needs an account'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  DELETE FROM public.sessions
  WHERE account_id = p_account_id AND (p_except_id IS NULL OR id <> p_except_id);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END
$$;

ALTER FUNCTION public.sys_list_sessions(uuid, uuid, integer) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_session_revoke_all(uuid, uuid) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_list_sessions(uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_session_revoke_all(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_list_sessions(uuid, uuid, integer) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_session_revoke_all(uuid, uuid) TO slugbase_app;
--> statement-breakpoint
-- src/sql/090-updated-at-trigger.sql
-- The updated_at trigger of doc 05 section 1. public.set_updated_at() is the one
-- trigger function every editable table attaches, as a BEFORE UPDATE row trigger
-- named <table>_set_updated_at, in a file of this directory. It runs with the
-- privileges of the session that writes the row, so it needs none of its own, and
-- it overwrites whatever the statement wrote to updated_at.
CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

CREATE OR REPLACE TRIGGER accounts_set_updated_at
  BEFORE UPDATE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
-- src/sql/100-workspaces.sql
-- Row-level security, privileges and system operations of workspaces and
-- workspace_members (doc 05 sections 2.2, 3.1 and 3.3). The tables themselves
-- are defined in src/schema/. Both functions are entered in
-- src/system/registry.ts. slugbase_owner creates each function and hands it to
-- slugbase_system, which needs CREATE on the schema for the length of those
-- statements.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- app_member_workspace_ids(): the workspaces the calling account (from
-- app_account_id(), never an argument) is a member of, without those being
-- deleted. The workspaces policy reads it, and it runs as slugbase_system so
-- that reading workspace_members from inside that policy does not evaluate
-- the policies again. Outside withTenant() the account is unset and nothing
-- comes back.
CREATE OR REPLACE FUNCTION public.app_member_workspace_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT m.workspace_id
    FROM public.workspace_members m
    JOIN public.workspaces w ON w.id = m.workspace_id
    WHERE m.account_id = public.app_account_id() AND w.deleting_at IS NULL
  $$;

-- sys_account_has_password(): whether the calling account (from
-- app_account_id(), never an argument) can sign in with a password, which is
-- all the profile may say of password_hash: slugbase_app has no privilege on
-- the column. NULL when no account is set.
CREATE OR REPLACE FUNCTION public.sys_account_has_password() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT a.password_hash IS NOT NULL FROM public.accounts a WHERE a.id = public.app_account_id()
  $$;

ALTER FUNCTION public.app_member_workspace_ids() OWNER TO slugbase_system;
ALTER FUNCTION public.sys_account_has_password() OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.app_member_workspace_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_account_has_password() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_member_workspace_ids() TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_account_has_password() TO slugbase_app;

-- workspaces: an account sees the workspaces it is a member of and the active
-- one, never one being deleted. The write policies name the active workspace
-- only; slugbase_app holds no write privilege on the table yet, and a workspace
-- is created by a system operation. slugbase_system, which bypasses the
-- policies, gets the privileges its functions and the deletion job need.
ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspaces FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspaces_tenant ON public.workspaces;
CREATE POLICY workspaces_tenant ON public.workspaces FOR SELECT
  USING ((id = public.app_workspace_id() OR id IN (SELECT public.app_member_workspace_ids())) AND deleting_at IS NULL);
DROP POLICY IF EXISTS workspaces_tenant_update ON public.workspaces;
CREATE POLICY workspaces_tenant_update ON public.workspaces FOR UPDATE
  USING (id = public.app_workspace_id())
  WITH CHECK (id = public.app_workspace_id());
DROP POLICY IF EXISTS workspaces_tenant_delete ON public.workspaces;
CREATE POLICY workspaces_tenant_delete ON public.workspaces FOR DELETE
  USING (id = public.app_workspace_id());
REVOKE ALL ON TABLE public.workspaces FROM PUBLIC, slugbase_app;
GRANT SELECT ON TABLE public.workspaces TO slugbase_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.workspaces TO slugbase_system;
CREATE OR REPLACE TRIGGER workspaces_set_updated_at
  BEFORE UPDATE ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- workspace_members: the members of the active workspace and the account's own
-- rows in every workspace; writes only in the active workspace. slugbase_app
-- may move last_active_at, the one column the tenant resolver writes; the
-- membership changes arrive with the operations that make them.
ALTER TABLE public.workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_members FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_members_tenant ON public.workspace_members;
CREATE POLICY workspace_members_tenant ON public.workspace_members FOR SELECT
  USING (workspace_id = public.app_workspace_id() OR account_id = public.app_account_id());
DROP POLICY IF EXISTS workspace_members_tenant_update ON public.workspace_members;
CREATE POLICY workspace_members_tenant_update ON public.workspace_members FOR UPDATE
  USING (workspace_id = public.app_workspace_id())
  WITH CHECK (workspace_id = public.app_workspace_id());
DROP POLICY IF EXISTS workspace_members_tenant_delete ON public.workspace_members;
CREATE POLICY workspace_members_tenant_delete ON public.workspace_members FOR DELETE
  USING (workspace_id = public.app_workspace_id());
REVOKE ALL ON TABLE public.workspace_members FROM PUBLIC, slugbase_app;
GRANT SELECT ON TABLE public.workspace_members TO slugbase_app;
GRANT UPDATE (last_active_at) ON TABLE public.workspace_members TO slugbase_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.workspace_members TO slugbase_system;
--> statement-breakpoint
-- src/sql/110-retention-purge.sql
-- sys_retention_purge(): the scheduled purge of what has outlived its retention
-- (doc 05 section 6, doc 01 section 8.1). It deletes at most 5 000 rows per table
-- per call and answers, per table, how many rows it deleted; a table with more
-- due rows than that is finished by the next calls. Each table's rule is one
-- statement below, in the order of the doc 05 section 6 table, and the epic that
-- creates a table adds its rule here.
--
-- sessions: past expires_at (the sliding expiry) or absolute_expires_at, whatever
-- the level; the same conditions sys_session_lookup refuses a session on. Rows
-- another statement holds are skipped and found by the next call, so the purge
-- never waits behind a request.
--
-- It takes no argument, so a caller cannot widen what it deletes, and it uses no
-- dynamic SQL. It is entered in src/system/registry.ts. slugbase_system, the
-- owner, already holds DELETE on sessions (060-accounts-sessions.sql);
-- slugbase_app reaches the table only through the system operations.
GRANT CREATE ON SCHEMA public TO slugbase_system;

CREATE OR REPLACE FUNCTION public.sys_retention_purge()
  RETURNS TABLE (table_name text, deleted bigint)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  c_batch CONSTANT integer := 5000;
  v_now timestamptz := clock_timestamp();
  v_deleted bigint;
BEGIN
  DELETE FROM public.sessions
  WHERE id IN (
    SELECT s.id FROM public.sessions s
    WHERE s.expires_at <= v_now OR s.absolute_expires_at <= v_now
    LIMIT c_batch
    FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN QUERY SELECT 'sessions'::text, v_deleted;
END
$$;

ALTER FUNCTION public.sys_retention_purge() OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;
REVOKE ALL ON FUNCTION public.sys_retention_purge() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_retention_purge() TO slugbase_app;
--> statement-breakpoint
-- src/sql/120-setup.sql
-- First-run setup (doc 05 sections 2.2 and 3.3, doc 02 section 2.2, doc 10
-- section 2.1): instance_state, workspace_settings and the system operations
-- that create the first account. The tables themselves are defined in
-- src/schema/. All five functions are entered in src/system/registry.ts.
-- slugbase_owner creates each function and hands it to slugbase_system, which
-- needs CREATE on the schema for the length of those statements.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_create_account(...): inserts an account that signs in with a password.
-- Registration, invitation accept and setup are anonymous, so the account does
-- not exist yet for a policy to name. The application passes the id it
-- generated and the email trimmed and NFKC-normalised. Answers false, and
-- inserts nothing, when the email (or the id) is taken, so the caller answers
-- generically and cannot be used to tell whether an address has an account.
-- It never makes an instance admin.
CREATE OR REPLACE FUNCTION public.sys_create_account(
  p_id uuid,
  p_email text,
  p_display_name text,
  p_password_hash text,
  p_locale text,
  p_email_verified boolean
) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF NOT coalesce(
    p_id IS NOT NULL AND p_email IS NOT NULL AND p_display_name IS NOT NULL AND p_locale IS NOT NULL
    AND p_email_verified IS NOT NULL,
    false
  ) THEN
    RAISE EXCEPTION 'sys_create_account needs an id, an email, a display name, a locale and a verified flag'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  BEGIN
    INSERT INTO public.accounts (id, email, email_verified_at, display_name, password_hash, locale)
    VALUES (
      p_id, p_email::public.citext, CASE WHEN p_email_verified THEN clock_timestamp() END,
      p_display_name, p_password_hash, p_locale
    );
  EXCEPTION WHEN unique_violation THEN
    RETURN false;
  END;
  RETURN true;
END
$$;

-- sys_create_workspace(...): a workspace, its owner membership and its settings
-- row, in one call, so a workspace never exists without an owner or without
-- settings. The new workspace is not the account's active one yet, so no tenant
-- context could create it. The caller names the account it authenticated.
-- Answers false, and changes nothing, for an unknown or disabled account.
CREATE OR REPLACE FUNCTION public.sys_create_workspace(p_account_id uuid, p_workspace_id uuid, p_name text)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF NOT coalesce(p_account_id IS NOT NULL AND p_workspace_id IS NOT NULL AND p_name IS NOT NULL, false) THEN
    RAISE EXCEPTION 'sys_create_workspace needs an account, a workspace id and a name'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = p_account_id AND a.disabled_at IS NULL) THEN
    RETURN false;
  END IF;

  INSERT INTO public.workspaces (id, name, created_by) VALUES (p_workspace_id, p_name, p_account_id);
  INSERT INTO public.workspace_members (workspace_id, account_id, role) VALUES (p_workspace_id, p_account_id, 'owner');
  INSERT INTO public.workspace_settings (workspace_id, updated_by) VALUES (p_workspace_id, p_account_id);
  RETURN true;
END
$$;

-- sys_setup_status(): whether first-run setup is pending, which is the case
-- while the instance has no account and setup has not been completed. A
-- deployment whose accounts were all deleted after a setup stays closed.
CREATE OR REPLACE FUNCTION public.sys_setup_status() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT NOT EXISTS (SELECT 1 FROM public.accounts)
      AND NOT EXISTS (SELECT 1 FROM public.instance_state s WHERE s.id = 1 AND s.setup_completed_at IS NOT NULL)
  $$;

-- sys_setup_token_set(token_hash): stores the SHA-256 of the one-time setup
-- token the server generated at start. While setup is pending it replaces the
-- stored hash in one statement, so the previous token stops working at the
-- moment the new one starts to, and there is no instant without a valid token.
-- It answers whether it stored the hash (false once setup is closed). Of
-- several servers starting together the last one to store wins and the tokens
-- of the others are invalid. The lock is the one sys_complete_setup takes.
CREATE OR REPLACE FUNCTION public.sys_setup_token_set(p_token_hash bytea) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_rows bigint;
BEGIN
  IF p_token_hash IS NULL OR octet_length(p_token_hash) <> 32 THEN
    RAISE EXCEPTION 'sys_setup_token_set needs a 32-byte token hash' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('slugbase.setup'));
  IF NOT public.sys_setup_status() THEN
    RETURN false;
  END IF;

  INSERT INTO public.instance_state AS s (id, setup_token_hash) VALUES (1, p_token_hash)
  ON CONFLICT (id) DO UPDATE SET setup_token_hash = excluded.setup_token_hash
  WHERE s.setup_completed_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END
$$;

-- sys_complete_setup(...): first-run setup, exactly once. Under the advisory
-- lock that serialises every setup call, it answers 'setup_completed' when the
-- instance has an account or has completed setup, and 'forbidden' when a setup
-- token is required and the presented hash is not the stored one; in both
-- cases it writes nothing. Otherwise it creates the verified account as
-- instance admin, its workspace with the owner membership and the settings row,
-- records the setup (clearing the token hash), and signs the account in with a
-- full session whose active workspace is the new one: all of it in this one
-- call, so a failure at any step leaves nothing. The password arrives hashed.
CREATE OR REPLACE FUNCTION public.sys_complete_setup(
  p_account_id uuid,
  p_workspace_id uuid,
  p_session_id uuid,
  p_email text,
  p_display_name text,
  p_password_hash text,
  p_locale text,
  p_workspace_name text,
  p_token_required boolean,
  p_token_hash bytea,
  p_session_token_hash bytea,
  p_ip_prefix cidr,
  p_user_agent text
) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_stored bytea;
BEGIN
  IF NOT coalesce(
    p_account_id IS NOT NULL AND p_workspace_id IS NOT NULL AND p_session_id IS NOT NULL
    AND p_email IS NOT NULL AND p_display_name IS NOT NULL AND p_password_hash IS NOT NULL
    AND p_locale IS NOT NULL AND p_workspace_name IS NOT NULL AND p_token_required IS NOT NULL
    AND (p_token_hash IS NULL OR octet_length(p_token_hash) = 32)
    AND octet_length(p_session_token_hash) = 32,
    false
  ) THEN
    RAISE EXCEPTION 'sys_complete_setup needs the account, its workspace and session, a password hash and 32-byte token hashes'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('slugbase.setup'));
  IF NOT public.sys_setup_status() THEN
    RETURN 'setup_completed';
  END IF;

  IF p_token_required THEN
    SELECT s.setup_token_hash INTO v_stored FROM public.instance_state s WHERE s.id = 1;
    IF v_stored IS NULL OR p_token_hash IS NULL OR v_stored <> p_token_hash THEN
      RETURN 'forbidden';
    END IF;
  END IF;

  IF NOT public.sys_create_account(p_account_id, p_email, p_display_name, p_password_hash, p_locale, true) THEN
    RETURN 'setup_completed';
  END IF;
  UPDATE public.accounts SET is_instance_admin = true WHERE id = p_account_id;
  IF NOT public.sys_create_workspace(p_account_id, p_workspace_id, p_workspace_name) THEN
    RAISE EXCEPTION 'the first workspace could not be created';
  END IF;

  INSERT INTO public.instance_state AS s (id, setup_completed_at, setup_by, setup_token_hash)
  VALUES (1, clock_timestamp(), p_account_id, NULL)
  ON CONFLICT (id) DO UPDATE
    SET setup_completed_at = excluded.setup_completed_at, setup_by = excluded.setup_by, setup_token_hash = NULL;

  IF NOT public.sys_session_create(
    p_session_id, p_account_id, 'full', false, p_ip_prefix, p_user_agent, p_session_token_hash, NULL
  ) THEN
    RAISE EXCEPTION 'the first session could not be created';
  END IF;
  UPDATE public.sessions SET active_workspace_id = p_workspace_id WHERE id = p_session_id;
  RETURN 'completed';
END
$$;

ALTER FUNCTION public.sys_create_account(uuid, text, text, text, text, boolean) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_create_workspace(uuid, uuid, text) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_setup_status() OWNER TO slugbase_system;
ALTER FUNCTION public.sys_setup_token_set(bytea) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_complete_setup(uuid, uuid, uuid, text, text, text, text, text, boolean, bytea, bytea, cidr, text) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_create_account(uuid, text, text, text, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_create_workspace(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_setup_status() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_setup_token_set(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_complete_setup(uuid, uuid, uuid, text, text, text, text, text, boolean, bytea, bytea, cidr, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_create_account(uuid, text, text, text, text, boolean) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_create_workspace(uuid, uuid, text) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_setup_status() TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_setup_token_set(bytea) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_complete_setup(uuid, uuid, uuid, text, text, text, text, text, boolean, bytea, bytea, cidr, text) TO slugbase_app;

-- accounts: the system operations insert the rows no account can insert for
-- itself (setup, and later registration and invitation accept).
GRANT INSERT ON TABLE public.accounts TO slugbase_system;

-- instance_state: no personal data and no row-level security; slugbase_app has
-- no privilege on it. Only sys_setup_status, sys_setup_token_set and
-- sys_complete_setup read or write it.
REVOKE ALL ON TABLE public.instance_state FROM PUBLIC, slugbase_app;
GRANT SELECT, INSERT, UPDATE ON TABLE public.instance_state TO slugbase_system;

-- workspace_settings: a workspace's own row only. slugbase_app reads it; the
-- row is written by sys_create_workspace, and a setting is changed by the
-- operation that introduces it.
ALTER TABLE public.workspace_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_settings_tenant ON public.workspace_settings;
CREATE POLICY workspace_settings_tenant ON public.workspace_settings FOR SELECT
  USING (workspace_id = public.app_workspace_id());
REVOKE ALL ON TABLE public.workspace_settings FROM PUBLIC, slugbase_app;
GRANT SELECT ON TABLE public.workspace_settings TO slugbase_app;
GRANT SELECT, INSERT, UPDATE ON TABLE public.workspace_settings TO slugbase_system;
CREATE OR REPLACE TRIGGER workspace_settings_set_updated_at
  BEFORE UPDATE ON public.workspace_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
