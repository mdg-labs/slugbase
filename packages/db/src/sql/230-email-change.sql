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
-- the account's own or belongs to another account: the confirmation is then mailed to
-- nobody, and the caller of the request is told nothing of it. The email_change token
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
-- registration that commits while it runs. The token is used up in each of those
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
