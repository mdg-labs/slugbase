-- The system operation behind redeeming a password-reset token (doc 05 section
-- 3.3, doc 02 section 2.5, doc 04 sections 4.5 and 10.2, doc 10 T4, T8 and T17).
-- It is entered in src/system/registry.ts. slugbase_owner creates the function
-- and hands it to slugbase_system, which needs CREATE on the schema for the
-- length of those statements.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_password_reset(token_hash, password_hash, session_id, session_token_hash,
-- ip_prefix, user_agent, replaced_token_hash): redeems a password-reset token
-- and signs the account in, all in this one call. The token is consumed first
-- (sys_credential_token_consume: once, before its expiry, purpose
-- password_reset); no row comes back for an unknown, used, expired or foreign
-- token, none for an account that is disabled and none for one whose address
-- was never verified, which a caller does not tell apart. A reset is for the
-- owner of a verified address: an account nobody has verified may have been set
-- up by whoever registered the address first, and only the verification takes
-- that setup away (sys_email_verify). The stored hash is replaced
-- (sys_password_set, which also moves password_changed_at) and every session of
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
