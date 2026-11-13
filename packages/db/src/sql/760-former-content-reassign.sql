-- The reassignment of former members' content by the workspace's admins (doc 02 sections 2.10 and 3.6, doc 05 sections 2.4, 3.3, 7.1 and 7.5, doc 10 T1, T2 and T11).
-- It is entered in src/system/registry.ts. slugbase_owner creates the function and hands it to slugbase_system, which needs CREATE on the schema for the length of
-- that statement.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_former_content_reassign(workspace_id, recipient, bookmark_ids, folder_ids): gives the bookmarks of bookmark_ids and the folders of folder_ids that have no owner in
-- the workspace the transaction acts in to `recipient`, a current member of that workspace, in the transaction of the call, and answers what it did: how many bookmarks
-- and folders it moved, how many slugs it cleared, how many folders it renamed and how many filings it removed. slugbase_app has no privilege to change the owner of a row,
-- and the rows are no longer the caller's: sys_member_departure_apply moves only the rows of one departure and only as the recipient, so content an account's deletion left
-- (departure_id NULL) had no way to an owner. The workspace's bookmark_count does not change: the rows are counted whoever owns them.
--
-- Whose content this moves is this function's rule, since the policies of bookmarks and folders name the workspace only. A row is moved only when it has no owner
-- (owner_id IS NULL) and no departure (departure_id IS NULL), the content of a member who left or whose account was deleted that no delivery of a departure still holds
-- (doc 05 section 7.5), and a bookmark only when it is not plan-archived: the rows the list of the former members' content holds (src/repositories/former-content.ts)
-- and sys_former_content_delete deletes. An identifier that names any other row (one a member owns, one a departure still holds, a plan-archived bookmark, one of another
-- workspace, a gone row or none at all) is skipped, writes nothing and is not told apart from another, so the answer does not say whether a row exists; a row named twice
-- is moved once.
--
-- Who may call it is this function's rule too: the account is app_account_id(), never an argument, and it must be an owner or an admin of the workspace, read from
-- workspace_members after the workspace's row is locked, so a role taken away by a concurrent change is not honoured. The recipient must be a member of the workspace,
-- read under the same lock: the removal of a member takes the workspace's row first, so a removal that is queued behind this call ends the membership after the rows
-- are moved, and the departure it queues is then applied to the rows the recipient owns. For an account that is no owner or admin, for a recipient that is no member
-- (a member of another workspace included), for a workspace other than the one the transaction acts in (app_workspace_id()) and for one being deleted or that does
-- not exist, the function writes nothing and answers NULL in every column. A NULL argument, a list with a NULL element or a list of more than 1000 positions is
-- refused with invalid_parameter_value, writing nothing.
--
-- The collisions are the departure's (sys_member_departure_apply, src/sql/680-member-departure.sql, whose rules these statements repeat for the rows of a former
-- member, which carry no saved original): a bookmark whose slug the recipient already owns, a plan-archived bookmark of the recipient included, arrives with the slug
-- cleared and forwarding turned off; a folder whose name the recipient already has, without regard to case, is named `<name> (<n>)` with the lowest n >= 2 that the
-- recipient has no folder of, the base cut so that the result is at most 64 characters, the folders judged in the order of their creation and each against the ones moved
-- before it. The other columns, the shares on the content (they are keyed by the bookmark and the folder) and the tag links stay as they were.
-- The recipient's own writers (a folder created or renamed, a slug set) take no lock of the workspace, so a name or slug they write in a transaction that commits while
-- a row is being moved is not seen by the check that precedes the update. The update of each row therefore runs in a block that catches the unique violation of
-- folders_owner_name_key or bookmarks_owner_slug_key and resolves it as the check would have: the next free name for a folder, a cleared slug with forwarding off for a
-- bookmark. A unique violation of any other constraint is raised again and ends the call.
--
-- Filings stay the owner's (doc 13 Q22): a folder_bookmarks row links a folder and a bookmark of one owner. A row whose bookmark or folder was moved by this call and whose
-- two sides now have different owners (a folder moved with a bookmark that stays ownerless, or the two moved to different recipients by two calls) is deleted in
-- the same call and counted in filings_removed. Rows of the content this call did not move are not looked at.
--
-- The workspace's row is locked (FOR NO KEY UPDATE) before any other row, the order sys_former_content_delete, sys_bookmark_delete_many, sys_bookmark_count_take,
-- sys_bookmark_archive_set, sys_member_departure_apply and the removal of a member take; the folders are then locked in the order of their identifiers, then the
-- bookmarks in the order of theirs, the order sys_member_departure_apply locks them in, so concurrent calls queue on the workspace and none ends in a deadlock.
CREATE OR REPLACE FUNCTION public.sys_former_content_reassign(
  p_workspace_id uuid, p_recipient uuid, p_bookmark_ids uuid[], p_folder_ids uuid[],
  OUT bookmarks_moved integer, OUT folders_moved integer, OUT slugs_cleared integer, OUT folders_renamed integer, OUT filings_removed integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_folder record;
  v_base text;
  v_candidate text;
  v_suffix text;
  v_n integer;
  v_constraint text;
  v_bookmark record;
  v_clash boolean;
  v_moved_bookmarks uuid[] := '{}';
  v_moved_folders uuid[] := '{}';
BEGIN
  IF p_workspace_id IS NULL OR p_recipient IS NULL OR p_bookmark_ids IS NULL OR p_folder_ids IS NULL THEN
    RAISE EXCEPTION 'sys_former_content_reassign needs a workspace, a recipient and a list of bookmarks and a list of folders'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF cardinality(p_bookmark_ids) > 1000 OR cardinality(p_folder_ids) > 1000 THEN
    RAISE EXCEPTION 'sys_former_content_reassign takes at most 1000 bookmarks and 1000 folders'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_bookmark_ids) AS u(id) WHERE u.id IS NULL)
     OR EXISTS (SELECT 1 FROM unnest(p_folder_ids) AS u(id) WHERE u.id IS NULL) THEN
    RAISE EXCEPTION 'sys_former_content_reassign needs an identifier at every position'
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
  IF NOT EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.workspace_id = p_workspace_id AND m.account_id = p_recipient) THEN
    RETURN;
  END IF;
  bookmarks_moved := 0;
  folders_moved := 0;
  slugs_cleared := 0;
  folders_renamed := 0;
  filings_removed := 0;

  PERFORM 1 FROM public.folders f
  WHERE f.workspace_id = p_workspace_id AND f.owner_id IS NULL AND f.departure_id IS NULL AND f.id = ANY (p_folder_ids)
  ORDER BY f.id
  FOR UPDATE;
  PERFORM 1 FROM public.bookmarks b
  WHERE b.workspace_id = p_workspace_id AND b.owner_id IS NULL AND b.departure_id IS NULL AND b.plan_archived_at IS NULL AND b.id = ANY (p_bookmark_ids)
  ORDER BY b.id
  FOR UPDATE;

  FOR v_folder IN
    SELECT f.id, f.name FROM public.folders f
    WHERE f.workspace_id = p_workspace_id AND f.owner_id IS NULL AND f.departure_id IS NULL AND f.id = ANY (p_folder_ids)
    ORDER BY f.created_at, f.id
  LOOP
    v_base := v_folder.name::text;
    v_candidate := v_base;
    v_n := 2;
    LOOP
      IF NOT EXISTS (
        SELECT 1 FROM public.folders g
        WHERE g.workspace_id = p_workspace_id AND g.owner_id = p_recipient AND g.name = v_candidate::citext
      ) THEN
        BEGIN
          UPDATE public.folders SET owner_id = p_recipient, name = v_candidate WHERE id = v_folder.id;
          EXIT;
        EXCEPTION WHEN unique_violation THEN
          GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
          IF v_constraint IS DISTINCT FROM 'folders_owner_name_key' THEN
            RAISE;
          END IF;
        END;
      END IF;
      v_suffix := ' (' || v_n::text || ')';
      v_candidate := rtrim(left(v_base, 64 - length(v_suffix))) || v_suffix;
      v_n := v_n + 1;
    END LOOP;
    v_moved_folders := v_moved_folders || v_folder.id;
    folders_moved := folders_moved + 1;
    IF v_candidate <> v_base THEN
      folders_renamed := folders_renamed + 1;
    END IF;
  END LOOP;

  FOR v_bookmark IN
    SELECT b.id, b.slug FROM public.bookmarks b
    WHERE b.workspace_id = p_workspace_id AND b.owner_id IS NULL AND b.departure_id IS NULL AND b.plan_archived_at IS NULL AND b.id = ANY (p_bookmark_ids)
    ORDER BY b.id
  LOOP
    v_clash := v_bookmark.slug IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.bookmarks r WHERE r.workspace_id = p_workspace_id AND r.owner_id = p_recipient AND r.slug = v_bookmark.slug);
    IF NOT v_clash THEN
      IF v_bookmark.slug IS NULL THEN
        UPDATE public.bookmarks SET owner_id = p_recipient WHERE id = v_bookmark.id;
      ELSE
        BEGIN
          UPDATE public.bookmarks SET owner_id = p_recipient WHERE id = v_bookmark.id;
        EXCEPTION WHEN unique_violation THEN
          GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
          IF v_constraint IS DISTINCT FROM 'bookmarks_owner_slug_key' THEN
            RAISE;
          END IF;
          v_clash := true;
        END;
      END IF;
    END IF;
    IF v_clash THEN
      UPDATE public.bookmarks SET owner_id = p_recipient, slug = NULL, forwarding = false WHERE id = v_bookmark.id;
      slugs_cleared := slugs_cleared + 1;
    END IF;
    v_moved_bookmarks := v_moved_bookmarks || v_bookmark.id;
    bookmarks_moved := bookmarks_moved + 1;
  END LOOP;

  WITH removed AS (
    DELETE FROM public.folder_bookmarks fb
    USING public.bookmarks b, public.folders f
    WHERE fb.workspace_id = p_workspace_id
      AND b.workspace_id = fb.workspace_id AND b.id = fb.bookmark_id
      AND f.workspace_id = fb.workspace_id AND f.id = fb.folder_id
      AND (fb.bookmark_id = ANY (v_moved_bookmarks) OR fb.folder_id = ANY (v_moved_folders))
      AND b.owner_id IS DISTINCT FROM f.owner_id
    RETURNING 1
  )
  SELECT count(*) INTO filings_removed FROM removed;
END
$$;

ALTER FUNCTION public.sys_former_content_reassign(uuid, uuid, uuid[], uuid[]) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_former_content_reassign(uuid, uuid, uuid[], uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_former_content_reassign(uuid, uuid, uuid[], uuid[]) TO slugbase_app;
