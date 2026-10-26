-- Filing and unfiling bookmarks (doc 05 section 2.4, doc 02 sections 7.1 and 8.2, doc 13 Q22, doc 10 T1 and T2). The table folder_bookmarks is
-- defined in src/schema/folders.ts and given its read policy in 520-folders.sql; this file grants what the operations that file and unfile
-- bookmarks write.
--
-- slugbase_app may insert the three columns that name a link (added_at is the column default) and delete a link; it may not update one, since
-- a link has nothing to change. A link is the owner's alone: the policies below admit a link only when the folder and the bookmark it names are
-- both owned by the account of the transaction in the active workspace, so the database itself refuses a statement that files someone else's
-- bookmark, files into someone else's folder or removes a link of someone else's, whatever the application passed. The composite foreign keys
-- already keep a link from joining a folder and a bookmark of different workspaces. A recipient of a share files nothing (Q22), because it
-- owns neither side.
DROP POLICY IF EXISTS folder_bookmarks_tenant_insert ON public.folder_bookmarks;
CREATE POLICY folder_bookmarks_tenant_insert ON public.folder_bookmarks FOR INSERT
  WITH CHECK (
    workspace_id = public.app_workspace_id()
    AND EXISTS (
      SELECT 1 FROM public.folders f
      WHERE f.workspace_id = folder_bookmarks.workspace_id AND f.id = folder_bookmarks.folder_id AND f.owner_id = public.app_account_id()
    )
    AND EXISTS (
      SELECT 1 FROM public.bookmarks b
      WHERE b.workspace_id = folder_bookmarks.workspace_id AND b.id = folder_bookmarks.bookmark_id AND b.owner_id = public.app_account_id()
    )
  );
DROP POLICY IF EXISTS folder_bookmarks_tenant_delete ON public.folder_bookmarks;
CREATE POLICY folder_bookmarks_tenant_delete ON public.folder_bookmarks FOR DELETE
  USING (
    workspace_id = public.app_workspace_id()
    AND EXISTS (
      SELECT 1 FROM public.folders f
      WHERE f.workspace_id = folder_bookmarks.workspace_id AND f.id = folder_bookmarks.folder_id AND f.owner_id = public.app_account_id()
    )
    AND EXISTS (
      SELECT 1 FROM public.bookmarks b
      WHERE b.workspace_id = folder_bookmarks.workspace_id AND b.id = folder_bookmarks.bookmark_id AND b.owner_id = public.app_account_id()
    )
  );
GRANT INSERT (workspace_id, folder_id, bookmark_id) ON TABLE public.folder_bookmarks TO slugbase_app;
GRANT DELETE ON TABLE public.folder_bookmarks TO slugbase_app;
