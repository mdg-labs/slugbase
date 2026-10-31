-- Row-level security and privileges of ai_suggestions and ai_suggestion_usage (doc 05 sections 2.8 and 3.2, doc 02 section 14, doc 10 T1 and T11). The
-- tables are defined in src/schema/ai.ts.
--
-- Both tables are a member's own in one workspace: the policies name the workspace and the account of the transaction, for reads and writes, so the
-- database itself hides a member's cached suggestion and usage rows from every other member of the workspace and from every other workspace, and
-- refuses a row written for either, whatever a statement names. slugbase_app may read ai_suggestions, insert a row and replace the result, the model and the
-- dates of one in the same statement (INSERT ... ON CONFLICT DO UPDATE); it cannot delete: an expired row is deleted by sys_retention_purge
-- (110-retention-purge.sql) and a workspace's rows by sys_workspace_purge_batch (280-workspace-deletion.sql), both of which run as slugbase_system, which
-- bypasses the policy and holds the privileges they need. ai_suggestion_usage is insert-only for slugbase_app, which also reads it; the rows hold which fields
-- came from a suggestion and no content. A member's rows also go with the member by foreign key.
ALTER TABLE public.ai_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_suggestions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_suggestions_tenant ON public.ai_suggestions;
CREATE POLICY ai_suggestions_tenant ON public.ai_suggestions
  USING (workspace_id = public.app_workspace_id() AND account_id = public.app_account_id())
  WITH CHECK (workspace_id = public.app_workspace_id() AND account_id = public.app_account_id());
REVOKE ALL ON TABLE public.ai_suggestions FROM PUBLIC, slugbase_app;
GRANT SELECT, INSERT ON TABLE public.ai_suggestions TO slugbase_app;
GRANT UPDATE (result, provider, model, created_at, expires_at) ON TABLE public.ai_suggestions TO slugbase_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ai_suggestions TO slugbase_system;

ALTER TABLE public.ai_suggestion_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_suggestion_usage FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_suggestion_usage_tenant ON public.ai_suggestion_usage;
CREATE POLICY ai_suggestion_usage_tenant ON public.ai_suggestion_usage
  USING (workspace_id = public.app_workspace_id() AND account_id = public.app_account_id())
  WITH CHECK (workspace_id = public.app_workspace_id() AND account_id = public.app_account_id());
REVOKE ALL ON TABLE public.ai_suggestion_usage FROM PUBLIC, slugbase_app;
GRANT SELECT ON TABLE public.ai_suggestion_usage TO slugbase_app;
GRANT INSERT (id, workspace_id, account_id, bookmark_id, fields_used) ON TABLE public.ai_suggestion_usage TO slugbase_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ai_suggestion_usage TO slugbase_system;
