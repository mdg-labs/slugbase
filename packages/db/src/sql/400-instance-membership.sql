-- The instance admin adding themselves to a workspace (doc 05 sections 2.9 and 3.3, doc 02 section 11.1, doc 10 T1,
-- T15 and T18). The function is entered in src/system/registry.ts. slugbase_owner creates it and hands it to
-- slugbase_system, which needs CREATE on the schema for the length of that statement.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_instance_add_membership(workspace_event_id, instance_event_id, ip_prefix, workspace_id): makes the calling
-- instance admin (app_account_id(), never an argument) a member of the workspace with the member role, and writes the
-- two audit events that make it visible, all in the calling transaction: 'member.instance_admin_joined' in the workspace's
-- own log (actor and entity are the admin, metadata the role; an action of its own, so its owners tell it from an
-- accepted invitation, which writes 'member.joined') and 'instance.workspace_joined' in the instance stream (the
-- workspace as entity), so the membership this function makes has both events or does not exist. The caller announces
-- the domain event member.joined in the same transaction when this answers 'added'.
--
-- Like every sys_instance_* function it repeats the check of the instanceAdmin policy in its own body: the flag, a
-- second factor and not disabled, otherwise it raises insufficient_privilege and writes nothing. Answers 'added';
-- 'unknown_workspace' for a workspace that does not exist or is being deleted, which a caller does not tell apart, as
-- in every policy and lookup that names it; or 'already_member' for an account that holds any role in it already. A
-- refusal writes nothing.
--
-- Rows are locked parent first, as sys_invitation_accept locks them: the workspace (FOR NO KEY UPDATE, which
-- conflicts with the FOR UPDATE of sys_instance_delete_workspace and sys_workspace_mark_deleting, so a deletion that
-- commits first is seen as 'unknown_workspace' and one that comes after waits for this membership), then the admin's
-- row (FOR SHARE, which sys_instance_update_account holds FOR UPDATE while it changes the flag or the disabled state). The admin is checked
-- again under those locks, so a demotion or a disabling that committed first ends this call as it ends any other.
CREATE OR REPLACE FUNCTION public.sys_instance_add_membership(p_workspace_event_id uuid, p_instance_event_id uuid, p_ip_prefix cidr, p_workspace_id uuid)
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_label text;
BEGIN
  IF p_workspace_event_id IS NULL OR p_instance_event_id IS NULL OR p_workspace_id IS NULL THEN
    RAISE EXCEPTION 'sys_instance_add_membership needs an event id for each log and a workspace' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.display_name INTO v_label
  FROM public.accounts a
  WHERE a.id = public.app_account_id() AND a.is_instance_admin AND a.mfa_enabled_at IS NOT NULL AND a.disabled_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the instance operations are for instance admins with a second factor' USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM 1 FROM public.workspaces w WHERE w.id = p_workspace_id AND w.deleting_at IS NULL FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN 'unknown_workspace';
  END IF;

  SELECT a.display_name INTO v_label
  FROM public.accounts a
  WHERE a.id = public.app_account_id() AND a.is_instance_admin AND a.mfa_enabled_at IS NOT NULL AND a.disabled_at IS NULL
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the instance operations are for instance admins with a second factor' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.workspace_id = p_workspace_id AND m.account_id = public.app_account_id()) THEN
    RETURN 'already_member';
  END IF;

  INSERT INTO public.workspace_members (workspace_id, account_id, role) VALUES (p_workspace_id, public.app_account_id(), 'member');

  INSERT INTO public.audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, entity_type, entity_id, metadata, ip_prefix)
  VALUES (
    p_workspace_event_id, p_workspace_id, 'account', public.app_account_id(), v_label, 'member.instance_admin_joined', 'member', public.app_account_id(),
    jsonb_build_object('role', 'member'), p_ip_prefix
  );
  INSERT INTO public.audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, entity_type, entity_id, metadata, ip_prefix)
  VALUES (p_instance_event_id, NULL, 'account', public.app_account_id(), v_label, 'instance.workspace_joined', 'workspace', p_workspace_id, '{}'::jsonb, p_ip_prefix);
  RETURN 'added';
END
$$;

ALTER FUNCTION public.sys_instance_add_membership(uuid, uuid, cidr, uuid) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_instance_add_membership(uuid, uuid, cidr, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_instance_add_membership(uuid, uuid, cidr, uuid) TO slugbase_app;
