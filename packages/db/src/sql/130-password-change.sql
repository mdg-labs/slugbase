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
