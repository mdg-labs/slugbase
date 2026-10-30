-- What a member's folders are called when the membership ends (doc 05 sections 2.4 and 7.1, doc 02 sections 3.5 and 3.6, doc 10 T2).
-- folders.owner_id is cleared by the foreign key to workspace_members (ON DELETE SET NULL (owner_id)), which moves the folders of the
-- departing member into the one namespace of the ownerless folders of the workspace, so a folder whose name an ownerless folder already
-- has would break folders_owner_name_key. Every statement that deletes a membership row (the removal of a member, a member leaving, the
-- deletion of an account by its owner or by an instance admin, the purge of a workspace) clears the owner by that foreign key, and the
-- trigger below renames the folder in the same UPDATE, so the rule has one place and a path that deletes the row directly cannot skip it.
-- folders_rename_on_release() is entered in src/system/registry.ts. slugbase_owner creates the function and hands it to slugbase_system,
-- which needs CREATE on the schema for the length of that statement.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- folders_rename_on_release(): the trigger function. It runs before a row of folders is updated, and acts when the update takes the
-- owner away (OLD.owner_id is set and NEW.owner_id is NULL): when an ownerless folder of the workspace has the name of the folder,
-- without regard to case, the folder is given the name `<name> (<n>)` with the lowest n >= 2 that no ownerless folder has. The base name
-- is cut so that the result is at most 64 characters, and a space the cut leaves at the end of the base is dropped. Only the name
-- changes: the icon, the colour, the filings of the folder and the bookmarks are not touched, and the version moves with the owner.
-- Folders of one member that are released by one statement are judged one after the other, each against the ownerless folders the
-- ones before it have made. The same update records the departure that released the folder (departure_id, from app_departure_id() of
-- src/sql/680-member-departure.sql), which is null when the statement named none, so the worker can tell the folders of one departure
-- from every other ownerless folder when it applies the content choice. When that departure's folder is renamed, the name it had is kept in
-- departure_name, so a transfer to the recipient starts from that name and not from the one the ownerless namespace forced on it.
--
-- The names of the ownerless folders change only here, so two departures from one workspace that run at once would each read the
-- ownerless folders without the other's rename and both choose the same name. The function therefore takes the lock of the
-- workspace's row first (the lock the owner trigger, the role changes and the deletion of the workspace take), and the second
-- transaction waits until the first has committed: the statements that follow read what it committed (the function is VOLATILE and
-- the transaction READ COMMITTED). A workspace row that the transaction deleted itself is not there to lock, and nothing then races
-- for its folders. The function runs as slugbase_system so that it reads every folder of the workspace whatever the row-level security
-- of the caller shows, and the foreign key's own session needs no privilege on it; it reads the folders of NEW.workspace_id only.
CREATE OR REPLACE FUNCTION public.folders_rename_on_release() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_suffix text;
  v_candidate text;
  v_n integer := 2;
BEGIN
  IF OLD.owner_id IS NULL OR NEW.owner_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  NEW.departure_id := public.app_departure_id();
  NEW.departure_name := NULL;
  PERFORM 1 FROM public.workspaces w WHERE w.id = NEW.workspace_id FOR NO KEY UPDATE;
  IF NOT EXISTS (
    SELECT 1 FROM public.folders g
    WHERE g.workspace_id = NEW.workspace_id AND g.owner_id IS NULL AND g.id <> NEW.id AND g.name = NEW.name) THEN
    RETURN NEW;
  END IF;
  LOOP
    v_suffix := ' (' || v_n::text || ')';
    v_candidate := rtrim(left(NEW.name::text, 64 - length(v_suffix))) || v_suffix;
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM public.folders g
      WHERE g.workspace_id = NEW.workspace_id AND g.owner_id IS NULL AND g.id <> NEW.id AND g.name = v_candidate::citext);
    v_n := v_n + 1;
  END LOOP;
  IF NEW.departure_id IS NOT NULL THEN
    NEW.departure_name := NEW.name;
  END IF;
  NEW.name := v_candidate;
  RETURN NEW;
END
$$;

ALTER FUNCTION public.folders_rename_on_release() OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.folders_rename_on_release() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.folders_rename_on_release() TO slugbase_app;

CREATE OR REPLACE TRIGGER folders_release_name
  BEFORE UPDATE ON public.folders
  FOR EACH ROW EXECUTE FUNCTION public.folders_rename_on_release();
