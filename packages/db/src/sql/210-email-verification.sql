-- The system operations behind verifying a registered address, and the read that
-- tells a sign-in whether the address was verified (doc 05 section 3.3, doc 02
-- sections 2.2, 2.3 and 2.6, doc 04
-- section 10.2, doc 10 T4 and T8). All are entered in src/system/registry.ts.
-- slugbase_owner creates each function and hands it to slugbase_system, which
-- needs CREATE on the schema for the length of those statements.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- account_mark_verified(account_id, password_hash): what marking an address verified does to the account of
-- an address nobody had verified, the one place the rule is written. Whoever registers an address is not necessarily its
-- owner, so verifying takes away what the registrant set up (doc 02 section 2.6): the stored password is replaced by the
-- hash given, or removed when none is, and password_changed_at moves with it; every session of the account is deleted;
-- the second factor (a pending enrolment included) and its backup codes, the API tokens, the linked identities and the
-- pending handshakes that would link one are removed; every unused password-reset token, since a reset requested before
-- the owner verified is not the owner's, and the pending change of email with its unused confirmation and cancel tokens
-- are removed; then the address is marked verified. The caller holds the account's backup-code rows and then the row of
-- the account locked, the order sys_mfa_lock documents, and has checked that the account is not disabled. Raises for an
-- account that does not exist or whose address is verified already, which a caller must keep from reaching it. It is called by sys_email_verify (the owner's own password) and by
-- sys_instance_update_account (no password: the owner gets in through a password-reset token or a provider). It is not a
-- system operation: it is SECURITY INVOKER, owned by slugbase_system and executable by it alone, so it runs only inside
-- those two functions and slugbase_app cannot call it.
CREATE OR REPLACE FUNCTION public.account_mark_verified(p_account_id uuid, p_password_hash text) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY INVOKER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  PERFORM 1 FROM public.accounts a WHERE a.id = p_account_id AND a.email_verified_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account_mark_verified needs an account whose address is not verified' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_password_hash IS NULL THEN
    UPDATE public.accounts SET password_hash = NULL, password_changed_at = clock_timestamp() WHERE id = p_account_id;
  ELSIF NOT public.sys_password_set(p_account_id, p_password_hash) THEN
    RAISE EXCEPTION 'the password of the account being verified could not be set';
  END IF;
  PERFORM public.sys_session_revoke_all(p_account_id, NULL);
  UPDATE public.accounts
  SET mfa_secret = NULL, mfa_secret_key_id = NULL, mfa_enabled_at = NULL, mfa_last_step = NULL, pending_email = NULL
  WHERE id = p_account_id;
  DELETE FROM public.mfa_backup_codes WHERE account_id = p_account_id;
  DELETE FROM public.api_tokens WHERE account_id = p_account_id;
  DELETE FROM public.account_identities WHERE account_id = p_account_id;
  DELETE FROM public.oidc_login_states WHERE link_account_id = p_account_id;
  DELETE FROM public.credential_tokens
  WHERE account_id = p_account_id AND purpose IN ('password_reset', 'email_change', 'email_change_cancel') AND used_at IS NULL;
  UPDATE public.accounts SET email_verified_at = clock_timestamp() WHERE id = p_account_id;
END
$$;

-- sys_email_verify(token_hash, password_hash, session_id, session_token_hash,
-- ip_prefix, user_agent, replaced_token_hash): redeems a signup verification
-- token and signs the account in, all in this one call. The account the token
-- belongs to is found by a read that locks nothing. Its backup-code rows are locked
-- first (in id order), the order sys_mfa_lock gives every writer of them, so a
-- redemption queues behind a sign-in with a backup code, a rewrite of the codes and
-- the instance admin's reset of the second factor or mark of the address instead of
-- deadlocking with them; then its account row; and the token is consumed after that
-- (sys_credential_token_consume: once, before its expiry, purpose email_verify), the
-- account row before the token row being the order in which
-- sys_credential_token_issue takes those two, so a redemption and an
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
-- verified is not the owner's either. Only then is the address marked verified. All of that is
-- account_mark_verified above, which the instance admin's marking of an address verified runs too.
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
  v_token_account uuid;
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

  SELECT t.account_id INTO v_token_account
  FROM public.credential_tokens t WHERE t.purpose = 'email_verify' AND t.token_hash = p_token_hash;
  PERFORM 1 FROM public.mfa_backup_codes c WHERE c.account_id = v_token_account ORDER BY c.id FOR UPDATE;
  PERFORM 1 FROM public.accounts a WHERE a.id = v_token_account FOR UPDATE;

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
    PERFORM public.account_mark_verified(v_account, p_password_hash);
    v_mfa := false;
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

ALTER FUNCTION public.account_mark_verified(uuid, text) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_email_verify(bytea, text, uuid, bytea, cidr, text, bytea) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_account_email_verified(uuid) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.account_mark_verified(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_email_verify(bytea, text, uuid, bytea, cidr, text, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_account_email_verified(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_email_verify(bytea, text, uuid, bytea, cidr, text, bytea) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_account_email_verified(uuid) TO slugbase_app;
