-- The system operation behind switching a session's active workspace (doc 05
-- sections 2.1 and 3.3, doc 04 section 10.4, doc 10 T1). It is entered in
-- src/system/registry.ts. slugbase_owner creates the function and hands it to
-- slugbase_system, which needs CREATE on the schema for the length of those
-- statements.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_session_set_active_workspace(session_id, account_id, workspace_id): points
-- a full session of the account at a workspace the account is a member of and
-- that is not being deleted, and says whether it did. The membership is checked
-- as of the snapshot of the statement that writes the session; the check takes
-- no lock on the membership row, so a removal that commits concurrently can
-- leave the session naming a workspace the account no longer belongs to. That
-- value is never trusted: the tenant resolver re-derives the active workspace
-- from the account's memberships on the next request. A workspace the account
-- does not belong to, one being deleted, a session of another account
-- and a partial session (its second factor is still to be given) change
-- nothing and answer false, and the caller cannot tell the first two apart. So
-- does an account other than the one a tenant transaction acts for: when
-- app_account_id() names an account, p_account_id must be that account, so a
-- transaction cannot move the session of somebody else.
CREATE OR REPLACE FUNCTION public.sys_session_set_active_workspace(p_session_id uuid, p_account_id uuid, p_workspace_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF p_session_id IS NULL OR p_account_id IS NULL OR p_workspace_id IS NULL THEN
    RAISE EXCEPTION 'sys_session_set_active_workspace needs a session, an account and a workspace'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF public.app_account_id() IS NOT NULL AND p_account_id <> public.app_account_id() THEN
    RETURN false;
  END IF;
  UPDATE public.sessions s
  SET active_workspace_id = p_workspace_id
  WHERE s.id = p_session_id AND s.account_id = p_account_id AND s.level = 'full'
    AND EXISTS (
      SELECT 1
      FROM public.workspace_members m
      JOIN public.workspaces w ON w.id = m.workspace_id
      WHERE m.workspace_id = p_workspace_id AND m.account_id = p_account_id AND w.deleting_at IS NULL
    );
  RETURN FOUND;
END
$$;

ALTER FUNCTION public.sys_session_set_active_workspace(uuid, uuid, uuid) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_session_set_active_workspace(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_session_set_active_workspace(uuid, uuid, uuid) TO slugbase_app;
