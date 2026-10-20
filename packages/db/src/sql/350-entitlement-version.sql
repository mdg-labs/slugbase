-- The system operation behind raising a workspace's entitlement version (doc 01 sections 7.5 and 8.3, doc 05
-- sections 2.2 and 3.3, doc 10 T11). It is entered in src/system/registry.ts. slugbase_owner creates the function
-- and hands it to slugbase_system, which needs CREATE on the schema for the length of those statements.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_workspace_bump_entitlement_version(workspace_id): moves workspaces.entitlement_version, the key of the
-- per-process entitlement cache, by one and answers the new version. slugbase_app cannot write the column, so a
-- change to a workspace's plan, archive state or override made in a tenant transaction raises the version through
-- this function in the same transaction. It acts only on the workspace the transaction acts in
-- (app_workspace_id()) and only for the account of the transaction (app_account_id(), never an argument) when it is
-- a member of that workspace: a transaction acting in A neither raises nor reads B's version. A workspace that is
-- being deleted, one that does not exist and a refused caller are all NULL, changing nothing. The ETag of the
-- workspace (version) and its name stay where they were; updated_at moves, as the workspaces_set_updated_at
-- trigger moves it on every UPDATE.
CREATE OR REPLACE FUNCTION public.sys_workspace_bump_entitlement_version(p_workspace_id uuid)
  RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_version integer;
BEGIN
  IF p_workspace_id IS NULL THEN
    RAISE EXCEPTION 'sys_workspace_bump_entitlement_version needs a workspace'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF public.app_account_id() IS NULL OR public.app_workspace_id() IS DISTINCT FROM p_workspace_id THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.workspace_members m
    WHERE m.workspace_id = p_workspace_id AND m.account_id = public.app_account_id()
  ) THEN
    RETURN NULL;
  END IF;
  UPDATE public.workspaces
  SET entitlement_version = entitlement_version + 1
  WHERE id = p_workspace_id AND deleting_at IS NULL
  RETURNING entitlement_version INTO v_version;
  RETURN v_version;
END
$$;

ALTER FUNCTION public.sys_workspace_bump_entitlement_version(uuid) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_workspace_bump_entitlement_version(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_workspace_bump_entitlement_version(uuid) TO slugbase_app;
