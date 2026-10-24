-- Row-level security, privileges and triggers of folders and folder_bookmarks (doc 05 section 2.4, doc 02 section 7.1, doc 10 T1 and
-- T2). The tables are defined in src/schema/folders.ts.
--
-- folders: the folders of the active workspace. The policies name the workspace only, as those of bookmarks do, since a later sharing
-- grant lets a recipient read a folder that is not theirs; whose folder a member may read or change is the repository's rule, which
-- names the owner in every statement (doc 10 T2). slugbase_app may insert the columns a creation gives a folder and update the name,
-- the icon and the colour (a column grant: the owner and the workspace of a folder never move); it may delete a folder, and the
-- associations of its bookmarks go with it by foreign key. The version and the timestamps are the triggers' alone. slugbase_system,
-- which bypasses the policies, gets the privileges the workspace deletion and the system operations need.

-- folders_bump_version(): the version of a folder, the ETag of doc 04 section 2.4, moves by one with every update that changes what a
-- member sees or edits (the owner, the name, the icon and the colour) and stays for one that writes the values the row has. The name is
-- compared as text: `citext` calls "Reading" and "reading" equal, but a change of the case is a change a member sees. The trigger
-- overwrites whatever the statement wrote to version, so no role sets the version of a row. It runs with the privileges of the session
-- that writes the row.
CREATE OR REPLACE FUNCTION public.folders_bump_version() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (NEW.owner_id, NEW.name::text, NEW.icon, NEW.color) IS DISTINCT FROM (OLD.owner_id, OLD.name::text, OLD.icon, OLD.color) THEN
    NEW.version := OLD.version + 1;
  ELSE
    NEW.version := OLD.version;
  END IF;
  RETURN NEW;
END
$$;

ALTER TABLE public.folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.folders FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS folders_tenant ON public.folders;
CREATE POLICY folders_tenant ON public.folders FOR SELECT
  USING (workspace_id = public.app_workspace_id());
DROP POLICY IF EXISTS folders_tenant_insert ON public.folders;
CREATE POLICY folders_tenant_insert ON public.folders FOR INSERT
  WITH CHECK (workspace_id = public.app_workspace_id());
DROP POLICY IF EXISTS folders_tenant_update ON public.folders;
CREATE POLICY folders_tenant_update ON public.folders FOR UPDATE
  USING (workspace_id = public.app_workspace_id())
  WITH CHECK (workspace_id = public.app_workspace_id());
DROP POLICY IF EXISTS folders_tenant_delete ON public.folders;
CREATE POLICY folders_tenant_delete ON public.folders FOR DELETE
  USING (workspace_id = public.app_workspace_id());
REVOKE ALL ON TABLE public.folders FROM PUBLIC, slugbase_app;
GRANT SELECT, DELETE ON TABLE public.folders TO slugbase_app;
GRANT INSERT (id, workspace_id, owner_id, name, icon, color) ON TABLE public.folders TO slugbase_app;
GRANT UPDATE (name, icon, color) ON TABLE public.folders TO slugbase_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.folders TO slugbase_system;
CREATE OR REPLACE TRIGGER folders_bump_version
  BEFORE UPDATE ON public.folders
  FOR EACH ROW EXECUTE FUNCTION public.folders_bump_version();
CREATE OR REPLACE TRIGGER folders_set_updated_at
  BEFORE UPDATE ON public.folders
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- folder_bookmarks: the bookmarks filed in a folder. The policy names the workspace; slugbase_app may read the table, which the counts of
-- the folders need, and the operations that file and unfile bookmarks grant what they write.
ALTER TABLE public.folder_bookmarks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.folder_bookmarks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS folder_bookmarks_tenant ON public.folder_bookmarks;
CREATE POLICY folder_bookmarks_tenant ON public.folder_bookmarks FOR SELECT
  USING (workspace_id = public.app_workspace_id());
REVOKE ALL ON TABLE public.folder_bookmarks FROM PUBLIC, slugbase_app;
GRANT SELECT ON TABLE public.folder_bookmarks TO slugbase_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.folder_bookmarks TO slugbase_system;
