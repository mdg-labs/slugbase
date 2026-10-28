-- Row-level security and privileges of url_metadata (doc 05 sections 2.7 and 3.2, doc 02 section 5.4, doc 10 section 5 and T1). The table is
-- defined in src/schema/url-metadata.ts.
--
-- The cache is per workspace: the policy names the workspace of the transaction, for reads and writes, so the database itself hides a workspace's
-- rows from every other workspace and refuses a row written for another. slugbase_app may read the table and write what the fetch job stores: it
-- inserts a row and replaces the status and fields of one in the same statement (INSERT ... ON CONFLICT DO UPDATE). It cannot delete: an expired
-- row is deleted by sys_retention_purge (110-retention-purge.sql) and a workspace's rows by sys_workspace_purge_batch (280-workspace-deletion.sql),
-- both of which run as slugbase_system, which bypasses the policy and holds the privileges they need.
ALTER TABLE public.url_metadata ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.url_metadata FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS url_metadata_tenant ON public.url_metadata;
CREATE POLICY url_metadata_tenant ON public.url_metadata
  USING (workspace_id = public.app_workspace_id())
  WITH CHECK (workspace_id = public.app_workspace_id());
REVOKE ALL ON TABLE public.url_metadata FROM PUBLIC, slugbase_app;
GRANT SELECT, INSERT ON TABLE public.url_metadata TO slugbase_app;
GRANT UPDATE (status, title, description, site_name, canonical_url, language, fetched_at, expires_at) ON TABLE public.url_metadata TO slugbase_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.url_metadata TO slugbase_system;
