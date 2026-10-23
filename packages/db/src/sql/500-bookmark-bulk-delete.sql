-- The system operation behind deleting many bookmarks in one request (doc 02 section 5.8, doc 05 sections 2.2 and 3.3, doc 10 T1 and T2).
-- It is entered in src/system/registry.ts. slugbase_owner creates the function and hands it to slugbase_system, which needs CREATE on
-- the schema for the length of those statements.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_bookmark_delete_many(workspace_id, bookmark_ids): deletes the bookmarks of bookmark_ids that the calling account owns in the
-- workspace the transaction acts in, and gives their places under bookmarks.max back by one change of the counter for the whole call: the
-- workspace's bookmark_count falls by the rows deleted that were not plan-archived, the number the counter counted. It answers how many
-- rows it deleted, the plan-archived ones included (an owner may delete those, doc 02 section 5.6). slugbase_app has no privilege on
-- workspaces.bookmark_count and none to delete a bookmark, so the counter falls only together with the rows it counted, in one statement
-- of the caller's transaction. The account is app_account_id(), never an argument, and the workspace is the one the transaction acts in
-- (app_workspace_id()); an identifier that is another member's, another workspace's, gone or that names no bookmark is skipped, writes nothing
-- and is not told apart from another, which is what keeps the answer from saying whether a bookmark exists. The outcome is NULL, writing
-- nothing, for a workspace other than the one the transaction acts in and for one being deleted or that does not exist. The list is
-- refused with invalid_parameter_value, writing nothing, when it is NULL, holds a NULL element or holds more than 5 000 positions (the
-- select-all cap, doc 02 section 16); a bookmark named twice is deleted once. The workspace's row is locked (FOR NO KEY UPDATE) before
-- the first bookmark's, the order sys_bookmark_delete, sys_bookmark_count_take, sys_bookmark_archive_set and the removal of a member
-- take, and the bookmarks are then locked in the order of their identifiers, the order a bulk pin takes, so concurrent calls queue and none
-- ends in a deadlock. The counter's CHECK refuses a count below zero, so a counter that disagrees with the rows fails the deletion
-- instead of passing silently.
CREATE OR REPLACE FUNCTION public.sys_bookmark_delete_many(p_workspace_id uuid, p_bookmark_ids uuid[]) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_deleted integer;
  v_released integer;
BEGIN
  IF p_workspace_id IS NULL OR p_bookmark_ids IS NULL THEN
    RAISE EXCEPTION 'sys_bookmark_delete_many needs a workspace and a list of bookmarks'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF cardinality(p_bookmark_ids) > 5000 THEN
    RAISE EXCEPTION 'sys_bookmark_delete_many takes at most 5000 bookmarks'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_bookmark_ids) AS u(bookmark_id) WHERE u.bookmark_id IS NULL) THEN
    RAISE EXCEPTION 'sys_bookmark_delete_many needs an identifier at every position'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF public.app_account_id() IS NULL OR public.app_workspace_id() IS DISTINCT FROM p_workspace_id THEN
    RETURN NULL;
  END IF;
  PERFORM 1 FROM public.workspaces w
  WHERE w.id = p_workspace_id AND w.deleting_at IS NULL
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  PERFORM 1 FROM public.bookmarks b
  WHERE b.workspace_id = p_workspace_id AND b.owner_id = public.app_account_id() AND b.id = ANY (p_bookmark_ids)
  ORDER BY b.id
  FOR UPDATE;

  WITH deleted AS (
    DELETE FROM public.bookmarks b
    WHERE b.workspace_id = p_workspace_id AND b.owner_id = public.app_account_id() AND b.id = ANY (p_bookmark_ids)
    RETURNING b.plan_archived_at
  )
  SELECT count(*), count(*) FILTER (WHERE d.plan_archived_at IS NULL) INTO v_deleted, v_released FROM deleted d;

  IF v_released > 0 THEN
    UPDATE public.workspaces SET bookmark_count = bookmark_count - v_released WHERE id = p_workspace_id;
  END IF;
  RETURN v_deleted;
END
$$;

ALTER FUNCTION public.sys_bookmark_delete_many(uuid, uuid[]) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_bookmark_delete_many(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_bookmark_delete_many(uuid, uuid[]) TO slugbase_app;
