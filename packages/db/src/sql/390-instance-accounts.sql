-- The account operations of the CE instance admin (doc 05 sections 2.1, 3.3 and 7.1, doc 02 sections 2.3 and 11.2,
-- doc 10 T4 and T18): list every account without a hash, a secret or any content, and change an account's
-- instance-admin flag and disabled state. Both are entered in src/system/registry.ts. slugbase_owner creates each
-- function and hands it to slugbase_system, which needs CREATE on the schema for the length of those statements. The
-- tables are unchanged.
--
-- Like every sys_instance_* function each repeats the check of the instanceAdmin policy inside its own body: the
-- account of the transaction (app_account_id(), never an argument) must hold the instance-admin flag, have a second
-- factor enrolled and not be disabled, otherwise it raises insufficient_privilege and writes nothing. Each writes its
-- instance audit event in the same call, under the identifier the application generated (Q91).
--
-- The result columns are prefixed acct_ so that none of them is read as a column of the tables the bodies query.
--
-- The function that changes an account locks the rows of the admin and of the account it changes together, in
-- identifier order, before it reads anything it decides on, and checks the admin once more under those locks. Every
-- change writes an audit event that names the admin, whose foreign key takes a share lock on the admin's row, so two
-- admins who changed each other, each having locked only the account they change, would wait on each other's row and
-- the database would abort one with a deadlock error; the one order cannot. The row of the admin being locked as well
-- means the admin is still an enabled admin when the change commits: a change that takes that admin away waits for it.
-- The flag and the disabled state of an account are changed by one call, so that the admin is checked once for the
-- whole request: an admin who changes their own account would otherwise be checked a second time after the first
-- change had already taken the flag or the enabled state from them.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_instance_list_accounts(event_id, ip_prefix): every account, oldest first, with its display name, address,
-- whether the address was confirmed and a second factor is on, the flag, whether it is disabled, its last complete
-- sign-in and the number of workspaces, not being deleted, it is a member of. It selects no password hash, no MFA
-- secret and nothing a workspace holds. Writes 'instance.accounts_viewed' for the admin, in the same call.
CREATE OR REPLACE FUNCTION public.sys_instance_list_accounts(p_event_id uuid, p_ip_prefix cidr)
  RETURNS TABLE (
    acct_id uuid, acct_name text, acct_email text, acct_verified boolean, acct_mfa_on boolean, acct_admin boolean,
    acct_disabled boolean, acct_last_sign_in timestamptz, acct_workspaces bigint
  )
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_label text;
BEGIN
  IF p_event_id IS NULL THEN
    RAISE EXCEPTION 'sys_instance_list_accounts needs an event id' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.display_name INTO v_label
  FROM public.accounts a
  WHERE a.id = public.app_account_id() AND a.is_instance_admin AND a.mfa_enabled_at IS NOT NULL AND a.disabled_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the instance operations are for instance admins with a second factor' USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO public.audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, metadata, ip_prefix)
  VALUES (p_event_id, NULL, 'account', public.app_account_id(), v_label, 'instance.accounts_viewed', '{}'::jsonb, p_ip_prefix);

  RETURN QUERY
    SELECT
      a.id,
      a.display_name,
      a.email::text,
      a.email_verified_at IS NOT NULL,
      a.mfa_enabled_at IS NOT NULL,
      a.is_instance_admin,
      a.disabled_at IS NOT NULL,
      a.last_sign_in_at,
      (SELECT count(*) FROM public.workspace_members m JOIN public.workspaces w ON w.id = m.workspace_id AND w.deleting_at IS NULL WHERE m.account_id = a.id)
    FROM public.accounts a
    ORDER BY a.created_at, a.id;
END
$$;

-- sys_instance_update_account(admin_event_id, disabled_event_id, ip_prefix, account_id, is_admin, is_disabled): sets
-- (true) or clears (false) the instance-admin flag of the account and disables (true) or enables (false) it; a value
-- that is NULL leaves its field as it is, and at least one must be given. The admin is checked once for both fields.
-- When the flag changes, the event 'instance.account_admin_granted' or 'instance.account_admin_revoked' is written under
-- admin_event_id; when the disabled state changes, 'instance.account_disabled' or 'instance.account_enabled' under
-- disabled_event_id; each names the account as its entity and is written in the same call. A change of the flag, and
-- disabling, delete every session of the account, whatever its level, so the next request of each answers 401 and a
-- privilege change cannot ride a token issued before it (doc 02 section 2.3); the lookups of the sign-in, of a session
-- and of an API token already refuse an account with disabled_at set, so its tokens stop working with no row of theirs
-- changed, and work again if the account is enabled. A field that already has the value is not changed and writes no
-- event; when neither field changes nothing is deleted or written. The caller queues the mail that tells the account
-- when disabled_changed is true and the account is disabled.
-- Answers the outcome, the field a refusal belongs to, which fields changed and, for 'updated', the account as it is
-- afterwards:
--   * 'updated': every field that was given is in the state it names;
--   * 'unknown_account': no such account, nothing written;
--   * 'last_instance_admin': the account is an enabled admin and the change would make it neither an admin nor enabled
--     while no other enabled admin exists, so the instance would be left without one who can sign in; nothing was
--     changed or written. refused_field is 'isInstanceAdmin' when the change clears the flag and 'disabled' otherwise.
-- The rows of the admin and of the account are locked first, and a change that takes an enabled admin away takes the
-- transaction-level advisory lock of the set of admins after them (the key sys_account_last_instance_admin takes in the
-- account deletion) and reads the other admins under it, in a statement of its own, so it sees what a change that
-- committed ahead of it left: an admin who clears their own flag while another deletes their account, which locks only
-- its own row, take the decision one after the other and one of them is refused. An admin who is disabled is not
-- another admin. The waits of this function come in one order: the rows of the admin and of the account, in identifier
-- order, then the advisory lock, then the session rows of the account when the sessions are deleted; the insert of the
-- audit event takes a share lock on the admin's row, which the function already holds. A second call of this function
-- therefore waits for the rows and the lock in the same order, and a session row only behind both. An admin whose
-- flag, second factor or enabled state a change that committed first took away is refused with insufficient_privilege,
-- as a caller who never had them.
CREATE OR REPLACE FUNCTION public.sys_instance_update_account(
    p_admin_event_id uuid, p_disabled_event_id uuid, p_ip_prefix cidr, p_account_id uuid, p_is_admin boolean, p_is_disabled boolean
  )
  RETURNS TABLE (
    outcome text, refused_field text, admin_changed boolean, disabled_changed boolean,
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
  v_admin_change boolean;
  v_disabled_change boolean;
BEGIN
  IF p_account_id IS NULL OR (p_is_admin IS NULL AND p_is_disabled IS NULL)
     OR (p_is_admin IS NOT NULL AND p_admin_event_id IS NULL) OR (p_is_disabled IS NOT NULL AND p_disabled_event_id IS NULL) THEN
    RAISE EXCEPTION 'sys_instance_update_account needs an account, an event id for each field and a value for at least one' USING ERRCODE = 'invalid_parameter_value';
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

  SELECT a.is_instance_admin, a.disabled_at IS NOT NULL INTO v_was_admin, v_was_disabled FROM public.accounts a WHERE a.id = p_account_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'unknown_account'::text, NULL::text, NULL::boolean, NULL::boolean, NULL::uuid, NULL::text, NULL::text, NULL::boolean, NULL::boolean, NULL::boolean, NULL::boolean, NULL::timestamptz, NULL::bigint;
    RETURN;
  END IF;

  v_admin_change := p_is_admin IS NOT NULL AND p_is_admin IS DISTINCT FROM v_was_admin;
  v_disabled_change := p_is_disabled IS NOT NULL AND p_is_disabled IS DISTINCT FROM v_was_disabled;

  IF v_was_admin AND NOT v_was_disabled
     AND (NOT COALESCE(p_is_admin, v_was_admin) OR COALESCE(p_is_disabled, v_was_disabled)) THEN
    PERFORM pg_advisory_xact_lock(hashtext('slugbase.instance_admins'));
    IF NOT EXISTS (SELECT 1 FROM public.accounts o WHERE o.is_instance_admin AND o.disabled_at IS NULL AND o.id <> p_account_id) THEN
      RETURN QUERY SELECT 'last_instance_admin'::text,
        CASE WHEN p_is_admin IS NOT DISTINCT FROM false THEN 'isInstanceAdmin' ELSE 'disabled' END,
        NULL::boolean, NULL::boolean, NULL::uuid, NULL::text, NULL::text, NULL::boolean, NULL::boolean, NULL::boolean, NULL::boolean, NULL::timestamptz, NULL::bigint;
      RETURN;
    END IF;
  END IF;

  IF v_admin_change THEN
    UPDATE public.accounts SET is_instance_admin = p_is_admin WHERE id = p_account_id;
  END IF;
  IF v_disabled_change THEN
    UPDATE public.accounts SET disabled_at = CASE WHEN p_is_disabled THEN clock_timestamp() END WHERE id = p_account_id;
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
    -- the second event of a call is stamped with the clock to come after the first whatever the two identifiers are.
    INSERT INTO public.audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, entity_type, entity_id, metadata, ip_prefix, created_at)
    VALUES (
      p_disabled_event_id, NULL, 'account', public.app_account_id(), v_label,
      CASE WHEN p_is_disabled THEN 'instance.account_disabled' ELSE 'instance.account_enabled' END,
      'account', p_account_id, '{}'::jsonb, p_ip_prefix, clock_timestamp()
    );
  END IF;

  RETURN QUERY
    SELECT 'updated'::text, NULL::text, v_admin_change, v_disabled_change,
           a.id, a.display_name, a.email::text, a.email_verified_at IS NOT NULL, a.mfa_enabled_at IS NOT NULL,
           a.is_instance_admin, a.disabled_at IS NOT NULL, a.last_sign_in_at,
           (SELECT count(*) FROM public.workspace_members m JOIN public.workspaces w ON w.id = m.workspace_id AND w.deleting_at IS NULL WHERE m.account_id = a.id)
    FROM public.accounts a WHERE a.id = p_account_id;
END
$$;

ALTER FUNCTION public.sys_instance_list_accounts(uuid, cidr) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_instance_update_account(uuid, uuid, cidr, uuid, boolean, boolean) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_instance_list_accounts(uuid, cidr) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_instance_update_account(uuid, uuid, cidr, uuid, boolean, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_instance_list_accounts(uuid, cidr) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_instance_update_account(uuid, uuid, cidr, uuid, boolean, boolean) TO slugbase_app;
