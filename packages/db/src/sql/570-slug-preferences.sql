-- Row-level security and privileges of slug_preferences (doc 05 sections 2.6 and 3.2, doc 02 section 6.4, doc 10 T1 and T2). The table is defined in
-- src/schema/slug-preferences.ts.
--
-- A preference is its member's own, in one workspace: the policy names the workspace and the account of the transaction, for reads and writes, so the
-- database itself hides a member's preference from every other member of the workspace and from every other workspace, and refuses a row written for either,
-- whatever a statement names. slugbase_app may read the table and insert the columns a choice gives a preference; choosing another bookmark for the slug
-- replaces the bookmark (the upsert of the choice updates `bookmark_id` and nothing else). It may delete a row: the policy confines that to the member's own
-- preferences, which the member forgets (DELETE /me/go-preferences/{slug}) and which the resolution of a slug forgets when its bookmark has changed its slug,
-- stopped forwarding or can no longer be read. A preference also goes with its bookmark or its member by foreign key. slugbase_system, which bypasses the
-- policy, gets the privileges the workspace deletion needs.
ALTER TABLE public.slug_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.slug_preferences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS slug_preferences_tenant ON public.slug_preferences;
CREATE POLICY slug_preferences_tenant ON public.slug_preferences
  USING (workspace_id = public.app_workspace_id() AND account_id = public.app_account_id())
  WITH CHECK (workspace_id = public.app_workspace_id() AND account_id = public.app_account_id());
REVOKE ALL ON TABLE public.slug_preferences FROM PUBLIC, slugbase_app;
GRANT SELECT ON TABLE public.slug_preferences TO slugbase_app;
GRANT INSERT (workspace_id, account_id, slug, bookmark_id) ON TABLE public.slug_preferences TO slugbase_app;
GRANT UPDATE (bookmark_id) ON TABLE public.slug_preferences TO slugbase_app;
GRANT DELETE ON TABLE public.slug_preferences TO slugbase_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.slug_preferences TO slugbase_system;
