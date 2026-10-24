-- Row-level security and privileges of tags and bookmark_tags (doc 05 section 2.4, doc 02 section 7.2, doc 10 T2). The tables are
-- defined in src/schema/tags.ts.
--
-- tags: a member's own tags of the active workspace. The policies name the owner as well as the workspace, so the database itself
-- hides a tag from every other member of the workspace: a statement that forgot the owner's predicate reads, renames and deletes
-- nothing of anyone else's. slugbase_app may insert the columns a creation gives a tag and rename (update `name`); it may delete a
-- tag, and the links of the tag go with it by foreign key. slugbase_system, which bypasses the policies, gets the privileges the
-- workspace deletion needs.
ALTER TABLE public.tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tags FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tags_tenant ON public.tags;
CREATE POLICY tags_tenant ON public.tags FOR SELECT
  USING (workspace_id = public.app_workspace_id() AND owner_id = public.app_account_id());
DROP POLICY IF EXISTS tags_tenant_insert ON public.tags;
CREATE POLICY tags_tenant_insert ON public.tags FOR INSERT
  WITH CHECK (workspace_id = public.app_workspace_id() AND owner_id = public.app_account_id());
DROP POLICY IF EXISTS tags_tenant_update ON public.tags;
CREATE POLICY tags_tenant_update ON public.tags FOR UPDATE
  USING (workspace_id = public.app_workspace_id() AND owner_id = public.app_account_id())
  WITH CHECK (workspace_id = public.app_workspace_id() AND owner_id = public.app_account_id());
DROP POLICY IF EXISTS tags_tenant_delete ON public.tags;
CREATE POLICY tags_tenant_delete ON public.tags FOR DELETE
  USING (workspace_id = public.app_workspace_id() AND owner_id = public.app_account_id());
REVOKE ALL ON TABLE public.tags FROM PUBLIC, slugbase_app;
GRANT SELECT, DELETE ON TABLE public.tags TO slugbase_app;
GRANT INSERT (id, workspace_id, owner_id, name) ON TABLE public.tags TO slugbase_app;
GRANT UPDATE (name) ON TABLE public.tags TO slugbase_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tags TO slugbase_system;

-- bookmark_tags: the links between a bookmark and a tag. A link is visible when the tag it names is the caller's own tag of the
-- active workspace (the same predicate as the tag's, read through the tag), so no member sees another's links either. slugbase_app
-- may read the table, which the counts of the tags need; the operations that attach and detach tags grant what they write.
ALTER TABLE public.bookmark_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bookmark_tags FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bookmark_tags_tenant ON public.bookmark_tags;
CREATE POLICY bookmark_tags_tenant ON public.bookmark_tags FOR SELECT
  USING (
    workspace_id = public.app_workspace_id()
    AND EXISTS (
      SELECT 1 FROM public.tags t
      WHERE t.workspace_id = bookmark_tags.workspace_id AND t.id = bookmark_tags.tag_id AND t.owner_id = public.app_account_id()
    )
  );
REVOKE ALL ON TABLE public.bookmark_tags FROM PUBLIC, slugbase_app;
GRANT SELECT ON TABLE public.bookmark_tags TO slugbase_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.bookmark_tags TO slugbase_system;
