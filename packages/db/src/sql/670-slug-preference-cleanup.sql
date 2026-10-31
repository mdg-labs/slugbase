-- The remembered choices of members who can no longer read the bookmark (doc 02 sections 3.6, 6.4 and 8.3, doc 05 sections 2.5 and 2.6, doc 10 T2). A choice in slug_preferences
-- names a bookmark; the resolution of a slug and the Forwarding page already ignore one whose bookmark the member cannot read (src/repositories/go.ts), and this file deletes
-- it when the access ends, in the transaction that ends it, so no row outlives the access it was made through. A member keeps a choice for as long as they read the bookmark by
-- any route: as its owner, through a share with them, through a share with a team they are in, or through a shared folder it is filed in.
--
-- The access of a member ends by deleting a row of one of four tables, whichever statement does it: a revoked share (bookmark_shares, folder_shares), a member taken out of a team
-- or a deleted team (team_members), a bookmark taken out of a folder or a deleted folder (folder_bookmarks), and the cascades of a member who leaves (their received shares and
-- their team memberships) and of a deleted bookmark, team or folder. Each of the four has a deferred constraint trigger, which fires for each deleted row at the end of the
-- transaction that deleted it, once every statement and cascade of the change has run, and deletes the choices the row may have given access to that no route reads any more:
--   bookmark_shares and folder_bookmarks: the choices for the row's bookmark.
--   folder_shares: the choices for the bookmarks filed in the row's folder.
--   team_members: the choices of the row's account.
-- The trigger therefore judges the state the transaction leaves, and not a state between two statements of a cascade, whose order the foreign keys decide; a route that the same
-- transaction takes away by another row is judged by that row's trigger as well, so a choice survives only while a route reads its bookmark at the commit. An update of a row of
-- these tables (only slugbase_system writes them) is judged by the row as it was.
--
-- slug_preferences_forget_unreadable() is entered in src/system/registry.ts. It runs as slugbase_system because the policy of slug_preferences lets slugbase_app delete only the
-- choices of its own account, and the trigger deletes those of other members. It reads and deletes in the workspace of the changed row and touches no other table.
-- slug_preference_bookmark_readable() states the access rule of bookmarkReadableBy in src/repositories/bookmark-access.ts in SQL, as the system operations of src/sql/580, 590 and
-- 600 do; the rules are changed together. It is not a system operation: it runs with the privileges of its caller, so a session of slugbase_app that calls it reads what its own policies show.
-- slugbase_owner creates the functions and hands the trigger function to slugbase_system, which needs CREATE on the schema for the length of that statement.
GRANT CREATE ON SCHEMA public TO slugbase_system;

CREATE OR REPLACE FUNCTION public.slug_preference_bookmark_readable(p_workspace_id uuid, p_account_id uuid, p_bookmark_id uuid) RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.bookmarks b
      WHERE b.workspace_id = p_workspace_id AND b.id = p_bookmark_id
        AND (b.owner_id = p_account_id
             OR EXISTS (
               SELECT 1 FROM public.bookmark_shares s
               WHERE s.workspace_id = b.workspace_id AND s.bookmark_id = b.id AND s.target_account_id = p_account_id)
             OR EXISTS (
               SELECT 1 FROM public.bookmark_shares s
               WHERE s.workspace_id = b.workspace_id AND s.bookmark_id = b.id
                 AND s.target_team_id IN (SELECT t.team_id FROM public.team_members t WHERE t.workspace_id = b.workspace_id AND t.account_id = p_account_id))
             OR EXISTS (
               SELECT 1 FROM public.folder_bookmarks fb JOIN public.folder_shares fs ON fs.workspace_id = fb.workspace_id AND fs.folder_id = fb.folder_id
               WHERE fb.workspace_id = b.workspace_id AND fb.bookmark_id = b.id AND fs.target_account_id = p_account_id)
             OR EXISTS (
               SELECT 1 FROM public.folder_bookmarks fb JOIN public.folder_shares fs ON fs.workspace_id = fb.workspace_id AND fs.folder_id = fb.folder_id
               WHERE fb.workspace_id = b.workspace_id AND fb.bookmark_id = b.id
                 AND fs.target_team_id IN (SELECT t.team_id FROM public.team_members t WHERE t.workspace_id = b.workspace_id AND t.account_id = p_account_id))))
  $$;

-- slug_preferences_forget_unreadable(): the trigger function of the four triggers below. A choice whose bookmark is gone is not here: it goes with its bookmark by foreign key.
CREATE OR REPLACE FUNCTION public.slug_preferences_forget_unreadable() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF TG_TABLE_NAME = 'bookmark_shares' OR TG_TABLE_NAME = 'folder_bookmarks' THEN
    DELETE FROM public.slug_preferences p
    WHERE p.workspace_id = OLD.workspace_id AND p.bookmark_id = OLD.bookmark_id
      AND NOT public.slug_preference_bookmark_readable(p.workspace_id, p.account_id, p.bookmark_id);
  ELSIF TG_TABLE_NAME = 'folder_shares' THEN
    DELETE FROM public.slug_preferences p
    WHERE p.workspace_id = OLD.workspace_id
      AND p.bookmark_id IN (SELECT fb.bookmark_id FROM public.folder_bookmarks fb WHERE fb.workspace_id = OLD.workspace_id AND fb.folder_id = OLD.folder_id)
      AND NOT public.slug_preference_bookmark_readable(p.workspace_id, p.account_id, p.bookmark_id);
  ELSIF TG_TABLE_NAME = 'team_members' THEN
    DELETE FROM public.slug_preferences p
    WHERE p.workspace_id = OLD.workspace_id AND p.account_id = OLD.account_id
      AND NOT public.slug_preference_bookmark_readable(p.workspace_id, p.account_id, p.bookmark_id);
  END IF;
  RETURN NULL;
END
$$;

ALTER FUNCTION public.slug_preferences_forget_unreadable() OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.slug_preferences_forget_unreadable() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.slug_preferences_forget_unreadable() TO slugbase_app;

DROP TRIGGER IF EXISTS bookmark_shares_forget_preferences ON public.bookmark_shares;
CREATE CONSTRAINT TRIGGER bookmark_shares_forget_preferences
  AFTER DELETE OR UPDATE ON public.bookmark_shares
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.slug_preferences_forget_unreadable();
DROP TRIGGER IF EXISTS folder_shares_forget_preferences ON public.folder_shares;
CREATE CONSTRAINT TRIGGER folder_shares_forget_preferences
  AFTER DELETE OR UPDATE ON public.folder_shares
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.slug_preferences_forget_unreadable();
DROP TRIGGER IF EXISTS folder_bookmarks_forget_preferences ON public.folder_bookmarks;
CREATE CONSTRAINT TRIGGER folder_bookmarks_forget_preferences
  AFTER DELETE OR UPDATE ON public.folder_bookmarks
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.slug_preferences_forget_unreadable();
DROP TRIGGER IF EXISTS team_members_forget_preferences ON public.team_members;
CREATE CONSTRAINT TRIGGER team_members_forget_preferences
  AFTER DELETE OR UPDATE ON public.team_members
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.slug_preferences_forget_unreadable();
