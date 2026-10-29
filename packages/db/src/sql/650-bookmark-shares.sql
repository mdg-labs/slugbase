-- Row-level security and privileges of bookmark_shares (doc 05 section 2.5, doc 02 section 8, doc 10 T1 and T2). The table is defined in
-- src/schema/shares.ts.
--
-- bookmark_shares: the grants of read access to bookmarks of the active workspace. A share is read through the workspace: the policy names
-- the workspace only, because a recipient reads the shares addressed to it to learn what it may open, and who may list the shares of a
-- bookmark (its owner, doc 02 section 8.2) is the repository's rule. A share is written by the owner of its bookmark and by no one else:
-- the insert and the delete policies admit a row only when the bookmark it names is owned by app_account_id() in the workspace, and an
-- insert records its author, so a share is never granted for another member's bookmark or in another member's name whatever the
-- application sends. The foreign keys keep the target to a current member of the workspace or to a team of the workspace. slugbase_app
-- may read, insert the columns of a grant and delete; there is nothing to update (a share is granted or revoked). slugbase_system, which
-- bypasses the policies, gets the privileges the workspace deletion needs. A bookmark's deletion, a member's departure and a team's
-- deletion remove the shares that name them through the cascading foreign keys, which row-level security does not apply to.
ALTER TABLE public.bookmark_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bookmark_shares FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bookmark_shares_tenant ON public.bookmark_shares;
CREATE POLICY bookmark_shares_tenant ON public.bookmark_shares FOR SELECT
  USING (workspace_id = public.app_workspace_id());
DROP POLICY IF EXISTS bookmark_shares_tenant_insert ON public.bookmark_shares;
CREATE POLICY bookmark_shares_tenant_insert ON public.bookmark_shares FOR INSERT
  WITH CHECK (
    workspace_id = public.app_workspace_id()
    AND granted_by = public.app_account_id()
    AND EXISTS (
      SELECT 1 FROM public.bookmarks b
      WHERE b.workspace_id = bookmark_shares.workspace_id AND b.id = bookmark_shares.bookmark_id AND b.owner_id = public.app_account_id()
    )
  );
DROP POLICY IF EXISTS bookmark_shares_tenant_delete ON public.bookmark_shares;
CREATE POLICY bookmark_shares_tenant_delete ON public.bookmark_shares FOR DELETE
  USING (
    workspace_id = public.app_workspace_id()
    AND EXISTS (
      SELECT 1 FROM public.bookmarks b
      WHERE b.workspace_id = bookmark_shares.workspace_id AND b.id = bookmark_shares.bookmark_id AND b.owner_id = public.app_account_id()
    )
  );
REVOKE ALL ON TABLE public.bookmark_shares FROM PUBLIC, slugbase_app;
GRANT SELECT, DELETE ON TABLE public.bookmark_shares TO slugbase_app;
GRANT INSERT (id, workspace_id, bookmark_id, target_account_id, target_team_id, granted_by) ON TABLE public.bookmark_shares TO slugbase_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.bookmark_shares TO slugbase_system;
