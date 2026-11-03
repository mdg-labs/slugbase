-- The export-only access mode of an account (doc 02 sections 2.11 and 11.2, doc 05 sections 2.1 and 3.3, doc 01 section 13.6, doc
-- 10 T4 and T18). An account is `full`, `export_only` (access_mode, with the end date export_only_until and the end action
-- export_only_end_action, which are set exactly while it is) or disabled (disabled_at, unchanged). slugbase_app holds no privilege on
-- the three columns, read or write (060-accounts-sessions.sql grants it the columns it names): it reads the mode through
-- sys_account_access_mode and only the system operations below move it. All of them are entered in
-- src/system/registry.ts. slugbase_owner creates each function and hands it to slugbase_system, which needs CREATE on the schema
-- for the length of those statements. The tables are unchanged.
--
-- While the mode lasts the account keeps its sessions and its API tokens; the HTTP chain refuses every request but the reads and
-- the exports (src/http/access-mode.ts), and an invitation is not accepted by an export-only account (sys_invitation_accept). The
-- mode is never set on an instance admin or a disabled account: an admin whose requests are all refused would still count as the
-- admin the instance must keep.
--
-- sys_instance_set_account_access_mode and sys_instance_list_account_access_modes are the instance admin's: like every
-- sys_instance_* function each repeats the check of the instanceAdmin policy inside its own body (the account of the transaction,
-- app_account_id(), never an argument, must hold the flag, have a second factor and not be disabled). sys_account_set_access_mode
-- is the service a composition calls from its own job (doc 01 section 13.6): the account it acts on is the account of the
-- transaction. The rows of the admin and of the account are locked together in identifier order, the order of
-- sys_instance_update_account, before anything is read that the change decides on.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- access_mode_apply(account_id, mode, until, end_action, event_id, actor_account_id, actor_label, actor_type, ip_prefix): the one place the rule is
-- written, SECURITY INVOKER and owned by slugbase_system, so it runs only inside the operations below and slugbase_app cannot call
-- it. The caller holds the lock of the account's row. Answers the outcome:
--   * 'unknown_account': there is no such account;
--   * 'account_disabled' and 'instance_admin': export_only is refused for such an account;
--   * 'until_too_soon': the end date is less than a day ahead (checked against the database clock);
--   * 'unchanged': the account is in the state asked for already; nothing is written;
--   * 'set' or 'cleared': the mode was set, or put back to full; the audit event 'instance.account_export_only_set' or
--     'instance.account_export_only_cleared' is written in the same call, naming the account as its entity and, for 'set', the end
--     action and the end date, never anything the account holds.
CREATE OR REPLACE FUNCTION public.access_mode_apply(
    p_account_id uuid, p_mode text, p_until timestamptz, p_end_action text, p_event_id uuid,
    p_actor_account_id uuid, p_actor_label text, p_actor_type text, p_ip_prefix cidr
  )
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY INVOKER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_mode text;
  v_until timestamptz;
  v_action text;
  v_disabled boolean;
  v_admin boolean;
BEGIN
  SELECT a.access_mode, a.export_only_until, a.export_only_end_action, a.disabled_at IS NOT NULL, a.is_instance_admin
  INTO v_mode, v_until, v_action, v_disabled, v_admin
  FROM public.accounts a WHERE a.id = p_account_id;
  IF NOT FOUND THEN
    RETURN 'unknown_account';
  END IF;

  IF p_mode = 'export_only' THEN
    IF v_disabled THEN
      RETURN 'account_disabled';
    END IF;
    IF v_admin THEN
      RETURN 'instance_admin';
    END IF;
    IF v_mode = 'export_only' AND v_until IS NOT DISTINCT FROM p_until AND v_action IS NOT DISTINCT FROM p_end_action THEN
      RETURN 'unchanged';
    END IF;
    IF p_until < clock_timestamp() + interval '1 day' THEN
      RETURN 'until_too_soon';
    END IF;
    UPDATE public.accounts SET access_mode = 'export_only', export_only_until = p_until, export_only_end_action = p_end_action
    WHERE id = p_account_id;
    INSERT INTO public.audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, entity_type, entity_id, metadata, ip_prefix)
    VALUES (
      p_event_id, NULL, p_actor_type, p_actor_account_id, p_actor_label, 'instance.account_export_only_set', 'account', p_account_id,
      jsonb_build_object('endAction', p_end_action, 'until', to_char(p_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')), p_ip_prefix
    );
    RETURN 'set';
  END IF;

  IF v_mode = 'full' THEN
    RETURN 'unchanged';
  END IF;
  UPDATE public.accounts SET access_mode = 'full', export_only_until = NULL, export_only_end_action = NULL WHERE id = p_account_id;
  INSERT INTO public.audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, entity_type, entity_id, metadata, ip_prefix)
  VALUES (p_event_id, NULL, p_actor_type, p_actor_account_id, p_actor_label, 'instance.account_export_only_cleared', 'account', p_account_id, '{}'::jsonb, p_ip_prefix);
  RETURN 'cleared';
END
$$;

-- sys_instance_set_account_access_mode(event_id, ip_prefix, account_id, mode, until, end_action): the instance admin sets
-- (mode 'export_only', with an end date at least a day ahead and the end action 'disable' or 'delete') or clears (mode 'full',
-- with neither) the export-only mode of an account, through access_mode_apply. The caller queues the email that tells the account
-- when the answer is 'set'. Any other combination of arguments is refused with invalid_parameter_value, and an admin that fails
-- its check, before or after the locks, with insufficient_privilege, writing nothing.
CREATE OR REPLACE FUNCTION public.sys_instance_set_account_access_mode(
    p_event_id uuid, p_ip_prefix cidr, p_account_id uuid, p_mode text, p_until timestamptz, p_end_action text
  )
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_label text;
BEGIN
  IF p_event_id IS NULL OR p_account_id IS NULL OR p_mode IS NULL OR p_mode NOT IN ('full', 'export_only')
     OR (p_mode = 'export_only' AND (p_until IS NULL OR p_end_action IS NULL OR p_end_action NOT IN ('disable', 'delete')))
     OR (p_mode = 'full' AND (p_until IS NOT NULL OR p_end_action IS NOT NULL)) THEN
    RAISE EXCEPTION 'sys_instance_set_account_access_mode needs an event, an account and either full or export_only with an end date and an end action' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM 1
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

  RETURN public.access_mode_apply(p_account_id, p_mode, p_until, p_end_action, p_event_id, public.app_account_id(), v_label, 'account', p_ip_prefix);
END
$$;

-- sys_instance_list_account_access_modes(): the accounts that are export-only, with the end date and the end action; an account
-- that is not listed is full (or disabled, which sys_instance_list_accounts says). It selects nothing else of an account and writes no
-- event: the list of the accounts, which the admin reads in the same transaction, wrote 'instance.accounts_viewed'.
CREATE OR REPLACE FUNCTION public.sys_instance_list_account_access_modes()
  RETURNS TABLE (acct_id uuid, acct_until timestamptz, acct_end_action text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.accounts a
    WHERE a.id = public.app_account_id() AND a.is_instance_admin AND a.mfa_enabled_at IS NOT NULL AND a.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'the instance operations are for instance admins with a second factor' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT a.id, a.export_only_until, a.export_only_end_action
    FROM public.accounts a
    WHERE a.access_mode = 'export_only'
    ORDER BY a.created_at, a.id;
END
$$;

-- sys_account_set_access_mode(event_id, account_id, mode, until, end_action): the service of doc 01 section 13.6, for a composition
-- that sets or clears the mode from its own job. The account is the account of the transaction (app_account_id()), which must act in
-- no workspace; for any other account, and when no account is set, nothing is written and the answer is 'unknown_account'. The
-- arguments and the outcomes are those of sys_instance_set_account_access_mode; the audit event names the system as its actor and has
-- no network prefix.
CREATE OR REPLACE FUNCTION public.sys_account_set_access_mode(p_event_id uuid, p_account_id uuid, p_mode text, p_until timestamptz, p_end_action text)
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF p_event_id IS NULL OR p_account_id IS NULL OR p_mode IS NULL OR p_mode NOT IN ('full', 'export_only')
     OR (p_mode = 'export_only' AND (p_until IS NULL OR p_end_action IS NULL OR p_end_action NOT IN ('disable', 'delete')))
     OR (p_mode = 'full' AND (p_until IS NOT NULL OR p_end_action IS NOT NULL)) THEN
    RAISE EXCEPTION 'sys_account_set_access_mode needs an event, an account and either full or export_only with an end date and an end action' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF public.app_account_id() IS DISTINCT FROM p_account_id OR public.app_workspace_id() IS NOT NULL THEN
    RETURN 'unknown_account';
  END IF;

  PERFORM 1 FROM public.accounts a WHERE a.id = p_account_id FOR UPDATE;
  RETURN public.access_mode_apply(p_account_id, p_mode, p_until, p_end_action, p_event_id, NULL, 'system', 'system', NULL);
END
$$;

-- sys_account_access_mode(account_id): the access mode of an account, its end date and its end action, for the check of the HTTP chain on the
-- request of a session or an API token and for the answer of the instance admin's change of an account; no row for an account that does not
-- exist. It selects no other column of the account and checks no caller: the answer of a change that took the calling admin's own standing away
-- must still be made, which a check of the admin would refuse.
CREATE OR REPLACE FUNCTION public.sys_account_access_mode(p_account_id uuid)
  RETURNS TABLE (access_mode text, export_only_until timestamptz, export_only_end_action text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'sys_account_access_mode needs an account' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY SELECT a.access_mode, a.export_only_until, a.export_only_end_action FROM public.accounts a WHERE a.id = p_account_id;
END
$$;

-- sys_account_access_mode_due(limit): at most `limit` (1 to 1000) accounts whose export-only period has ended, oldest end date first,
-- with the end action each is to get: the work list of the daily maintenance job. It changes nothing.
CREATE OR REPLACE FUNCTION public.sys_account_access_mode_due(p_limit integer)
  RETURNS TABLE (due_account_id uuid, due_end_action text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'sys_account_access_mode_due needs a limit of 1 to 1000' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
    SELECT a.id, a.export_only_end_action
    FROM public.accounts a
    WHERE a.access_mode = 'export_only' AND a.export_only_until <= clock_timestamp()
    ORDER BY a.export_only_until, a.id
    LIMIT p_limit;
END
$$;

-- sys_account_access_mode_end(event_id, account_id, action, sole_workspace_ids): ends the export-only period of the account of the
-- transaction with `action`, in that transaction, once its end date has passed. The account is the account of the transaction
-- (app_account_id(), which must act in no workspace), as for the deletion of an account (sys_delete_account). The account is locked as
-- sys_account_deletion_scope locks it for a deletion, and everything is decided under those locks. Answers:
--   * 'not_due': there is nothing to end: the account is gone, is not export-only, its end date has not passed, the action is
--     'delete' and the end action stored is 'disable', or the account is not the one of the transaction; nothing is written, so a job
--     that runs twice acts once;
--   * 'disabled': the action is 'disable'. disabled_at is set, the mode is put back to full, every session of the account is deleted
--     (its API tokens are refused by their lookup) and 'instance.account_export_only_ended' is written;
--   * 'deleted': the action is 'delete' and the account is deleted by account_delete, the deletion of 290-account-deletion.sql, with
--     `sole_workspace_ids` (the workspaces where it is the only member) marked as being deleted; the event is written after the
--     clean-up of account_delete, so it names no account, and the caller queues the workspace.delete job of each of them and
--     account.deleted in the same transaction;
--   * 'blocked': the action is 'delete' and the account is the only owner of a workspace that has other members, or the last enabled
--     instance admin; nothing is changed, and the caller may end the period with 'disable' instead;
--   * 'unavailable': the action is 'delete' and the workspaces where the account is the only member are not exactly `sole_workspace_ids`;
--     nothing is changed.
CREATE OR REPLACE FUNCTION public.sys_account_access_mode_end(p_event_id uuid, p_account_id uuid, p_action text, p_sole_workspace_ids uuid[])
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_sole uuid[];
  v_blocking integer;
  v_action text;
BEGIN
  IF p_event_id IS NULL OR p_account_id IS NULL OR p_action IS NULL OR p_action NOT IN ('disable', 'delete') OR p_sole_workspace_ids IS NULL THEN
    RAISE EXCEPTION 'sys_account_access_mode_end needs an event, an account, an action of disable or delete and the workspaces that go with it' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF public.app_account_id() IS DISTINCT FROM p_account_id OR public.app_workspace_id() IS NOT NULL THEN
    RETURN 'not_due';
  END IF;

  SELECT coalesce(array_agg(s.workspace_id ORDER BY s.workspace_id) FILTER (WHERE s.kind = 'sole'), '{}'),
         count(*) FILTER (WHERE s.kind = 'blocking')
  INTO v_sole, v_blocking
  FROM public.sys_account_deletion_scope(p_account_id) s;

  SELECT a.export_only_end_action INTO v_action
  FROM public.accounts a
  WHERE a.id = p_account_id AND a.access_mode = 'export_only' AND a.export_only_until <= clock_timestamp();
  IF NOT FOUND OR (p_action = 'delete' AND v_action IS DISTINCT FROM 'delete') THEN
    RETURN 'not_due';
  END IF;

  IF p_action = 'disable' THEN
    UPDATE public.accounts
    SET disabled_at = coalesce(disabled_at, clock_timestamp()), access_mode = 'full', export_only_until = NULL, export_only_end_action = NULL
    WHERE id = p_account_id;
    DELETE FROM public.sessions WHERE account_id = p_account_id;
    INSERT INTO public.audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, entity_type, entity_id, metadata, ip_prefix)
    VALUES (p_event_id, NULL, 'system', NULL, 'system', 'instance.account_export_only_ended', 'account', p_account_id, jsonb_build_object('endAction', 'disable'), NULL);
    RETURN 'disabled';
  END IF;

  IF v_blocking > 0 OR public.sys_account_last_instance_admin(p_account_id) THEN
    RETURN 'blocked';
  END IF;
  IF v_sole IS DISTINCT FROM (SELECT coalesce(array_agg(DISTINCT i ORDER BY i), '{}') FROM unnest(p_sole_workspace_ids) i) THEN
    RETURN 'unavailable';
  END IF;

  PERFORM public.account_delete(p_account_id, v_sole);
  INSERT INTO public.audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, entity_type, entity_id, metadata, ip_prefix)
  VALUES (p_event_id, NULL, 'system', NULL, 'system', 'instance.account_export_only_ended', NULL, NULL, jsonb_build_object('endAction', 'delete'), NULL);
  RETURN 'deleted';
END
$$;

ALTER FUNCTION public.access_mode_apply(uuid, text, timestamptz, text, uuid, uuid, text, text, cidr) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_instance_set_account_access_mode(uuid, cidr, uuid, text, timestamptz, text) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_instance_list_account_access_modes() OWNER TO slugbase_system;
ALTER FUNCTION public.sys_account_set_access_mode(uuid, uuid, text, timestamptz, text) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_account_access_mode(uuid) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_account_access_mode_due(integer) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_account_access_mode_end(uuid, uuid, text, uuid[]) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.access_mode_apply(uuid, text, timestamptz, text, uuid, uuid, text, text, cidr) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_instance_set_account_access_mode(uuid, cidr, uuid, text, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_instance_list_account_access_modes() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_account_set_access_mode(uuid, uuid, text, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_account_access_mode(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_account_access_mode_due(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_account_access_mode_end(uuid, uuid, text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_instance_set_account_access_mode(uuid, cidr, uuid, text, timestamptz, text) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_instance_list_account_access_modes() TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_account_set_access_mode(uuid, uuid, text, timestamptz, text) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_account_access_mode(uuid) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_account_access_mode_due(integer) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_account_access_mode_end(uuid, uuid, text, uuid[]) TO slugbase_app;
