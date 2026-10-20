-- The deletion of an account by an instance admin (doc 05 sections 3.3 and 7.1, doc 02 sections 2.10 and 11.2, doc 10 T1 and
-- T18): the same deletion as DELETE /me (account_delete of 290-account-deletion.sql), asked for another account, with the
-- ownership of its workspaces resolved first. Both functions are entered in src/system/registry.ts. slugbase_owner creates
-- each function and hands it to slugbase_system, which needs CREATE on the schema for the length of those statements. The
-- tables are unchanged.
--
-- Like every sys_instance_* function each repeats the check of the instanceAdmin policy inside its own body: the account of
-- the transaction (app_account_id(), never an argument) must hold the instance-admin flag, have a second factor enrolled and
-- not be disabled, otherwise it raises insufficient_privilege and writes nothing; the check is made again once the rows are
-- locked.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_instance_account_deletion_scope(account_id): what deleting the account would do, and the locks that keep it true for
-- the rest of the transaction, so the caller can refuse or ask the deletion guard before anything changes. It locks, in the
-- order of sys_account_deletion_scope: the workspaces the account is a member of or created and that are not being deleted
-- (identifier order), the account's backup-code rows (identifier order, the order sys_mfa_lock documents), the rows of the
-- calling admin and of the account together in identifier order (the order of sys_instance_update_account), and, when the
-- account is an instance admin, the advisory key of the set of admins (doc 05 section 7.1), last of all. The admin is
-- checked again under those locks. The first row says what to do:
--   * outcome 'unknown_account': there is no such account;
--   * outcome 'last_instance_admin': the account is an instance admin and no other enabled account is one, which for an
--     account other than the admin's own cannot happen, since the admin is another enabled admin; it is the admin who asks
--     to delete their own account when they are the only one. The check comes before 'self' so that the one admin is told
--     why the instance keeps their account;
--   * outcome 'self': the account is the calling admin's, which is deleted by DELETE /me (the typed address, the end of the
--     session and the cookie are that route's);
--   * outcome 'ok', and then, after that row, one row for each workspace the deletion touches: kind 'blocking' when the
--     account is its only owner and it has other members (the account would leave it without an owner) and 'sole' when the
--     account is its only member (it goes with the account). A workspace with another owner, or where the account is not an
--     owner, is neither: the membership just ends.
-- Only the first row carries a NULL workspace_id and workspace_name and a NULL kind.
CREATE OR REPLACE FUNCTION public.sys_instance_account_deletion_scope(p_account_id uuid)
  RETURNS TABLE (outcome text, workspace_id uuid, workspace_name text, kind text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_target_admin boolean;
BEGIN
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'sys_instance_account_deletion_scope needs an account' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM 1
  FROM public.accounts a
  WHERE a.id = public.app_account_id() AND a.is_instance_admin AND a.mfa_enabled_at IS NOT NULL AND a.disabled_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the instance operations are for instance admins with a second factor' USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM 1 FROM public.workspaces w
  WHERE w.deleting_at IS NULL
    AND (w.created_by = p_account_id
         OR w.id IN (SELECT m.workspace_id FROM public.workspace_members m WHERE m.account_id = p_account_id))
  ORDER BY w.id
  FOR UPDATE OF w;
  PERFORM 1 FROM public.mfa_backup_codes c WHERE c.account_id = p_account_id ORDER BY c.id FOR UPDATE;
  PERFORM 1 FROM public.accounts a WHERE a.id IN (public.app_account_id(), p_account_id) ORDER BY a.id FOR UPDATE;
  PERFORM 1
  FROM public.accounts a
  WHERE a.id = public.app_account_id() AND a.is_instance_admin AND a.mfa_enabled_at IS NOT NULL AND a.disabled_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the instance operations are for instance admins with a second factor' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT a.is_instance_admin INTO v_target_admin FROM public.accounts a WHERE a.id = p_account_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'unknown_account'::text, NULL::uuid, NULL::text, NULL::text;
    RETURN;
  END IF;
  IF v_target_admin THEN
    PERFORM pg_advisory_xact_lock(hashtext('slugbase.instance_admins'));
    IF NOT EXISTS (SELECT 1 FROM public.accounts o WHERE o.is_instance_admin AND o.disabled_at IS NULL AND o.id <> p_account_id) THEN
      RETURN QUERY SELECT 'last_instance_admin'::text, NULL::uuid, NULL::text, NULL::text;
      RETURN;
    END IF;
  END IF;
  IF p_account_id = public.app_account_id() THEN
    RETURN QUERY SELECT 'self'::text, NULL::uuid, NULL::text, NULL::text;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'ok'::text, NULL::uuid, NULL::text, NULL::text;
  RETURN QUERY
  SELECT 'ok'::text, w.id, w.name,
    CASE
      WHEN c.members = 1 THEN 'sole'
      WHEN me.role = 'owner' AND c.other_owners = 0 THEN 'blocking'
    END
  FROM public.workspace_members me
  JOIN public.workspaces w ON w.id = me.workspace_id AND w.deleting_at IS NULL
  CROSS JOIN LATERAL (
    SELECT count(*) AS members, count(*) FILTER (WHERE o.role = 'owner' AND o.account_id <> p_account_id) AS other_owners
    FROM public.workspace_members o WHERE o.workspace_id = w.id
  ) c
  WHERE me.account_id = p_account_id
    AND (c.members = 1 OR (me.role = 'owner' AND c.other_owners = 0))
  ORDER BY w.id;
END
$$;

-- sys_instance_delete_account(event_id, ip_prefix, account_id, sole_workspace_ids): deletes the account, in the transaction of
-- the calling admin, and writes 'instance.account_deleted' in the same call. The scope is computed again under the locks of
-- sys_instance_account_deletion_scope, so whatever the caller read, the rules are the database's. The deletion is
-- account_delete of 290-account-deletion.sql, the one DELETE /me runs: the workspaces where the account is the only member
-- (`sole_workspace_ids`, the ones the caller asked the deletion guard about) are put through the request half of the workspace
-- deletion, the network prefix and the target identifier of the events that name the account are cleared, and the account
-- row is deleted with everything that cascades from it, its sessions included. The caller queues the workspace.delete job of
-- each of them and the account.deleted event in the same transaction, only when this answers 'deleted'.
-- The event is written after that clean-up, with the identifier of the account as its entity and no address or name: it is
-- the one row that holds the identifier of the deleted account, which names no row any more, and it is the admin's record
-- of what they deleted (doc 05 section 7.1).
-- Answers 'deleted', or a refusal that changes and writes nothing: 'unknown_account', 'last_instance_admin' and 'self' (see
-- sys_instance_account_deletion_scope), and 'unavailable' when the account is the only owner of a workspace that has other
-- members or the workspaces where it is the only member are not exactly `sole_workspace_ids`.
CREATE OR REPLACE FUNCTION public.sys_instance_delete_account(p_event_id uuid, p_ip_prefix cidr, p_account_id uuid, p_sole_workspace_ids uuid[])
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_label text;
  v_outcome text;
  v_sole uuid[];
  v_blocking integer;
BEGIN
  IF p_event_id IS NULL OR p_account_id IS NULL OR p_sole_workspace_ids IS NULL THEN
    RAISE EXCEPTION 'sys_instance_delete_account needs an event id, an account and the workspaces that go with it' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT min(s.outcome),
         coalesce(array_agg(s.workspace_id ORDER BY s.workspace_id) FILTER (WHERE s.kind = 'sole'), '{}'),
         count(*) FILTER (WHERE s.kind = 'blocking')
  INTO v_outcome, v_sole, v_blocking
  FROM public.sys_instance_account_deletion_scope(p_account_id) s;
  IF v_outcome <> 'ok' THEN
    RETURN v_outcome;
  END IF;
  IF v_blocking > 0 OR v_sole IS DISTINCT FROM (SELECT coalesce(array_agg(DISTINCT i ORDER BY i), '{}') FROM unnest(p_sole_workspace_ids) i) THEN
    RETURN 'unavailable';
  END IF;

  SELECT a.display_name INTO v_label FROM public.accounts a WHERE a.id = public.app_account_id();
  PERFORM public.account_delete(p_account_id, v_sole);
  INSERT INTO public.audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, entity_type, entity_id, metadata, ip_prefix)
  VALUES (p_event_id, NULL, 'account', public.app_account_id(), v_label, 'instance.account_deleted', 'account', p_account_id, '{}'::jsonb, p_ip_prefix);
  RETURN 'deleted';
END
$$;

ALTER FUNCTION public.sys_instance_account_deletion_scope(uuid) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_instance_delete_account(uuid, cidr, uuid, uuid[]) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_instance_account_deletion_scope(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_instance_delete_account(uuid, cidr, uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_instance_account_deletion_scope(uuid) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_instance_delete_account(uuid, cidr, uuid, uuid[]) TO slugbase_app;
