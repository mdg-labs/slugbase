-- The system operations behind deleting a workspace (doc 05 sections 2.2, 3.3 and 7.2, doc 02 section 3.7,
-- doc 10 T1). All three are entered in src/system/registry.ts. slugbase_owner creates each function and hands it
-- to slugbase_system, which needs CREATE on the schema for the length of those statements.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_workspace_mark_deleting(workspace_id): the request half of a deletion, in the tenant transaction of the
-- owner who asks. It sets deleting_at, which hides the workspace from every policy and lookup that names it
-- (the workspaces policy, app_member_workspace_ids(), sys_session_set_active_workspace, sys_api_token_lookup),
-- points every session that had the workspace active at none, and revokes the API tokens bound to it, and says
-- whether it did. The workspace must be the one the transaction acts in (app_workspace_id()) and the account of the
-- transaction (app_account_id(), never an argument) must be an owner of it: a transaction acting in A neither
-- marks nor reads B, and an admin or a member marks nothing even if the role check of the authorization stage
-- were skipped. A workspace that is already being deleted, one that does not exist and a refused caller are all
-- false, changing nothing, and the caller cannot tell them apart. The row is locked first, with the lock the owner
-- trigger of workspace_members takes, so a removal that commits concurrently waits and then finds the workspace
-- exempt from the owner rule.
CREATE OR REPLACE FUNCTION public.sys_workspace_mark_deleting(p_workspace_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_workspace_id IS NULL THEN
    RAISE EXCEPTION 'sys_workspace_mark_deleting needs a workspace'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF public.app_account_id() IS NULL OR public.app_workspace_id() IS DISTINCT FROM p_workspace_id THEN
    RETURN false;
  END IF;
  PERFORM 1 FROM public.workspaces w
  WHERE w.id = p_workspace_id AND w.deleting_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.workspace_members m
    WHERE m.workspace_id = p_workspace_id AND m.account_id = public.app_account_id() AND m.role = 'owner'
  ) THEN
    RETURN false;
  END IF;
  UPDATE public.workspaces SET deleting_at = v_now WHERE id = p_workspace_id;
  UPDATE public.sessions SET active_workspace_id = NULL WHERE active_workspace_id = p_workspace_id;
  UPDATE public.api_tokens SET revoked_at = v_now WHERE workspace_id = p_workspace_id AND revoked_at IS NULL;
  RETURN true;
END
$$;

-- sys_workspace_purge_batch(workspace_id, table_name, batch_size): the job half of a deletion. It deletes at most
-- batch_size rows of one tenant table that belong to a workspace that is being deleted and answers how many it
-- deleted; repeating it finishes the table, and a table with nothing left answers 0. Each table is a statement of
-- its own because a system operation takes no dynamic SQL; the order the job calls them in is the registry of
-- src/purge-registry.ts, which `pnpm db:check` holds to the tables that have a workspace_id column and to this
-- function. A table this function does not know is refused whatever the workspace. A workspace that is not being
-- deleted, or is already gone, loses nothing: the function answers 0 for it. Only the worker calls it, outside any
-- tenant transaction: a transaction that acts for an account or a workspace is refused, so a request cannot hurry
-- or widen a deletion.
CREATE OR REPLACE FUNCTION public.sys_workspace_purge_batch(p_workspace_id uuid, p_table text, p_batch_size integer)
  RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_deleted bigint;
BEGIN
  IF p_workspace_id IS NULL OR p_table IS NULL OR p_batch_size IS NULL OR p_batch_size < 1 OR p_batch_size > 10000 THEN
    RAISE EXCEPTION 'sys_workspace_purge_batch needs a workspace, a table and a batch size from 1 to 10000'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_table NOT IN ('api_tokens', 'audit_events', 'workspace_invitations', 'workspace_settings', 'workspace_members') THEN
    RAISE EXCEPTION 'sys_workspace_purge_batch does not know the table %', p_table
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF public.app_account_id() IS NOT NULL OR public.app_workspace_id() IS NOT NULL THEN
    RETURN 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = p_workspace_id AND w.deleting_at IS NOT NULL) THEN
    RETURN 0;
  END IF;

  IF p_table = 'api_tokens' THEN
    DELETE FROM public.api_tokens
    WHERE id IN (SELECT t.id FROM public.api_tokens t WHERE t.workspace_id = p_workspace_id LIMIT p_batch_size);
  ELSIF p_table = 'audit_events' THEN
    DELETE FROM public.audit_events
    WHERE id IN (SELECT e.id FROM public.audit_events e WHERE e.workspace_id = p_workspace_id LIMIT p_batch_size);
  ELSIF p_table = 'workspace_invitations' THEN
    DELETE FROM public.workspace_invitations
    WHERE id IN (SELECT i.id FROM public.workspace_invitations i WHERE i.workspace_id = p_workspace_id LIMIT p_batch_size);
  ELSIF p_table = 'workspace_settings' THEN
    DELETE FROM public.workspace_settings WHERE workspace_id = p_workspace_id;
  ELSE
    DELETE FROM public.workspace_members
    WHERE (workspace_id, account_id) IN (
      SELECT m.workspace_id, m.account_id FROM public.workspace_members m WHERE m.workspace_id = p_workspace_id LIMIT p_batch_size);
  END IF;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted::integer;
END
$$;

-- sys_workspace_delete_finish(workspace_id): deletes the row of a workspace that is being deleted, which cascades
-- whatever rows the registry left, and says whether it did. A workspace that is not being deleted, one that is
-- gone already and a call inside a tenant transaction are false and delete nothing. The members that go with the
-- row are exempt from the owner rule because the transaction deleted the workspace itself.
CREATE OR REPLACE FUNCTION public.sys_workspace_delete_finish(p_workspace_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF p_workspace_id IS NULL THEN
    RAISE EXCEPTION 'sys_workspace_delete_finish needs a workspace'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF public.app_account_id() IS NOT NULL OR public.app_workspace_id() IS NOT NULL THEN
    RETURN false;
  END IF;
  DELETE FROM public.workspaces WHERE id = p_workspace_id AND deleting_at IS NOT NULL;
  RETURN FOUND;
END
$$;

ALTER FUNCTION public.sys_workspace_mark_deleting(uuid) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_workspace_purge_batch(uuid, text, integer) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_workspace_delete_finish(uuid) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_workspace_mark_deleting(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_workspace_purge_batch(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_workspace_delete_finish(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_workspace_mark_deleting(uuid) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_workspace_purge_batch(uuid, text, integer) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_workspace_delete_finish(uuid) TO slugbase_app;
