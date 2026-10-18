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
-- and every unused password-reset token, since a reset requested before the
-- owner verified is not the owner's. Only then is the address marked verified.
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
    SET mfa_secret = NULL, mfa_secret_key_id = NULL, mfa_enabled_at = NULL, mfa_last_step = NULL
    WHERE id = v_account;
    v_mfa := false;
    DELETE FROM public.mfa_backup_codes WHERE account_id = v_account;
    DELETE FROM public.api_tokens WHERE account_id = v_account;
    DELETE FROM public.account_identities WHERE account_id = v_account;
    DELETE FROM public.oidc_login_states WHERE link_account_id = v_account;
    DELETE FROM public.credential_tokens WHERE account_id = v_account AND purpose = 'password_reset' AND used_at IS NULL;
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
