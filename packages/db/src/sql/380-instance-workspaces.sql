-- The workspace operations of the CE instance admin (doc 05 sections 2.2, 2.9 and 3.3, doc 02 section 11.1, doc 10
-- T1 and T18): list every workspace without any content, create one for a chosen account or for the first owner an
-- invitation will bring, and delete one. All three are entered in src/system/registry.ts. slugbase_owner creates each
-- function and hands it to slugbase_system, which needs CREATE on the schema for the length of those statements.
-- The tables are unchanged: workspace_invitations already allows the owner role for a row with instance_issued, which
-- slugbase_app cannot insert (300-workspace-invitations.sql), so sys_instance_create_workspace is the only writer of
-- an owner invitation.
--
-- Like every sys_instance_* function each repeats the check of the instanceAdmin policy inside its own body: the
-- account of the transaction (app_account_id(), never an argument) must hold the instance-admin flag, have a second
-- factor enrolled and not be disabled, otherwise it raises insufficient_privilege and writes nothing. Each writes its
-- instance audit event in the same call, under the identifier the application generated (Q91).
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_instance_list_workspaces(event_id, ip_prefix): every workspace that is not being deleted, newest first, with
-- its name, its creation time, its member count and its owners (account, display name and address). It reads no
-- bookmark or other content of any workspace and shows no member who is not an owner. Writes
-- 'instance.workspaces_viewed' for the admin, in the same call.
CREATE OR REPLACE FUNCTION public.sys_instance_list_workspaces(p_event_id uuid, p_ip_prefix cidr)
  RETURNS TABLE (workspace_id uuid, workspace_name text, workspace_created_at timestamptz, member_count bigint, owners jsonb)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_label text;
BEGIN
  IF p_event_id IS NULL THEN
    RAISE EXCEPTION 'sys_instance_list_workspaces needs an event id' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.display_name INTO v_label
  FROM public.accounts a
  WHERE a.id = public.app_account_id() AND a.is_instance_admin AND a.mfa_enabled_at IS NOT NULL AND a.disabled_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the instance operations are for instance admins with a second factor' USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO public.audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, metadata, ip_prefix)
  VALUES (p_event_id, NULL, 'account', public.app_account_id(), v_label, 'instance.workspaces_viewed', '{}'::jsonb, p_ip_prefix);

  RETURN QUERY
    SELECT
      w.id,
      w.name,
      w.created_at,
      (SELECT count(*) FROM public.workspace_members m WHERE m.workspace_id = w.id),
      coalesce(
        (SELECT jsonb_agg(
            jsonb_build_object('accountId', a.id, 'displayName', a.display_name, 'email', a.email::text)
            ORDER BY o.joined_at, a.id)
         FROM public.workspace_members o
         JOIN public.accounts a ON a.id = o.account_id
         WHERE o.workspace_id = w.id AND o.role = 'owner'),
        '[]'::jsonb)
    FROM public.workspaces w
    WHERE w.deleting_at IS NULL
    ORDER BY w.created_at DESC, w.id;
END
$$;

-- sys_instance_create_workspace(...): a workspace and its settings row, and exactly one of two ways to its first
-- owner, in one call, so a workspace never exists half made:
--   * p_owner_account_id names an account that exists and is not disabled: it becomes the owner, as in
--     sys_create_workspace;
--   * p_owner_email names the address of the first owner: the workspace has no member and one pending owner
--     invitation (instance_issued, role owner) that holds the SHA-256 of the token the caller keeps, and that expires
--     p_ttl_seconds from now by the database's clock. The accept operations give the owner role to exactly that
--     invitation.
-- Answers 'created', with the invitation's expiry on the second path, or 'unknown_account' when the account does not
-- exist or is disabled, writing nothing. A call that names both ways or neither, or an invitation without its
-- identifier, hash and lifetime, raises invalid_parameter_value. Writes 'instance.workspace_created' for the
-- workspace, naming only which way the owner was chosen. The account row is locked while it is checked, so a
-- concurrent disabling waits for the owner membership or is seen by the check.
CREATE OR REPLACE FUNCTION public.sys_instance_create_workspace(
  p_event_id uuid,
  p_ip_prefix cidr,
  p_workspace_id uuid,
  p_name text,
  p_owner_account_id uuid,
  p_owner_email citext,
  p_invitation_id uuid,
  p_token_hash bytea,
  p_ttl_seconds integer
) RETURNS TABLE (outcome text, invitation_expires_at timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_label text;
  v_expires timestamptz;
BEGIN
  IF p_event_id IS NULL OR p_workspace_id IS NULL OR p_name IS NULL THEN
    RAISE EXCEPTION 'sys_instance_create_workspace needs an event id, a workspace id and a name' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF (p_owner_account_id IS NULL) = (p_owner_email IS NULL) THEN
    RAISE EXCEPTION 'sys_instance_create_workspace needs an owner account or an owner address, and not both' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_owner_email IS NOT NULL AND (p_invitation_id IS NULL OR p_token_hash IS NULL OR p_ttl_seconds IS NULL OR p_ttl_seconds < 1) THEN
    RAISE EXCEPTION 'sys_instance_create_workspace needs an invitation id, a token hash and a lifetime for an owner address' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.display_name INTO v_label
  FROM public.accounts a
  WHERE a.id = public.app_account_id() AND a.is_instance_admin AND a.mfa_enabled_at IS NOT NULL AND a.disabled_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the instance operations are for instance admins with a second factor' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_owner_account_id IS NOT NULL THEN
    PERFORM 1 FROM public.accounts o WHERE o.id = p_owner_account_id AND o.disabled_at IS NULL FOR SHARE;
    IF NOT FOUND THEN
      RETURN QUERY SELECT 'unknown_account'::text, NULL::timestamptz;
      RETURN;
    END IF;
  END IF;

  INSERT INTO public.workspaces (id, name, created_by) VALUES (p_workspace_id, p_name, public.app_account_id());
  INSERT INTO public.workspace_settings (workspace_id, updated_by) VALUES (p_workspace_id, public.app_account_id());
  IF p_owner_account_id IS NOT NULL THEN
    INSERT INTO public.workspace_members (workspace_id, account_id, role) VALUES (p_workspace_id, p_owner_account_id, 'owner');
  ELSE
    INSERT INTO public.workspace_invitations (id, workspace_id, email, role, instance_issued, token_hash, invited_by, expires_at)
    VALUES (p_invitation_id, p_workspace_id, p_owner_email, 'owner', true, p_token_hash, public.app_account_id(), clock_timestamp() + p_ttl_seconds * interval '1 second')
    RETURNING expires_at INTO v_expires;
  END IF;

  INSERT INTO public.audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, entity_type, entity_id, metadata, ip_prefix)
  VALUES (
    p_event_id, NULL, 'account', public.app_account_id(), v_label, 'instance.workspace_created', 'workspace', p_workspace_id,
    jsonb_build_object('owner', CASE WHEN p_owner_account_id IS NOT NULL THEN 'account' ELSE 'invitation' END), p_ip_prefix
  );

  RETURN QUERY SELECT 'created'::text, v_expires;
END
$$;

-- sys_instance_delete_workspace(event_id, ip_prefix, workspace_id): the request half of deleting a workspace as
-- the instance admin, with the effects of sys_workspace_mark_deleting: deleting_at hides the workspace from every
-- policy and lookup that names it, the sessions that had it active are pointed at none and the API tokens bound
-- to it are revoked. The caller queues the job that removes the rows in the same transaction, once this answers
-- true. The row is locked first with the lock the owner trigger of workspace_members takes, so a removal that commits
-- concurrently waits and then finds the workspace exempt from the owner rule. Answers false, changing and writing
-- nothing, for a workspace that does not exist or is already being deleted. Writes
-- 'instance.workspace_deletion_requested' for the workspace in the same call.
CREATE OR REPLACE FUNCTION public.sys_instance_delete_workspace(p_event_id uuid, p_ip_prefix cidr, p_workspace_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_label text;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_event_id IS NULL OR p_workspace_id IS NULL THEN
    RAISE EXCEPTION 'sys_instance_delete_workspace needs an event id and a workspace' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.display_name INTO v_label
  FROM public.accounts a
  WHERE a.id = public.app_account_id() AND a.is_instance_admin AND a.mfa_enabled_at IS NOT NULL AND a.disabled_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the instance operations are for instance admins with a second factor' USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM 1 FROM public.workspaces w
  WHERE w.id = p_workspace_id AND w.deleting_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE public.workspaces SET deleting_at = v_now WHERE id = p_workspace_id;
  UPDATE public.sessions SET active_workspace_id = NULL WHERE active_workspace_id = p_workspace_id;
  UPDATE public.api_tokens SET revoked_at = v_now WHERE workspace_id = p_workspace_id AND revoked_at IS NULL;

  INSERT INTO public.audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, entity_type, entity_id, metadata, ip_prefix)
  VALUES (p_event_id, NULL, 'account', public.app_account_id(), v_label, 'instance.workspace_deletion_requested', 'workspace', p_workspace_id, '{}'::jsonb, p_ip_prefix);
  RETURN true;
END
$$;

ALTER FUNCTION public.sys_instance_list_workspaces(uuid, cidr) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_instance_create_workspace(uuid, cidr, uuid, text, uuid, citext, uuid, bytea, integer) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_instance_delete_workspace(uuid, cidr, uuid) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_instance_list_workspaces(uuid, cidr) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_instance_create_workspace(uuid, cidr, uuid, text, uuid, citext, uuid, bytea, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_instance_delete_workspace(uuid, cidr, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_instance_list_workspaces(uuid, cidr) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_instance_create_workspace(uuid, cidr, uuid, text, uuid, citext, uuid, bytea, integer) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_instance_delete_workspace(uuid, cidr, uuid) TO slugbase_app;
