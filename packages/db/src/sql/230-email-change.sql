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
-- Every function that touches an account locks its row first and the tokens after,
-- the order sys_credential_token_issue takes them in, so two calls for one account
-- queue and do not wait on each other.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_email_change_request(account_id, email): records the address the account asked
-- to move to and deletes the account's unused email-change tokens of both purposes,
-- so a link of an earlier request stops working. Nothing about the address is read:
-- whether it is the account's own or another account's is for the token issue to
-- decide, so every request does the same work. False, changing nothing, for an
-- account that does not exist or is disabled; an argument that is no address-sized
-- text is refused with invalid_parameter_value.
CREATE OR REPLACE FUNCTION public.sys_email_change_request(p_account_id uuid, p_email text) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF NOT coalesce(p_account_id IS NOT NULL AND char_length(p_email) BETWEEN 3 AND 320, false) THEN
    RAISE EXCEPTION 'sys_email_change_request needs an account and an address of 3 to 320 characters'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM 1 FROM public.accounts WHERE id = p_account_id AND disabled_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  DELETE FROM public.credential_tokens
  WHERE account_id = p_account_id AND purpose IN ('email_change', 'email_change_cancel') AND used_at IS NULL;
  UPDATE public.accounts SET pending_email = p_email::public.citext WHERE id = p_account_id;
  RETURN true;
END
$$;

-- sys_email_change_clear(account_id): cancels the account's pending change: the
-- pending address is cleared and the unused email-change tokens of both purposes are
-- deleted. Repeating it, or calling it for an account with no pending change, leaves
-- the same state. False for an account that does not exist or is disabled.
CREATE OR REPLACE FUNCTION public.sys_email_change_clear(p_account_id uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'sys_email_change_clear needs an account' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM 1 FROM public.accounts WHERE id = p_account_id AND disabled_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  DELETE FROM public.credential_tokens
  WHERE account_id = p_account_id AND purpose IN ('email_change', 'email_change_cancel') AND used_at IS NULL;
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
-- the account's own or belongs to another account: the confirmation is then mailed to
-- nobody, and the caller of the request is told nothing of it. The email_change token
-- records the address it moves to (credential_tokens.target_email); the cancel token
-- records none. An older unused token of the purpose is replaced (sys_credential_token_issue),
-- and when the confirmation is declined for an address that is not free, the account's
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
  ) THEN
    DELETE FROM public.credential_tokens
    WHERE account_id = p_account_id AND purpose = 'email_change' AND used_at IS NULL;
    RETURN NULL;
  END IF;

  IF NOT public.sys_credential_token_issue(
    p_id, p_purpose, p_account_id, p_token_hash,
    CASE WHEN p_purpose = 'email_change' THEN v_pending::text END,
    p_ttl_seconds
  ) THEN
    RETURN NULL;
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
-- registration that commits while it runs. The token is used up in each of those
-- cases. The address becomes the account's email and the pending address is cleared;
-- the verified time stays, since the token proved the new address, and no session ends.
-- The account's other unused confirmation tokens are deleted; its cancel token stays,
-- so the "this wasn't me" link of the notice still works after the change.
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

  IF EXISTS (SELECT 1 FROM public.accounts o WHERE o.email = v_target AND o.id <> v_account) THEN
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
-- expired ones included. The link works whether the change is still pending or was
-- confirmed since: the address stays as it is, but no session survives. NULL comes
-- back, which a caller does not tell apart, for an unknown, used, expired, replaced or
-- foreign token and for a disabled account.
CREATE OR REPLACE FUNCTION public.sys_email_change_cancel(p_token_hash bytea) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_account uuid;
BEGIN
  IF octet_length(p_token_hash) IS DISTINCT FROM 32 THEN
    RAISE EXCEPTION 'sys_email_change_cancel needs a 32-byte token hash' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM 1 FROM public.accounts a
  WHERE a.id = (SELECT t.account_id FROM public.credential_tokens t WHERE t.purpose = 'email_change_cancel' AND t.token_hash = p_token_hash)
  FOR UPDATE;

  SELECT t.account_id INTO v_account FROM public.sys_credential_token_consume('email_change_cancel', p_token_hash) t;
  IF v_account IS NULL THEN
    RETURN NULL;
  END IF;

  PERFORM 1 FROM public.accounts a WHERE a.id = v_account AND a.disabled_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  UPDATE public.accounts SET pending_email = NULL WHERE id = v_account AND pending_email IS NOT NULL;
  DELETE FROM public.credential_tokens WHERE account_id = v_account AND purpose = 'email_change' AND used_at IS NULL;
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
