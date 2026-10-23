-- The system operation behind archiving and restoring bookmarks (doc 01 sections 7.5 and 13.3, doc 02 section 5.6, doc 05
-- sections 2.2 and 3.3, doc 10 T1 and T11). It is entered in src/system/registry.ts. slugbase_owner creates the function and
-- hands it to slugbase_system, which needs CREATE on the schema for the length of those statements.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_bookmark_archive_set(workspace_id, bookmark_ids, archive): sets plan_archived_at on (archive) or clears it from (not archive)
-- the bookmarks of the workspace the transaction acts in whose state differs, and answers how many rows it changed. slugbase_app has
-- no privilege on bookmarks.plan_archived_at or on workspaces.bookmark_count, so the archive state and the counter that counts the
-- rows that are not archived can only move together, in one call of the caller's transaction: the counter falls (archive) or rises
-- (restore) by the rows that changed. It does not touch entitlement_version: the caller raises it with
-- sys_workspace_bump_entitlement_version in the same transaction, through withEntitlementChange (doc 01 section 7.5), which the
-- core services archiveBookmarks and restoreBookmarks do. An identifier that names no bookmark of the workspace (another workspace's,
-- one that is gone, a NULL element) is skipped, and a bookmark that is in the wanted state already is not counted, so the function is
-- idempotent. It writes nothing else of the bookmark: the pin, the slug, forwarding, the owner and the usage stay; the triggers move
-- the version and updated_at of the rows it changes. It does not choose which bookmarks to archive and never restores against a
-- ceiling: both belong to the caller. The outcome is NULL, writing nothing, for a workspace other than the one the transaction acts
-- in, one being deleted or one that does not exist, and for an account that is no member of it (the account comes from
-- app_account_id(), never an argument). The workspace's row is locked (FOR NO KEY UPDATE) before any bookmark's, the order
-- sys_bookmark_count_take, sys_bookmark_delete and a member's removal take, so concurrent calls for one workspace queue on it and
-- none ends in a deadlock; the bump that follows updates the row this transaction holds the lock on already.
CREATE OR REPLACE FUNCTION public.sys_bookmark_archive_set(p_workspace_id uuid, p_bookmark_ids uuid[], p_archive boolean)
  RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_changed integer;
BEGIN
  IF p_workspace_id IS NULL OR p_bookmark_ids IS NULL OR p_archive IS NULL THEN
    RAISE EXCEPTION 'sys_bookmark_archive_set needs a workspace, a list of bookmarks and a direction'
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

  PERFORM 1 FROM public.workspaces w
  WHERE w.id = p_workspace_id AND w.deleting_at IS NULL
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF p_archive THEN
    UPDATE public.bookmarks b SET plan_archived_at = now()
    WHERE b.workspace_id = p_workspace_id AND b.id = ANY (p_bookmark_ids) AND b.plan_archived_at IS NULL;
  ELSE
    UPDATE public.bookmarks b SET plan_archived_at = NULL
    WHERE b.workspace_id = p_workspace_id AND b.id = ANY (p_bookmark_ids) AND b.plan_archived_at IS NOT NULL;
  END IF;
  GET DIAGNOSTICS v_changed = ROW_COUNT;

  UPDATE public.workspaces
  SET bookmark_count = bookmark_count + CASE WHEN p_archive THEN -v_changed ELSE v_changed END
  WHERE id = p_workspace_id;
  RETURN v_changed;
END
$$;

ALTER FUNCTION public.sys_bookmark_archive_set(uuid, uuid[], boolean) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_bookmark_archive_set(uuid, uuid[], boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_bookmark_archive_set(uuid, uuid[], boolean) TO slugbase_app;
