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
