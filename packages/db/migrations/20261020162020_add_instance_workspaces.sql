-- slugbase:custom-sql sha256=e8d7eb21e2dbfeaddad7eb24c01e1a2d1f79a24f54ef00e2087a22d76855e56d
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
-- accounts: forced row-level security with the own-row policy, and a second policy
-- that lets an account read the rows of the members of the workspace it acts in
-- (the members list); the two are permissive, so they add up for a read, and only
-- the own-row policy admits a write. slugbase_app may read
-- every column but password_hash and the mfa_* columns, which only the system
-- operations return (140-mfa.sql). It
-- may update display_name, locale and the preference columns of the profile
-- operation (theme, accent, default_bookmark_view, single_key_shortcuts,
-- signin_alerts, ai_opt_out, analytics_consent, consent_at, onboarding), and
-- only on its own row: the policy's WITH CHECK keeps the id, and no other
-- column is granted. It holds no INSERT or DELETE. slugbase_system gets the table
-- privileges its functions need (it bypasses row-level security).
ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS accounts_tenant ON public.accounts;
CREATE POLICY accounts_tenant ON public.accounts
  USING (id = public.app_account_id())
  WITH CHECK (id = public.app_account_id());
DROP POLICY IF EXISTS accounts_tenant_co_members ON public.accounts;
CREATE POLICY accounts_tenant_co_members ON public.accounts FOR SELECT
  USING (id IN (SELECT m.account_id FROM public.workspace_members m WHERE m.workspace_id = public.app_workspace_id()));
REVOKE ALL ON TABLE public.accounts FROM PUBLIC, slugbase_app;
GRANT SELECT (
  id, email, email_verified_at, pending_email, display_name, password_changed_at, locale, theme, accent,
  default_bookmark_view, single_key_shortcuts, signin_alerts, ai_opt_out, analytics_consent, consent_at,
  onboarding, is_instance_admin, disabled_at, last_sign_in_at, created_at, updated_at
) ON TABLE public.accounts TO slugbase_app;
GRANT UPDATE (
  display_name, locale, theme, accent, default_bookmark_view, single_key_shortcuts, signin_alerts, ai_opt_out, analytics_consent,
  consent_at, onboarding
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
-- disabled, and when the level does not fit the account's second factor: an
-- account whose MFA is on gets only a partial session (doc 02 section 2.3, doc
-- 10 T17), and an account whose MFA is off only a full one. A partial session
-- (the password is verified, the code is pending) expires after 5 minutes, both
-- its sliding and its absolute expiry, and is not moved forward by a lookup;
-- sys_session_promote makes it a full session once the code is accepted. A full
-- session sets the account's last sign-in time with its creation.
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
    AND p_level IN ('partial', 'full')
    AND octet_length(p_token_hash) = 32
    AND (p_replaced_token_hash IS NULL OR octet_length(p_replaced_token_hash) = 32),
    false
  ) THEN
    RAISE EXCEPTION 'sys_session_create needs an id, an account, a partial or full level, a remember flag and 32-byte token hashes'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO public.sessions AS s (
    id, token_hash, account_id, level, remember, created_at, last_seen_at, expires_at, absolute_expires_at,
    ip_prefix, user_agent
  )
  SELECT p_id, p_token_hash, a.id, p_level, p_remember, v_now, v_now,
         CASE
           WHEN p_level = 'partial' THEN v_now + interval '5 minutes'
           WHEN p_remember THEN v_now + interval '90 days'
           ELSE v_now + interval '30 days'
         END,
         CASE WHEN p_level = 'partial' THEN v_now + interval '5 minutes' ELSE v_now + interval '180 days' END,
         p_ip_prefix, left(p_user_agent, 256)
  FROM public.accounts a
  WHERE a.id = p_account_id AND a.disabled_at IS NULL
    AND (a.mfa_enabled_at IS NOT NULL) = (p_level = 'partial');
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF p_replaced_token_hash IS NOT NULL THEN
    DELETE FROM public.sessions WHERE token_hash = p_replaced_token_hash;
  END IF;
  IF p_level = 'full' THEN
    UPDATE public.accounts SET last_sign_in_at = v_now WHERE id = p_account_id;
  END IF;
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
-- only. slugbase_app may change the name and the version of a row and nothing
-- else (the rename is the one operation that does, and whether the caller may
-- is the role check of the authorization stage); a workspace is created by a
-- system operation. slugbase_system, which bypasses the policies, gets the
-- privileges its functions and the deletion job need.
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
GRANT UPDATE (name, version) ON TABLE public.workspaces TO slugbase_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.workspaces TO slugbase_system;
CREATE OR REPLACE TRIGGER workspaces_set_updated_at
  BEFORE UPDATE ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- workspace_members: the members of the active workspace and the account's own
-- rows in every workspace; writes only in the active workspace. slugbase_app
-- may move last_active_at, which the tenant resolver writes, and change role, the
-- one column a membership operation writes (whether the caller may is the role
-- check of the member service; that the workspace keeps an owner is the deferred
-- constraint trigger of 270-member-roles.sql), and delete a row of the active
-- workspace, which is how a member leaves or is removed (the same service check
-- and trigger apply; the tokens bound to the membership go with it through the
-- composite foreign key of api_tokens). Adding a member arrives with the
-- operation that makes one.
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
GRANT SELECT, DELETE ON TABLE public.workspace_members TO slugbase_app;
GRANT UPDATE (role, last_active_at) ON TABLE public.workspace_members TO slugbase_app;
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
-- api_tokens: revoked_at or expires_at more than 30 days in the past, whichever
-- of the two is set and whatever the other says (a revoked token that has not
-- expired, an expired one that was never revoked). A token with no expiry that
-- is not revoked, one that is active, and one revoked or expired less than 30
-- days ago stay; the token lookup refuses a revoked or expired token from the
-- moment it is one, so deleting the row later changes no answer except that a
-- repeated revocation of a token that old is no longer answered as the first
-- one (doc 04 section 2.4). The table is created by the schema migrations, which
-- run before this file is applied, so the plpgsql body resolves it when it runs;
-- the grants it needs are in 150-api-tokens.sql.
--
-- oidc_login_states: past expires_at. A state that was consumed is already gone;
-- sys_oidc_state_consume refuses an expired one from the moment it is, so
-- deleting the row later changes no answer. The grants it needs are in
-- 170-oidc.sql.
--
-- credential_tokens: used_at or expires_at more than 7 days in the past, whichever
-- of the two is set and whatever the other says (a token used before its expiry,
-- one that expired unused). A token that is unused and unexpired, and one used or
-- expired less than 7 days ago, stay; sys_credential_token_consume refuses a used
-- or expired token from the moment it is one, so deleting the row later changes
-- no answer. The grants it needs are in 190-credential-tokens.sql.
--
-- workspace_invitations: not pending (accepted or revoked) and closed_at more than 30 days in the past.
-- closed_at is set by the statement that moves the status out of pending and by nothing else, so a later
-- change to the row (the inviter's account deleted, which nulls invited_by) does not move the deletion. A
-- pending invitation stays whatever its expiry says: it is listed, resent and revoked until it is
-- answered, and the accept refuses an expired one from the moment it is. The grants it needs are in
-- 300-workspace-invitations.sql.
--
-- idempotency_keys: past expires_at, which is 24 hours after the key was first used (doc 04 section
-- 6.3). A request that finds an expired key treats it as absent and replaces it, so deleting the row
-- later changes no answer. Rows another statement holds are skipped and found by the next call. The
-- grants it needs are in 310-idempotency-keys.sql.
--
-- audit_events: workspace events (those with a workspace) created more than
-- p_audit_retention_days days ago, which is the operator's AUDIT_RETENTION_DAYS (Q53). 0 keeps
-- them forever and deletes none; a negative number or NULL is refused. Events of a deployment
-- with no workspace are not deleted. Nothing locks an audit row (the application role cannot
-- update one), so the batch is selected without a row lock, which slugbase_system holds no
-- UPDATE privilege for. The grants it needs are in 250-audit-events.sql.
--
-- Every other rule is fixed in the function, and its one argument only chooses how
-- long audit events stay, so a caller cannot widen what the other tables lose; it
-- uses no dynamic SQL. The overload without an argument keeps working for a replica
-- of the previous release during a rolling deploy and deletes no audit event (it
-- passes 0). Both are entered in src/system/registry.ts. slugbase_system, the
-- owner, already holds DELETE on sessions (060-accounts-sessions.sql) and holds
-- DELETE on api_tokens (150-api-tokens.sql); slugbase_app reaches neither table
-- for a delete except through this function.
GRANT CREATE ON SCHEMA public TO slugbase_system;

CREATE OR REPLACE FUNCTION public.sys_retention_purge(p_audit_retention_days integer)
  RETURNS TABLE (table_name text, deleted bigint)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  c_batch CONSTANT integer := 5000;
  v_now timestamptz := clock_timestamp();
  c_token_retention CONSTANT interval := interval '30 days';
  c_credential_token_retention CONSTANT interval := interval '7 days';
  c_invitation_retention CONSTANT interval := interval '30 days';
  v_deleted bigint;
BEGIN
  IF p_audit_retention_days IS NULL OR p_audit_retention_days < 0 THEN
    RAISE EXCEPTION 'sys_retention_purge needs an audit retention of 0 (keep forever) or a number of days'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  DELETE FROM public.sessions
  WHERE id IN (
    SELECT s.id FROM public.sessions s
    WHERE s.expires_at <= v_now OR s.absolute_expires_at <= v_now
    LIMIT c_batch
    FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN QUERY SELECT 'sessions'::text, v_deleted;

  DELETE FROM public.api_tokens
  WHERE id IN (
    SELECT t.id FROM public.api_tokens t
    WHERE t.revoked_at <= v_now - c_token_retention OR t.expires_at <= v_now - c_token_retention
    LIMIT c_batch
    FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN QUERY SELECT 'api_tokens'::text, v_deleted;

  DELETE FROM public.oidc_login_states
  WHERE state_hash IN (
    SELECT s.state_hash FROM public.oidc_login_states s
    WHERE s.expires_at <= v_now
    LIMIT c_batch
    FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN QUERY SELECT 'oidc_login_states'::text, v_deleted;

  DELETE FROM public.credential_tokens
  WHERE id IN (
    SELECT t.id FROM public.credential_tokens t
    WHERE t.used_at <= v_now - c_credential_token_retention OR t.expires_at <= v_now - c_credential_token_retention
    LIMIT c_batch
    FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN QUERY SELECT 'credential_tokens'::text, v_deleted;

  DELETE FROM public.workspace_invitations
  WHERE id IN (
    SELECT i.id FROM public.workspace_invitations i
    WHERE i.status <> 'pending' AND i.closed_at <= v_now - c_invitation_retention
    LIMIT c_batch
    FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN QUERY SELECT 'workspace_invitations'::text, v_deleted;

  DELETE FROM public.idempotency_keys
  WHERE (account_id, key) IN (
    SELECT k.account_id, k.key FROM public.idempotency_keys k
    WHERE k.expires_at <= v_now
    LIMIT c_batch
    FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN QUERY SELECT 'idempotency_keys'::text, v_deleted;

  v_deleted := 0;
  IF p_audit_retention_days > 0 THEN
    DELETE FROM public.audit_events
    WHERE id IN (
      SELECT e.id FROM public.audit_events e
      WHERE e.workspace_id IS NOT NULL AND e.created_at <= v_now - p_audit_retention_days * interval '1 day'
      LIMIT c_batch
    );
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
  END IF;
  RETURN QUERY SELECT 'audit_events'::text, v_deleted;
END
$$;

-- The overload of the previous release: the same purge with the audit log kept.
CREATE OR REPLACE FUNCTION public.sys_retention_purge()
  RETURNS TABLE (table_name text, deleted bigint)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  RETURN QUERY SELECT * FROM public.sys_retention_purge(0);
END
$$;

ALTER FUNCTION public.sys_retention_purge(integer) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_retention_purge() OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;
REVOKE ALL ON FUNCTION public.sys_retention_purge(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_retention_purge() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_retention_purge(integer) TO slugbase_app;
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
-- An address that the unused, unexpired "this wasn't me" token of an account
-- records (credential_tokens.target_email: the address a confirmed change of
-- that account replaced) counts as taken too, so the link that restores it
-- cannot be blocked by creating an account on it; the reservation ends when the
-- token is used or expires. The check runs first on every call, so an address
-- that is reserved costs the caller what one that has an account costs.
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

  IF EXISTS (
    SELECT 1 FROM public.credential_tokens t
    WHERE t.purpose = 'email_change_cancel' AND t.used_at IS NULL AND t.expires_at > clock_timestamp()
      AND t.target_email = p_email::public.citext
  ) THEN
    RETURN false;
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
-- Answers false, and changes nothing, for an unknown or disabled account, and for an account other
-- than the one a tenant transaction acts for: when app_account_id() names an account, p_account_id
-- must be that account, so a transaction cannot make a workspace owned by somebody else. The
-- anonymous flows that create the first workspace of an account (setup, registration, verification)
-- run with no account set and name the account they just made.
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
  IF public.app_account_id() IS NOT NULL AND p_account_id <> public.app_account_id() THEN
    RETURN false;
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

-- workspace_settings: a workspace's own row only. slugbase_app reads it and may
-- change the setting columns and who changed them, in the active workspace; the
-- row is written by sys_create_workspace and deleted with the workspace by
-- sys_workspace_purge_batch (280-workspace-deletion.sql), and a column joins the
-- grant with the operation that introduces the setting.
ALTER TABLE public.workspace_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_settings_tenant ON public.workspace_settings;
CREATE POLICY workspace_settings_tenant ON public.workspace_settings FOR SELECT
  USING (workspace_id = public.app_workspace_id());
DROP POLICY IF EXISTS workspace_settings_tenant_update ON public.workspace_settings;
CREATE POLICY workspace_settings_tenant_update ON public.workspace_settings FOR UPDATE
  USING (workspace_id = public.app_workspace_id())
  WITH CHECK (workspace_id = public.app_workspace_id());
REVOKE ALL ON TABLE public.workspace_settings FROM PUBLIC, slugbase_app;
GRANT SELECT ON TABLE public.workspace_settings TO slugbase_app;
GRANT UPDATE (ai_enabled, updated_by) ON TABLE public.workspace_settings TO slugbase_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.workspace_settings TO slugbase_system;
CREATE OR REPLACE TRIGGER workspace_settings_set_updated_at
  BEFORE UPDATE ON public.workspace_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
-- src/sql/130-password-change.sql
-- The system operations behind re-authentication and the password change (doc
-- 05 section 3.3, doc 04 sections 4.3, 4.4 and 10.3). All four are entered in
-- src/system/registry.ts. slugbase_owner creates each function and hands it to
-- slugbase_system, which needs CREATE on the schema for the length of those
-- statements. The account is a parameter of each, so another account's row or
-- session is never read or changed.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_account_password_hash(account_id): the argon2id hash the application
-- verifies a typed password against, for an account that exists, is not
-- disabled and has a password. NULL for an unknown or disabled account and for
-- one without a password, which the caller treats alike as "no usable password".
CREATE OR REPLACE FUNCTION public.sys_account_password_hash(p_account_id uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT a.password_hash FROM public.accounts a WHERE a.id = p_account_id AND a.disabled_at IS NULL
  $$;

-- sys_session_reauth(id, account_id): records that the session re-authenticated
-- now, on the database clock, and says whether a full session of the account
-- with that id exists. A partial session, or one of another account, is left
-- as it is.
CREATE OR REPLACE FUNCTION public.sys_session_reauth(p_id uuid, p_account_id uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF p_id IS NULL OR p_account_id IS NULL THEN
    RAISE EXCEPTION 'sys_session_reauth needs a session and an account'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.sessions SET reauth_at = clock_timestamp()
  WHERE id = p_id AND account_id = p_account_id AND level = 'full';
  RETURN FOUND;
END
$$;

-- sys_password_set(account_id, hash): stores a new password hash and sets
-- password_changed_at to now, which invalidates every session of the account
-- created before it (sys_session_lookup and sys_list_sessions compare against
-- it). It checks the shape of an argon2id PHC string and nothing more: the
-- $argon2id$ prefix, an optional version field, the m, t and p parameters, and
-- a salt field and a hash field, each non-empty base64 without padding; any
-- other string, a leading or trailing space or newline included, is refused
-- with invalid_parameter_value. It does not check the lengths of the salt or
-- the hash, nor that the hash decodes: the application's hasher is the only
-- writer (this function is called only through AuthStore.changePassword, and
-- through AuthStore.verifyEmail and AuthStore.resetPassword by way of
-- sys_email_verify and sys_password_reset) and sets those. Answers false, and
-- changes nothing, for an unknown or disabled account.
CREATE OR REPLACE FUNCTION public.sys_password_set(p_account_id uuid, p_hash text) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF p_account_id IS NULL OR p_hash IS NULL OR p_hash !~ '^[$]argon2id[$](v=[0-9]+[$])?m=[0-9]+,t=[0-9]+,p=[0-9]+[$][A-Za-z0-9+/]+[$][A-Za-z0-9+/]+$' THEN
    RAISE EXCEPTION 'sys_password_set needs an account and a hash of the shape of an argon2id PHC string'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.accounts SET password_hash = p_hash, password_changed_at = clock_timestamp()
  WHERE id = p_account_id AND disabled_at IS NULL;
  RETURN FOUND;
END
$$;

-- sys_session_rotate(id, account_id, new_token_hash): gives one full session of
-- the account a new token and counts it as created now, so a password change
-- made earlier in the same transaction does not invalidate it. The old token
-- is refused from then on. Answers false, and changes nothing, when the account
-- has no full session with that id.
CREATE OR REPLACE FUNCTION public.sys_session_rotate(p_id uuid, p_account_id uuid, p_new_token_hash bytea) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF p_id IS NULL OR p_account_id IS NULL OR p_new_token_hash IS NULL OR octet_length(p_new_token_hash) <> 32 THEN
    RAISE EXCEPTION 'sys_session_rotate needs a session, an account and a 32-byte token hash'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.sessions SET token_hash = p_new_token_hash, created_at = clock_timestamp()
  WHERE id = p_id AND account_id = p_account_id AND level = 'full';
  RETURN FOUND;
END
$$;

ALTER FUNCTION public.sys_account_password_hash(uuid) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_session_reauth(uuid, uuid) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_password_set(uuid, text) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_session_rotate(uuid, uuid, bytea) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_account_password_hash(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_session_reauth(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_password_set(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_session_rotate(uuid, uuid, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_account_password_hash(uuid) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_session_reauth(uuid, uuid) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_password_set(uuid, text) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_session_rotate(uuid, uuid, bytea) TO slugbase_app;
--> statement-breakpoint
-- src/sql/140-mfa.sql
-- The system operations behind the second factor (doc 05 sections 2.1, 3.1 and
-- 3.3, doc 02 sections 2.3 and 2.7, doc 10 T7 and T17). The columns and the
-- table are defined in src/schema/. All eleven functions are entered in
-- src/system/registry.ts. slugbase_owner creates each function and hands it to
-- slugbase_system, which needs CREATE on the schema for the length of those
-- statements.
--
-- accounts.mfa_enabled_at, mfa_secret, mfa_secret_key_id and mfa_last_step are
-- not in the column list slugbase_app may SELECT (060-accounts-sessions.sql),
-- and no UPDATE on them is granted: the application reads and writes them only
-- through sys_mfa_get_secret, sys_mfa_set and sys_mfa_accept_step. The secret
-- reaches the database sealed by the secret box; none of these functions sees
-- or returns a plaintext secret, a code or a backup code.
--
-- mfa_backup_codes: forced row-level security and no policy, and slugbase_app
-- holds no privilege on it. sys_backup_codes_replace and sys_backup_code_consume
-- are its only writers.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_mfa_get_secret(account_id): the sealed secret of the account with the id
-- of the key that sealed it, the time MFA was enabled (enabled_at) and the
-- latest accepted time step (last_step; null before the first). No row for an
-- unknown or disabled account and for one with no secret, which a caller does
-- not tell apart. A pending enrolment (a secret with enabled_at null) is
-- returned like an active one; enabled_at says which it is.
CREATE OR REPLACE FUNCTION public.sys_mfa_get_secret(p_account_id uuid)
  RETURNS TABLE (secret bytea, key_id text, enabled_at timestamptz, last_step bigint)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT a.mfa_secret, a.mfa_secret_key_id, a.mfa_enabled_at, a.mfa_last_step
    FROM public.accounts a
    WHERE a.id = p_account_id AND a.disabled_at IS NULL AND a.mfa_secret IS NOT NULL
  $$;

-- sys_mfa_set(account_id, action, secret, key_id, expected_secret): the one
-- writer of the secret and of enabled_at. It answers whether it changed the
-- account's row, and changes nothing for an unknown or disabled account. The
-- action is one of:
--   start     stores a pending secret and forgets the last accepted step. It
--             replaces an earlier pending secret and is refused (false) for an
--             account whose MFA is enabled, so the secret of an active factor is
--             never replaced through it. expected_secret must be null.
--   reseal    stores the same secret sealed under another key. It writes only
--             when the stored ciphertext still is expected_secret, so a
--             re-sealing made from a read that has since been replaced (a new
--             enrolment, another re-sealing) writes nothing. It never touches
--             enabled_at or last_step.
--   activate  sets enabled_at to now. It writes only when MFA is not yet
--             enabled, the stored ciphertext is expected_secret (the one the
--             caller verified a code against) and a time step was accepted for
--             it (sys_mfa_accept_step). secret and key_id must be null.
-- A sealed value is at least the 12-byte IV and 16-byte tag of the secret box
-- and one byte; any other shape of argument is refused with
-- invalid_parameter_value.
CREATE OR REPLACE FUNCTION public.sys_mfa_set(
  p_account_id uuid,
  p_action text,
  p_secret bytea,
  p_key_id text,
  p_expected_secret bytea
) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  c_min_sealed CONSTANT integer := 29;
  c_max_sealed CONSTANT integer := 1024;
BEGIN
  IF NOT coalesce(
    p_account_id IS NOT NULL
    AND CASE p_action
      WHEN 'start' THEN
        octet_length(p_secret) BETWEEN c_min_sealed AND c_max_sealed
        AND length(p_key_id) BETWEEN 1 AND 128 AND p_expected_secret IS NULL
      WHEN 'reseal' THEN
        octet_length(p_secret) BETWEEN c_min_sealed AND c_max_sealed
        AND length(p_key_id) BETWEEN 1 AND 128
        AND octet_length(p_expected_secret) BETWEEN c_min_sealed AND c_max_sealed
      WHEN 'activate' THEN
        p_secret IS NULL AND p_key_id IS NULL
        AND octet_length(p_expected_secret) BETWEEN c_min_sealed AND c_max_sealed
      ELSE false
    END,
    false
  ) THEN
    RAISE EXCEPTION 'sys_mfa_set needs an account, the action start, reseal or activate, and the sealed values that action takes'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_action = 'start' THEN
    UPDATE public.accounts
    SET mfa_secret = p_secret, mfa_secret_key_id = p_key_id, mfa_last_step = NULL
    WHERE id = p_account_id AND disabled_at IS NULL AND mfa_enabled_at IS NULL;
  ELSIF p_action = 'reseal' THEN
    UPDATE public.accounts
    SET mfa_secret = p_secret, mfa_secret_key_id = p_key_id
    WHERE id = p_account_id AND disabled_at IS NULL AND mfa_secret = p_expected_secret;
  ELSE
    UPDATE public.accounts
    SET mfa_enabled_at = clock_timestamp()
    WHERE id = p_account_id AND disabled_at IS NULL AND mfa_enabled_at IS NULL
      AND mfa_secret = p_expected_secret AND mfa_last_step IS NOT NULL;
  END IF;
  RETURN FOUND;
END
$$;

-- sys_mfa_accept_step(account_id, step): records the TOTP time step of a code
-- that verified, and says whether it was new: a step at or below the latest
-- accepted one (a replay, or an older code) changes nothing and answers false.
-- The comparison and the write are one statement on the locked row, so two
-- requests presenting one code never both succeed. The account must exist, not
-- be disabled and have a secret (pending or active).
CREATE OR REPLACE FUNCTION public.sys_mfa_accept_step(p_account_id uuid, p_step bigint) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF p_account_id IS NULL OR p_step IS NULL OR p_step < 1 THEN
    RAISE EXCEPTION 'sys_mfa_accept_step needs an account and a positive time step'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.accounts SET mfa_last_step = p_step
  WHERE id = p_account_id AND disabled_at IS NULL AND mfa_secret IS NOT NULL
    AND (mfa_last_step IS NULL OR mfa_last_step < p_step);
  RETURN FOUND;
END
$$;

-- sys_backup_codes_replace(account_id, ids, hashes): gives the account exactly
-- this set of backup codes, deleting the ones it had, in one call. The
-- application generates the identifiers (UUIDv7) and hashes each code with
-- argon2id; `hashes[i]` belongs to `ids[i]`. Between 1 and 20 codes, no null
-- and no empty hash. Answers false, and changes nothing, for an unknown or
-- disabled account and for one whose MFA is not enabled.
CREATE OR REPLACE FUNCTION public.sys_backup_codes_replace(p_account_id uuid, p_ids uuid[], p_hashes bytea[]) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF NOT coalesce(
    p_account_id IS NOT NULL
    AND cardinality(p_ids) BETWEEN 1 AND 20
    AND cardinality(p_ids) = cardinality(p_hashes)
    AND NOT EXISTS (SELECT 1 FROM unnest(p_ids) AS i WHERE i IS NULL)
    AND NOT EXISTS (SELECT 1 FROM unnest(p_hashes) AS h WHERE h IS NULL OR octet_length(h) = 0),
    false
  ) THEN
    RAISE EXCEPTION 'sys_backup_codes_replace needs an account and between 1 and 20 identifiers with as many non-empty hashes'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.accounts a
    WHERE a.id = p_account_id AND a.disabled_at IS NULL AND a.mfa_enabled_at IS NOT NULL
  ) THEN
    RETURN false;
  END IF;
  DELETE FROM public.mfa_backup_codes WHERE account_id = p_account_id;
  INSERT INTO public.mfa_backup_codes (id, account_id, code_hash)
  SELECT c.id, p_account_id, c.code_hash FROM unnest(p_ids, p_hashes) AS c (id, code_hash);
  RETURN true;
END
$$;

-- sys_backup_code_consume(account_id, code_id): marks one unused backup code of
-- the account as used, now, and says whether it did. A code that is already
-- used, one of another account and one that does not exist answer false alike.
-- The test and the write are one statement, so a code presented twice at once
-- is accepted once. The application has verified the typed code against the
-- code's hash before it asks.
CREATE OR REPLACE FUNCTION public.sys_backup_code_consume(p_account_id uuid, p_code_id uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF p_account_id IS NULL OR p_code_id IS NULL THEN
    RAISE EXCEPTION 'sys_backup_code_consume needs an account and a code'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.mfa_backup_codes c SET used_at = clock_timestamp()
  WHERE c.id = p_code_id AND c.account_id = p_account_id AND c.used_at IS NULL
    AND EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = c.account_id AND a.disabled_at IS NULL);
  RETURN FOUND;
END
$$;

-- sys_backup_codes_unused(account_id): the account's backup codes that are not
-- used yet, as the application checks a typed code against them: argon2id
-- hashes are salted, so the database cannot verify a code itself. It lists the
-- code's id and its hash (the argon2id PHC string, as bytes), oldest first, and
-- nothing for an unknown or disabled account and for one whose MFA is not on.
-- The application then consumes the matching code by id
-- (sys_backup_code_consume).
CREATE OR REPLACE FUNCTION public.sys_backup_codes_unused(p_account_id uuid)
  RETURNS TABLE (id uuid, code_hash bytea)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT c.id, c.code_hash
    FROM public.mfa_backup_codes c
    JOIN public.accounts a ON a.id = c.account_id
    WHERE c.account_id = p_account_id AND c.used_at IS NULL
      AND a.disabled_at IS NULL AND a.mfa_enabled_at IS NOT NULL
    ORDER BY c.id
  $$;

-- sys_session_promote(id, account_id, new_token_hash): completes the sign-in of
-- a partial session. The session becomes a full one under the new token, counted
-- as created now, with the sliding window its remember flag chose and the 180-day
-- absolute cap from now, and its failure count is cleared; the old token is
-- refused from then on, and the account's last sign-in time is set. It answers
-- false, and changes nothing, when the account has no such partial session: one
-- that is full, expired, created before the account's password change, of
-- another account, or whose account is disabled or has no MFA. The account row
-- is locked first, as every other function that touches both rows does.
CREATE OR REPLACE FUNCTION public.sys_session_promote(p_id uuid, p_account_id uuid, p_new_token_hash bytea) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_changed_at timestamptz;
BEGIN
  IF p_id IS NULL OR p_account_id IS NULL OR p_new_token_hash IS NULL OR octet_length(p_new_token_hash) <> 32 THEN
    RAISE EXCEPTION 'sys_session_promote needs a session, an account and a 32-byte token hash'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT a.password_changed_at INTO v_changed_at
  FROM public.accounts a
  WHERE a.id = p_account_id AND a.disabled_at IS NULL AND a.mfa_enabled_at IS NOT NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE public.sessions s
  SET level = 'full', token_hash = p_new_token_hash, created_at = v_now, last_seen_at = v_now,
      expires_at = v_now + CASE WHEN s.remember THEN interval '90 days' ELSE interval '30 days' END,
      absolute_expires_at = v_now + interval '180 days', mfa_failures = 0
  WHERE s.id = p_id AND s.account_id = p_account_id AND s.level = 'partial'
    AND s.expires_at > v_now AND s.absolute_expires_at > v_now
    AND (v_changed_at IS NULL OR s.created_at >= v_changed_at);
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE public.accounts SET last_sign_in_at = v_now WHERE id = p_account_id;
  RETURN true;
END
$$;

-- sys_session_mfa_failure(id, account_id): counts one refused code against a
-- partial session and deletes the session at the fifth (doc 02 section 2.3, doc
-- 04 section 4.3). It answers whether the session is over: true when it was
-- deleted by this failure, false while it still stands. A session that is gone,
-- full or of another account answers true and changes nothing. The count and
-- the deletion are one call on the locked row, so failures made at once are all
-- counted.
CREATE OR REPLACE FUNCTION public.sys_session_mfa_failure(p_id uuid, p_account_id uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  c_max_failures CONSTANT smallint := 5;
  v_failures smallint;
BEGIN
  IF p_id IS NULL OR p_account_id IS NULL THEN
    RAISE EXCEPTION 'sys_session_mfa_failure needs a session and an account'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.sessions SET mfa_failures = mfa_failures + 1
  WHERE id = p_id AND account_id = p_account_id AND level = 'partial'
  RETURNING mfa_failures INTO v_failures;
  IF NOT FOUND THEN
    RETURN true;
  END IF;
  IF v_failures >= c_max_failures THEN
    DELETE FROM public.sessions WHERE id = p_id;
    RETURN true;
  END IF;
  RETURN false;
END
$$;

-- sys_mfa_lock(account_id): takes, for the rest of the transaction, the row locks
-- that a change of the account's whole second factor needs, in the one order
-- every writer of these rows uses: the account's backup-code rows (in id
-- order), then the account row, and after them the session row (sys_session_*).
-- A sign-in with a backup code consumes the code row and then promotes the
-- session, which locks the account row; taking the account row before the code
-- rows here would let the two wait for each other. Answers false, and locks
-- nothing of the account, when it does not exist, is disabled or has MFA off. A
-- caller that rewrites the backup codes or turns MFA off calls it first, so that
-- two of them made at once queue instead of each leaving a set of codes the
-- other cannot see (each later statement of the transaction sees what the
-- earlier holder committed).
CREATE OR REPLACE FUNCTION public.sys_mfa_lock(p_account_id uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'sys_mfa_lock needs an account'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM 1 FROM public.mfa_backup_codes c WHERE c.account_id = p_account_id ORDER BY c.id FOR UPDATE;
  PERFORM 1 FROM public.accounts a
  WHERE a.id = p_account_id AND a.disabled_at IS NULL AND a.mfa_enabled_at IS NOT NULL
  FOR UPDATE;
  RETURN FOUND;
END
$$;

-- sys_mfa_disable(account_id): turns the second factor off: clears the secret,
-- its key id, enabled_at and the last accepted step, and deletes every backup
-- code of the account, used ones included. Answers false, and changes nothing,
-- for an unknown or disabled account and for one whose MFA is not enabled. The
-- application has checked the account's second factor and password before it
-- asks, and has called sys_mfa_lock in the same transaction.
CREATE OR REPLACE FUNCTION public.sys_mfa_disable(p_account_id uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'sys_mfa_disable needs an account'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.accounts
  SET mfa_secret = NULL, mfa_secret_key_id = NULL, mfa_enabled_at = NULL, mfa_last_step = NULL
  WHERE id = p_account_id AND disabled_at IS NULL AND mfa_enabled_at IS NOT NULL;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  DELETE FROM public.mfa_backup_codes WHERE account_id = p_account_id;
  RETURN true;
END
$$;

-- sys_account_mfa_enabled(): whether the calling account (from app_account_id(),
-- never an argument) has the second factor on, which is all the profile may say
-- of the mfa_* columns: slugbase_app has no privilege on them. True exactly when
-- mfa_enabled_at is set, so an enrolment that is only pending reads as off. It
-- returns no secret, key id or step. NULL when no account is set.
CREATE OR REPLACE FUNCTION public.sys_account_mfa_enabled() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT a.mfa_enabled_at IS NOT NULL FROM public.accounts a WHERE a.id = public.app_account_id()
  $$;

ALTER FUNCTION public.sys_mfa_get_secret(uuid) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_mfa_set(uuid, text, bytea, text, bytea) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_mfa_accept_step(uuid, bigint) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_backup_codes_replace(uuid, uuid[], bytea[]) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_backup_code_consume(uuid, uuid) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_backup_codes_unused(uuid) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_session_promote(uuid, uuid, bytea) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_session_mfa_failure(uuid, uuid) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_mfa_lock(uuid) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_mfa_disable(uuid) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_account_mfa_enabled() OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_mfa_get_secret(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_mfa_set(uuid, text, bytea, text, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_mfa_accept_step(uuid, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_backup_codes_replace(uuid, uuid[], bytea[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_backup_code_consume(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_backup_codes_unused(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_session_promote(uuid, uuid, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_session_mfa_failure(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_mfa_lock(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_mfa_disable(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_account_mfa_enabled() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_mfa_get_secret(uuid) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_mfa_set(uuid, text, bytea, text, bytea) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_mfa_accept_step(uuid, bigint) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_backup_codes_replace(uuid, uuid[], bytea[]) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_backup_code_consume(uuid, uuid) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_backup_codes_unused(uuid) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_session_promote(uuid, uuid, bytea) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_session_mfa_failure(uuid, uuid) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_mfa_lock(uuid) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_mfa_disable(uuid) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_account_mfa_enabled() TO slugbase_app;

-- mfa_backup_codes: no app access and no policy, so no role that is subject to
-- row-level security sees a row; slugbase_system, which bypasses it, reaches the
-- table through the functions above.
ALTER TABLE public.mfa_backup_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mfa_backup_codes FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mfa_backup_codes FROM PUBLIC, slugbase_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mfa_backup_codes TO slugbase_system;
--> statement-breakpoint
-- src/sql/150-api-tokens.sql
-- Row-level security and privileges of api_tokens (doc 05 sections 2.1 and
-- 3.1). The table itself is defined in src/schema/api-tokens.ts.
--
-- Management is on the account policy: an account sees and writes its own
-- tokens only, in an account-level transaction, whatever workspace a token is
-- bound to. slugbase_app may read every column but token_hash, so no list or
-- insert result can carry a hash, may insert a token with the columns a
-- creation sets (not revoked_at, last_used_at, last_used_ip_prefix or
-- created_at, which a token starts without or takes its default for), and may
-- update revoked_at alone, the one column a revocation changes. It holds no
-- DELETE: a token leaves by the cascade of its membership or account, or by
-- sys_retention_purge 30 days after it was revoked or expired.
-- last_used_at and last_used_ip_prefix are written by the token lookup, a
-- system operation; the application never sets them. slugbase_system, which
-- bypasses the policy, gets the table privileges that lookup needs and the DELETE
-- of that purge (110-retention-purge.sql). The REVOKE below is what takes an
-- INSERT on the whole table from a database that held it: a column-level GRANT
-- alone adds to a table-level one.
ALTER TABLE public.api_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_tokens FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS api_tokens_account ON public.api_tokens;
CREATE POLICY api_tokens_account ON public.api_tokens
  USING (account_id = public.app_account_id())
  WITH CHECK (account_id = public.app_account_id());
REVOKE ALL ON TABLE public.api_tokens FROM PUBLIC, slugbase_app;
GRANT SELECT (
  id, account_id, workspace_id, name, token_prefix, scope, expires_at, last_used_at, revoked_at, created_at
) ON TABLE public.api_tokens TO slugbase_app;
GRANT INSERT (
  id, account_id, workspace_id, name, token_hash, token_prefix, scope, expires_at
) ON TABLE public.api_tokens TO slugbase_app;
GRANT UPDATE (revoked_at) ON TABLE public.api_tokens TO slugbase_app;
GRANT SELECT, UPDATE, DELETE ON TABLE public.api_tokens TO slugbase_system;
--> statement-breakpoint
-- src/sql/160-api-token-lookup.sql
-- The system operation behind the bearer credential (doc 05 section 3.3, doc 01
-- section 4 stage 4). It is entered in src/system/registry.ts. The application
-- role cannot read api_tokens.token_hash, so a token is looked up only here.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_api_token_lookup(token_hash, ip_prefix): the principal behind a bearer
-- token, one round trip per request. A row comes back only for a token that has
-- not been revoked and has not expired, whose account is not disabled and whose
-- workspace is not being deleted; any other hash, a hash of a token that was
-- never issued included, gets no row, so the caller cannot tell the cases apart.
-- The role the account holds in the workspace is not part of the answer: the
-- tenant resolver reads it for every request. A token whose membership ended is
-- gone (the composite foreign key deletes it with the membership). A token last
-- used more than a minute ago has last_used_at and last_used_ip_prefix written
-- in the same call, from the database clock; p_ip_prefix is null when the client
-- address is unknown.
CREATE OR REPLACE FUNCTION public.sys_api_token_lookup(p_token_hash bytea, p_ip_prefix cidr)
  RETURNS TABLE (
    token_id uuid,
    account_id uuid,
    workspace_id uuid,
    scope text
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

  SELECT t.id AS id, t.account_id AS account, t.workspace_id AS workspace, t.scope AS scope,
         t.last_used_at AS last_used
  INTO v_row
  FROM public.api_tokens t
  JOIN public.accounts a ON a.id = t.account_id
  JOIN public.workspaces w ON w.id = t.workspace_id
  WHERE t.token_hash = p_token_hash
    AND t.revoked_at IS NULL
    AND (t.expires_at IS NULL OR t.expires_at > v_now)
    AND a.disabled_at IS NULL
    AND w.deleting_at IS NULL;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF v_row.last_used IS NULL OR v_row.last_used <= v_now - interval '1 minute' THEN
    UPDATE public.api_tokens t
    SET last_used_at = v_now, last_used_ip_prefix = p_ip_prefix
    WHERE t.id = v_row.id AND (t.last_used_at IS NULL OR t.last_used_at <= v_now - interval '1 minute');
  END IF;

  RETURN QUERY SELECT v_row.id, v_row.account, v_row.workspace, v_row.scope;
END
$$;

ALTER FUNCTION public.sys_api_token_lookup(bytea, cidr) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_api_token_lookup(bytea, cidr) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_api_token_lookup(bytea, cidr) TO slugbase_app;
--> statement-breakpoint
-- src/sql/170-oidc.sql
-- Row-level security, privileges and system operations of the OIDC sign-in (doc
-- 05 sections 2.1, 3.1 and 3.3, doc 02 sections 2.3 and 2.8, doc 10 T4, T17
-- and T20). The tables are defined in src/schema/identities.ts. The three
-- functions are entered in src/system/registry.ts. slugbase_owner creates each
-- function and hands it to slugbase_system, which needs CREATE on the schema
-- for the length of those statements.
--
-- account_identities: an account sees its own identities only. slugbase_app
-- reads the columns below and writes none: an identity is linked, and its
-- last-used time written, by system operations.
--
-- oidc_login_states: the callback is anonymous, so the table has forced
-- row-level security and no policy, and slugbase_app holds no privilege on it.
-- sys_oidc_state_create and sys_oidc_state_consume are its only users;
-- sys_retention_purge deletes what expired unconsumed (110-retention-purge.sql);
-- its FOR UPDATE SKIP LOCKED is why slugbase_system holds UPDATE as well.
ALTER TABLE public.account_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_identities FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS account_identities_account ON public.account_identities;
CREATE POLICY account_identities_account ON public.account_identities
  USING (account_id = public.app_account_id())
  WITH CHECK (account_id = public.app_account_id());
REVOKE ALL ON TABLE public.account_identities FROM PUBLIC, slugbase_app;
GRANT SELECT (id, account_id, provider, email_at_link, created_at, last_used_at) ON TABLE public.account_identities TO slugbase_app;
GRANT SELECT, UPDATE ON TABLE public.account_identities TO slugbase_system;

ALTER TABLE public.oidc_login_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oidc_login_states FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.oidc_login_states FROM PUBLIC, slugbase_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.oidc_login_states TO slugbase_system;

GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_oidc_state_create(...): stores the state of a handshake that is starting.
-- The state arrives as its SHA-256 and the PKCE verifier already sealed by the
-- secret box with the id of the key that sealed it; the record expires 10
-- minutes from now, on the database clock. The return path must be a relative
-- one and the link account must be given for the link and reauth intents only
-- (the table's checks); any argument that breaks them is refused with
-- invalid_parameter_value.
CREATE OR REPLACE FUNCTION public.sys_oidc_state_create(
  p_state_hash bytea,
  p_provider text,
  p_intent text,
  p_nonce text,
  p_code_verifier bytea,
  p_code_verifier_key_id text,
  p_return_to text,
  p_link_account_id uuid
) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF NOT coalesce(
    octet_length(p_state_hash) = 32
    AND p_provider IS NOT NULL AND p_provider <> ''
    AND p_intent IN ('login', 'link', 'reauth')
    AND p_nonce IS NOT NULL AND p_nonce <> ''
    AND p_code_verifier IS NOT NULL AND octet_length(p_code_verifier) > 0
    AND p_code_verifier_key_id IS NOT NULL AND p_code_verifier_key_id <> ''
    AND p_return_to LIKE '/%' AND length(p_return_to) <= 2048
    AND ((p_intent = 'login') = (p_link_account_id IS NULL)),
    false
  ) THEN
    RAISE EXCEPTION 'sys_oidc_state_create needs a 32-byte state hash, a provider, a login, link or reauth intent, a nonce, a sealed verifier with its key id, a relative return path and a link account for the link and reauth intents only'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO public.oidc_login_states (
    state_hash, provider, intent, nonce, code_verifier, code_verifier_key_id, return_to, link_account_id, expires_at
  ) VALUES (
    p_state_hash, p_provider, p_intent, p_nonce, p_code_verifier, p_code_verifier_key_id, p_return_to, p_link_account_id,
    clock_timestamp() + interval '10 minutes'
  );
END
$$;

-- sys_oidc_state_consume(state_hash, provider): the state of a handshake that is
-- ending. It deletes the record and returns it in one statement, so a state is
-- answered once whatever the number of concurrent callbacks; no row comes back
-- for an unknown state, a state that expired, one already consumed and one of
-- another provider, which a caller does not tell apart.
CREATE OR REPLACE FUNCTION public.sys_oidc_state_consume(p_state_hash bytea, p_provider text)
  RETURNS TABLE (
    intent text,
    nonce text,
    code_verifier bytea,
    code_verifier_key_id text,
    return_to text,
    link_account_id uuid
  )
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    DELETE FROM public.oidc_login_states s
    WHERE s.state_hash = p_state_hash
      AND s.provider = p_provider
      AND s.expires_at > clock_timestamp()
    RETURNING s.intent, s.nonce, s.code_verifier, s.code_verifier_key_id, s.return_to, s.link_account_id
  $$;

-- sys_identity_sign_in(...): signs in the account an identity is linked to. In
-- one call it finds the identity by (provider, subject), requires its account
-- to exist and not to be disabled, inserts a full session (30-day sliding
-- window, 180-day cap, created now), deletes the session of the token the
-- request carried (p_replaced_token_hash, when not null), and sets the
-- account's last sign-in time and the identity's last-used time. It answers
-- false, changing nothing, for an unknown identity and for a disabled account,
-- which a caller does not tell apart.
--
-- The session is full whether or not the account has a second factor: the
-- provider is trusted for that factor (doc 02 section 2.3), the one exception
-- to the rule of sys_session_create that a full session needs MFA off.
CREATE OR REPLACE FUNCTION public.sys_identity_sign_in(
  p_provider text,
  p_subject text,
  p_session_id uuid,
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
  v_identity_id uuid;
  v_account_id uuid;
BEGIN
  IF NOT coalesce(
    p_provider IS NOT NULL AND p_subject IS NOT NULL AND p_session_id IS NOT NULL
    AND octet_length(p_token_hash) = 32
    AND (p_replaced_token_hash IS NULL OR octet_length(p_replaced_token_hash) = 32),
    false
  ) THEN
    RAISE EXCEPTION 'sys_identity_sign_in needs a provider, a subject, a session id and 32-byte token hashes'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT i.id, a.id INTO v_identity_id, v_account_id
  FROM public.account_identities i
  JOIN public.accounts a ON a.id = i.account_id
  WHERE i.provider = p_provider AND i.subject = p_subject AND a.disabled_at IS NULL;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  INSERT INTO public.sessions (
    id, token_hash, account_id, level, remember, created_at, last_seen_at, expires_at, absolute_expires_at,
    ip_prefix, user_agent
  ) VALUES (
    p_session_id, p_token_hash, v_account_id, 'full', false, v_now, v_now, v_now + interval '30 days', v_now + interval '180 days',
    p_ip_prefix, left(p_user_agent, 256)
  );
  IF p_replaced_token_hash IS NOT NULL THEN
    DELETE FROM public.sessions WHERE token_hash = p_replaced_token_hash;
  END IF;
  UPDATE public.accounts SET last_sign_in_at = v_now WHERE id = v_account_id;
  UPDATE public.account_identities SET last_used_at = v_now WHERE id = v_identity_id;
  RETURN true;
END
$$;

ALTER FUNCTION public.sys_oidc_state_create(bytea, text, text, text, bytea, text, text, uuid) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_oidc_state_consume(bytea, text) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_identity_sign_in(text, text, uuid, cidr, text, bytea, bytea) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_oidc_state_create(bytea, text, text, text, bytea, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_oidc_state_consume(bytea, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_identity_sign_in(text, text, uuid, cidr, text, bytea, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_oidc_state_create(bytea, text, text, text, bytea, text, text, uuid) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_oidc_state_consume(bytea, text) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_identity_sign_in(text, text, uuid, cidr, text, bytea, bytea) TO slugbase_app;
--> statement-breakpoint
-- src/sql/180-identity-management.sql
-- The system operations behind linking, unlinking and re-authenticating with an
-- OIDC identity, and behind setting the first password of an account that has
-- none (doc 05 section 3.3, doc 02 sections 2.5 and 2.8, doc 04 sections 4.4 and
-- 10.3, doc 10 T18 and T20). All four are entered in src/system/registry.ts.
-- slugbase_owner creates each function and hands it to slugbase_system, which
-- needs CREATE on the schema for the length of those statements. The account is
-- a parameter of each, so another account's identity, session or password is
-- never read or changed. slugbase_app still holds no write privilege on
-- account_identities: an identity is linked and unlinked here only.
GRANT INSERT, DELETE ON TABLE public.account_identities TO slugbase_system;

GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_identity_link(account_id, id, provider, subject, email): adds the identity
-- the provider asserted to the account. Answers 'linked' for a new link,
-- 'already_linked' when the account holds this identity already (nothing
-- changes), 'taken' when another account holds it (nothing changes), and
-- 'no_account' for an unknown or disabled account. The account's row is locked
-- first, so linking and unlinking an account's identities queue on it. The
-- address is stored as asserted, cut at 320 characters; an unverified address is
-- no reason to refuse an explicit link (doc 02 section 2.8).
CREATE OR REPLACE FUNCTION public.sys_identity_link(
  p_account_id uuid,
  p_id uuid,
  p_provider text,
  p_subject text,
  p_email text
) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_owner uuid;
BEGIN
  IF NOT coalesce(
    p_account_id IS NOT NULL AND p_id IS NOT NULL AND p_email IS NOT NULL
    AND length(p_provider) BETWEEN 1 AND 64
    AND length(p_subject) BETWEEN 1 AND 255,
    false
  ) THEN
    RAISE EXCEPTION 'sys_identity_link needs an account, an identifier, a provider of 1 to 64 characters, a subject of 1 to 255 characters and an address'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM 1 FROM public.accounts WHERE id = p_account_id AND disabled_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'no_account';
  END IF;

  INSERT INTO public.account_identities (id, account_id, provider, subject, email_at_link)
  VALUES (p_id, p_account_id, p_provider, p_subject, left(p_email, 320))
  ON CONFLICT (provider, subject) DO NOTHING;
  IF FOUND THEN
    RETURN 'linked';
  END IF;

  SELECT account_id INTO v_owner FROM public.account_identities WHERE provider = p_provider AND subject = p_subject;
  RETURN CASE WHEN v_owner = p_account_id THEN 'already_linked' ELSE 'taken' END;
END
$$;

-- sys_identity_unlink(account_id, id): deletes the account's identity with this
-- id. Answers 'unlinked', 'not_found' for an id the account does not hold (another
-- account's included, which a caller does not tell apart) and
-- 'last_sign_in_method', changing nothing, when the account has no password and
-- no other identity. The account's row is locked before the count, so two
-- unlinks made at once from two sessions cannot each see the other identity and
-- both delete.
CREATE OR REPLACE FUNCTION public.sys_identity_unlink(p_account_id uuid, p_id uuid) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_has_password boolean;
BEGIN
  IF p_account_id IS NULL OR p_id IS NULL THEN
    RAISE EXCEPTION 'sys_identity_unlink needs an account and an identity'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.password_hash IS NOT NULL INTO v_has_password
  FROM public.accounts a WHERE a.id = p_account_id AND a.disabled_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  PERFORM 1 FROM public.account_identities WHERE id = p_id AND account_id = p_account_id;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  IF NOT v_has_password
     AND NOT EXISTS (SELECT 1 FROM public.account_identities WHERE account_id = p_account_id AND id <> p_id) THEN
    RETURN 'last_sign_in_method';
  END IF;

  DELETE FROM public.account_identities WHERE id = p_id AND account_id = p_account_id;
  RETURN 'unlinked';
END
$$;

-- sys_identity_reauth(session_id, account_id, provider, subject): records that
-- the full session of the account re-authenticated now, on the database clock,
-- because the provider asserted an identity the account holds, and sets that
-- identity's last-used time. Answers false, changing nothing, when the account
-- does not hold the identity, is disabled, or has no full session with that id:
-- an identity of another account re-authenticates nothing.
CREATE OR REPLACE FUNCTION public.sys_identity_reauth(
  p_session_id uuid,
  p_account_id uuid,
  p_provider text,
  p_subject text
) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_identity_id uuid;
BEGIN
  IF p_session_id IS NULL OR p_account_id IS NULL OR p_provider IS NULL OR p_subject IS NULL THEN
    RAISE EXCEPTION 'sys_identity_reauth needs a session, an account, a provider and a subject'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT i.id INTO v_identity_id
  FROM public.account_identities i
  JOIN public.accounts a ON a.id = i.account_id
  WHERE i.account_id = p_account_id AND i.provider = p_provider AND i.subject = p_subject AND a.disabled_at IS NULL;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE public.sessions SET reauth_at = v_now
  WHERE id = p_session_id AND account_id = p_account_id AND level = 'full';
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE public.account_identities SET last_used_at = v_now WHERE id = v_identity_id;
  RETURN true;
END
$$;

-- sys_password_set_initial(account_id, hash): stores the first password hash of
-- an account that has none, like sys_password_set (which it calls, so the same
-- shape of an argon2id PHC string is required). Answers false, changing nothing,
-- for an unknown or disabled account and for an account that already has a
-- password, so a first password never replaces one. The account's row is locked
-- before it is read.
CREATE OR REPLACE FUNCTION public.sys_password_set_initial(p_account_id uuid, p_hash text) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_hash text;
BEGIN
  IF p_account_id IS NULL OR p_hash IS NULL THEN
    RAISE EXCEPTION 'sys_password_set_initial needs an account and a hash'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT password_hash INTO v_hash FROM public.accounts WHERE id = p_account_id AND disabled_at IS NULL FOR UPDATE;
  IF NOT FOUND OR v_hash IS NOT NULL THEN
    RETURN false;
  END IF;
  RETURN public.sys_password_set(p_account_id, p_hash);
END
$$;

ALTER FUNCTION public.sys_identity_link(uuid, uuid, text, text, text) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_identity_unlink(uuid, uuid) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_identity_reauth(uuid, uuid, text, text) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_password_set_initial(uuid, text) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_identity_link(uuid, uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_identity_unlink(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_identity_reauth(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_password_set_initial(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_identity_link(uuid, uuid, text, text, text) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_identity_unlink(uuid, uuid) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_identity_reauth(uuid, uuid, text, text) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_password_set_initial(uuid, text) TO slugbase_app;
--> statement-breakpoint
-- src/sql/190-credential-tokens.sql
-- Row-level security, privileges and system operations of the emailed single-use
-- tokens (doc 05 sections 2.1 and 3.3, doc 02 sections 2.5 and 2.6, doc 10 T4 and
-- T8). The table is defined in src/schema/credential-tokens.ts. Both functions
-- are entered in src/system/registry.ts. slugbase_owner creates each function
-- and hands it to slugbase_system, which needs CREATE on the schema for the
-- length of those statements.
--
-- credential_tokens: a token is redeemed anonymously, by possession of the link,
-- so the table has forced row-level security and no policy, and slugbase_app
-- holds no privilege on it. sys_credential_token_issue and
-- sys_credential_token_consume are its only users; sys_retention_purge deletes a
-- token 7 days after it was used or expired (110-retention-purge.sql); its
-- FOR UPDATE SKIP LOCKED is why slugbase_system holds UPDATE as well.
ALTER TABLE public.credential_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credential_tokens FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.credential_tokens FROM PUBLIC, slugbase_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.credential_tokens TO slugbase_system;

GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_credential_token_issue(id, purpose, account_id, hash, target_email,
-- ttl_seconds): stores the SHA-256 of a token the application generated, under
-- the identifier it generated, and deletes the account's older unused tokens of
-- the same purpose in the same call, so at most one token of a purpose works at
-- a time. The expiry is set from the database clock. The account's row is locked
-- first, so two issues for one account queue and the later one leaves exactly
-- its own token. Answers false, changing nothing, for an unknown or disabled
-- account; an argument that breaks the table's checks, or a lifetime outside 1
-- second to 7 days, is refused with invalid_parameter_value.
CREATE OR REPLACE FUNCTION public.sys_credential_token_issue(
  p_id uuid,
  p_purpose text,
  p_account_id uuid,
  p_token_hash bytea,
  p_target_email text,
  p_ttl_seconds integer
) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF NOT coalesce(
    p_id IS NOT NULL AND p_account_id IS NOT NULL
    AND p_purpose IN ('email_verify', 'email_change', 'email_change_cancel', 'password_reset')
    AND octet_length(p_token_hash) = 32
    AND p_ttl_seconds BETWEEN 1 AND 604800,
    false
  ) THEN
    RAISE EXCEPTION 'sys_credential_token_issue needs an identifier, a known purpose, an account, a 32-byte token hash and a lifetime of 1 second to 7 days'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM 1 FROM public.accounts WHERE id = p_account_id AND disabled_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  DELETE FROM public.credential_tokens
  WHERE account_id = p_account_id AND purpose = p_purpose AND used_at IS NULL;

  INSERT INTO public.credential_tokens (id, purpose, account_id, token_hash, target_email, expires_at)
  VALUES (
    p_id, p_purpose, p_account_id, p_token_hash, p_target_email::public.citext,
    clock_timestamp() + p_ttl_seconds * interval '1 second'
  );
  RETURN true;
END
$$;

-- sys_credential_token_consume(purpose, hash): redeems a token. The row is marked
-- used and returned in one statement, so a token is answered once whatever the
-- number of concurrent requests; no row comes back for an unknown token, one of
-- another purpose, one already used and one past its expiry, which a caller does
-- not tell apart. What the redemption does with the account is the caller's.
CREATE OR REPLACE FUNCTION public.sys_credential_token_consume(p_purpose text, p_token_hash bytea)
  RETURNS TABLE (account_id uuid, target_email public.citext)
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    UPDATE public.credential_tokens t
    SET used_at = clock_timestamp()
    WHERE t.purpose = p_purpose
      AND t.token_hash = p_token_hash
      AND t.used_at IS NULL
      AND t.expires_at > clock_timestamp()
    RETURNING t.account_id, t.target_email
  $$;

ALTER FUNCTION public.sys_credential_token_issue(uuid, text, uuid, bytea, text, integer) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_credential_token_consume(text, bytea) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_credential_token_issue(uuid, text, uuid, bytea, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_credential_token_consume(text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_credential_token_issue(uuid, text, uuid, bytea, text, integer) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_credential_token_consume(text, bytea) TO slugbase_app;
--> statement-breakpoint
-- src/sql/200-signin-alerts.sql
-- The system operation behind the "new sign-in" email (doc 02 section 12, doc 05
-- sections 2.1 and 3.3, doc 10 T7), entered in src/system/registry.ts.
-- slugbase_owner creates the function and hands it to slugbase_system, which
-- needs CREATE on the schema for the length of those statements. sessions stays
-- closed to slugbase_app: this function is the only way the alert reads it.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_signin_alert_context(account_id, ip_prefix): what the sign-in of an account
-- needs to know to decide whether to alert it, read before the new session is
-- created. alerts_on is the account's signin_alerts flag; signed_in_before is
-- whether the account has had a full session before (last_sign_in_at is set by
-- every full session's creation), so the account's first session is never a new
-- device; user_agents holds the user agent of every live session of the account
-- that was created from the same stored IP prefix, each once (a session with no
-- user agent is an empty string, and an unknown prefix matches an unknown
-- prefix). A live
-- session is the one sys_list_sessions lists: full, unexpired (sliding and
-- absolute) and not older than the account's password change. No row for an
-- unknown or disabled account. The caller compares user-agent families, which
-- the database does not know.
CREATE OR REPLACE FUNCTION public.sys_signin_alert_context(p_account_id uuid, p_ip_prefix cidr)
  RETURNS TABLE (alerts_on boolean, signed_in_before boolean, user_agents text[])
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT a.signin_alerts,
           a.last_sign_in_at IS NOT NULL,
           coalesce(
             (SELECT array_agg(DISTINCT coalesce(s.user_agent, ''))
              FROM public.sessions s
              WHERE s.account_id = a.id
                AND s.level = 'full'
                AND s.expires_at > clock_timestamp()
                AND s.absolute_expires_at > clock_timestamp()
                AND (a.password_changed_at IS NULL OR s.created_at >= a.password_changed_at)
                AND s.ip_prefix IS NOT DISTINCT FROM p_ip_prefix),
             ARRAY[]::text[])
    FROM public.accounts a
    WHERE a.id = p_account_id AND a.disabled_at IS NULL
  $$;

ALTER FUNCTION public.sys_signin_alert_context(uuid, cidr) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_signin_alert_context(uuid, cidr) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_signin_alert_context(uuid, cidr) TO slugbase_app;
--> statement-breakpoint
-- src/sql/210-email-verification.sql
-- The system operations behind verifying a registered address and the personal
-- workspace of the account, and the read that tells a sign-in whether the address
-- was verified (doc 05 section 3.3, doc 02 sections 2.2, 2.3 and 2.6, doc 04
-- section 10.2, doc 10 T4 and T8). All are entered in src/system/registry.ts.
-- slugbase_owner creates each function and hands it to slugbase_system, which
-- needs CREATE on the schema for the length of those statements.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_email_verify(token_hash, password_hash, session_id, session_token_hash,
-- ip_prefix, user_agent, replaced_token_hash): redeems a signup verification
-- token and signs the account in, all in this one call. The row of the account
-- the token belongs to is locked first, found by a read that locks nothing, and
-- the token is consumed after that (sys_credential_token_consume: once, before
-- its expiry, purpose email_verify), the order in which
-- sys_credential_token_issue takes the same two rows, so a redemption and an
-- issue for one account queue and do not wait on each other. No row comes back
-- for an unknown, used, expired or foreign token, and none for an account that
-- is disabled, which a caller does not tell apart. An account whose address was
-- never verified is the one a visitor registered, and the visitor is not
-- necessarily the owner of the address, so verifying it takes the password the
-- owner chose: the stored hash is replaced (sys_password_set, which also moves
-- password_changed_at), every session of the account is deleted, and everything
-- else the visitor could have set up while signed in is removed with it: the
-- second factor (a pending enrolment included) and its backup codes, the API
-- tokens, the linked identities and the pending handshakes that would link one,
-- every unused password-reset token, since a reset requested before the
-- owner verified is not the owner's, and the pending change of email with its
-- unused confirmation and cancel tokens, since a change started before the owner
-- verified is not the owner's either. Only then is the address marked verified.
-- An account that is already verified keeps all of it. The
-- session is partial for an account whose second factor is on and full
-- otherwise, and replaces the session of the token the request carried. The
-- account row is locked before anything is changed, so two redemptions of
-- tokens of one account queue.
CREATE OR REPLACE FUNCTION public.sys_email_verify(
  p_token_hash bytea,
  p_password_hash text,
  p_session_id uuid,
  p_session_token_hash bytea,
  p_ip_prefix cidr,
  p_user_agent text,
  p_replaced_token_hash bytea
) RETURNS TABLE (verified_account_id uuid, session_level text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_account uuid;
  v_verified_at timestamptz;
  v_mfa boolean;
  v_level text;
BEGIN
  IF NOT coalesce(
    octet_length(p_token_hash) = 32 AND p_password_hash IS NOT NULL AND p_session_id IS NOT NULL
    AND octet_length(p_session_token_hash) = 32
    AND (p_replaced_token_hash IS NULL OR octet_length(p_replaced_token_hash) = 32),
    false
  ) THEN
    RAISE EXCEPTION 'sys_email_verify needs a 32-byte token hash, a password hash, a session and a 32-byte session token hash'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM 1 FROM public.accounts a
  WHERE a.id = (SELECT t.account_id FROM public.credential_tokens t WHERE t.purpose = 'email_verify' AND t.token_hash = p_token_hash)
  FOR UPDATE;

  SELECT t.account_id INTO v_account FROM public.sys_credential_token_consume('email_verify', p_token_hash) t;
  IF v_account IS NULL THEN
    RETURN;
  END IF;

  SELECT a.email_verified_at, a.mfa_enabled_at IS NOT NULL INTO v_verified_at, v_mfa
  FROM public.accounts a
  WHERE a.id = v_account AND a.disabled_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF v_verified_at IS NULL THEN
    IF NOT public.sys_password_set(v_account, p_password_hash) THEN
      RAISE EXCEPTION 'the password of the account being verified could not be set';
    END IF;
    PERFORM public.sys_session_revoke_all(v_account, NULL);
    UPDATE public.accounts
    SET mfa_secret = NULL, mfa_secret_key_id = NULL, mfa_enabled_at = NULL, mfa_last_step = NULL, pending_email = NULL
    WHERE id = v_account;
    v_mfa := false;
    DELETE FROM public.mfa_backup_codes WHERE account_id = v_account;
    DELETE FROM public.api_tokens WHERE account_id = v_account;
    DELETE FROM public.account_identities WHERE account_id = v_account;
    DELETE FROM public.oidc_login_states WHERE link_account_id = v_account;
    DELETE FROM public.credential_tokens
    WHERE account_id = v_account AND purpose IN ('password_reset', 'email_change', 'email_change_cancel') AND used_at IS NULL;
    UPDATE public.accounts SET email_verified_at = clock_timestamp() WHERE id = v_account;
  END IF;

  v_level := CASE WHEN v_mfa THEN 'partial' ELSE 'full' END;
  IF NOT public.sys_session_create(
    p_session_id, v_account, v_level, false, p_ip_prefix, p_user_agent, p_session_token_hash, p_replaced_token_hash
  ) THEN
    RAISE EXCEPTION 'the session of the verified account could not be created';
  END IF;

  verified_account_id := v_account;
  session_level := v_level;
  RETURN NEXT;
END
$$;

-- sys_create_personal_workspace(account_id, workspace_id, name_suffix): gives the
-- account the workspace "<display name><suffix>" through sys_create_workspace,
-- unless it already owns a workspace, in which case it writes nothing, so a
-- repeated call and a verification after a registration that provisioned
-- leave one. The display name is cut so that the whole name fits the 64
-- characters a workspace name may have. The account's row is locked first, so
-- two calls for one account queue and the second finds the first's workspace.
-- Answers 'created', 'exists', or 'unavailable' for an account that does not
-- exist or is disabled.
CREATE OR REPLACE FUNCTION public.sys_create_personal_workspace(p_account_id uuid, p_workspace_id uuid, p_name_suffix text)
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_display_name text;
BEGIN
  IF NOT coalesce(
    p_account_id IS NOT NULL AND p_workspace_id IS NOT NULL AND char_length(p_name_suffix) BETWEEN 1 AND 32,
    false
  ) THEN
    RAISE EXCEPTION 'sys_create_personal_workspace needs an account, a workspace id and a name suffix of 1 to 32 characters'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.display_name INTO v_display_name
  FROM public.accounts a
  WHERE a.id = p_account_id AND a.disabled_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'unavailable';
  END IF;

  IF EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.account_id = p_account_id AND m.role = 'owner') THEN
    RETURN 'exists';
  END IF;

  IF NOT public.sys_create_workspace(
    p_account_id, p_workspace_id, rtrim(left(v_display_name, 64 - char_length(p_name_suffix))) || p_name_suffix
  ) THEN
    RAISE EXCEPTION 'the personal workspace could not be created';
  END IF;
  RETURN 'created';
END
$$;

-- sys_account_email_verified(account_id): whether the address of the account was
-- verified (email_verified_at is set), which is all a sign-in may learn of that
-- column and is asked only once the password is known good. False for an
-- account that does not exist, so a caller that requires verification never
-- reads an absent row as a verified one.
CREATE OR REPLACE FUNCTION public.sys_account_email_verified(p_account_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT coalesce(
      (SELECT a.email_verified_at IS NOT NULL FROM public.accounts a WHERE a.id = p_account_id),
      false)
  $$;

ALTER FUNCTION public.sys_email_verify(bytea, text, uuid, bytea, cidr, text, bytea) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_create_personal_workspace(uuid, uuid, text) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_account_email_verified(uuid) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_email_verify(bytea, text, uuid, bytea, cidr, text, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_create_personal_workspace(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_account_email_verified(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_email_verify(bytea, text, uuid, bytea, cidr, text, bytea) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_create_personal_workspace(uuid, uuid, text) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_account_email_verified(uuid) TO slugbase_app;
--> statement-breakpoint
-- src/sql/220-password-reset.sql
-- The system operation behind redeeming a password-reset token (doc 05 section
-- 3.3, doc 02 section 2.5, doc 04 sections 4.5 and 10.2, doc 10 T4, T8 and T17).
-- It is entered in src/system/registry.ts. slugbase_owner creates the function
-- and hands it to slugbase_system, which needs CREATE on the schema for the
-- length of those statements.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_password_reset(token_hash, password_hash, session_id, session_token_hash,
-- ip_prefix, user_agent, replaced_token_hash): redeems a password-reset token
-- and signs the account in, all in this one call. The row of the account the
-- token belongs to is locked first, found by a read that locks nothing, and the
-- token is consumed after that (sys_credential_token_consume: once, before its
-- expiry, purpose password_reset), the order in which
-- sys_credential_token_issue takes the same two rows, so a redemption and an
-- issue for one account queue and do not wait on each other. No row comes back
-- for an unknown, used, expired or foreign token, none for an account that is
-- disabled and none for one whose address was never verified, which a caller
-- does not tell apart. A reset is for the owner of a verified address: an
-- account nobody has verified may have been set up by whoever registered the
-- address first, and only the verification takes that setup away
-- (sys_email_verify). The stored hash is replaced (sys_password_set, which also
-- moves password_changed_at) and every session of
-- the account is deleted, the one of the token the request carried included.
-- The new session is partial for an account whose second factor is on and full
-- otherwise, so a mailbox that is not the account's alone cannot skip the
-- second factor. The account row is locked before anything is changed, so two
-- redemptions of tokens of one account queue.
CREATE OR REPLACE FUNCTION public.sys_password_reset(
  p_token_hash bytea,
  p_password_hash text,
  p_session_id uuid,
  p_session_token_hash bytea,
  p_ip_prefix cidr,
  p_user_agent text,
  p_replaced_token_hash bytea
) RETURNS TABLE (reset_account_id uuid, session_level text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_account uuid;
  v_mfa boolean;
  v_level text;
BEGIN
  IF NOT coalesce(
    octet_length(p_token_hash) = 32 AND p_password_hash IS NOT NULL AND p_session_id IS NOT NULL
    AND octet_length(p_session_token_hash) = 32
    AND (p_replaced_token_hash IS NULL OR octet_length(p_replaced_token_hash) = 32),
    false
  ) THEN
    RAISE EXCEPTION 'sys_password_reset needs a 32-byte token hash, a password hash, a session and a 32-byte session token hash'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM 1 FROM public.accounts a
  WHERE a.id = (SELECT t.account_id FROM public.credential_tokens t WHERE t.purpose = 'password_reset' AND t.token_hash = p_token_hash)
  FOR UPDATE;

  SELECT t.account_id INTO v_account FROM public.sys_credential_token_consume('password_reset', p_token_hash) t;
  IF v_account IS NULL THEN
    RETURN;
  END IF;

  SELECT a.mfa_enabled_at IS NOT NULL INTO v_mfa
  FROM public.accounts a
  WHERE a.id = v_account AND a.disabled_at IS NULL AND a.email_verified_at IS NOT NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF NOT public.sys_password_set(v_account, p_password_hash) THEN
    RAISE EXCEPTION 'the password of the account being reset could not be set';
  END IF;
  PERFORM public.sys_session_revoke_all(v_account, NULL);

  v_level := CASE WHEN v_mfa THEN 'partial' ELSE 'full' END;
  IF NOT public.sys_session_create(
    p_session_id, v_account, v_level, false, p_ip_prefix, p_user_agent, p_session_token_hash, p_replaced_token_hash
  ) THEN
    RAISE EXCEPTION 'the session of the account being reset could not be created';
  END IF;

  reset_account_id := v_account;
  session_level := v_level;
  RETURN NEXT;
END
$$;

ALTER FUNCTION public.sys_password_reset(bytea, text, uuid, bytea, cidr, text, bytea) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_password_reset(bytea, text, uuid, bytea, cidr, text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_password_reset(bytea, text, uuid, bytea, cidr, text, bytea) TO slugbase_app;
--> statement-breakpoint
-- src/sql/230-email-change.sql
-- The system operations behind changing the email address of an account (doc 05
-- sections 2.1 and 3.3, doc 02 section 2.6, doc 04 sections 10.2 and 10.3, doc 10 T4,
-- T8 and T18). All are entered in src/system/registry.ts. slugbase_owner creates each
-- function and hands it to slugbase_system, which needs CREATE on the schema for the
-- length of those statements.
--
-- A change is three rows of state: accounts.pending_email, an email_change token
-- (mailed to the new address) and an email_change_cancel token (mailed to the old
-- one, the "this wasn't me" link). The request stores the first and drops the
-- unused tokens of an earlier request; the mail job issues the tokens, so whether
-- the new address is free is decided where no caller sees it (sys_email_change_token_issue).
-- A cancel token records the address the account held when it was issued. Once the
-- change is confirmed, that address is no longer the account's: the token is then the
-- undo link of the confirmed change, and neither a later request nor a later
-- cancellation of the account deletes it, nor does a later notice replace it. Only
-- redeeming a cancel token (sys_email_change_cancel) ends it, and that ends the cancel
-- tokens issued after the redeemed one, which record addresses the account held later,
-- never the ones issued before it: the oldest address's link outlives every other
-- redemption. A cancel token that records no address, issued before the token recorded
-- one, is treated as one that targets the account's current address.
-- While a cancel token is unused and unexpired, the address it records is reserved to
-- its account: no other account is created on it (sys_create_account) or confirmed onto
-- it (sys_email_change_confirm, and sys_email_change_token_issue mails no confirmation
-- for it), so whoever confirmed the change cannot take the address before the owner uses
-- the link. The reservation ends when the token is used or expires; the restore in
-- sys_email_change_cancel, which moves the account itself, is not held up by it.
-- Every function that touches an account locks its row first and the tokens after,
-- the order sys_credential_token_issue takes them in, so two calls for one account
-- queue and do not wait on each other.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_email_change_request(account_id, email): records the address the account asked
-- to move to and deletes the account's unused email_change tokens and its unused
-- cancel tokens that target the address it holds (or none), so a link of an earlier
-- request stops working; the cancel token of a confirmed change, which targets the
-- address that change replaced, stays. Nothing about the address is read:
-- whether it is the account's own or another account's is for the token issue to
-- decide, so every request does the same work. False, changing nothing, for an
-- account that does not exist or is disabled; an argument that is no address-sized
-- text is refused with invalid_parameter_value.
CREATE OR REPLACE FUNCTION public.sys_email_change_request(p_account_id uuid, p_email text) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_email public.citext;
BEGIN
  IF NOT coalesce(p_account_id IS NOT NULL AND char_length(p_email) BETWEEN 3 AND 320, false) THEN
    RAISE EXCEPTION 'sys_email_change_request needs an account and an address of 3 to 320 characters'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.email INTO v_email FROM public.accounts a WHERE a.id = p_account_id AND a.disabled_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  DELETE FROM public.credential_tokens
  WHERE account_id = p_account_id AND used_at IS NULL
    AND (purpose = 'email_change' OR (purpose = 'email_change_cancel' AND (target_email IS NULL OR target_email = v_email)));
  UPDATE public.accounts SET pending_email = p_email::public.citext WHERE id = p_account_id;
  RETURN true;
END
$$;

-- sys_email_change_clear(account_id): cancels the account's pending change: the
-- pending address is cleared and the unused email_change tokens and the unused cancel
-- tokens that target the address the account holds (or none) are deleted; the cancel
-- token of a confirmed change stays, as in sys_email_change_request. Repeating it, or calling it for an account with no pending change, leaves
-- the same state. False for an account that does not exist or is disabled.
CREATE OR REPLACE FUNCTION public.sys_email_change_clear(p_account_id uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_email public.citext;
BEGIN
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'sys_email_change_clear needs an account' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.email INTO v_email FROM public.accounts a WHERE a.id = p_account_id AND a.disabled_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  DELETE FROM public.credential_tokens
  WHERE account_id = p_account_id AND used_at IS NULL
    AND (purpose = 'email_change' OR (purpose = 'email_change_cancel' AND (target_email IS NULL OR target_email = v_email)));
  UPDATE public.accounts SET pending_email = NULL WHERE id = p_account_id AND pending_email IS NOT NULL;
  RETURN true;
END
$$;

-- sys_email_change_token_issue(id, purpose, account_id, hash, ttl_seconds): stores the
-- token of an email change of the account and answers the address the change moves to.
-- Nothing is stored, and NULL comes back, when the account has no pending change, is
-- disabled or was never verified (whoever registered an address first is not
-- necessarily its owner, so such an account changes nothing, as it resets nothing:
-- sys_password_reset), and, for the purpose email_change, when the pending address is
-- the account's own, belongs to another account or is reserved to another account by
-- its unused cancel token: the confirmation is then mailed to nobody, and the caller of the request is told nothing of it. The email_change token
-- records the address it moves to (credential_tokens.target_email); the cancel token
-- records the account's current address, the one a confirmed change replaces and the
-- cancel link puts back. An older unused token of the purpose is replaced; for the
-- cancel purpose that is the account's unused cancel tokens that target the address it
-- holds (or none), so the cancel token of a confirmed change, which targets the
-- address that change replaced, is not replaced by the notice of a newer request and
-- both links work. A confirmation is stored by sys_credential_token_issue, a cancel
-- token by the insert below, in the same transaction and under the same account lock.
-- When the confirmation is declined for an address that is not free, the account's
-- unused confirmation tokens are deleted, so a link mailed by an earlier run of the job
-- does not outlive the run that found the address taken.
CREATE OR REPLACE FUNCTION public.sys_email_change_token_issue(
  p_id uuid,
  p_purpose text,
  p_account_id uuid,
  p_token_hash bytea,
  p_ttl_seconds integer
) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_email public.citext;
  v_pending public.citext;
BEGIN
  IF NOT coalesce(
    p_id IS NOT NULL AND p_account_id IS NOT NULL AND p_purpose IN ('email_change', 'email_change_cancel')
    AND octet_length(p_token_hash) = 32 AND p_ttl_seconds BETWEEN 1 AND 604800,
    false
  ) THEN
    RAISE EXCEPTION 'sys_email_change_token_issue needs an identifier, an email-change purpose, an account, a 32-byte token hash and a lifetime of 1 second to 7 days'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.email, a.pending_email INTO v_email, v_pending
  FROM public.accounts a
  WHERE a.id = p_account_id AND a.disabled_at IS NULL AND a.email_verified_at IS NOT NULL
  FOR UPDATE;
  IF NOT FOUND OR v_pending IS NULL THEN
    RETURN NULL;
  END IF;

  IF p_purpose = 'email_change' AND (
    v_pending = v_email OR EXISTS (SELECT 1 FROM public.accounts o WHERE o.email = v_pending AND o.id <> p_account_id)
    OR EXISTS (
    SELECT 1 FROM public.credential_tokens r
    WHERE r.purpose = 'email_change_cancel' AND r.used_at IS NULL AND r.expires_at > clock_timestamp()
      AND r.target_email = v_pending AND r.account_id <> p_account_id
  )
  ) THEN
    DELETE FROM public.credential_tokens
    WHERE account_id = p_account_id AND purpose = 'email_change' AND used_at IS NULL;
    RETURN NULL;
  END IF;

  IF p_purpose = 'email_change' THEN
    IF NOT public.sys_credential_token_issue(p_id, p_purpose, p_account_id, p_token_hash, v_pending::text, p_ttl_seconds) THEN
      RETURN NULL;
    END IF;
  ELSE
    DELETE FROM public.credential_tokens
    WHERE account_id = p_account_id AND purpose = 'email_change_cancel' AND used_at IS NULL
      AND (target_email IS NULL OR target_email = v_email);
    INSERT INTO public.credential_tokens (id, purpose, account_id, token_hash, target_email, expires_at, created_at)
    VALUES (p_id, p_purpose, p_account_id, p_token_hash, v_email, clock_timestamp() + p_ttl_seconds * interval '1 second', clock_timestamp());
  END IF;
  RETURN v_pending::text;
END
$$;

-- sys_email_change_confirm(token_hash): redeems the confirmation token mailed to the
-- new address and moves the account to it. The row of the account the token belongs to
-- is locked first, found by a read that locks nothing, and the token is consumed after
-- that (sys_credential_token_consume: once, before its expiry, purpose email_change).
-- NULL comes back, which a caller does not tell apart, for an unknown, used, expired,
-- replaced or foreign token, for a token of an account that is disabled or whose
-- address was never verified, for a token whose address is no longer the account's
-- pending one (the change was cancelled or asked for again), and for an address that
-- another account holds by now, whether it was taken before the call or by a
-- registration that commits while it runs, or that another account's unused, unexpired
-- cancel token reserves. The token is used up in each of those
-- cases. The address becomes the account's email and the pending address is cleared;
-- the verified time stays, since the token proved the new address, and no session ends.
-- The account's other unused confirmation tokens are deleted; its cancel token stays,
-- so the "this wasn't me" link of the notice still works after the change, and it keeps
-- working when the account requests or cancels another change afterwards.
CREATE OR REPLACE FUNCTION public.sys_email_change_confirm(p_token_hash bytea) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_account uuid;
  v_target public.citext;
BEGIN
  IF octet_length(p_token_hash) IS DISTINCT FROM 32 THEN
    RAISE EXCEPTION 'sys_email_change_confirm needs a 32-byte token hash' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM 1 FROM public.accounts a
  WHERE a.id = (SELECT t.account_id FROM public.credential_tokens t WHERE t.purpose = 'email_change' AND t.token_hash = p_token_hash)
  FOR UPDATE;

  SELECT t.account_id, t.target_email INTO v_account, v_target
  FROM public.sys_credential_token_consume('email_change', p_token_hash) t;
  IF v_account IS NULL OR v_target IS NULL THEN
    RETURN NULL;
  END IF;

  PERFORM 1 FROM public.accounts a
  WHERE a.id = v_account AND a.disabled_at IS NULL AND a.email_verified_at IS NOT NULL AND a.pending_email = v_target
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM public.accounts o WHERE o.email = v_target AND o.id <> v_account)
    OR EXISTS (
    SELECT 1 FROM public.credential_tokens r
    WHERE r.purpose = 'email_change_cancel' AND r.used_at IS NULL AND r.expires_at > clock_timestamp()
      AND r.target_email = v_target AND r.account_id <> v_account
  ) THEN
    RETURN NULL;
  END IF;

  BEGIN
    UPDATE public.accounts SET email = v_target, pending_email = NULL WHERE id = v_account;
  EXCEPTION WHEN unique_violation THEN
    RETURN NULL;
  END;
  DELETE FROM public.credential_tokens WHERE account_id = v_account AND purpose = 'email_change' AND used_at IS NULL;
  RETURN v_account;
END
$$;

-- sys_email_change_cancel(token_hash): redeems the "this wasn't me" token mailed to the
-- old address. The row of the account is locked first and the token consumed after
-- that (purpose email_change_cancel). The pending change is cancelled, the unused
-- email-change tokens are deleted and every session of the account ends, partial and
-- expired ones included. The token records the address the account had when it was
-- issued. When the change was confirmed since, the account no longer holds that
-- address: it is put back as the account's email, the verified time stays, and the
-- account's unused password-reset and email-change tokens are deleted, and so are its
-- unused cancel tokens issued after the redeemed one (or recording no address): they
-- record the addresses the account held after the one put back, so no link issued to
-- an address the undo moved away from outlives it, and one issued before the redeemed
-- one, which records an earlier address, stays: the oldest address's link still works
-- whatever order the others are redeemed in, and no redemption deletes a link to an
-- address older than the one it restores. An address that
-- another account holds by now (taken before the call or by a registration that
-- commits while it runs) is not taken over: the account keeps its current address and
-- the rest happens all the same. NULL comes back, which a caller does not tell apart,
-- for an unknown, used, expired, replaced or foreign token and for a disabled account.
CREATE OR REPLACE FUNCTION public.sys_email_change_cancel(p_token_hash bytea) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_account uuid;
  v_target public.citext;
  v_email public.citext;
  v_issued timestamptz;
BEGIN
  IF octet_length(p_token_hash) IS DISTINCT FROM 32 THEN
    RAISE EXCEPTION 'sys_email_change_cancel needs a 32-byte token hash' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM 1 FROM public.accounts a
  WHERE a.id = (SELECT t.account_id FROM public.credential_tokens t WHERE t.purpose = 'email_change_cancel' AND t.token_hash = p_token_hash)
  FOR UPDATE;

  SELECT t.account_id, t.target_email INTO v_account, v_target
  FROM public.sys_credential_token_consume('email_change_cancel', p_token_hash) t;
  IF v_account IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT a.email INTO v_email FROM public.accounts a WHERE a.id = v_account AND a.disabled_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  UPDATE public.accounts SET pending_email = NULL WHERE id = v_account AND pending_email IS NOT NULL;
  IF v_target IS NOT NULL AND v_email <> v_target THEN
    IF NOT EXISTS (SELECT 1 FROM public.accounts o WHERE o.email = v_target AND o.id <> v_account) THEN
      BEGIN
        UPDATE public.accounts SET email = v_target WHERE id = v_account;
      EXCEPTION WHEN unique_violation THEN
        NULL;
      END;
    END IF;
    SELECT t.created_at INTO v_issued FROM public.credential_tokens t WHERE t.purpose = 'email_change_cancel' AND t.token_hash = p_token_hash;
    DELETE FROM public.credential_tokens
    WHERE account_id = v_account AND used_at IS NULL
      AND (purpose IN ('password_reset', 'email_change')
        OR (purpose = 'email_change_cancel' AND (target_email IS NULL OR created_at > v_issued)));
  ELSE
    DELETE FROM public.credential_tokens WHERE account_id = v_account AND purpose = 'email_change' AND used_at IS NULL;
  END IF;
  PERFORM public.sys_session_revoke_all(v_account, NULL);
  RETURN v_account;
END
$$;

ALTER FUNCTION public.sys_email_change_request(uuid, text) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_email_change_clear(uuid) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_email_change_token_issue(uuid, text, uuid, bytea, integer) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_email_change_confirm(bytea) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_email_change_cancel(bytea) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_email_change_request(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_email_change_clear(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_email_change_token_issue(uuid, text, uuid, bytea, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_email_change_confirm(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_email_change_cancel(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_email_change_request(uuid, text) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_email_change_clear(uuid) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_email_change_token_issue(uuid, text, uuid, bytea, integer) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_email_change_confirm(bytea) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_email_change_cancel(bytea) TO slugbase_app;
--> statement-breakpoint
-- src/sql/240-oidc-first-login.sql
-- The system operation behind the first login of an OIDC identity nobody linked
-- yet (doc 05 section 3.3, doc 02 sections 2.2 and 2.8, doc 10 T17 and T20). It
-- is entered in src/system/registry.ts. slugbase_owner creates the function and
-- hands it to slugbase_system, which needs CREATE on the schema for the length
-- of those statements.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_identity_link_by_email(id, provider, subject, email): adds the identity
-- the provider asserted to the account that holds this address, for a caller
-- that has seen the provider assert the address as verified. Only an account
-- whose own address is verified and that is not disabled is a match: an address
-- somebody registered and nobody confirmed proves nothing about who owns it, so
-- a verified address at a provider never reaches the account of that
-- registration. The match is case-insensitive (the column is citext); the
-- caller passes the trimmed, NFKC-normalised address. The account's row is
-- locked by the lookup, so the match is judged on the row as it stands when the
-- identity is written, and the link is sys_identity_link's: it answers 'linked',
-- 'already_linked' (the account holds the identity), 'taken' (another account
-- holds it; nothing moves) or 'no_account' (no verified, enabled account holds
-- the address; nothing changes).
CREATE OR REPLACE FUNCTION public.sys_identity_link_by_email(
  p_id uuid,
  p_provider text,
  p_subject text,
  p_email text
) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_account_id uuid;
BEGIN
  IF NOT coalesce(
    p_id IS NOT NULL AND p_email IS NOT NULL AND p_email <> ''
    AND length(p_provider) BETWEEN 1 AND 64
    AND length(p_subject) BETWEEN 1 AND 255,
    false
  ) THEN
    RAISE EXCEPTION 'sys_identity_link_by_email needs an identifier, a provider of 1 to 64 characters, a subject of 1 to 255 characters and an address'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.id INTO v_account_id
  FROM public.accounts a
  WHERE a.email = p_email::public.citext AND a.email_verified_at IS NOT NULL AND a.disabled_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'no_account';
  END IF;

  RETURN public.sys_identity_link(v_account_id, p_id, p_provider, p_subject, p_email);
END
$$;

ALTER FUNCTION public.sys_identity_link_by_email(uuid, text, text, text) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_identity_link_by_email(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_identity_link_by_email(uuid, text, text, text) TO slugbase_app;
--> statement-breakpoint
-- src/sql/250-audit-events.sql
-- Row-level security and privileges of audit_events, and the workspace member counts of the
-- workspace list (doc 05 sections 2.9 and 3.3, doc 02 section 3.2, doc 10 T1). The table itself is
-- defined in src/schema/audit.ts. app_member_workspace_counts is entered in src/system/registry.ts.
-- slugbase_owner creates the function and hands it to slugbase_system, which needs CREATE on the
-- schema for the length of those statements.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- app_member_workspace_counts(): how many members each workspace of the calling account (from
-- app_account_id(), never an argument) has, for the workspaces that are not being deleted. The
-- workspace_members policy shows an account the rows of the active workspace and its own rows only,
-- so the count of every workspace in the switcher needs a function that runs as slugbase_system. It
-- answers a number per workspace the account belongs to and no member's identity. Outside
-- withTenant() the account is unset and nothing comes back.
CREATE OR REPLACE FUNCTION public.app_member_workspace_counts() RETURNS TABLE (workspace_id uuid, member_count bigint)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT m.workspace_id, count(*)
    FROM public.workspace_members m
    WHERE m.workspace_id IN (SELECT public.app_member_workspace_ids())
    GROUP BY m.workspace_id
  $$;

ALTER FUNCTION public.app_member_workspace_counts() OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.app_member_workspace_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_member_workspace_counts() TO slugbase_app;

-- audit_events: a workspace's events are read in that workspace only. An event is written in the
-- workspace the transaction acts in, or, in an account-level transaction that acts in none, in a
-- workspace the account is a member of: the workspace an account creates is not its active one yet,
-- and its creation event is written in the transaction that creates it. A transaction that acts in a
-- workspace never writes another's events, and an event with no workspace (a deployment-level one)
-- is admitted by no policy. slugbase_app holds SELECT and INSERT and nothing that changes or
-- removes a row: an event is deleted only by sys_retention_purge. slugbase_system, which bypasses
-- the policies, gets the privileges that purge needs and the INSERT of the system operations that
-- record an event no tenant policy admits, such as a deployment-level one (doc 05 section 3.3).
ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_events_tenant ON public.audit_events;
CREATE POLICY audit_events_tenant ON public.audit_events FOR SELECT
  USING (workspace_id = public.app_workspace_id());
DROP POLICY IF EXISTS audit_events_tenant_insert ON public.audit_events;
CREATE POLICY audit_events_tenant_insert ON public.audit_events FOR INSERT
  WITH CHECK (
    workspace_id = public.app_workspace_id()
    OR (public.app_workspace_id() IS NULL AND workspace_id IN (SELECT public.app_member_workspace_ids()))
  );
REVOKE ALL ON TABLE public.audit_events FROM PUBLIC, slugbase_app;
GRANT SELECT, INSERT ON TABLE public.audit_events TO slugbase_app;
GRANT SELECT, INSERT, DELETE ON TABLE public.audit_events TO slugbase_system;
--> statement-breakpoint
-- src/sql/260-session-active-workspace.sql
-- The system operation behind switching a session's active workspace (doc 05
-- sections 2.1 and 3.3, doc 04 section 10.4, doc 10 T1). It is entered in
-- src/system/registry.ts. slugbase_owner creates the function and hands it to
-- slugbase_system, which needs CREATE on the schema for the length of those
-- statements.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_session_set_active_workspace(session_id, account_id, workspace_id): points
-- a full session of the account at a workspace the account is a member of and
-- that is not being deleted, and says whether it did. The membership is checked
-- as of the snapshot of the statement that writes the session; the check takes
-- no lock on the membership row, so a removal that commits concurrently can
-- leave the session naming a workspace the account no longer belongs to. That
-- value is never trusted: the tenant resolver re-derives the active workspace
-- from the account's memberships on the next request. A workspace the account
-- does not belong to, one being deleted, a session of another account
-- and a partial session (its second factor is still to be given) change
-- nothing and answer false, and the caller cannot tell the first two apart. So
-- does an account other than the one a tenant transaction acts for: when
-- app_account_id() names an account, p_account_id must be that account, so a
-- transaction cannot move the session of somebody else.
CREATE OR REPLACE FUNCTION public.sys_session_set_active_workspace(p_session_id uuid, p_account_id uuid, p_workspace_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF p_session_id IS NULL OR p_account_id IS NULL OR p_workspace_id IS NULL THEN
    RAISE EXCEPTION 'sys_session_set_active_workspace needs a session, an account and a workspace'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF public.app_account_id() IS NOT NULL AND p_account_id <> public.app_account_id() THEN
    RETURN false;
  END IF;
  UPDATE public.sessions s
  SET active_workspace_id = p_workspace_id
  WHERE s.id = p_session_id AND s.account_id = p_account_id AND s.level = 'full'
    AND EXISTS (
      SELECT 1
      FROM public.workspace_members m
      JOIN public.workspaces w ON w.id = m.workspace_id
      WHERE m.workspace_id = p_workspace_id AND m.account_id = p_account_id AND w.deleting_at IS NULL
    );
  RETURN FOUND;
END
$$;

ALTER FUNCTION public.sys_session_set_active_workspace(uuid, uuid, uuid) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_session_set_active_workspace(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_session_set_active_workspace(uuid, uuid, uuid) TO slugbase_app;
--> statement-breakpoint
-- src/sql/270-member-roles.sql
-- The rule that a workspace always has an owner (doc 02 section 3.3, doc 05 section
-- 2.2, doc 10 T2). workspace_members_check_owner() is entered in
-- src/system/registry.ts. slugbase_owner creates the function and hands it to
-- slugbase_system, which needs CREATE on the schema for the length of those
-- statements.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- workspace_members_check_owner(): the trigger function behind the constraint
-- trigger below. It runs after a row of workspace_members that was an owner was
-- deleted or stopped being one in its workspace, when the transaction commits,
-- and refuses the commit (check_violation, constraint
-- workspace_members_owner_required) when the workspace then has no owner. A
-- workspace being deleted is exempt, and so is one the transaction itself
-- deleted, whose members go with it.
--
-- Two transactions that each remove a different owner of one workspace do not see
-- each other's change, so each would find the other still an owner. The function
-- therefore takes the lock of the workspace's row before it counts: the second
-- transaction waits until the first has committed, and the count that follows is
-- a statement of its own that reads what the first committed (the function is
-- VOLATILE and the transaction READ COMMITTED), so exactly one of the two
-- commits. It runs as slugbase_system so that it reads every member of the
-- workspace whatever the row-level security of the caller shows.
CREATE OR REPLACE FUNCTION public.workspace_members_check_owner() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF OLD.role <> 'owner' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.role = 'owner' AND NEW.workspace_id = OLD.workspace_id THEN
    RETURN NULL;
  END IF;
  PERFORM 1 FROM public.workspaces w
  WHERE w.id = OLD.workspace_id AND w.deleting_at IS NULL
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.workspace_id = OLD.workspace_id AND m.role = 'owner') THEN
    RAISE EXCEPTION 'the workspace would have no owner'
      USING ERRCODE = 'check_violation', TABLE = 'workspace_members', CONSTRAINT = 'workspace_members_owner_required';
  END IF;
  RETURN NULL;
END
$$;

ALTER FUNCTION public.workspace_members_check_owner() OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.workspace_members_check_owner() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.workspace_members_check_owner() TO slugbase_app;

-- A constraint trigger has no CREATE OR REPLACE, and every migration that carries the
-- files of src/sql/ runs this one again, so it is dropped and created in the same
-- migration.
DROP TRIGGER IF EXISTS workspace_members_owner_required ON public.workspace_members;
CREATE CONSTRAINT TRIGGER workspace_members_owner_required
  AFTER DELETE OR UPDATE ON public.workspace_members
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.workspace_members_check_owner();
--> statement-breakpoint
-- src/sql/280-workspace-deletion.sql
-- The system operations behind deleting a workspace (doc 05 sections 2.2, 3.3 and 7.2, doc 02 section 3.7,
-- doc 10 T1). All three are entered in src/system/registry.ts. slugbase_owner creates each function and hands it
-- to slugbase_system, which needs CREATE on the schema for the length of those statements.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_workspace_mark_deleting(workspace_id): the request half of a deletion, in the tenant transaction of the
-- owner who asks. It sets deleting_at, which hides the workspace from every policy and lookup that names it
-- (the workspaces policy, app_member_workspace_ids(), sys_session_set_active_workspace, sys_api_token_lookup),
-- points every session that had the workspace active at none, and revokes the API tokens bound to it, and says
-- whether it did. The workspace must be the one the transaction acts in (app_workspace_id()) and the account of the
-- transaction (app_account_id(), never an argument) must be an owner of it: a transaction acting in A neither
-- marks nor reads B, and an admin or a member marks nothing even if the role check of the authorization stage
-- were skipped. A workspace that is already being deleted, one that does not exist and a refused caller are all
-- false, changing nothing, and the caller cannot tell them apart. The row is locked first, with the lock the owner
-- trigger of workspace_members takes, so a removal that commits concurrently waits and then finds the workspace
-- exempt from the owner rule.
CREATE OR REPLACE FUNCTION public.sys_workspace_mark_deleting(p_workspace_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_workspace_id IS NULL THEN
    RAISE EXCEPTION 'sys_workspace_mark_deleting needs a workspace'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF public.app_account_id() IS NULL OR public.app_workspace_id() IS DISTINCT FROM p_workspace_id THEN
    RETURN false;
  END IF;
  PERFORM 1 FROM public.workspaces w
  WHERE w.id = p_workspace_id AND w.deleting_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.workspace_members m
    WHERE m.workspace_id = p_workspace_id AND m.account_id = public.app_account_id() AND m.role = 'owner'
  ) THEN
    RETURN false;
  END IF;
  UPDATE public.workspaces SET deleting_at = v_now WHERE id = p_workspace_id;
  UPDATE public.sessions SET active_workspace_id = NULL WHERE active_workspace_id = p_workspace_id;
  UPDATE public.api_tokens SET revoked_at = v_now WHERE workspace_id = p_workspace_id AND revoked_at IS NULL;
  RETURN true;
END
$$;

-- sys_workspace_purge_batch(workspace_id, table_name, batch_size): the job half of a deletion. It deletes at most
-- batch_size rows of one tenant table that belong to a workspace that is being deleted and answers how many it
-- deleted; repeating it finishes the table, and a table with nothing left answers 0. Each table is a statement of
-- its own because a system operation takes no dynamic SQL; the order the job calls them in is the registry of
-- src/purge-registry.ts, which `pnpm db:check` holds to the tables that have a workspace_id column and to this
-- function. A table this function does not know is refused whatever the workspace. A workspace that is not being
-- deleted, or is already gone, loses nothing: the function answers 0 for it. Only the worker calls it, outside any
-- tenant transaction: a transaction that acts for an account or a workspace is refused, so a request cannot hurry
-- or widen a deletion.
CREATE OR REPLACE FUNCTION public.sys_workspace_purge_batch(p_workspace_id uuid, p_table text, p_batch_size integer)
  RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_deleted bigint;
BEGIN
  IF p_workspace_id IS NULL OR p_table IS NULL OR p_batch_size IS NULL OR p_batch_size < 1 OR p_batch_size > 10000 THEN
    RAISE EXCEPTION 'sys_workspace_purge_batch needs a workspace, a table and a batch size from 1 to 10000'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_table NOT IN ('api_tokens', 'audit_events', 'workspace_invitations', 'workspace_settings', 'workspace_members') THEN
    RAISE EXCEPTION 'sys_workspace_purge_batch does not know the table %', p_table
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF public.app_account_id() IS NOT NULL OR public.app_workspace_id() IS NOT NULL THEN
    RETURN 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = p_workspace_id AND w.deleting_at IS NOT NULL) THEN
    RETURN 0;
  END IF;

  IF p_table = 'api_tokens' THEN
    DELETE FROM public.api_tokens
    WHERE id IN (SELECT t.id FROM public.api_tokens t WHERE t.workspace_id = p_workspace_id LIMIT p_batch_size);
  ELSIF p_table = 'audit_events' THEN
    DELETE FROM public.audit_events
    WHERE id IN (SELECT e.id FROM public.audit_events e WHERE e.workspace_id = p_workspace_id LIMIT p_batch_size);
  ELSIF p_table = 'workspace_invitations' THEN
    DELETE FROM public.workspace_invitations
    WHERE id IN (SELECT i.id FROM public.workspace_invitations i WHERE i.workspace_id = p_workspace_id LIMIT p_batch_size);
  ELSIF p_table = 'workspace_settings' THEN
    DELETE FROM public.workspace_settings WHERE workspace_id = p_workspace_id;
  ELSE
    DELETE FROM public.workspace_members
    WHERE (workspace_id, account_id) IN (
      SELECT m.workspace_id, m.account_id FROM public.workspace_members m WHERE m.workspace_id = p_workspace_id LIMIT p_batch_size);
  END IF;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted::integer;
END
$$;

-- sys_workspace_delete_finish(workspace_id): deletes the row of a workspace that is being deleted, which cascades
-- whatever rows the registry left, and says whether it did. A workspace that is not being deleted, one that is
-- gone already and a call inside a tenant transaction are false and delete nothing. The members that go with the
-- row are exempt from the owner rule because the transaction deleted the workspace itself.
CREATE OR REPLACE FUNCTION public.sys_workspace_delete_finish(p_workspace_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF p_workspace_id IS NULL THEN
    RAISE EXCEPTION 'sys_workspace_delete_finish needs a workspace'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF public.app_account_id() IS NOT NULL OR public.app_workspace_id() IS NOT NULL THEN
    RETURN false;
  END IF;
  DELETE FROM public.workspaces WHERE id = p_workspace_id AND deleting_at IS NOT NULL;
  RETURN FOUND;
END
$$;

ALTER FUNCTION public.sys_workspace_mark_deleting(uuid) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_workspace_purge_batch(uuid, text, integer) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_workspace_delete_finish(uuid) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_workspace_mark_deleting(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_workspace_purge_batch(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_workspace_delete_finish(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_workspace_mark_deleting(uuid) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_workspace_purge_batch(uuid, text, integer) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_workspace_delete_finish(uuid) TO slugbase_app;
--> statement-breakpoint
-- src/sql/290-account-deletion.sql
-- The system operations behind deleting an account (doc 05 sections 3.3 and 7.1, doc 02 section 2.10, doc 10 T1).
-- Both are entered in src/system/registry.ts. slugbase_owner creates each function and hands it to
-- slugbase_system, which needs CREATE on the schema for the length of those statements.
--
-- The account row is deleted by sys_delete_account only, and the events that name the account lose what names it
-- before the account is gone: the coarse network of the events it made, and the target identifier (entity_id) and
-- the `transferTo` metadata field of the events about it (doc 05 section 7.1). Those are the only columns of
-- audit_events slugbase_system may change.
GRANT DELETE ON TABLE public.accounts TO slugbase_system;
GRANT UPDATE (ip_prefix, entity_id, metadata) ON TABLE public.audit_events TO slugbase_system;

GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_account_deletion_scope(account_id): what deleting the account would do to each workspace it belongs to that is
-- not already being deleted, so the caller can refuse or ask the deletion guard before anything changes. A workspace
-- is `blocking` when the account is its only owner and it has other members (the account would leave it without an
-- owner), and `sole` when the account is its only member (it goes with the account). A workspace with another owner,
-- or one where the account is not an owner, is neither: the membership just ends. The rows of the workspaces and
-- then the account are locked first, in that order and the workspaces in identifier order, the order the member and
-- invitation paths take them in, so the answer stays true for the rest of the transaction: no member joins, leaves
-- or changes role in these workspaces and the account gains no membership until it commits. The workspaces locked
-- are those the account is a member of and those it created (created_by), members or not: deleting the account sets
-- created_by of the latter to NULL, which writes their rows, and a path that took the account first and those rows
-- after would deadlock with an invitation accepted into one of them, which takes the workspace and then the account.
-- A workspace already being deleted is locked in neither case. The account of the
-- transaction (app_account_id(), which must be the argument) is the only account that can ask; for any other
-- argument, and when no tenant account is set, nothing comes back and nothing is locked.
CREATE OR REPLACE FUNCTION public.sys_account_deletion_scope(p_account_id uuid)
  RETURNS TABLE (workspace_id uuid, workspace_name text, kind text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'sys_account_deletion_scope needs an account'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF public.app_account_id() IS DISTINCT FROM p_account_id THEN
    RETURN;
  END IF;
  PERFORM 1 FROM public.workspaces w
  WHERE w.deleting_at IS NULL
    AND (w.created_by = p_account_id
         OR w.id IN (SELECT m.workspace_id FROM public.workspace_members m WHERE m.account_id = p_account_id))
  ORDER BY w.id
  FOR UPDATE OF w;
  PERFORM 1 FROM public.accounts a WHERE a.id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT w.id, w.name,
    CASE
      WHEN c.members = 1 THEN 'sole'
      WHEN me.role = 'owner' AND c.other_owners = 0 THEN 'blocking'
    END
  FROM public.workspace_members me
  JOIN public.workspaces w ON w.id = me.workspace_id AND w.deleting_at IS NULL
  CROSS JOIN LATERAL (
    SELECT count(*) AS members, count(*) FILTER (WHERE o.role = 'owner' AND o.account_id <> p_account_id) AS other_owners
    FROM public.workspace_members o WHERE o.workspace_id = w.id
  ) c
  WHERE me.account_id = p_account_id
    AND (c.members = 1 OR (me.role = 'owner' AND c.other_owners = 0))
  ORDER BY w.id;
END
$$;

-- sys_account_last_instance_admin(account_id): whether the account holds the instance-admin flag and no other account
-- does, so deleting it would leave the instance without an admin (doc 02 section 6). It is the last step of the locks
-- of the deletion, after the workspaces and the account's own row (sys_account_deletion_scope): an account that is an
-- instance admin takes the transaction-level advisory lock of the set of admins, held until the transaction ends, and
-- reads the other admins under it. Two admins deleting themselves at once therefore take the decision one after the
-- other, and the second one sees the first one's deletion; neither reads "another admin remains" from the same stale
-- set. Row locks on the admins' rows would be taken in the order each caller reaches them and could deadlock two
-- admins; the one advisory key cannot, because it is always taken after the rows of the caller and never before them.
-- A path that clears the flag of an admin or deletes one must take the same key after the rows it locks, or it and a
-- deletion each read the other admin as still there; only the deletion and this function take it so far. The first
-- promotion of the first-run setup needs no lock, as no admin exists for it to race with. An account that is not an
-- admin takes no lock: its own row is locked by the scope, so its flag holds for the transaction. For an account other than the one of the transaction, and when no tenant account is set, it is false
-- and nothing is locked.
CREATE OR REPLACE FUNCTION public.sys_account_last_instance_admin(p_account_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'sys_account_last_instance_admin needs an account'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF public.app_account_id() IS DISTINCT FROM p_account_id THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = p_account_id AND a.is_instance_admin) THEN
    RETURN false;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('slugbase.instance_admins'));
  RETURN NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.is_instance_admin AND a.id <> p_account_id);
END
$$;

-- sys_delete_account(account_id, sole_workspace_ids): deletes the account of the transaction, in that transaction, and
-- says whether it did. The workspaces where the account is the only member (`sole_workspace_ids`, the ones the
-- caller asked the deletion guard about) are put through the request half of the workspace deletion (doc 05 section
-- 7.2) as sys_workspace_mark_deleting does for one: deleting_at is set, the sessions that had them active are
-- pointed at none and their API tokens are revoked, and the caller queues the workspace.delete job of each in the
-- same transaction. The network prefix of every event that names the account as its actor is cleared, the target
-- identifier of every event that names it as its target is cleared and the `transferTo` metadata field that names
-- it is removed (the event keeps its type, label and other fields; `transferTo` is the only field of the audit
-- catalog that holds an account identifier), and the account row is deleted, which ends its memberships elsewhere (the owner rule does not apply to a workspace being
-- deleted) and deletes everything that cascades from it: sessions, API tokens, identities, credential tokens, backup
-- codes; the audit events stay with the actor reference set to NULL and the label they carry. The scope is
-- computed again under the locks of sys_account_deletion_scope: when the account is the only owner of a workspace
-- that has other members, or the workspaces where it is the only member are not exactly `sole_workspace_ids`, the
-- function is false and changes nothing, and so it is when the account is the last instance admin
-- (sys_account_last_instance_admin, read under its lock once the account is locked). It is false as well for an
-- account other than the one of the transaction, for a transaction that acts in a workspace and for an account that
-- does not exist; the caller cannot tell these apart.
CREATE OR REPLACE FUNCTION public.sys_delete_account(p_account_id uuid, p_sole_workspace_ids uuid[])
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_sole uuid[];
  v_blocking integer;
BEGIN
  IF p_account_id IS NULL OR p_sole_workspace_ids IS NULL THEN
    RAISE EXCEPTION 'sys_delete_account needs an account and the workspaces that go with it'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF public.app_account_id() IS DISTINCT FROM p_account_id OR public.app_workspace_id() IS NOT NULL THEN
    RETURN false;
  END IF;

  SELECT coalesce(array_agg(s.workspace_id ORDER BY s.workspace_id) FILTER (WHERE s.kind = 'sole'), '{}'),
         count(*) FILTER (WHERE s.kind = 'blocking')
  INTO v_sole, v_blocking
  FROM public.sys_account_deletion_scope(p_account_id) s;
  IF public.sys_account_last_instance_admin(p_account_id) THEN
    RETURN false;
  END IF;
  IF v_blocking > 0 OR v_sole IS DISTINCT FROM (SELECT coalesce(array_agg(DISTINCT i ORDER BY i), '{}') FROM unnest(p_sole_workspace_ids) i) THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = p_account_id) THEN
    RETURN false;
  END IF;

  UPDATE public.workspaces SET deleting_at = v_now WHERE id = ANY (v_sole);
  UPDATE public.sessions SET active_workspace_id = NULL WHERE active_workspace_id = ANY (v_sole);
  UPDATE public.api_tokens SET revoked_at = v_now WHERE workspace_id = ANY (v_sole) AND revoked_at IS NULL;
  UPDATE public.audit_events SET ip_prefix = NULL WHERE actor_account_id = p_account_id AND ip_prefix IS NOT NULL;
  UPDATE public.audit_events SET entity_id = NULL WHERE entity_id = p_account_id;
  UPDATE public.audit_events SET metadata = metadata - 'transferTo' WHERE lower(metadata ->> 'transferTo') = p_account_id::text;
  DELETE FROM public.accounts WHERE id = p_account_id;
  RETURN true;
END
$$;

ALTER FUNCTION public.sys_account_deletion_scope(uuid) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_account_last_instance_admin(uuid) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_delete_account(uuid, uuid[]) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_account_deletion_scope(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_account_last_instance_admin(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_delete_account(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_account_deletion_scope(uuid) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_account_last_instance_admin(uuid) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_delete_account(uuid, uuid[]) TO slugbase_app;
--> statement-breakpoint
-- src/sql/300-workspace-invitations.sql
-- Row-level security, privileges and the system operation of workspace_invitations (doc 05 sections 2.2 and
-- 3.3, doc 02 section 3.4, doc 10 T1 and T19). The table itself is defined in src/schema/invitations.ts.
-- sys_invitation_invitee_locale is entered in src/system/registry.ts. slugbase_owner creates the function and
-- hands it to slugbase_system, which needs CREATE on the schema for the length of those statements.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_invitation_invitee_locale(invitation_id): the language of the account that holds the invited address of a
-- pending invitation of the workspace the transaction acts in, which the invitation email is written in; NULL
-- when no account holds the address, so the caller falls back to the inviter's language. The policy of accounts
-- shows an account that shares no workspace with the caller to nobody, so this is a function of slugbase_system.
-- It answers for an invitation of the active workspace only and only to an owner or an admin of it (the account
-- of the transaction comes from app_account_id(), never an argument), and it answers a language and nothing
-- else, so it cannot be asked about an address nobody invited into that workspace.
CREATE OR REPLACE FUNCTION public.sys_invitation_invitee_locale(p_invitation_id uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT a.locale
    FROM public.workspace_invitations i
    JOIN public.accounts a ON a.email = i.email
    WHERE i.id = p_invitation_id
      AND i.status = 'pending'
      AND i.workspace_id = public.app_workspace_id()
      AND EXISTS (
        SELECT 1 FROM public.workspace_members m
        WHERE m.workspace_id = i.workspace_id AND m.account_id = public.app_account_id() AND m.role IN ('owner', 'admin'))
  $$;

ALTER FUNCTION public.sys_invitation_invitee_locale(uuid) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_invitation_invitee_locale(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_invitation_invitee_locale(uuid) TO slugbase_app;

-- workspace_invitations: the invitations of the active workspace, read and written there only. slugbase_app
-- may insert an invitation without the columns that make one an owner's or an accepted one (instance_issued,
-- status, accepted_by: a new row is pending and never instance-issued), and change what a resend replaces:
-- the role and teams of the new request, the inviter, the token hash, the mail ticket and the expiry, and revoke a pending one
-- (the status and closed_at columns, with an update policy that lets only a pending row become pending or revoked, so the
-- application role can neither accept an invitation nor reopen a revoked one). It never deletes a row.
-- Whether the caller may invite is the invitation service's check and the role of the authorization stage;
-- that an invitation never grants owner is the CHECK of the table. Inspecting and accepting an invitation by
-- its token, and the purge of old rows, are system operations of their own. slugbase_system, which bypasses
-- the policies, gets the privileges they need.
ALTER TABLE public.workspace_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_invitations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_invitations_tenant ON public.workspace_invitations;
CREATE POLICY workspace_invitations_tenant ON public.workspace_invitations FOR SELECT
  USING (workspace_id = public.app_workspace_id());
DROP POLICY IF EXISTS workspace_invitations_tenant_insert ON public.workspace_invitations;
CREATE POLICY workspace_invitations_tenant_insert ON public.workspace_invitations FOR INSERT
  WITH CHECK (workspace_id = public.app_workspace_id());
DROP POLICY IF EXISTS workspace_invitations_tenant_update ON public.workspace_invitations;
CREATE POLICY workspace_invitations_tenant_update ON public.workspace_invitations FOR UPDATE
  USING (workspace_id = public.app_workspace_id() AND status = 'pending')
  WITH CHECK (workspace_id = public.app_workspace_id() AND status IN ('pending', 'revoked'));
REVOKE ALL ON TABLE public.workspace_invitations FROM PUBLIC, slugbase_app;
GRANT SELECT ON TABLE public.workspace_invitations TO slugbase_app;
GRANT INSERT (id, workspace_id, email, role, team_ids, token_hash, mail_ticket, invited_by, expires_at) ON TABLE public.workspace_invitations TO slugbase_app;
GRANT UPDATE (role, team_ids, token_hash, mail_ticket, invited_by, expires_at, status, closed_at) ON TABLE public.workspace_invitations TO slugbase_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.workspace_invitations TO slugbase_system;
CREATE OR REPLACE TRIGGER workspace_invitations_set_updated_at
  BEFORE UPDATE ON public.workspace_invitations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
-- src/sql/310-idempotency-keys.sql
-- Row-level security and privileges of idempotency_keys (doc 05 sections 2.10 and 3.1, doc 04 section 6.3, doc
-- 10 T1). The table itself is defined in src/schema/idempotency-keys.ts.
--
-- The rows are the account's own: one policy on the account of the transaction, for reads and writes, so a key
-- of another account is neither seen nor changed whatever UUID is named, and the same UUID from two accounts
-- is two rows. slugbase_app may insert a key with the columns a request names (status starts in_progress and
-- created_at takes its default), and update what completing a key or reusing an expired one replaces; it never
-- deletes a row: sys_retention_purge removes a key once it has expired (110-retention-purge.sql), and the
-- cascade of the account removes the rest. slugbase_system, which bypasses the policy, gets the privileges
-- the purge needs; its FOR UPDATE SKIP LOCKED is why it holds UPDATE as well.
ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.idempotency_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS idempotency_keys_account ON public.idempotency_keys;
CREATE POLICY idempotency_keys_account ON public.idempotency_keys
  USING (account_id = public.app_account_id())
  WITH CHECK (account_id = public.app_account_id());
REVOKE ALL ON TABLE public.idempotency_keys FROM PUBLIC, slugbase_app;
GRANT SELECT ON TABLE public.idempotency_keys TO slugbase_app;
GRANT INSERT (account_id, key, operation, request_hash, expires_at) ON TABLE public.idempotency_keys TO slugbase_app;
GRANT UPDATE (operation, request_hash, status, response_status, response_body, created_at, expires_at) ON TABLE public.idempotency_keys TO slugbase_app;
GRANT SELECT, UPDATE, DELETE ON TABLE public.idempotency_keys TO slugbase_system;
--> statement-breakpoint
-- src/sql/320-invitation-acceptance.sql
-- The system operations behind inspecting and accepting an invitation by its token (doc 05 section 3.3, doc 02
-- section 3.4, doc 04 section 10.5, doc 10 T1, T4 and T19). Both are entered in src/system/registry.ts.
-- slugbase_owner creates each function and hands it to slugbase_system, which needs CREATE on the schema for the
-- length of those statements.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_invitation_inspect(token_hash): what the page behind an invitation link shows of it: the name of the
-- workspace, the display name of the account that invited (NULL once that account is deleted), the invited
-- address, the role and whether an account holds the address. It answers for a pending invitation that has not
-- expired, of a workspace that is not being deleted, and for nothing else; whether the token is unknown, used,
-- revoked, replaced or expired is not told apart, since no row comes back for any of them. The token is the only
-- credential, so it is a function of slugbase_system: the policies of workspace_invitations, workspaces and
-- accounts show an anonymous caller nothing.
CREATE OR REPLACE FUNCTION public.sys_invitation_inspect(p_token_hash bytea)
  RETURNS TABLE (workspace_name text, inviter_name text, invited_email text, invited_role text, account_exists boolean)
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT w.name, inviter.display_name, i.email::text, i.role::text,
           EXISTS (SELECT 1 FROM public.accounts holder WHERE holder.email = i.email)
    FROM public.workspace_invitations i
    JOIN public.workspaces w ON w.id = i.workspace_id
    LEFT JOIN public.accounts inviter ON inviter.id = i.invited_by
    WHERE octet_length(p_token_hash) = 32
      AND i.token_hash = p_token_hash
      AND i.status = 'pending'
      AND i.expires_at > clock_timestamp()
      AND w.deleting_at IS NULL
  $$;

-- sys_invitation_accept(token_hash, account_id, seat_limit): adds the account to the workspace of the invitation
-- the token belongs to, with exactly the invited role, and marks the invitation accepted (status, accepted_by and
-- closed_at in the one statement the CHECK of the table needs), all in the calling transaction. The outcome is one
-- of: 'accepted'; 'gone' for an unknown, used, revoked, replaced or expired token, a workspace being deleted and an
-- account that does not exist or is disabled, which a caller does not tell apart; 'email_mismatch' when the verified
-- address of the account is not the invited one; 'already_member'; 'seat_limit_reached'. The checks run in that
-- order, and a refusal writes nothing and leaves the invitation pending. seat_limit is the seats the workspace may
-- hold, NULL meaning unlimited (the entitlement engine supplies it); the members are counted under the lock of the
-- workspace's row, which every acceptance into the workspace takes, so two acceptances cannot both take the last seat.
-- When app_account_id() names an account, p_account_id must be that account.
--
-- Rows are locked parent first and the same way every time: the workspace (FOR NO KEY UPDATE), the account (FOR SHARE,
-- so a change of its address waits and the address checked is the address the membership is given for), then the
-- invitation. The invitation is found by its token before any lock, pending and unexpired, only to learn the workspace:
-- an unknown, used, revoked, replaced or expired token ends there with 'gone', after the one lookup an unknown token
-- takes, so no token that was once issued waits for a lock an unknown one does not. It is read again under the locks by
-- the token, so a revocation, a resend, a link that replaced the token or the passing of its expiry in between ends
-- this acceptance, and of two requests for one token the second finds the invitation accepted.
--
-- The workspace lock is FOR NO KEY UPDATE, not FOR UPDATE, because a request that has changed an invitation row (a
-- revocation, a resend, a link) goes on to write rows that reference the workspace, its audit event first, and the
-- foreign key of such a row takes FOR KEY SHARE on the workspace row. That lock does not conflict with FOR NO KEY
-- UPDATE, so the request is never queued behind an acceptance that is itself queued behind the invitation row the
-- request holds: the request commits, and the acceptance then finds the invitation revoked or its token replaced and
-- answers 'gone'. The seats stay counted one acceptance at a time, because FOR NO KEY UPDATE conflicts with itself.
-- It conflicts as well with FOR UPDATE and FOR NO KEY UPDATE, the locks of every other writer that needs the workspace
-- to stand still: the removal of a member, a role change and an ownership transfer (MemberRoleStore.roles and the
-- owner-required trigger of workspace_members), the deletion of the workspace (sys_workspace_mark_deleting), the
-- deletion of an account (sys_account_deletion_scope) and the rename of the workspace. A member is added to an
-- existing workspace by this function and sys_invitation_accept_new_account only, so no other insert of a member
-- needs the exclusion that FOR KEY SHARE had against FOR UPDATE.
CREATE OR REPLACE FUNCTION public.sys_invitation_accept(p_token_hash bytea, p_account_id uuid, p_seat_limit integer)
  RETURNS TABLE (outcome text, accepted_workspace_id uuid, accepted_invitation_id uuid, accepted_role text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_workspace uuid;
  v_invitation uuid;
  v_invited_email citext;
  v_role member_role;
  v_account_email citext;
  v_account_verified boolean;
BEGIN
  IF p_token_hash IS NULL OR octet_length(p_token_hash) <> 32 OR p_account_id IS NULL OR p_seat_limit < 0 THEN
    RAISE EXCEPTION 'sys_invitation_accept needs a 32-byte token hash, an account and a seat limit that is not negative'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF public.app_account_id() IS NOT NULL AND p_account_id <> public.app_account_id() THEN
    outcome := 'gone';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT i.workspace_id INTO v_workspace
  FROM public.workspace_invitations i
  WHERE i.token_hash = p_token_hash AND i.status = 'pending' AND i.expires_at > clock_timestamp();
  IF v_workspace IS NULL THEN
    outcome := 'gone';
    RETURN NEXT;
    RETURN;
  END IF;

  PERFORM 1 FROM public.workspaces w WHERE w.id = v_workspace AND w.deleting_at IS NULL FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    outcome := 'gone';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT a.email, a.email_verified_at IS NOT NULL INTO v_account_email, v_account_verified
  FROM public.accounts a WHERE a.id = p_account_id AND a.disabled_at IS NULL FOR SHARE;
  IF NOT FOUND THEN
    outcome := 'gone';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT i.id, i.email, i.role INTO v_invitation, v_invited_email, v_role
  FROM public.workspace_invitations i
  WHERE i.token_hash = p_token_hash AND i.workspace_id = v_workspace AND i.status = 'pending' AND i.expires_at > clock_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN
    outcome := 'gone';
    RETURN NEXT;
    RETURN;
  END IF;

  IF NOT v_account_verified OR v_account_email IS DISTINCT FROM v_invited_email THEN
    outcome := 'email_mismatch';
    RETURN NEXT;
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.workspace_id = v_workspace AND m.account_id = p_account_id) THEN
    outcome := 'already_member';
    RETURN NEXT;
    RETURN;
  END IF;

  IF p_seat_limit IS NOT NULL AND (SELECT count(*) FROM public.workspace_members m WHERE m.workspace_id = v_workspace) >= p_seat_limit THEN
    outcome := 'seat_limit_reached';
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO public.workspace_members (workspace_id, account_id, role) VALUES (v_workspace, p_account_id, v_role);
  UPDATE public.workspace_invitations
  SET status = 'accepted', accepted_by = p_account_id, closed_at = clock_timestamp()
  WHERE id = v_invitation;

  outcome := 'accepted';
  accepted_workspace_id := v_workspace;
  accepted_invitation_id := v_invitation;
  accepted_role := v_role::text;
  RETURN NEXT;
END
$$;

ALTER FUNCTION public.sys_invitation_inspect(bytea) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_invitation_accept(bytea, uuid, integer) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_invitation_inspect(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_invitation_accept(bytea, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_invitation_inspect(bytea) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_invitation_accept(bytea, uuid, integer) TO slugbase_app;
--> statement-breakpoint
-- src/sql/330-invitation-signup.sql
-- The system operation behind accepting an invitation with registration fields (doc 05 section 3.3, doc 02 sections
-- 2.2 and 3.4, doc 04 section 10.5, doc 10 T1, T8 and T19). It is entered in src/system/registry.ts. slugbase_owner
-- creates the function and hands it to slugbase_system, which needs CREATE on the schema for the length of those
-- statements.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_invitation_accept_new_account(...): for an invitation that is pending and unexpired, of a workspace that is not
-- being deleted, creates the account the invitation is for, with the address the invitation names and never one the
-- caller names, verified because the token that arrived in the mailbox proves it; adds it to the workspace with exactly
-- the invited role; marks the invitation accepted; and signs the account in with a full session whose active workspace
-- is that one: all in the calling transaction, so a failure at any step leaves nothing. It makes no personal
-- workspace. The password arrives hashed, or NULL for an account that signs in through a provider
-- (sys_invitation_accept_with_identity). The outcome is one of: 'accepted'; 'gone' for an unknown, used, revoked,
-- replaced or expired token or a workspace being deleted, which a caller does not tell apart; 'seat_limit_reached'
-- (seat_limit is the seats the workspace may hold, NULL meaning unlimited); 'email_taken' when an account holds the
-- address or the address is reserved by an unused "this wasn't me" token (sys_create_account decides). The checks run
-- in that order and a refusal writes nothing, so the invitation stays pending and usable.
--
-- Rows are locked parent first, as sys_invitation_accept does: the workspace (FOR NO KEY UPDATE, the lock every
-- acceptance into the workspace takes, for the reason sys_invitation_accept gives), then the invitation, found by its
-- token before any lock, pending and unexpired, only to learn the workspace (any other token ends there with 'gone',
-- as an unknown one does) and read again under the locks, so of two requests for one token the second finds the
-- invitation accepted and answers 'gone', and one token creates one account and one membership however many requests
-- carry it. The account insert
-- comes after both locks, so a request that finds the address taken has held the locks only to read. The deletion of an
-- account (sys_delete_account) takes the same order: it locks the workspaces the account is a member of or created
-- before the account row, so an insert that waits for a deleted row with the invited address never waits on a
-- transaction that waits for the workspace this one holds.
-- The operation is the anonymous caller's: it refuses ('gone') inside a transaction that acts for an account, and
-- needs no account to exist.
CREATE OR REPLACE FUNCTION public.sys_invitation_accept_new_account(
  p_token_hash bytea,
  p_account_id uuid,
  p_display_name text,
  p_password_hash text,
  p_locale text,
  p_seat_limit integer,
  p_session_id uuid,
  p_session_token_hash bytea,
  p_replaced_token_hash bytea,
  p_ip_prefix cidr,
  p_user_agent text
) RETURNS TABLE (outcome text, accepted_workspace_id uuid, accepted_invitation_id uuid, accepted_role text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_workspace uuid;
  v_invitation uuid;
  v_invited_email citext;
  v_role member_role;
BEGIN
  IF NOT coalesce(
    p_token_hash IS NOT NULL AND octet_length(p_token_hash) = 32
    AND p_account_id IS NOT NULL AND p_display_name IS NOT NULL AND p_locale IS NOT NULL
    AND p_session_id IS NOT NULL AND octet_length(p_session_token_hash) = 32
    AND (p_replaced_token_hash IS NULL OR octet_length(p_replaced_token_hash) = 32)
    AND (p_seat_limit IS NULL OR p_seat_limit >= 0),
    false
  ) THEN
    RAISE EXCEPTION 'sys_invitation_accept_new_account needs a 32-byte token hash, the account and its session and a seat limit that is not negative'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF public.app_account_id() IS NOT NULL THEN
    outcome := 'gone';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT i.workspace_id INTO v_workspace
  FROM public.workspace_invitations i
  WHERE i.token_hash = p_token_hash AND i.status = 'pending' AND i.expires_at > clock_timestamp();
  IF v_workspace IS NULL THEN
    outcome := 'gone';
    RETURN NEXT;
    RETURN;
  END IF;

  PERFORM 1 FROM public.workspaces w WHERE w.id = v_workspace AND w.deleting_at IS NULL FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    outcome := 'gone';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT i.id, i.email, i.role INTO v_invitation, v_invited_email, v_role
  FROM public.workspace_invitations i
  WHERE i.token_hash = p_token_hash AND i.workspace_id = v_workspace AND i.status = 'pending' AND i.expires_at > clock_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN
    outcome := 'gone';
    RETURN NEXT;
    RETURN;
  END IF;

  IF p_seat_limit IS NOT NULL AND (SELECT count(*) FROM public.workspace_members m WHERE m.workspace_id = v_workspace) >= p_seat_limit THEN
    outcome := 'seat_limit_reached';
    RETURN NEXT;
    RETURN;
  END IF;

  IF NOT public.sys_create_account(p_account_id, v_invited_email::text, p_display_name, p_password_hash, p_locale, true) THEN
    outcome := 'email_taken';
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO public.workspace_members (workspace_id, account_id, role) VALUES (v_workspace, p_account_id, v_role);
  UPDATE public.workspace_invitations
  SET status = 'accepted', accepted_by = p_account_id, closed_at = clock_timestamp()
  WHERE id = v_invitation;

  IF NOT public.sys_session_create(
    p_session_id, p_account_id, 'full', false, p_ip_prefix, p_user_agent, p_session_token_hash, p_replaced_token_hash
  ) THEN
    RAISE EXCEPTION 'the session of the account that accepted the invitation could not be created';
  END IF;
  UPDATE public.sessions SET active_workspace_id = v_workspace WHERE id = p_session_id;

  outcome := 'accepted';
  accepted_workspace_id := v_workspace;
  accepted_invitation_id := v_invitation;
  accepted_role := v_role::text;
  RETURN NEXT;
END
$$;

ALTER FUNCTION public.sys_invitation_accept_new_account(bytea, uuid, text, text, text, integer, uuid, bytea, bytea, cidr, text) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_invitation_accept_new_account(bytea, uuid, text, text, text, integer, uuid, bytea, bytea, cidr, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_invitation_accept_new_account(bytea, uuid, text, text, text, integer, uuid, bytea, bytea, cidr, text) TO slugbase_app;
--> statement-breakpoint
-- src/sql/340-oidc-invitation.sql
-- The system operations behind accepting an invitation through an OIDC provider (doc 05 sections 2.1 and 3.3, doc 02
-- sections 2.8 and 3.4, doc 04 sections 4.5 and 10.2, doc 10 T4, T19 and T20). All three are entered in
-- src/system/registry.ts. slugbase_owner creates each function and hands it to slugbase_system, which needs CREATE on
-- the schema for the length of those statements.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_oidc_state_create(..., invitation_token_hash): the overload of sys_oidc_state_create (170-oidc.sql) that also
-- stores the intent `invite`. The record of that intent holds the SHA-256 of the invitation token the handshake will
-- accept, never the token, and no link account; every other intent holds none. The eight-argument overload stays for
-- the previous release's replicas during a rolling deploy. Any argument that breaks a check of the table is refused
-- with invalid_parameter_value.
CREATE OR REPLACE FUNCTION public.sys_oidc_state_create(
  p_state_hash bytea,
  p_provider text,
  p_intent text,
  p_nonce text,
  p_code_verifier bytea,
  p_code_verifier_key_id text,
  p_return_to text,
  p_link_account_id uuid,
  p_invitation_token_hash bytea
) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF NOT coalesce(
    octet_length(p_state_hash) = 32
    AND p_provider IS NOT NULL AND p_provider <> ''
    AND p_intent IN ('login', 'link', 'reauth', 'invite')
    AND p_nonce IS NOT NULL AND p_nonce <> ''
    AND p_code_verifier IS NOT NULL AND octet_length(p_code_verifier) > 0
    AND p_code_verifier_key_id IS NOT NULL AND p_code_verifier_key_id <> ''
    AND p_return_to LIKE '/%' AND length(p_return_to) <= 2048
    AND ((p_intent IN ('link', 'reauth')) = (p_link_account_id IS NOT NULL))
    AND ((p_intent = 'invite') = (p_invitation_token_hash IS NOT NULL))
    AND (p_invitation_token_hash IS NULL OR octet_length(p_invitation_token_hash) = 32),
    false
  ) THEN
    RAISE EXCEPTION 'sys_oidc_state_create needs a 32-byte state hash, a provider, a login, link, reauth or invite intent, a nonce, a sealed verifier with its key id, a relative return path, a link account for the link and reauth intents only and a 32-byte invitation token hash for the invite intent only'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO public.oidc_login_states (
    state_hash, provider, intent, nonce, code_verifier, code_verifier_key_id, return_to, link_account_id,
    invitation_token_hash, expires_at
  ) VALUES (
    p_state_hash, p_provider, p_intent, p_nonce, p_code_verifier, p_code_verifier_key_id, p_return_to, p_link_account_id,
    p_invitation_token_hash, clock_timestamp() + interval '10 minutes'
  );
END
$$;

-- sys_oidc_state_take(state_hash, provider): sys_oidc_state_consume (170-oidc.sql) with the invitation the record
-- names. It deletes the record and returns it in one statement, so a state is answered once whatever the number of
-- concurrent callbacks, and so the invitation token hash it holds is used by at most one callback; no row comes back
-- for an unknown state, one that expired, one already consumed and one of another provider, which a caller does not
-- tell apart.
CREATE OR REPLACE FUNCTION public.sys_oidc_state_take(p_state_hash bytea, p_provider text)
  RETURNS TABLE (
    intent text,
    nonce text,
    code_verifier bytea,
    code_verifier_key_id text,
    return_to text,
    link_account_id uuid,
    invitation_token_hash bytea
  )
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    DELETE FROM public.oidc_login_states s
    WHERE s.state_hash = p_state_hash
      AND s.provider = p_provider
      AND s.expires_at > clock_timestamp()
    RETURNING s.intent, s.nonce, s.code_verifier, s.code_verifier_key_id, s.return_to, s.link_account_id, s.invitation_token_hash
  $$;

-- sys_invitation_accept_with_identity(...): accepts the invitation the token hash belongs to for the person a
-- provider identified, in the calling transaction. The caller has seen the provider assert p_email as verified; the
-- function accepts only when that is exactly the address the invitation names, compared the way the accounts compare
-- addresses (citext), and writes nothing otherwise. Which account accepts is decided in this order:
--   1. the account the identity (provider, subject) is linked to;
--   2. the enabled account that holds the invited address verified, to which the identity is then linked;
--   3. a new account for the invited address, verified because the provider asserted it, without a password, only
--      when p_may_create says the registration policy allowed it (the invitation authorises creating it whatever the
--      provider's auto-create setting says, Q31).
-- The first two are accepted through sys_invitation_accept and the third through sys_invitation_accept_new_account, so
-- the checks under their locks (status, expiry, the verified address of the account, membership, the seat count) are
-- theirs and are not written a third time. The identity is linked to the account that accepted, and the account is
-- signed in with a full session whose active workspace is the one joined: the provider is trusted for the second
-- factor, as for any sign-in through it.
--
-- The outcome is one of: 'accepted'; 'gone' for an unknown, used, revoked, replaced or expired token, a workspace being
-- deleted and a disabled account, which a caller does not tell apart; 'email_mismatch' for a provider address that is
-- not the invited one and for an account that does not hold the invited address verified; 'already_member';
-- 'seat_limit_reached'; 'email_taken' when no account may be created because an account (unverified, or disabled) holds
-- the address or an unused "this wasn't me" token reserves it; 'not_permitted' when an account would have to be created
-- and p_may_create is false. A refusal writes nothing and leaves the invitation pending. A link that fails after the
-- acceptance (the identity went to another account in the meantime) ends in the exception SB001, which undoes the
-- transaction.
--
-- Rows are locked parent first, as sys_invitation_accept does: the workspace (FOR NO KEY UPDATE), the account (FOR
-- UPDATE, not FOR SHARE, because the identity is linked and the sign-in recorded on it afterwards and a lock raised
-- from FOR SHARE to FOR UPDATE could wait for another acceptance of the same account that wants the same), then the
-- invitation. The invitation is found by its token before any lock, pending and unexpired, only to learn the workspace,
-- and the account is found by plain reads before any lock; both are read again under the locks by the functions that
-- accept. An unknown, used, revoked, replaced or expired token ends before any lock, as it does for the others. The
-- operation is the anonymous caller's: it refuses ('gone') inside a transaction that acts for an account.
CREATE OR REPLACE FUNCTION public.sys_invitation_accept_with_identity(
  p_token_hash bytea,
  p_provider text,
  p_subject text,
  p_email text,
  p_identity_id uuid,
  p_account_id uuid,
  p_display_name text,
  p_locale text,
  p_may_create boolean,
  p_seat_limit integer,
  p_session_id uuid,
  p_session_token_hash bytea,
  p_replaced_token_hash bytea,
  p_ip_prefix cidr,
  p_user_agent text
) RETURNS TABLE (
  outcome text,
  accepted_workspace_id uuid,
  accepted_invitation_id uuid,
  accepted_role text,
  accepted_account_id uuid,
  accepted_display_name text,
  account_created boolean
)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_workspace uuid;
  v_invited_email citext;
  v_account uuid;
  v_account_disabled boolean;
  v_linked boolean := false;
  v_accept record;
  v_name text;
BEGIN
  IF NOT coalesce(
    p_token_hash IS NOT NULL AND octet_length(p_token_hash) = 32
    AND length(p_provider) BETWEEN 1 AND 64
    AND length(p_subject) BETWEEN 1 AND 255
    AND p_email IS NOT NULL AND p_email <> ''
    AND p_identity_id IS NOT NULL AND p_account_id IS NOT NULL AND p_display_name IS NOT NULL AND p_locale IS NOT NULL
    AND p_may_create IS NOT NULL
    AND (p_seat_limit IS NULL OR p_seat_limit >= 0)
    AND p_session_id IS NOT NULL AND octet_length(p_session_token_hash) = 32
    AND (p_replaced_token_hash IS NULL OR octet_length(p_replaced_token_hash) = 32),
    false
  ) THEN
    RAISE EXCEPTION 'sys_invitation_accept_with_identity needs a 32-byte token hash, a provider of 1 to 64 characters, a subject of 1 to 255 characters, an address, the identity, the account and its session and a seat limit that is not negative'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF public.app_account_id() IS NOT NULL THEN
    outcome := 'gone';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT i.workspace_id, i.email INTO v_workspace, v_invited_email
  FROM public.workspace_invitations i
  WHERE i.token_hash = p_token_hash AND i.status = 'pending' AND i.expires_at > clock_timestamp();
  IF v_workspace IS NULL THEN
    outcome := 'gone';
    RETURN NEXT;
    RETURN;
  END IF;
  IF v_invited_email IS DISTINCT FROM p_email::public.citext THEN
    outcome := 'email_mismatch';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT a.id, a.disabled_at IS NOT NULL INTO v_account, v_account_disabled
  FROM public.account_identities ai
  JOIN public.accounts a ON a.id = ai.account_id
  WHERE ai.provider = p_provider AND ai.subject = p_subject;
  IF FOUND THEN
    v_linked := true;
    IF v_account_disabled THEN
      outcome := 'gone';
      RETURN NEXT;
      RETURN;
    END IF;
  ELSE
    SELECT a.id INTO v_account
    FROM public.accounts a
    WHERE a.email = v_invited_email AND a.email_verified_at IS NOT NULL AND a.disabled_at IS NULL;
    IF v_account IS NULL AND NOT p_may_create THEN
      outcome := 'not_permitted';
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  PERFORM 1 FROM public.workspaces w WHERE w.id = v_workspace AND w.deleting_at IS NULL FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    outcome := 'gone';
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_account IS NOT NULL THEN
    PERFORM 1 FROM public.accounts a WHERE a.id = v_account AND a.disabled_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN
      outcome := 'gone';
      RETURN NEXT;
      RETURN;
    END IF;

    SELECT * INTO v_accept FROM public.sys_invitation_accept(p_token_hash, v_account, p_seat_limit);
    IF v_accept.outcome <> 'accepted' THEN
      outcome := v_accept.outcome;
      RETURN NEXT;
      RETURN;
    END IF;

    IF NOT v_linked AND public.sys_identity_link(v_account, p_identity_id, p_provider, p_subject, p_email) <> 'linked' THEN
      RAISE EXCEPTION 'the identity is linked to another account' USING ERRCODE = 'SB001';
    END IF;
    IF NOT public.sys_identity_sign_in(p_provider, p_subject, p_session_id, p_ip_prefix, p_user_agent, p_session_token_hash, p_replaced_token_hash) THEN
      RAISE EXCEPTION 'the account that accepted the invitation could not be signed in';
    END IF;
    UPDATE public.sessions SET active_workspace_id = v_workspace WHERE id = p_session_id;
    SELECT a.display_name INTO v_name FROM public.accounts a WHERE a.id = v_account;
    account_created := false;
  ELSE
    SELECT * INTO v_accept FROM public.sys_invitation_accept_new_account(
      p_token_hash, p_account_id, p_display_name, NULL, p_locale, p_seat_limit, p_session_id, p_session_token_hash,
      p_replaced_token_hash, p_ip_prefix, p_user_agent
    );
    IF v_accept.outcome <> 'accepted' THEN
      outcome := v_accept.outcome;
      RETURN NEXT;
      RETURN;
    END IF;

    IF public.sys_identity_link(p_account_id, p_identity_id, p_provider, p_subject, p_email) <> 'linked' THEN
      RAISE EXCEPTION 'the identity is linked to another account' USING ERRCODE = 'SB001';
    END IF;
    v_account := p_account_id;
    v_name := p_display_name;
    account_created := true;
  END IF;

  outcome := 'accepted';
  accepted_workspace_id := v_accept.accepted_workspace_id;
  accepted_invitation_id := v_accept.accepted_invitation_id;
  accepted_role := v_accept.accepted_role;
  accepted_account_id := v_account;
  accepted_display_name := v_name;
  RETURN NEXT;
END
$$;

ALTER FUNCTION public.sys_oidc_state_create(bytea, text, text, text, bytea, text, text, uuid, bytea) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_oidc_state_take(bytea, text) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_invitation_accept_with_identity(bytea, text, text, text, uuid, uuid, text, text, boolean, integer, uuid, bytea, bytea, cidr, text) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_oidc_state_create(bytea, text, text, text, bytea, text, text, uuid, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_oidc_state_take(bytea, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_invitation_accept_with_identity(bytea, text, text, text, uuid, uuid, text, text, boolean, integer, uuid, bytea, bytea, cidr, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_oidc_state_create(bytea, text, text, text, bytea, text, text, uuid, bytea) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_oidc_state_take(bytea, text) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_invitation_accept_with_identity(bytea, text, text, text, uuid, uuid, text, text, boolean, integer, uuid, bytea, bytea, cidr, text) TO slugbase_app;
--> statement-breakpoint
-- src/sql/350-entitlement-version.sql
-- The system operation behind raising a workspace's entitlement version (doc 01 sections 7.5 and 8.3, doc 05
-- sections 2.2 and 3.3, doc 10 T11). It is entered in src/system/registry.ts. slugbase_owner creates the function
-- and hands it to slugbase_system, which needs CREATE on the schema for the length of those statements.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_workspace_bump_entitlement_version(workspace_id): moves workspaces.entitlement_version, the key of the
-- per-process entitlement cache, by one and answers the new version. slugbase_app cannot write the column, so a
-- change to a workspace's plan, archive state or override made in a tenant transaction raises the version through
-- this function in the same transaction. It acts only on the workspace the transaction acts in
-- (app_workspace_id()) and only for the account of the transaction (app_account_id(), never an argument) when it is
-- a member of that workspace: a transaction acting in A neither raises nor reads B's version. A workspace that is
-- being deleted, one that does not exist and a refused caller are all NULL, changing nothing. The ETag of the
-- workspace (version) and its name stay where they were; updated_at moves, as the workspaces_set_updated_at
-- trigger moves it on every UPDATE.
CREATE OR REPLACE FUNCTION public.sys_workspace_bump_entitlement_version(p_workspace_id uuid)
  RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_version integer;
BEGIN
  IF p_workspace_id IS NULL THEN
    RAISE EXCEPTION 'sys_workspace_bump_entitlement_version needs a workspace'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF public.app_account_id() IS NULL OR public.app_workspace_id() IS DISTINCT FROM p_workspace_id THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.workspace_members m
    WHERE m.workspace_id = p_workspace_id AND m.account_id = public.app_account_id()
  ) THEN
    RETURN NULL;
  END IF;
  UPDATE public.workspaces
  SET entitlement_version = entitlement_version + 1
  WHERE id = p_workspace_id AND deleting_at IS NULL
  RETURNING entitlement_version INTO v_version;
  RETURN v_version;
END
$$;

ALTER FUNCTION public.sys_workspace_bump_entitlement_version(uuid) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_workspace_bump_entitlement_version(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_workspace_bump_entitlement_version(uuid) TO slugbase_app;
--> statement-breakpoint
-- src/sql/360-instance-admin.sql
-- The deployment-level audit stream and the first system operations of the CE instance admin (doc 05 sections
-- 2.9 and 3.3, doc 02 section 11, doc 10 T3 and T15). The table is audit_events (src/schema/audit.ts): an event
-- with no workspace is a deployment-level one, admitted by no policy of 250-audit-events.sql, so slugbase_app
-- neither reads nor writes it; the functions below, which run as slugbase_system and bypass the policies, are the
-- only way in and out. All three are entered in src/system/registry.ts. slugbase_owner creates each function and
-- hands it to slugbase_system, which needs CREATE on the schema for the length of those statements.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_instance_status(event_id, ip_prefix): the counts of the instance status (accounts, workspaces that are not
-- being deleted, and complete sessions that have not expired), and an instance audit event 'instance.status_viewed'
-- for the account of the transaction, in the same call. Every sys_instance_* function repeats the check of the
-- policy inside its own body, so a caller that reaches it by any path other than the HTTP chain is held to it: the
-- account of the transaction (app_account_id(), never an argument) must hold the instance-admin flag, have a second
-- factor enrolled and not be disabled, otherwise it raises insufficient_privilege and writes nothing. The event id
-- is generated by the application (Q91).
CREATE OR REPLACE FUNCTION public.sys_instance_status(p_event_id uuid, p_ip_prefix cidr)
  RETURNS TABLE (account_count bigint, workspace_count bigint, active_session_count bigint)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_label text;
BEGIN
  IF p_event_id IS NULL THEN
    RAISE EXCEPTION 'sys_instance_status needs an event id' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.display_name INTO v_label
  FROM public.accounts a
  WHERE a.id = public.app_account_id() AND a.is_instance_admin AND a.mfa_enabled_at IS NOT NULL AND a.disabled_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the instance operations are for instance admins with a second factor' USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO public.audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, metadata, ip_prefix)
  VALUES (p_event_id, NULL, 'account', public.app_account_id(), v_label, 'instance.status_viewed', '{}'::jsonb, p_ip_prefix);

  RETURN QUERY SELECT
    (SELECT count(*) FROM public.accounts),
    (SELECT count(*) FROM public.workspaces w WHERE w.deleting_at IS NULL),
    (SELECT count(*) FROM public.sessions s WHERE s.level = 'full' AND s.expires_at > v_now AND s.absolute_expires_at > v_now);
END
$$;

-- sys_list_instance_audit(limit, before_id): the instance audit stream, newest first, at most p_limit (1 to 200)
-- events, from the event after the one p_before_id names when it is given. The position is an event, not a time:
-- created_at keeps microseconds that a client round trip would cut, so the keyset (created_at, id) is read from the
-- row; an identifier that is no event of the stream raises invalid_parameter_value. It is the only reader of the
-- stream: workspace members and slugbase_app see no event with no workspace. It repeats the admin check of
-- sys_instance_status and raises when it fails. Reading the stream writes no event of its own.
CREATE OR REPLACE FUNCTION public.sys_list_instance_audit(p_limit integer, p_before_id uuid)
  RETURNS TABLE (
    id uuid,
    created_at timestamptz,
    actor_account_id uuid,
    actor_label text,
    action text,
    entity_type text,
    entity_id uuid,
    metadata jsonb,
    ip_prefix cidr
  )
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_before_at timestamptz;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 THEN
    RAISE EXCEPTION 'sys_list_instance_audit needs a limit of 1 to 200' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.accounts a
    WHERE a.id = public.app_account_id() AND a.is_instance_admin AND a.mfa_enabled_at IS NOT NULL AND a.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'the instance operations are for instance admins with a second factor' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_before_id IS NOT NULL THEN
    SELECT b.created_at INTO v_before_at FROM public.audit_events b WHERE b.id = p_before_id AND b.workspace_id IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'sys_list_instance_audit was given a position that is no event of the stream' USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;

  RETURN QUERY
    SELECT e.id, e.created_at, e.actor_account_id, e.actor_label, e.action, e.entity_type, e.entity_id, e.metadata, e.ip_prefix
    FROM public.audit_events e
    WHERE e.workspace_id IS NULL
      AND (p_before_id IS NULL OR (e.created_at, e.id) < (v_before_at, p_before_id))
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT p_limit;
END
$$;

-- sys_setup_audit(event_id, ip_prefix): the instance audit event 'instance.setup_completed' of first-run setup,
-- written in the transaction that completes it (right after sys_complete_setup, which has no way to take the id
-- the application generates). The actor is the account that setup recorded (instance_state.setup_by), never an
-- argument, and the event is written at most once: it answers false, and writes nothing, while setup is not
-- completed, when the account is gone and when the event exists. The caller still chooses the event id and the
-- ip_prefix. On a deployment whose setup completed before this function existed there is no event yet, so the
-- first call after the upgrade writes it. The same advisory lock as the setup's serialises two callers.
CREATE OR REPLACE FUNCTION public.sys_setup_audit(p_event_id uuid, p_ip_prefix cidr)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_admin uuid;
  v_label text;
BEGIN
  IF p_event_id IS NULL THEN
    RAISE EXCEPTION 'sys_setup_audit needs an event id' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('slugbase.setup'));
  SELECT s.setup_by INTO v_admin FROM public.instance_state s WHERE s.id = 1 AND s.setup_completed_at IS NOT NULL;
  IF v_admin IS NULL THEN
    RETURN false;
  END IF;
  IF EXISTS (SELECT 1 FROM public.audit_events e WHERE e.workspace_id IS NULL AND e.action = 'instance.setup_completed') THEN
    RETURN false;
  END IF;
  SELECT a.display_name INTO v_label FROM public.accounts a WHERE a.id = v_admin;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  INSERT INTO public.audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, metadata, ip_prefix)
  VALUES (p_event_id, NULL, 'account', v_admin, v_label, 'instance.setup_completed', '{}'::jsonb, p_ip_prefix);
  RETURN true;
END
$$;

ALTER FUNCTION public.sys_instance_status(uuid, cidr) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_list_instance_audit(integer, uuid) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_setup_audit(uuid, cidr) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_instance_status(uuid, cidr) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_list_instance_audit(integer, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_setup_audit(uuid, cidr) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_instance_status(uuid, cidr) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_list_instance_audit(integer, uuid) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_setup_audit(uuid, cidr) TO slugbase_app;
--> statement-breakpoint
-- src/sql/370-instance-settings.sql
-- The instance settings and the test email of the CE instance admin (doc 05 sections 2.2, 2.9 and 3.3, doc 02
-- section 11.3, doc 04 section 10.10). The table is instance_settings (src/schema/instance.ts). It holds no personal
-- data and has no row-level security, because the display name and the sign-in notice are public on the sign-in page
-- and whether accounts may create workspaces is answered by the workspace list: slugbase_app reads it and nothing
-- else, and the row is written only by sys_instance_update_settings, which runs as slugbase_system. All three functions
-- are entered in src/system/registry.ts. slugbase_owner creates each function and hands it to slugbase_system, which
-- needs CREATE on the schema for the length of those statements.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_instance_settings(event_id, ip_prefix): the settings as they are stored (every column NULL while no row exists),
-- and the instance audit event 'instance.settings_viewed' for the account of the transaction, in the same call, under
-- the check of sys_instance_status. Reading the settings as an instance admin is an action of the admin and is
-- audited like the status; the sign-in page and the workspace routes read the table directly and write no event.
CREATE OR REPLACE FUNCTION public.sys_instance_settings(p_event_id uuid, p_ip_prefix cidr)
  RETURNS TABLE (allow_workspace_creation boolean, display_name text, sign_in_notice text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_label text;
BEGIN
  IF p_event_id IS NULL THEN
    RAISE EXCEPTION 'sys_instance_settings needs an event id' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.display_name INTO v_label
  FROM public.accounts a
  WHERE a.id = public.app_account_id() AND a.is_instance_admin AND a.mfa_enabled_at IS NOT NULL AND a.disabled_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the instance operations are for instance admins with a second factor' USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO public.audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, metadata, ip_prefix)
  VALUES (p_event_id, NULL, 'account', public.app_account_id(), v_label, 'instance.settings_viewed', '{}'::jsonb, p_ip_prefix);

  RETURN QUERY SELECT
    (SELECT s.allow_workspace_creation FROM public.instance_settings s WHERE s.id = 1),
    (SELECT s.display_name FROM public.instance_settings s WHERE s.id = 1),
    (SELECT s.sign_in_notice FROM public.instance_settings s WHERE s.id = 1);
END
$$;

-- sys_instance_update_settings(...): changes the settings whose p_set_* flag is true, to the value that follows it
-- (NULL clears the setting, so the default of the deployment applies again), and leaves the others as they are. The
-- row is created by the first call. Like every sys_instance_* function it repeats the check of the instanceAdmin
-- policy inside its own body: the account of the transaction (app_account_id(), never an argument) must hold the
-- instance-admin flag, have a second factor enrolled and not be disabled, otherwise it raises insufficient_privilege
-- and writes nothing. The audit event 'instance.settings_changed' names the settings that changed, never a value,
-- and is written in the same call under the identifier the application generated (Q91). A call that changes no
-- setting raises invalid_parameter_value. Answers the row as it is after the change.
CREATE OR REPLACE FUNCTION public.sys_instance_update_settings(
  p_event_id uuid,
  p_ip_prefix cidr,
  p_set_allow_workspace_creation boolean,
  p_allow_workspace_creation boolean,
  p_set_display_name boolean,
  p_display_name text,
  p_set_sign_in_notice boolean,
  p_sign_in_notice text
) RETURNS TABLE (allow_workspace_creation boolean, display_name text, sign_in_notice text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_label text;
  v_changed text[] := ARRAY[]::text[];
BEGIN
  IF p_event_id IS NULL OR p_set_allow_workspace_creation IS NULL OR p_set_display_name IS NULL OR p_set_sign_in_notice IS NULL THEN
    RAISE EXCEPTION 'sys_instance_update_settings needs an event id and a flag for each setting' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.display_name INTO v_label
  FROM public.accounts a
  WHERE a.id = public.app_account_id() AND a.is_instance_admin AND a.mfa_enabled_at IS NOT NULL AND a.disabled_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the instance operations are for instance admins with a second factor' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_set_allow_workspace_creation THEN
    v_changed := array_append(v_changed, 'allowWorkspaceCreation'::text);
  END IF;
  IF p_set_display_name THEN
    v_changed := array_append(v_changed, 'displayName'::text);
  END IF;
  IF p_set_sign_in_notice THEN
    v_changed := array_append(v_changed, 'signInNotice'::text);
  END IF;
  IF cardinality(v_changed) = 0 THEN
    RAISE EXCEPTION 'sys_instance_update_settings was given no setting to change' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO public.instance_settings AS s (id, allow_workspace_creation, display_name, sign_in_notice, updated_by)
  VALUES (
    1,
    CASE WHEN p_set_allow_workspace_creation THEN p_allow_workspace_creation END,
    CASE WHEN p_set_display_name THEN p_display_name END,
    CASE WHEN p_set_sign_in_notice THEN p_sign_in_notice END,
    public.app_account_id()
  )
  ON CONFLICT (id) DO UPDATE SET
    allow_workspace_creation = CASE WHEN p_set_allow_workspace_creation THEN p_allow_workspace_creation ELSE s.allow_workspace_creation END,
    display_name = CASE WHEN p_set_display_name THEN p_display_name ELSE s.display_name END,
    sign_in_notice = CASE WHEN p_set_sign_in_notice THEN p_sign_in_notice ELSE s.sign_in_notice END,
    updated_by = public.app_account_id();

  INSERT INTO public.audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, metadata, ip_prefix)
  VALUES (
    p_event_id, NULL, 'account', public.app_account_id(), v_label, 'instance.settings_changed',
    jsonb_build_object('settings', array_to_string(v_changed, ',')), p_ip_prefix
  );

  RETURN QUERY
    SELECT s.allow_workspace_creation, s.display_name, s.sign_in_notice FROM public.instance_settings s WHERE s.id = 1;
END
$$;

-- sys_instance_test_mail(event_id, ip_prefix): the instance audit event 'instance.test_mail_queued' for the account of
-- the transaction, written under the check of sys_instance_update_settings, so the test email that the caller queues
-- in the same transaction exists exactly when its event does. It sends and queues nothing itself.
CREATE OR REPLACE FUNCTION public.sys_instance_test_mail(p_event_id uuid, p_ip_prefix cidr)
  RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_label text;
BEGIN
  IF p_event_id IS NULL THEN
    RAISE EXCEPTION 'sys_instance_test_mail needs an event id' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.display_name INTO v_label
  FROM public.accounts a
  WHERE a.id = public.app_account_id() AND a.is_instance_admin AND a.mfa_enabled_at IS NOT NULL AND a.disabled_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the instance operations are for instance admins with a second factor' USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO public.audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, metadata, ip_prefix)
  VALUES (p_event_id, NULL, 'account', public.app_account_id(), v_label, 'instance.test_mail_queued', '{}'::jsonb, p_ip_prefix);
END
$$;

ALTER FUNCTION public.sys_instance_settings(uuid, cidr) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_instance_update_settings(uuid, cidr, boolean, boolean, boolean, text, boolean, text) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_instance_test_mail(uuid, cidr) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_instance_settings(uuid, cidr) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_instance_update_settings(uuid, cidr, boolean, boolean, boolean, text, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_instance_test_mail(uuid, cidr) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_instance_settings(uuid, cidr) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_instance_update_settings(uuid, cidr, boolean, boolean, boolean, text, boolean, text) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_instance_test_mail(uuid, cidr) TO slugbase_app;

-- instance_settings: no personal data and no row-level security. slugbase_app reads it, which is how the sign-in page
-- and the workspace routes see the settings; only sys_instance_update_settings writes it.
REVOKE ALL ON TABLE public.instance_settings FROM PUBLIC, slugbase_app;
GRANT SELECT ON TABLE public.instance_settings TO slugbase_app;
GRANT SELECT, INSERT, UPDATE ON TABLE public.instance_settings TO slugbase_system;

CREATE OR REPLACE TRIGGER instance_settings_set_updated_at
  BEFORE UPDATE ON public.instance_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
-- src/sql/380-instance-workspaces.sql
-- The workspace operations of the CE instance admin (doc 05 sections 2.2, 2.9 and 3.3, doc 02 section 11.1, doc 10
-- T1 and T18): list every workspace without any content, create one for a chosen account or for the first owner an
-- invitation will bring, and delete one. All three are entered in src/system/registry.ts. slugbase_owner creates each
-- function and hands it to slugbase_system, which needs CREATE on the schema for the length of those statements.
-- The tables are unchanged: workspace_invitations already allows the owner role for a row with instance_issued, which
-- slugbase_app cannot insert (300-workspace-invitations.sql), so sys_instance_create_workspace is the only writer of
-- an owner invitation.
--
-- Like every sys_instance_* function each repeats the check of the instanceAdmin policy inside its own body: the
-- account of the transaction (app_account_id(), never an argument) must hold the instance-admin flag, have a second
-- factor enrolled and not be disabled, otherwise it raises insufficient_privilege and writes nothing. Each writes its
-- instance audit event in the same call, under the identifier the application generated (Q91).
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_instance_list_workspaces(event_id, ip_prefix): every workspace that is not being deleted, newest first, with
-- its name, its creation time, its member count and its owners (account, display name and address). It reads no
-- bookmark or other content of any workspace and shows no member who is not an owner. Writes
-- 'instance.workspaces_viewed' for the admin, in the same call.
CREATE OR REPLACE FUNCTION public.sys_instance_list_workspaces(p_event_id uuid, p_ip_prefix cidr)
  RETURNS TABLE (workspace_id uuid, workspace_name text, workspace_created_at timestamptz, member_count bigint, owners jsonb)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_label text;
BEGIN
  IF p_event_id IS NULL THEN
    RAISE EXCEPTION 'sys_instance_list_workspaces needs an event id' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.display_name INTO v_label
  FROM public.accounts a
  WHERE a.id = public.app_account_id() AND a.is_instance_admin AND a.mfa_enabled_at IS NOT NULL AND a.disabled_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the instance operations are for instance admins with a second factor' USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO public.audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, metadata, ip_prefix)
  VALUES (p_event_id, NULL, 'account', public.app_account_id(), v_label, 'instance.workspaces_viewed', '{}'::jsonb, p_ip_prefix);

  RETURN QUERY
    SELECT
      w.id,
      w.name,
      w.created_at,
      (SELECT count(*) FROM public.workspace_members m WHERE m.workspace_id = w.id),
      coalesce(
        (SELECT jsonb_agg(
            jsonb_build_object('accountId', a.id, 'displayName', a.display_name, 'email', a.email::text)
            ORDER BY o.joined_at, a.id)
         FROM public.workspace_members o
         JOIN public.accounts a ON a.id = o.account_id
         WHERE o.workspace_id = w.id AND o.role = 'owner'),
        '[]'::jsonb)
    FROM public.workspaces w
    WHERE w.deleting_at IS NULL
    ORDER BY w.created_at DESC, w.id;
END
$$;

-- sys_instance_create_workspace(...): a workspace and its settings row, and exactly one of two ways to its first
-- owner, in one call, so a workspace never exists half made:
--   * p_owner_account_id names an account that exists and is not disabled: it becomes the owner, as in
--     sys_create_workspace;
--   * p_owner_email names the address of the first owner: the workspace has no member and one pending owner
--     invitation (instance_issued, role owner) that holds the SHA-256 of the token the caller keeps, and that expires
--     p_ttl_seconds from now by the database's clock. The accept operations give the owner role to exactly that
--     invitation.
-- Answers 'created', with the invitation's expiry on the second path, or 'unknown_account' when the account does not
-- exist or is disabled, writing nothing. A call that names both ways or neither, or an invitation without its
-- identifier, hash and lifetime, raises invalid_parameter_value. Writes 'instance.workspace_created' for the
-- workspace, naming only which way the owner was chosen. The account row is locked while it is checked, so a
-- concurrent disabling waits for the owner membership or is seen by the check.
CREATE OR REPLACE FUNCTION public.sys_instance_create_workspace(
  p_event_id uuid,
  p_ip_prefix cidr,
  p_workspace_id uuid,
  p_name text,
  p_owner_account_id uuid,
  p_owner_email citext,
  p_invitation_id uuid,
  p_token_hash bytea,
  p_ttl_seconds integer
) RETURNS TABLE (outcome text, invitation_expires_at timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_label text;
  v_expires timestamptz;
BEGIN
  IF p_event_id IS NULL OR p_workspace_id IS NULL OR p_name IS NULL THEN
    RAISE EXCEPTION 'sys_instance_create_workspace needs an event id, a workspace id and a name' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF (p_owner_account_id IS NULL) = (p_owner_email IS NULL) THEN
    RAISE EXCEPTION 'sys_instance_create_workspace needs an owner account or an owner address, and not both' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_owner_email IS NOT NULL AND (p_invitation_id IS NULL OR p_token_hash IS NULL OR p_ttl_seconds IS NULL OR p_ttl_seconds < 1) THEN
    RAISE EXCEPTION 'sys_instance_create_workspace needs an invitation id, a token hash and a lifetime for an owner address' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.display_name INTO v_label
  FROM public.accounts a
  WHERE a.id = public.app_account_id() AND a.is_instance_admin AND a.mfa_enabled_at IS NOT NULL AND a.disabled_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the instance operations are for instance admins with a second factor' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_owner_account_id IS NOT NULL THEN
    PERFORM 1 FROM public.accounts o WHERE o.id = p_owner_account_id AND o.disabled_at IS NULL FOR SHARE;
    IF NOT FOUND THEN
      RETURN QUERY SELECT 'unknown_account'::text, NULL::timestamptz;
      RETURN;
    END IF;
  END IF;

  INSERT INTO public.workspaces (id, name, created_by) VALUES (p_workspace_id, p_name, public.app_account_id());
  INSERT INTO public.workspace_settings (workspace_id, updated_by) VALUES (p_workspace_id, public.app_account_id());
  IF p_owner_account_id IS NOT NULL THEN
    INSERT INTO public.workspace_members (workspace_id, account_id, role) VALUES (p_workspace_id, p_owner_account_id, 'owner');
  ELSE
    INSERT INTO public.workspace_invitations (id, workspace_id, email, role, instance_issued, token_hash, invited_by, expires_at)
    VALUES (p_invitation_id, p_workspace_id, p_owner_email, 'owner', true, p_token_hash, public.app_account_id(), clock_timestamp() + p_ttl_seconds * interval '1 second')
    RETURNING expires_at INTO v_expires;
  END IF;

  INSERT INTO public.audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, entity_type, entity_id, metadata, ip_prefix)
  VALUES (
    p_event_id, NULL, 'account', public.app_account_id(), v_label, 'instance.workspace_created', 'workspace', p_workspace_id,
    jsonb_build_object('owner', CASE WHEN p_owner_account_id IS NOT NULL THEN 'account' ELSE 'invitation' END), p_ip_prefix
  );

  RETURN QUERY SELECT 'created'::text, v_expires;
END
$$;

-- sys_instance_delete_workspace(event_id, ip_prefix, workspace_id): the request half of deleting a workspace as
-- the instance admin, with the effects of sys_workspace_mark_deleting: deleting_at hides the workspace from every
-- policy and lookup that names it, the sessions that had it active are pointed at none and the API tokens bound
-- to it are revoked. The caller queues the job that removes the rows in the same transaction, once this answers
-- true. The row is locked first with the lock the owner trigger of workspace_members takes, so a removal that commits
-- concurrently waits and then finds the workspace exempt from the owner rule. Answers false, changing and writing
-- nothing, for a workspace that does not exist or is already being deleted. Writes
-- 'instance.workspace_deletion_requested' for the workspace in the same call.
CREATE OR REPLACE FUNCTION public.sys_instance_delete_workspace(p_event_id uuid, p_ip_prefix cidr, p_workspace_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_label text;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_event_id IS NULL OR p_workspace_id IS NULL THEN
    RAISE EXCEPTION 'sys_instance_delete_workspace needs an event id and a workspace' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.display_name INTO v_label
  FROM public.accounts a
  WHERE a.id = public.app_account_id() AND a.is_instance_admin AND a.mfa_enabled_at IS NOT NULL AND a.disabled_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the instance operations are for instance admins with a second factor' USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM 1 FROM public.workspaces w
  WHERE w.id = p_workspace_id AND w.deleting_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE public.workspaces SET deleting_at = v_now WHERE id = p_workspace_id;
  UPDATE public.sessions SET active_workspace_id = NULL WHERE active_workspace_id = p_workspace_id;
  UPDATE public.api_tokens SET revoked_at = v_now WHERE workspace_id = p_workspace_id AND revoked_at IS NULL;

  INSERT INTO public.audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, entity_type, entity_id, metadata, ip_prefix)
  VALUES (p_event_id, NULL, 'account', public.app_account_id(), v_label, 'instance.workspace_deletion_requested', 'workspace', p_workspace_id, '{}'::jsonb, p_ip_prefix);
  RETURN true;
END
$$;

ALTER FUNCTION public.sys_instance_list_workspaces(uuid, cidr) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_instance_create_workspace(uuid, cidr, uuid, text, uuid, citext, uuid, bytea, integer) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_instance_delete_workspace(uuid, cidr, uuid) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_instance_list_workspaces(uuid, cidr) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_instance_create_workspace(uuid, cidr, uuid, text, uuid, citext, uuid, bytea, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_instance_delete_workspace(uuid, cidr, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_instance_list_workspaces(uuid, cidr) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_instance_create_workspace(uuid, cidr, uuid, text, uuid, citext, uuid, bytea, integer) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_instance_delete_workspace(uuid, cidr, uuid) TO slugbase_app;
