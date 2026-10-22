-- The workspaces an account may own (doc 01 section 7.5, doc 02 sections 2.2 and 3.2, doc 10 T11). The two functions
-- are entered in src/system/registry.ts. slugbase_owner creates each function and hands it to slugbase_system, which
-- needs CREATE on the schema for the length of those statements.
--
-- Both take the ceiling as p_owned_max, the value of the account-scoped entitlement workspaces.ownMax the caller read
-- from the entitlement source (NULL: no ceiling), and judge it against the count made here, under the lock of the
-- account's row, in the transaction that inserts the workspace. Two creations for one account queue on that row, so the
-- second counts the workspace the first made and a ceiling of one is never exceeded by a pair that runs in parallel.
-- The lock is the one sys_create_personal_workspace and the account deletion take (the deletion locks the workspaces
-- it deletes first and the account after them; these functions lock no workspace row that exists, only the account's).
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_create_workspace_limited(account_id, workspace_id, name, owned_max): sys_create_workspace, unless the account
-- already owns p_owned_max workspaces that are not being deleted, in which case it writes nothing. The outcome is
-- 'created', 'limit_reached', or 'unavailable' for an account that does not exist, is disabled, or is not the account a
-- tenant transaction acts for (the refusal sys_create_workspace makes). For 'limit_reached' the owned column carries the
-- count the refusal was judged against, so a caller reports that number and not a later count of its own; it is NULL for
-- every other outcome. The anonymous flows that create an account's first workspace run with no account set and name the
-- account they just made.
CREATE OR REPLACE FUNCTION public.sys_create_workspace_limited(p_account_id uuid, p_workspace_id uuid, p_name text, p_owned_max integer, OUT outcome text, OUT owned integer)
  RETURNS record
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_owned integer;
BEGIN
  IF NOT coalesce(
    p_account_id IS NOT NULL AND p_workspace_id IS NOT NULL AND p_name IS NOT NULL AND (p_owned_max IS NULL OR p_owned_max >= 0),
    false
  ) THEN
    RAISE EXCEPTION 'sys_create_workspace_limited needs an account, a workspace id, a name and a ceiling that is not negative'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF public.app_account_id() IS NOT NULL AND p_account_id <> public.app_account_id() THEN
    outcome := 'unavailable';
    RETURN;
  END IF;

  PERFORM 1 FROM public.accounts a WHERE a.id = p_account_id AND a.disabled_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    outcome := 'unavailable';
    RETURN;
  END IF;

  IF p_owned_max IS NOT NULL THEN
    SELECT count(*)::integer INTO v_owned
    FROM public.workspace_members m
    JOIN public.workspaces w ON w.id = m.workspace_id
    WHERE m.account_id = p_account_id AND m.role = 'owner' AND w.deleting_at IS NULL;
    IF v_owned >= p_owned_max THEN
      outcome := 'limit_reached';
      owned := v_owned;
      RETURN;
    END IF;
  END IF;

  IF NOT public.sys_create_workspace(p_account_id, p_workspace_id, p_name) THEN
    RAISE EXCEPTION 'the workspace could not be created';
  END IF;
  outcome := 'created';
END
$$;

-- sys_create_personal_workspace_limited(account_id, workspace_id, name_suffix, owned_max):
-- sys_create_personal_workspace with the ceiling of sys_create_workspace_limited. An account that owns a workspace
-- already is 'exists', whatever the ceiling; an account that owns none and is at the ceiling (a ceiling of zero) is
-- 'limit_reached' and gets no workspace, so the registration or the verification that asked still succeeds and the
-- account is left without one. Answers 'created', 'exists', 'limit_reached' or 'unavailable' for an account that does
-- not exist or is disabled.
CREATE OR REPLACE FUNCTION public.sys_create_personal_workspace_limited(p_account_id uuid, p_workspace_id uuid, p_name_suffix text, p_owned_max integer)
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_display_name text;
  v_outcome text;
BEGIN
  IF NOT coalesce(
    p_account_id IS NOT NULL AND p_workspace_id IS NOT NULL AND char_length(p_name_suffix) BETWEEN 1 AND 32
      AND (p_owned_max IS NULL OR p_owned_max >= 0),
    false
  ) THEN
    RAISE EXCEPTION 'sys_create_personal_workspace_limited needs an account, a workspace id, a name suffix of 1 to 32 characters and a ceiling that is not negative'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.display_name INTO v_display_name
  FROM public.accounts a
  WHERE a.id = p_account_id AND a.disabled_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'unavailable';
  END IF;

  IF EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.account_id = p_account_id AND m.role = 'owner') THEN
    RETURN 'exists';
  END IF;

  SELECT l.outcome INTO v_outcome FROM public.sys_create_workspace_limited(
    p_account_id, p_workspace_id, rtrim(left(v_display_name, 64 - char_length(p_name_suffix))) || p_name_suffix, p_owned_max
  ) l;
  IF v_outcome NOT IN ('created', 'limit_reached') THEN
    RAISE EXCEPTION 'the personal workspace could not be created';
  END IF;
  RETURN v_outcome;
END
$$;

ALTER FUNCTION public.sys_create_workspace_limited(uuid, uuid, text, integer) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_create_personal_workspace_limited(uuid, uuid, text, integer) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_create_workspace_limited(uuid, uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_create_personal_workspace_limited(uuid, uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_create_workspace_limited(uuid, uuid, text, integer) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_create_personal_workspace_limited(uuid, uuid, text, integer) TO slugbase_app;
