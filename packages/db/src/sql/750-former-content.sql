-- The deletion of former members' content by the workspace's admins (doc 02 sections 2.10 and 3.6, doc 05 sections 2.2, 2.4, 3.3 and 7.1, doc 10 T1, T2 and T11).
-- It is entered in src/system/registry.ts. slugbase_owner creates the function and hands it to slugbase_system, which needs CREATE on the schema for the length of
-- that statement.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_former_content_delete(workspace_id, bookmark_ids, folder_ids): deletes the bookmarks of bookmark_ids and the folders of folder_ids that have no owner in the
-- workspace the transaction acts in, with what references them by foreign key (shares, filings, tag links, remembered /go choices), and gives the places of the deleted
-- bookmarks under bookmarks.max back by one change of the counter for the whole call: the workspace's bookmark_count falls by the bookmarks deleted, which are all
-- counted ones. It answers how many bookmarks and how many folders it deleted. slugbase_app has no privilege to delete a bookmark or to change workspaces.bookmark_count,
-- and sys_bookmark_delete and sys_bookmark_delete_many delete only rows the calling account owns, so the counter falls only together with the rows it counted, in one
-- statement of the caller's transaction.
--
-- Whose content this deletes is this function's rule, since the policies of bookmarks and folders name the workspace only. A row is deleted only when it has no owner
-- (owner_id IS NULL) and no departure (departure_id IS NULL), the content of a member who left or whose account was deleted that no delivery of a departure still holds
-- (doc 05 section 7.5), and a bookmark only when it is not plan-archived, the rows the list of the former members' content holds (src/repositories/former-content.ts).
-- An identifier that names any other row (one a member owns, one a departure still holds, a plan-archived bookmark, one of another workspace, a gone row or none at all)
-- is skipped, writes nothing and is not told apart from another, which keeps the answer from saying whether a row exists; a row named twice is deleted once.
--
-- Who may call it is this function's rule too, not only the route's: the account is app_account_id(), never an argument, and it must be an owner or an admin of the
-- workspace, read from workspace_members after the workspace's row is locked, so a role taken away by a concurrent change is not honoured. For any other account the
-- function writes nothing and answers NULL, the answer it gives for a workspace other than the one the transaction acts in (app_workspace_id()) and for one being deleted
-- or that does not exist. A list that is NULL, holds a NULL element or holds more than 1000 positions is refused with invalid_parameter_value, writing nothing.
--
-- The workspace's row is locked (FOR NO KEY UPDATE) before the first bookmark's, the order sys_bookmark_delete_many, sys_bookmark_delete, sys_bookmark_count_take,
-- sys_bookmark_archive_set and the removal of a member take; the bookmarks are then locked in the order of their identifiers, then the folders in the order of theirs, so
-- concurrent calls queue on the workspace and none ends in a deadlock. The counter's CHECK refuses a count below zero, so a counter that disagrees with the rows fails
-- the deletion instead of passing silently.
CREATE OR REPLACE FUNCTION public.sys_former_content_delete(
  p_workspace_id uuid, p_bookmark_ids uuid[], p_folder_ids uuid[],
  OUT bookmarks_deleted integer, OUT folders_deleted integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF p_workspace_id IS NULL OR p_bookmark_ids IS NULL OR p_folder_ids IS NULL THEN
    RAISE EXCEPTION 'sys_former_content_delete needs a workspace and a list of bookmarks and a list of folders'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF cardinality(p_bookmark_ids) > 1000 OR cardinality(p_folder_ids) > 1000 THEN
    RAISE EXCEPTION 'sys_former_content_delete takes at most 1000 bookmarks and 1000 folders'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_bookmark_ids) AS u(id) WHERE u.id IS NULL)
     OR EXISTS (SELECT 1 FROM unnest(p_folder_ids) AS u(id) WHERE u.id IS NULL) THEN
    RAISE EXCEPTION 'sys_former_content_delete needs an identifier at every position'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF public.app_account_id() IS NULL OR public.app_workspace_id() IS DISTINCT FROM p_workspace_id THEN
    RETURN;
  END IF;
  PERFORM 1 FROM public.workspaces w
  WHERE w.id = p_workspace_id AND w.deleting_at IS NULL
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.workspace_members m
    WHERE m.workspace_id = p_workspace_id AND m.account_id = public.app_account_id() AND m.role IN ('owner', 'admin')
  ) THEN
    RETURN;
  END IF;

  PERFORM 1 FROM public.bookmarks b
  WHERE b.workspace_id = p_workspace_id AND b.owner_id IS NULL AND b.departure_id IS NULL AND b.plan_archived_at IS NULL AND b.id = ANY (p_bookmark_ids)
  ORDER BY b.id
  FOR UPDATE;
  PERFORM 1 FROM public.folders f
  WHERE f.workspace_id = p_workspace_id AND f.owner_id IS NULL AND f.departure_id IS NULL AND f.id = ANY (p_folder_ids)
  ORDER BY f.id
  FOR UPDATE;

  WITH deleted AS (
    DELETE FROM public.bookmarks b
    WHERE b.workspace_id = p_workspace_id AND b.owner_id IS NULL AND b.departure_id IS NULL AND b.plan_archived_at IS NULL AND b.id = ANY (p_bookmark_ids)
    RETURNING b.id
  )
  SELECT count(*) INTO bookmarks_deleted FROM deleted;
  IF bookmarks_deleted > 0 THEN
    UPDATE public.workspaces SET bookmark_count = bookmark_count - bookmarks_deleted WHERE id = p_workspace_id;
  END IF;

  WITH deleted AS (
    DELETE FROM public.folders f
    WHERE f.workspace_id = p_workspace_id AND f.owner_id IS NULL AND f.departure_id IS NULL AND f.id = ANY (p_folder_ids)
    RETURNING f.id
  )
  SELECT count(*) INTO folders_deleted FROM deleted;
END
$$;

ALTER FUNCTION public.sys_former_content_delete(uuid, uuid[], uuid[]) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_former_content_delete(uuid, uuid[], uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_former_content_delete(uuid, uuid[], uuid[]) TO slugbase_app;
