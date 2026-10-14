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
