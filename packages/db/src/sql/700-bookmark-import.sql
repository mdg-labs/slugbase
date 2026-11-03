-- The system operation behind creating many bookmarks in one request (the JSON import, doc 02 section 13.1, doc 01 section 7.5, doc 05
-- sections 2.2 and 3.3, doc 10 T1 and T11). It is entered in src/system/registry.ts. slugbase_owner creates the function and hands it to
-- slugbase_system, which needs CREATE on the schema for the length of those statements.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_bookmark_count_take_many(workspace_id, max, wanted): takes up to `wanted` places under the ceiling of the workspace the transaction acts
-- in (the entitlement bookmarks.max the caller read from the entitlement source; NULL: no ceiling), with the checks and the lock of
-- sys_bookmark_count_take and one change of the counter for the whole call: it locks the workspace's row, takes the smaller of `wanted` and
-- the room that is left (the ceiling less workspaces.bookmark_count, never below zero) and raises the counter by that number, so the check and
-- the increment are one step and two imports at the limit minus one together take one place: the second waits on the lock and then finds the
-- counter at the ceiling. slugbase_app has no privilege on the column, and the transaction that takes the places also inserts the bookmarks, so
-- a failed insert rolls the places back. The outcome is 'taken' when all `wanted` places were taken (none, for 0, which writes nothing),
-- 'limit_reached' when fewer were, and 'unavailable' for a workspace other than the one the transaction acts in, one being deleted or one that
-- does not exist, and for an account that is no member of it (the account comes from app_account_id(), never an argument). `taken` is the number
-- of places taken, possibly 0, and `used` the count after the increment, so a caller that is refused reports the count it was judged against and
-- not a later count of its own; both are NULL for 'unavailable'. `wanted` is refused with invalid_parameter_value, writing nothing, when it is
-- NULL, negative or over 5 000 (the cap of an import, doc 02 section 13.1). The lock is FOR NO KEY UPDATE, the one sys_bookmark_count_take and the
-- owner trigger of workspace_members take, so the three queue in a fixed order. The updated_at of the workspace moves with the counter, its
-- version (the ETag) and its name stay.
CREATE OR REPLACE FUNCTION public.sys_bookmark_count_take_many(p_workspace_id uuid, p_max integer, p_wanted integer, OUT outcome text, OUT taken integer, OUT used integer)
  RETURNS record
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_workspace_id IS NULL OR p_wanted IS NULL OR p_wanted < 0 OR p_wanted > 5000 OR (p_max IS NOT NULL AND p_max < 0) THEN
    RAISE EXCEPTION 'sys_bookmark_count_take_many needs a workspace, a number of places from 0 to 5000 and a ceiling that is not negative'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF public.app_account_id() IS NULL OR public.app_workspace_id() IS DISTINCT FROM p_workspace_id THEN
    outcome := 'unavailable';
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.workspace_members m
    WHERE m.workspace_id = p_workspace_id AND m.account_id = public.app_account_id()
  ) THEN
    outcome := 'unavailable';
    RETURN;
  END IF;

  SELECT w.bookmark_count INTO v_count
  FROM public.workspaces w
  WHERE w.id = p_workspace_id AND w.deleting_at IS NULL
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    outcome := 'unavailable';
    RETURN;
  END IF;

  taken := CASE WHEN p_max IS NULL THEN p_wanted ELSE least(p_wanted, greatest(0, p_max - v_count)) END;
  IF taken > 0 THEN
    UPDATE public.workspaces SET bookmark_count = bookmark_count + taken WHERE id = p_workspace_id;
  END IF;
  outcome := CASE WHEN taken = p_wanted THEN 'taken' ELSE 'limit_reached' END;
  used := v_count + taken;
END
$$;

ALTER FUNCTION public.sys_bookmark_count_take_many(uuid, integer, integer) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_bookmark_count_take_many(uuid, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_bookmark_count_take_many(uuid, integer, integer) TO slugbase_app;
