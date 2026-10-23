-- Row-level security, privileges and the system operation of bookmarks (doc 05 sections 2.2, 2.4 and
-- 3.3, doc 01 section 7.5, doc 10 T1, T2 and T11). The table itself is defined in src/schema/bookmarks.ts.
-- sys_bookmark_count_take is entered in src/system/registry.ts. slugbase_owner creates the function and hands it to
-- slugbase_system, which needs CREATE on the schema for the length of those statements.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_bookmark_count_take(workspace_id, max): takes one place under the ceiling of the workspace the transaction acts in
-- (the entitlement bookmarks.max the caller read from the entitlement source; NULL: no ceiling). It locks the workspace's row,
-- compares workspaces.bookmark_count + 1 with the ceiling and raises the counter, so the check and the increment are one
-- step and two creations at the limit minus one make one: the second waits on the lock and then finds the counter at the
-- ceiling. slugbase_app has no privilege on the column, and the transaction that takes the place also inserts the bookmark,
-- so a refused or failed insert rolls the place back. The outcome is 'taken', 'limit_reached' or 'unavailable' for a workspace
-- other than the one the transaction acts in, one being deleted or one that does not exist, and for an account that is no
-- member of it (the account comes from app_account_id(), never an argument). For 'limit_reached' used carries the count the
-- refusal was judged against, so a caller reports that number and not a later count of its own; for 'taken' it is the count
-- after the increment, and NULL for 'unavailable'. The lock is FOR NO KEY UPDATE, which a foreign-key check of another
-- table's insert does not wait for, and is the one the owner trigger of workspace_members takes, so the two queue in a
-- fixed order. The updated_at of the workspace moves with the counter, its version (the ETag) and its name stay.
CREATE OR REPLACE FUNCTION public.sys_bookmark_count_take(p_workspace_id uuid, p_max integer, OUT outcome text, OUT used integer)
  RETURNS record
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_workspace_id IS NULL OR (p_max IS NOT NULL AND p_max < 0) THEN
    RAISE EXCEPTION 'sys_bookmark_count_take needs a workspace and a ceiling that is not negative'
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

  IF p_max IS NOT NULL AND v_count + 1 > p_max THEN
    outcome := 'limit_reached';
    used := v_count;
    RETURN;
  END IF;
  UPDATE public.workspaces SET bookmark_count = bookmark_count + 1 WHERE id = p_workspace_id;
  outcome := 'taken';
  used := v_count + 1;
END
$$;

ALTER FUNCTION public.sys_bookmark_count_take(uuid, integer) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_bookmark_count_take(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_bookmark_count_take(uuid, integer) TO slugbase_app;

-- bookmarks: the bookmarks of the active workspace, read and inserted there only. slugbase_app may insert the columns a
-- creation gives a new bookmark and not the slug, forwarding, the archive state, the usage, the version or the timestamps, so a
-- row it writes is never archived or forwarding and starts unused. It never updates or deletes a row: changing and deleting a
-- bookmark arrive with their operations.
-- Whose bookmark a member may read is the bookmark service's rule (doc 10 T2), not the policy's; the policy keeps one
-- workspace's rows from another's. slugbase_system, which bypasses the policies, gets the privileges the workspace deletion
-- and the system operations need.
ALTER TABLE public.bookmarks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bookmarks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bookmarks_tenant ON public.bookmarks;
CREATE POLICY bookmarks_tenant ON public.bookmarks FOR SELECT
  USING (workspace_id = public.app_workspace_id());
DROP POLICY IF EXISTS bookmarks_tenant_insert ON public.bookmarks;
CREATE POLICY bookmarks_tenant_insert ON public.bookmarks FOR INSERT
  WITH CHECK (workspace_id = public.app_workspace_id());
REVOKE ALL ON TABLE public.bookmarks FROM PUBLIC, slugbase_app;
GRANT SELECT ON TABLE public.bookmarks TO slugbase_app;
GRANT INSERT (id, workspace_id, owner_id, url, url_canonical, host, title, description, pinned_at) ON TABLE public.bookmarks TO slugbase_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.bookmarks TO slugbase_system;
CREATE OR REPLACE TRIGGER bookmarks_set_updated_at
  BEFORE UPDATE ON public.bookmarks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
