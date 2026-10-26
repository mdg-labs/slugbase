-- Tagging and untagging bookmarks (doc 05 section 2.4, doc 02 sections 7.2 and 8.2, doc 13 Q22, doc 10 T1 and T2). The table bookmark_tags is
-- defined in src/schema/tags.ts and given its read policy in 510-tags.sql; this file grants what the operations that attach and detach tags write.
--
-- slugbase_app may insert the three columns that name a link and delete a link; it may not update one, since a link has nothing to change. A
-- link is the owner's alone: the policies below admit a link only when the tag and the bookmark it names are both owned by the account of the
-- transaction in the active workspace, so the database itself refuses a statement that tags someone else's bookmark, attaches someone else's
-- tag or removes a link of someone else's, whatever the application passed. The composite foreign keys already keep a link from joining a
-- bookmark and a tag of different workspaces. A recipient of a share tags nothing (Q22), because it does not own the bookmark, and a member
-- never sees another member's tags: the existing read policy of the table shows a link through the caller's own tag only.
DROP POLICY IF EXISTS bookmark_tags_tenant_insert ON public.bookmark_tags;
CREATE POLICY bookmark_tags_tenant_insert ON public.bookmark_tags FOR INSERT
  WITH CHECK (
    workspace_id = public.app_workspace_id()
    AND EXISTS (
      SELECT 1 FROM public.tags t
      WHERE t.workspace_id = bookmark_tags.workspace_id AND t.id = bookmark_tags.tag_id AND t.owner_id = public.app_account_id()
    )
    AND EXISTS (
      SELECT 1 FROM public.bookmarks b
      WHERE b.workspace_id = bookmark_tags.workspace_id AND b.id = bookmark_tags.bookmark_id AND b.owner_id = public.app_account_id()
    )
  );
DROP POLICY IF EXISTS bookmark_tags_tenant_delete ON public.bookmark_tags;
CREATE POLICY bookmark_tags_tenant_delete ON public.bookmark_tags FOR DELETE
  USING (
    workspace_id = public.app_workspace_id()
    AND EXISTS (
      SELECT 1 FROM public.tags t
      WHERE t.workspace_id = bookmark_tags.workspace_id AND t.id = bookmark_tags.tag_id AND t.owner_id = public.app_account_id()
    )
    AND EXISTS (
      SELECT 1 FROM public.bookmarks b
      WHERE b.workspace_id = bookmark_tags.workspace_id AND b.id = bookmark_tags.bookmark_id AND b.owner_id = public.app_account_id()
    )
  );
GRANT INSERT (workspace_id, bookmark_id, tag_id) ON TABLE public.bookmark_tags TO slugbase_app;
GRANT DELETE ON TABLE public.bookmark_tags TO slugbase_app;
