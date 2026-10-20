-- The recovery operations of the CE instance admin (doc 05 sections 2.9 and 3.3, doc 02 sections 2.5, 2.6, 2.7 and 11.2,
-- doc 10 T4, T7, T17 and T18): reset the second factor of an account, issue a password-reset token for it, ask for a new
-- verification email, and mark the address of an account verified. All are entered in src/system/registry.ts.
-- slugbase_owner creates each function and hands it to slugbase_system, which needs CREATE on the schema for the length of
-- those statements. The tables are unchanged.
--
-- Like every sys_instance_* function each repeats the check of the instanceAdmin policy inside its own body: the account of
-- the transaction (app_account_id(), never an argument) must hold the instance-admin flag, have a second factor enrolled and
-- not be disabled, otherwise it raises insufficient_privilege and writes nothing. Each writes its instance audit event in the
-- same call, under the identifier the application generated (Q91), and the target account is its entity.
--
-- Each function locks the rows it decides on and checks the admin again under those locks, in the order of
-- sys_instance_update_account: the rows of the admin and of the target together in identifier order. A function that
-- touches the second factor takes the target's backup-code rows first, the order sys_mfa_lock gives every writer of them.
-- A disabled target is refused by the three that would send it something or change how it signs in: a link or a mail to a
-- disabled account would let it back in through a door the disabled state keeps shut (the sign-in, session, token and
-- reset-redemption lookups all refuse it).
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_instance_update_account(admin_event_id, disabled_event_id, verified_event_id, ip_prefix, account_id, is_admin,
-- is_disabled, mark_verified): sys_instance_update_account of 390-instance-accounts.sql with a third field, so that the
-- calling admin is still checked once for the whole request. mark_verified is NULL (the field is left alone) or true; false
-- is refused with invalid_parameter_value, since nothing unverifies an address. Marking a verified address verified changes
-- nothing and writes no event. Marking an unverified one runs account_mark_verified of 210-email-verification.sql, the
-- clean-up sys_email_verify runs when the owner redeems the verification link: whoever registered the address is not
-- necessarily its owner, so the account's password is removed, its sessions, second factor and backup codes, API tokens,
-- linked identities and the pending handshakes that would link one are deleted, and so are its unused password-reset,
-- email-change and verification tokens, all in the same transaction as the mark. The owner then gets in through a
-- password-reset token (sys_instance_issue_reset_link) or through a provider. It writes 'instance.account_email_verified'
-- under verified_event_id. The one account the clean-up does not run for is the calling admin's own, whose second factor
-- and session are what authorised the call: for it the address is marked and its unused verification tokens deleted, and
-- nothing else changes. A disabled account may be marked verified; that opens no door, since a reset or a sign-in refuses
-- it for as long as it is disabled. A call that marks an address takes the target's backup-code rows
-- first, the order sys_mfa_lock gives every writer of them. Everything else is as sys_instance_update_account was: the
-- same locks, the same refusals, and the extra column verified_changed after disabled_changed.
CREATE OR REPLACE FUNCTION public.sys_instance_update_account(
    p_admin_event_id uuid, p_disabled_event_id uuid, p_verified_event_id uuid, p_ip_prefix cidr, p_account_id uuid,
    p_is_admin boolean, p_is_disabled boolean, p_mark_verified boolean
  )
  RETURNS TABLE (
    outcome text, refused_field text, admin_changed boolean, disabled_changed boolean, verified_changed boolean,
    acct_id uuid, acct_name text, acct_email text, acct_verified boolean, acct_mfa_on boolean, acct_admin boolean,
    acct_disabled boolean, acct_last_sign_in timestamptz, acct_workspaces bigint
  )
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_label text;
  v_was_admin boolean;
  v_was_disabled boolean;
  v_was_verified boolean;
  v_admin_change boolean;
  v_disabled_change boolean;
  v_verified_change boolean;
BEGIN
  IF p_account_id IS NULL OR (p_is_admin IS NULL AND p_is_disabled IS NULL AND p_mark_verified IS NULL) OR p_mark_verified IS FALSE
     OR (p_is_admin IS NOT NULL AND p_admin_event_id IS NULL) OR (p_is_disabled IS NOT NULL AND p_disabled_event_id IS NULL)
     OR (p_mark_verified IS NOT NULL AND p_verified_event_id IS NULL) THEN
    RAISE EXCEPTION 'sys_instance_update_account needs an account, an event id for each field, a value for at least one and true for mark_verified' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.display_name INTO v_label
  FROM public.accounts a
  WHERE a.id = public.app_account_id() AND a.is_instance_admin AND a.mfa_enabled_at IS NOT NULL AND a.disabled_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the instance operations are for instance admins with a second factor' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_mark_verified IS NOT NULL THEN
    PERFORM 1 FROM public.mfa_backup_codes c WHERE c.account_id = p_account_id ORDER BY c.id FOR UPDATE;
  END IF;
  PERFORM 1 FROM public.accounts a WHERE a.id IN (public.app_account_id(), p_account_id) ORDER BY a.id FOR UPDATE;
  SELECT a.display_name INTO v_label
  FROM public.accounts a
  WHERE a.id = public.app_account_id() AND a.is_instance_admin AND a.mfa_enabled_at IS NOT NULL AND a.disabled_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the instance operations are for instance admins with a second factor' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT a.is_instance_admin, a.disabled_at IS NOT NULL, a.email_verified_at IS NOT NULL INTO v_was_admin, v_was_disabled, v_was_verified
  FROM public.accounts a WHERE a.id = p_account_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'unknown_account'::text, NULL::text, NULL::boolean, NULL::boolean, NULL::boolean, NULL::uuid, NULL::text, NULL::text, NULL::boolean, NULL::boolean, NULL::boolean, NULL::boolean, NULL::timestamptz, NULL::bigint;
    RETURN;
  END IF;

  v_admin_change := p_is_admin IS NOT NULL AND p_is_admin IS DISTINCT FROM v_was_admin;
  v_disabled_change := p_is_disabled IS NOT NULL AND p_is_disabled IS DISTINCT FROM v_was_disabled;
  v_verified_change := p_mark_verified IS NOT NULL AND NOT v_was_verified;

  IF v_was_admin AND NOT v_was_disabled
     AND (NOT COALESCE(p_is_admin, v_was_admin) OR COALESCE(p_is_disabled, v_was_disabled)) THEN
    PERFORM pg_advisory_xact_lock(hashtext('slugbase.instance_admins'));
    IF NOT EXISTS (SELECT 1 FROM public.accounts o WHERE o.is_instance_admin AND o.disabled_at IS NULL AND o.id <> p_account_id) THEN
      RETURN QUERY SELECT 'last_instance_admin'::text,
        CASE WHEN p_is_admin IS NOT DISTINCT FROM false THEN 'isInstanceAdmin' ELSE 'disabled' END,
        NULL::boolean, NULL::boolean, NULL::boolean, NULL::uuid, NULL::text, NULL::text, NULL::boolean, NULL::boolean, NULL::boolean, NULL::boolean, NULL::timestamptz, NULL::bigint;
      RETURN;
    END IF;
  END IF;

  IF v_admin_change THEN
    UPDATE public.accounts SET is_instance_admin = p_is_admin WHERE id = p_account_id;
  END IF;
  IF v_disabled_change THEN
    UPDATE public.accounts SET disabled_at = CASE WHEN p_is_disabled THEN clock_timestamp() END WHERE id = p_account_id;
  END IF;
  IF v_verified_change THEN
    IF p_account_id = public.app_account_id() THEN
      UPDATE public.accounts SET email_verified_at = clock_timestamp() WHERE id = p_account_id;
    ELSE
      PERFORM public.account_mark_verified(p_account_id, NULL);
    END IF;
    DELETE FROM public.credential_tokens WHERE account_id = p_account_id AND purpose = 'email_verify' AND used_at IS NULL;
  END IF;
  IF v_admin_change OR (v_disabled_change AND p_is_disabled) THEN
    DELETE FROM public.sessions WHERE account_id = p_account_id;
  END IF;
  IF v_admin_change THEN
    INSERT INTO public.audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, entity_type, entity_id, metadata, ip_prefix)
    VALUES (
      p_admin_event_id, NULL, 'account', public.app_account_id(), v_label,
      CASE WHEN p_is_admin THEN 'instance.account_admin_granted' ELSE 'instance.account_admin_revoked' END,
      'account', p_account_id, '{}'::jsonb, p_ip_prefix
    );
  END IF;
  IF v_disabled_change THEN
    -- The stream is read by created_at and then by identifier, and now() is the same for every row of a transaction, so
    -- the later events of a call are stamped with the clock to come after the first whatever the identifiers are.
    INSERT INTO public.audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, entity_type, entity_id, metadata, ip_prefix, created_at)
    VALUES (
      p_disabled_event_id, NULL, 'account', public.app_account_id(), v_label,
      CASE WHEN p_is_disabled THEN 'instance.account_disabled' ELSE 'instance.account_enabled' END,
      'account', p_account_id, '{}'::jsonb, p_ip_prefix, clock_timestamp()
    );
  END IF;
  IF v_verified_change THEN
    INSERT INTO public.audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, entity_type, entity_id, metadata, ip_prefix, created_at)
    VALUES (p_verified_event_id, NULL, 'account', public.app_account_id(), v_label, 'instance.account_email_verified', 'account', p_account_id, '{}'::jsonb, p_ip_prefix, clock_timestamp());
  END IF;

  RETURN QUERY
    SELECT 'updated'::text, NULL::text, v_admin_change, v_disabled_change, v_verified_change,
           a.id, a.display_name, a.email::text, a.email_verified_at IS NOT NULL, a.mfa_enabled_at IS NOT NULL,
           a.is_instance_admin, a.disabled_at IS NOT NULL, a.last_sign_in_at,
           (SELECT count(*) FROM public.workspace_members m JOIN public.workspaces w ON w.id = m.workspace_id AND w.deleting_at IS NULL WHERE m.account_id = a.id)
    FROM public.accounts a WHERE a.id = p_account_id;
END
$$;

-- The six-argument form of 390-instance-accounts.sql stays for a replica of the previous release that still calls it
-- while a deployment rolls: it is the eight-argument function without the third field, so the two cannot differ.
CREATE OR REPLACE FUNCTION public.sys_instance_update_account(
    p_admin_event_id uuid, p_disabled_event_id uuid, p_ip_prefix cidr, p_account_id uuid, p_is_admin boolean, p_is_disabled boolean
  )
  RETURNS TABLE (
    outcome text, refused_field text, admin_changed boolean, disabled_changed boolean,
    acct_id uuid, acct_name text, acct_email text, acct_verified boolean, acct_mfa_on boolean, acct_admin boolean,
    acct_disabled boolean, acct_last_sign_in timestamptz, acct_workspaces bigint
  )
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT r.outcome, r.refused_field, r.admin_changed, r.disabled_changed,
           r.acct_id, r.acct_name, r.acct_email, r.acct_verified, r.acct_mfa_on, r.acct_admin,
           r.acct_disabled, r.acct_last_sign_in, r.acct_workspaces
    FROM public.sys_instance_update_account(
      p_admin_event_id, p_disabled_event_id, NULL::uuid, p_ip_prefix, p_account_id, p_is_admin, p_is_disabled, NULL::boolean
    ) r
  $$;

-- sys_instance_reset_mfa(event_id, ip_prefix, account_id): turns the second factor of the account off for a member who has
-- lost both the authenticator and the backup codes (doc 02 section 2.7): clears the secret, its key id, enabled_at and the
-- last accepted step, deletes every backup code, used ones included, and deletes every session of the account, partial
-- ones too, so that the next request of each answers 401 and the account signs in with its password alone. The secret is
-- cleared and never read or copied. Writes 'instance.account_mfa_reset' with the account as entity in the same call. The
-- caller queues the email that tells the account when this answers 'reset'.
-- Answers:
--   * 'reset': the second factor was on and is off, and the event is written;
--   * 'mfa_not_enabled': the account has no confirmed second factor (a pending enrolment is left alone), so nothing is
--     written, deleted or queued; a second admin who asks after the first finds this;
--   * 'account_disabled': the account is disabled;
--   * 'self': the target is the calling admin, whose second factor is turned off with the second factor that
--     disabling it asks for (doc 10 T17), not by a request that needs only a re-authentication;
--   * 'unknown_account': no such account.
-- The backup-code rows of the account are locked first, then the rows of the admin and of the account in identifier order,
-- the order sys_mfa_lock and the sign-in with a backup code use, then the session rows are deleted. A sign-in of the
-- account that the reset races is therefore one of two things: it read the second factor as on and its session is deleted
-- here or promotes against an account whose second factor is off, which sys_session_promote refuses, or it read it as off
-- after the reset and signs in with the password alone.
CREATE OR REPLACE FUNCTION public.sys_instance_reset_mfa(p_event_id uuid, p_ip_prefix cidr, p_account_id uuid)
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_label text;
  v_disabled boolean;
  v_enabled boolean;
BEGIN
  IF p_event_id IS NULL OR p_account_id IS NULL THEN
    RAISE EXCEPTION 'sys_instance_reset_mfa needs an event id and an account' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.display_name INTO v_label
  FROM public.accounts a
  WHERE a.id = public.app_account_id() AND a.is_instance_admin AND a.mfa_enabled_at IS NOT NULL AND a.disabled_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the instance operations are for instance admins with a second factor' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_account_id = public.app_account_id() THEN
    RETURN 'self';
  END IF;

  PERFORM 1 FROM public.mfa_backup_codes c WHERE c.account_id = p_account_id ORDER BY c.id FOR UPDATE;
  PERFORM 1 FROM public.accounts a WHERE a.id IN (public.app_account_id(), p_account_id) ORDER BY a.id FOR UPDATE;
  SELECT a.display_name INTO v_label
  FROM public.accounts a
  WHERE a.id = public.app_account_id() AND a.is_instance_admin AND a.mfa_enabled_at IS NOT NULL AND a.disabled_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the instance operations are for instance admins with a second factor' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT a.disabled_at IS NOT NULL, a.mfa_enabled_at IS NOT NULL INTO v_disabled, v_enabled FROM public.accounts a WHERE a.id = p_account_id;
  IF NOT FOUND THEN
    RETURN 'unknown_account';
  END IF;
  IF v_disabled THEN
    RETURN 'account_disabled';
  END IF;
  IF NOT v_enabled THEN
    RETURN 'mfa_not_enabled';
  END IF;

  UPDATE public.accounts
  SET mfa_secret = NULL, mfa_secret_key_id = NULL, mfa_enabled_at = NULL, mfa_last_step = NULL
  WHERE id = p_account_id;
  DELETE FROM public.mfa_backup_codes WHERE account_id = p_account_id;
  DELETE FROM public.sessions WHERE account_id = p_account_id;
  INSERT INTO public.audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, entity_type, entity_id, metadata, ip_prefix)
  VALUES (p_event_id, NULL, 'account', public.app_account_id(), v_label, 'instance.account_mfa_reset', 'account', p_account_id, '{}'::jsonb, p_ip_prefix);
  RETURN 'reset';
END
$$;

-- sys_instance_issue_reset_link(event_id, ip_prefix, account_id, token_id, token_hash): vouches that the account may be
-- sent a password-reset token (doc 02 sections 2.5 and 11.2) and writes 'instance.account_reset_link_issued' with the
-- account as entity and the metadata delivery, 'mail' or 'link'. With a token hash (32 bytes, generated by the application
-- and never stored in the clear) it issues the one-hour token through sys_credential_token_issue, which ends the account's
-- earlier unused reset tokens, so that the application can return the link once; delivery is 'link'. Without one, delivery
-- is 'mail' and no token exists yet: the caller queues the password-reset email in the same transaction, and the mail job
-- makes the token when it runs, as it does for a member's own request. A token and its hash come together.
-- Answers 'issued', or a refusal that writes nothing and issues nothing:
--   * 'account_disabled': the account is disabled, which its redemption would refuse anyway;
--   * 'email_unverified': the address was never verified; a reset is for the owner of a verified address (sys_password_reset),
--     and the way into such an account is to mark the address verified or resend the verification email;
--   * 'no_password': the account signs in through a provider only: it has no password and a linked provider identity, and
--     doc 02 section 2.5 gives it no reset, only a password added after a re-authentication through its provider. An
--     account with neither a password nor an identity, which is what marking its address verified leaves, is not that
--     account: the reset link is its way in;
--   * 'link_required': the call asked for the mail and the account has no password, so the mail job, which sends the
--     reset email only to an account with one, would send nothing; the caller asks again with a token and hands the link
--     over;
--   * 'unknown_account': no such account.
-- These are the conditions the mail job and the redemption apply, so a link is never issued that the redemption refuses,
-- and a mail is never promised that the job would not send. Redeeming it is the ordinary sys_password_reset: the password
-- is set, every session of the account is deleted and the new one is partial for an account whose second factor is on.
CREATE OR REPLACE FUNCTION public.sys_instance_issue_reset_link(p_event_id uuid, p_ip_prefix cidr, p_account_id uuid, p_token_id uuid, p_token_hash bytea)
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_label text;
  v_disabled boolean;
  v_verified boolean;
  v_password boolean;
  v_identity boolean;
BEGIN
  IF p_event_id IS NULL OR p_account_id IS NULL OR (p_token_id IS NULL) <> (p_token_hash IS NULL)
     OR (p_token_hash IS NOT NULL AND octet_length(p_token_hash) <> 32) THEN
    RAISE EXCEPTION 'sys_instance_issue_reset_link needs an event id, an account, and a token identifier with a 32-byte hash or neither' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.display_name INTO v_label
  FROM public.accounts a
  WHERE a.id = public.app_account_id() AND a.is_instance_admin AND a.mfa_enabled_at IS NOT NULL AND a.disabled_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the instance operations are for instance admins with a second factor' USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM 1 FROM public.accounts a WHERE a.id IN (public.app_account_id(), p_account_id) ORDER BY a.id FOR UPDATE;
  SELECT a.display_name INTO v_label
  FROM public.accounts a
  WHERE a.id = public.app_account_id() AND a.is_instance_admin AND a.mfa_enabled_at IS NOT NULL AND a.disabled_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the instance operations are for instance admins with a second factor' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT a.disabled_at IS NOT NULL, a.email_verified_at IS NOT NULL, a.password_hash IS NOT NULL,
         EXISTS (SELECT 1 FROM public.account_identities i WHERE i.account_id = a.id)
  INTO v_disabled, v_verified, v_password, v_identity
  FROM public.accounts a WHERE a.id = p_account_id;
  IF NOT FOUND THEN
    RETURN 'unknown_account';
  END IF;
  IF v_disabled THEN
    RETURN 'account_disabled';
  END IF;
  IF NOT v_verified THEN
    RETURN 'email_unverified';
  END IF;
  IF NOT v_password AND v_identity THEN
    RETURN 'no_password';
  END IF;
  IF NOT v_password AND p_token_hash IS NULL THEN
    RETURN 'link_required';
  END IF;

  IF p_token_hash IS NOT NULL
     AND NOT public.sys_credential_token_issue(p_token_id, 'password_reset', p_account_id, p_token_hash, NULL, 3600) THEN
    RAISE EXCEPTION 'the password-reset token of the account could not be issued';
  END IF;

  INSERT INTO public.audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, entity_type, entity_id, metadata, ip_prefix)
  VALUES (
    p_event_id, NULL, 'account', public.app_account_id(), v_label, 'instance.account_reset_link_issued', 'account', p_account_id,
    jsonb_build_object('delivery', CASE WHEN p_token_hash IS NULL THEN 'mail' ELSE 'link' END), p_ip_prefix
  );
  RETURN 'issued';
END
$$;

-- sys_instance_resend_verification(event_id, ip_prefix, account_id): vouches that the account may be sent a new
-- verification email (doc 02 section 2.6) and writes 'instance.account_verification_resent' with the account as entity.
-- No token is made here: the caller queues the verification email in the same transaction and the mail job makes the
-- token when it runs, which replaces the account's earlier unused one. Answers 'requested', or a refusal that writes
-- nothing: 'already_verified' for an address that was verified (the job would send nothing), 'account_disabled' for a
-- disabled account, and 'unknown_account'.
CREATE OR REPLACE FUNCTION public.sys_instance_resend_verification(p_event_id uuid, p_ip_prefix cidr, p_account_id uuid)
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_label text;
  v_disabled boolean;
  v_verified boolean;
BEGIN
  IF p_event_id IS NULL OR p_account_id IS NULL THEN
    RAISE EXCEPTION 'sys_instance_resend_verification needs an event id and an account' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.display_name INTO v_label
  FROM public.accounts a
  WHERE a.id = public.app_account_id() AND a.is_instance_admin AND a.mfa_enabled_at IS NOT NULL AND a.disabled_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the instance operations are for instance admins with a second factor' USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM 1 FROM public.accounts a WHERE a.id IN (public.app_account_id(), p_account_id) ORDER BY a.id FOR UPDATE;
  SELECT a.display_name INTO v_label
  FROM public.accounts a
  WHERE a.id = public.app_account_id() AND a.is_instance_admin AND a.mfa_enabled_at IS NOT NULL AND a.disabled_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the instance operations are for instance admins with a second factor' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT a.disabled_at IS NOT NULL, a.email_verified_at IS NOT NULL INTO v_disabled, v_verified FROM public.accounts a WHERE a.id = p_account_id;
  IF NOT FOUND THEN
    RETURN 'unknown_account';
  END IF;
  IF v_disabled THEN
    RETURN 'account_disabled';
  END IF;
  IF v_verified THEN
    RETURN 'already_verified';
  END IF;

  INSERT INTO public.audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, entity_type, entity_id, metadata, ip_prefix)
  VALUES (p_event_id, NULL, 'account', public.app_account_id(), v_label, 'instance.account_verification_resent', 'account', p_account_id, '{}'::jsonb, p_ip_prefix);
  RETURN 'requested';
END
$$;

ALTER FUNCTION public.sys_instance_update_account(uuid, uuid, uuid, cidr, uuid, boolean, boolean, boolean) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_instance_update_account(uuid, uuid, cidr, uuid, boolean, boolean) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_instance_reset_mfa(uuid, cidr, uuid) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_instance_issue_reset_link(uuid, cidr, uuid, uuid, bytea) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_instance_resend_verification(uuid, cidr, uuid) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_instance_update_account(uuid, uuid, uuid, cidr, uuid, boolean, boolean, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_instance_reset_mfa(uuid, cidr, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_instance_issue_reset_link(uuid, cidr, uuid, uuid, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_instance_resend_verification(uuid, cidr, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_instance_update_account(uuid, uuid, uuid, cidr, uuid, boolean, boolean, boolean) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_instance_reset_mfa(uuid, cidr, uuid) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_instance_issue_reset_link(uuid, cidr, uuid, uuid, bytea) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_instance_resend_verification(uuid, cidr, uuid) TO slugbase_app;
