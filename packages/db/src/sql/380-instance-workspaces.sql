-- The workspace operations of the CE instance admin (doc 05 sections 2.2, 2.9 and 3.3, doc 02 section 11.1, doc 10
-- T1 and T18): list every workspace without any content, create one for a chosen account or for the first owner an
-- invitation will bring, issue that invitation again while the workspace is still without an owner, and delete one.
-- All four are entered in src/system/registry.ts. slugbase_owner creates each
-- function and hands it to slugbase_system, which needs CREATE on the schema for the length of those statements.
-- The tables are unchanged: workspace_invitations already allows the owner role for a row with instance_issued, which
-- slugbase_app cannot insert (300-workspace-invitations.sql), so sys_instance_create_workspace and
-- sys_instance_reissue_owner_invitation are the only writers of an owner invitation.
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
--     invitation. Its mail ticket is its own identifier, which is the ticket of the invitation.send job the caller
--     queues in the same transaction when the link is mailed.
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
    INSERT INTO public.workspace_invitations (id, workspace_id, email, role, instance_issued, token_hash, mail_ticket, invited_by, expires_at)
    VALUES (p_invitation_id, p_workspace_id, p_owner_email, 'owner', true, p_token_hash, p_invitation_id, public.app_account_id(), clock_timestamp() + p_ttl_seconds * interval '1 second')
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

-- sys_instance_reissue_owner_invitation(...): a new owner invitation for a workspace that has no owner yet, which ends
-- every pending owner invitation of it, in one call, so a workspace waits on exactly one link. The workspace row is
-- locked first, FOR NO KEY UPDATE like an acceptance, so an owner invitation that is being accepted completes before
-- this decides (and the workspace then has its owner) or finds its invitation revoked and answers 'gone'; the pending
-- owner invitations are then revoked and the new one inserted (instance_issued, role owner, holding the SHA-256 of the
-- token the caller keeps, expiring p_ttl_seconds from now by the database's clock). The address is p_owner_email, or,
-- when that is NULL, the one the latest owner invitation of the workspace was for, whatever became of it. Its mail
-- ticket is its own identifier, the ticket of the invitation.send job the caller queues in the same transaction when
-- the link is mailed.
-- Answers 'issued' with the address and the expiry; 'unknown_workspace' for a workspace that does not exist or is being
-- deleted; 'has_owner' for a workspace with an owner; 'email_required' when no address was given and the workspace
-- never had an owner invitation (or it was purged). A refusal writes and revokes nothing. A call without an event id,
-- workspace, invitation id, a 32-byte token hash or a lifetime of at least a second raises invalid_parameter_value.
-- Writes 'instance.workspace_owner_invited' for the workspace, naming no address.
CREATE OR REPLACE FUNCTION public.sys_instance_reissue_owner_invitation(
  p_event_id uuid,
  p_ip_prefix cidr,
  p_workspace_id uuid,
  p_owner_email citext,
  p_invitation_id uuid,
  p_token_hash bytea,
  p_ttl_seconds integer
) RETURNS TABLE (outcome text, invitation_email text, invitation_expires_at timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_label text;
  v_email citext;
  v_expires timestamptz;
BEGIN
  IF p_event_id IS NULL OR p_workspace_id IS NULL OR p_invitation_id IS NULL OR p_token_hash IS NULL
     OR octet_length(p_token_hash) <> 32 OR p_ttl_seconds IS NULL OR p_ttl_seconds < 1 THEN
    RAISE EXCEPTION 'sys_instance_reissue_owner_invitation needs an event id, a workspace, an invitation id, a 32-byte token hash and a lifetime' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.display_name INTO v_label
  FROM public.accounts a
  WHERE a.id = public.app_account_id() AND a.is_instance_admin AND a.mfa_enabled_at IS NOT NULL AND a.disabled_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the instance operations are for instance admins with a second factor' USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM 1 FROM public.workspaces w WHERE w.id = p_workspace_id AND w.deleting_at IS NULL FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'unknown_workspace'::text, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.workspace_id = p_workspace_id AND m.role = 'owner') THEN
    RETURN QUERY SELECT 'has_owner'::text, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  v_email := p_owner_email;
  IF v_email IS NULL THEN
    SELECT i.email INTO v_email
    FROM public.workspace_invitations i
    WHERE i.workspace_id = p_workspace_id AND i.role = 'owner' AND i.instance_issued
    ORDER BY i.created_at DESC, i.id DESC
    LIMIT 1;
    IF v_email IS NULL THEN
      RETURN QUERY SELECT 'email_required'::text, NULL::text, NULL::timestamptz;
      RETURN;
    END IF;
  END IF;

  UPDATE public.workspace_invitations
  SET status = 'revoked', closed_at = clock_timestamp()
  WHERE workspace_id = p_workspace_id AND role = 'owner' AND status = 'pending';

  INSERT INTO public.workspace_invitations (id, workspace_id, email, role, instance_issued, token_hash, mail_ticket, invited_by, expires_at)
  VALUES (p_invitation_id, p_workspace_id, v_email, 'owner', true, p_token_hash, p_invitation_id, public.app_account_id(), clock_timestamp() + p_ttl_seconds * interval '1 second')
  RETURNING expires_at INTO v_expires;

  INSERT INTO public.audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, entity_type, entity_id, metadata, ip_prefix)
  VALUES (p_event_id, NULL, 'account', public.app_account_id(), v_label, 'instance.workspace_owner_invited', 'workspace', p_workspace_id, '{}'::jsonb, p_ip_prefix);

  RETURN QUERY SELECT 'issued'::text, v_email::text, v_expires;
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
ALTER FUNCTION public.sys_instance_reissue_owner_invitation(uuid, cidr, uuid, citext, uuid, bytea, integer) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_instance_delete_workspace(uuid, cidr, uuid) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_instance_list_workspaces(uuid, cidr) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_instance_create_workspace(uuid, cidr, uuid, text, uuid, citext, uuid, bytea, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_instance_reissue_owner_invitation(uuid, cidr, uuid, citext, uuid, bytea, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_instance_delete_workspace(uuid, cidr, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_instance_list_workspaces(uuid, cidr) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_instance_create_workspace(uuid, cidr, uuid, text, uuid, citext, uuid, bytea, integer) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_instance_reissue_owner_invitation(uuid, cidr, uuid, citext, uuid, bytea, integer) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_instance_delete_workspace(uuid, cidr, uuid) TO slugbase_app;
