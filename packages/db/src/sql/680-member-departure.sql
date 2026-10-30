-- The content choice of a member's departure (doc 02 section 3.6, doc 05 sections 2.4, 3.3 and 7.1, doc 10 T1 and T2). Ending a membership clears the owner of the
-- member's bookmarks and folders by foreign key (src/sql/530 and 560 give the released rows their name and slug), which leaves nothing on a row to say whose it was.
-- The statement that deletes the membership therefore names the departure first: app.departure_id, set transaction-locally to the identifier of the `member.left`
-- event queued in the same transaction (memberRepository.remove), and the release triggers copy it to the released row's departure_id. A deletion that names none
-- (an account's deletion, the purge of a workspace) leaves departure_id null, so its ownerless content stays Former-member content. The worker then applies the
-- choice of the event to exactly the rows of its departure.
--
-- app_departure_id(): the departure the transaction names, NULL when it names none or the setting is empty. It is a tenant setting like app_account_id() and runs
-- with the privileges of its caller. slugbase_owner creates sys_member_departure_apply and hands it to slugbase_system, which needs CREATE on the schema for the
-- length of that statement.
GRANT CREATE ON SCHEMA public TO slugbase_system;

CREATE OR REPLACE FUNCTION public.app_departure_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.departure_id', true), '')::uuid $$;

-- sys_member_departure_apply(workspace_id, departure_id, content, recipient): applies the content choice of the departure `departure_id` to the bookmarks and
-- folders it released in the workspace the transaction acts in, in the transaction of the call, and answers what it did. It is entered in src/system/registry.ts.
-- slugbase_app has no privilege to change the owner of a row, to delete a bookmark or to lower workspaces.bookmark_count, and the rows are no longer the caller's:
-- the function runs as slugbase_system. The workspace must be the one the transaction acts in (app_workspace_id(), with an account set), as in the other
-- operations of the tenant transaction, and the account must be the recipient (app_account_id() = p_recipient, as the worker's delivery acts), so a session of
-- another member cannot hand a departure's content to someone else; a workspace that is being deleted or is gone changes nothing. The workspace row is locked first (FOR NO KEY UPDATE),
-- the lock the removal of a member takes, so a departure's content and a concurrent removal or leave queue on it. Only rows with owner_id NULL and the departure's
-- identifier are touched: a member who joined again has an owner on every row of theirs, and the content of another departure carries another identifier.
--   'transfer': when the recipient is a member of the workspace, every released folder and bookmark gets the recipient as owner and loses its departure_id. The
--     slug and forwarding a bookmark had when the departure released it, and the name a folder had, are the ones judged: the release triggers (src/sql/530 and 560)
--     may have taken them to keep the ownerless namespace unique and keep the originals in departure_slug, departure_forwarding and departure_name, which are given back
--     and cleared here. A bookmark whose slug the recipient already owns has the slug cleared and forwarding turned off; a folder whose name the recipient already has
--     gets the name `<name> (<n>)` with the lowest n >= 2 the recipient has no folder of (the base cut so that the result is at most 64 characters), in the order of
--     the folders' creation. The shares on the content are keyed by the bookmark and folder and stay as they were, and so do the filings. When the recipient is no
--     member any more, no row moves: the content loses its departure_id and the saved originals and stays ownerless as the release left it, with the slug cleared and the
--     name changed where an ownerless row held them, so it obeys the ownerless uniqueness like the content of a deleted account does.
--   'delete': the released bookmarks and folders are deleted with what references them by foreign key (shares, filings, tag links, remembered go choices), and the
--     counter of the workspace falls by the deleted bookmarks that were not plan-archived, in the same call.
-- A second call for the same departure finds no row and changes nothing. Any other content value, or a NULL argument, is refused with invalid_parameter_value.
CREATE OR REPLACE FUNCTION public.sys_member_departure_apply(
  p_workspace_id uuid, p_departure_id uuid, p_content text, p_recipient uuid,
  OUT bookmarks_moved integer, OUT folders_moved integer, OUT slugs_cleared integer, OUT folders_renamed integer,
  OUT bookmarks_deleted integer, OUT folders_deleted integer, OUT left_ownerless integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_released integer;
  v_folder record;
  v_base text;
  v_candidate text;
  v_suffix text;
  v_n integer;
BEGIN
  IF p_workspace_id IS NULL OR p_departure_id IS NULL OR p_content IS NULL OR p_recipient IS NULL OR p_content NOT IN ('transfer', 'delete') THEN
    RAISE EXCEPTION 'sys_member_departure_apply needs a workspace, a departure, a content choice of transfer or delete and a recipient'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  bookmarks_moved := 0;
  folders_moved := 0;
  slugs_cleared := 0;
  folders_renamed := 0;
  bookmarks_deleted := 0;
  folders_deleted := 0;
  left_ownerless := 0;
  IF public.app_account_id() IS DISTINCT FROM p_recipient OR public.app_workspace_id() IS DISTINCT FROM p_workspace_id THEN
    RETURN;
  END IF;
  PERFORM 1 FROM public.workspaces w
  WHERE w.id = p_workspace_id AND w.deleting_at IS NULL
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF p_content = 'delete' THEN
    WITH deleted AS (
      DELETE FROM public.bookmarks b
      WHERE b.workspace_id = p_workspace_id AND b.owner_id IS NULL AND b.departure_id = p_departure_id
      RETURNING b.plan_archived_at
    )
    SELECT count(*), count(*) FILTER (WHERE d.plan_archived_at IS NULL) INTO bookmarks_deleted, v_released FROM deleted d;
    IF v_released > 0 THEN
      UPDATE public.workspaces SET bookmark_count = bookmark_count - v_released WHERE id = p_workspace_id;
    END IF;
    WITH deleted AS (
      DELETE FROM public.folders f
      WHERE f.workspace_id = p_workspace_id AND f.owner_id IS NULL AND f.departure_id = p_departure_id
      RETURNING f.id
    )
    SELECT count(*) INTO folders_deleted FROM deleted;
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.workspace_id = p_workspace_id AND m.account_id = p_recipient) THEN
    WITH kept AS (
      UPDATE public.bookmarks b SET departure_id = NULL, departure_slug = NULL, departure_forwarding = NULL
      WHERE b.workspace_id = p_workspace_id AND b.owner_id IS NULL AND b.departure_id = p_departure_id
      RETURNING b.id
    )
    SELECT count(*) INTO left_ownerless FROM kept;
    WITH kept AS (
      UPDATE public.folders f SET departure_id = NULL, departure_name = NULL
      WHERE f.workspace_id = p_workspace_id AND f.owner_id IS NULL AND f.departure_id = p_departure_id
      RETURNING f.id
    )
    SELECT count(*) + left_ownerless INTO left_ownerless FROM kept;
    RETURN;
  END IF;

  FOR v_folder IN
    SELECT f.id, coalesce(f.departure_name, f.name) AS name FROM public.folders f
    WHERE f.workspace_id = p_workspace_id AND f.owner_id IS NULL AND f.departure_id = p_departure_id
    ORDER BY f.created_at, f.id
    FOR UPDATE
  LOOP
    v_base := v_folder.name::text;
    v_candidate := v_base;
    v_n := 2;
    WHILE EXISTS (
      SELECT 1 FROM public.folders g
      WHERE g.workspace_id = p_workspace_id AND g.owner_id = p_recipient AND g.name = v_candidate::citext
    ) LOOP
      v_suffix := ' (' || v_n::text || ')';
      v_candidate := rtrim(left(v_base, 64 - length(v_suffix))) || v_suffix;
      v_n := v_n + 1;
    END LOOP;
    UPDATE public.folders SET owner_id = p_recipient, departure_id = NULL, departure_name = NULL, name = v_candidate WHERE id = v_folder.id;
    folders_moved := folders_moved + 1;
    IF v_candidate <> v_base THEN
      folders_renamed := folders_renamed + 1;
    END IF;
  END LOOP;

  WITH released AS (
    SELECT b.id,
           coalesce(b.slug, b.departure_slug) AS slug,
           CASE WHEN b.departure_slug IS NOT NULL THEN b.departure_forwarding ELSE b.forwarding END AS forwarding,
           coalesce(b.slug, b.departure_slug) IS NOT NULL AND EXISTS (
             SELECT 1 FROM public.bookmarks r WHERE r.workspace_id = b.workspace_id AND r.owner_id = p_recipient AND r.slug = coalesce(b.slug, b.departure_slug)) AS clash
    FROM public.bookmarks b
    WHERE b.workspace_id = p_workspace_id AND b.owner_id IS NULL AND b.departure_id = p_departure_id
    ORDER BY b.id
    FOR UPDATE OF b
  ),
  moved AS (
    UPDATE public.bookmarks b
    SET owner_id = p_recipient,
        departure_id = NULL,
        departure_slug = NULL,
        departure_forwarding = NULL,
        slug = CASE WHEN r.clash THEN NULL ELSE r.slug END,
        forwarding = CASE WHEN r.clash THEN false ELSE r.forwarding END
    FROM released r
    WHERE b.id = r.id
    RETURNING r.clash
  )
  SELECT count(*), count(*) FILTER (WHERE m.clash) INTO bookmarks_moved, slugs_cleared FROM moved m;
  RETURN;
END
$$;

ALTER FUNCTION public.sys_member_departure_apply(uuid, uuid, text, uuid) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_member_departure_apply(uuid, uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_member_departure_apply(uuid, uuid, text, uuid) TO slugbase_app;
