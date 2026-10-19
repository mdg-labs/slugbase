-- Row-level security and privileges of audit_events, and the workspace member counts of the
-- workspace list (doc 05 sections 2.9 and 3.3, doc 02 section 3.2, doc 10 T1). The table itself is
-- defined in src/schema/audit.ts. app_member_workspace_counts is entered in src/system/registry.ts.
-- slugbase_owner creates the function and hands it to slugbase_system, which needs CREATE on the
-- schema for the length of those statements.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- app_member_workspace_counts(): how many members each workspace of the calling account (from
-- app_account_id(), never an argument) has, for the workspaces that are not being deleted. The
-- workspace_members policy shows an account the rows of the active workspace and its own rows only,
-- so the count of every workspace in the switcher needs a function that runs as slugbase_system. It
-- answers a number per workspace the account belongs to and no member's identity. Outside
-- withTenant() the account is unset and nothing comes back.
CREATE OR REPLACE FUNCTION public.app_member_workspace_counts() RETURNS TABLE (workspace_id uuid, member_count bigint)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT m.workspace_id, count(*)
    FROM public.workspace_members m
    WHERE m.workspace_id IN (SELECT public.app_member_workspace_ids())
    GROUP BY m.workspace_id
  $$;

ALTER FUNCTION public.app_member_workspace_counts() OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.app_member_workspace_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_member_workspace_counts() TO slugbase_app;

-- audit_events: a workspace's events are read in that workspace only. An event is written in the
-- workspace the transaction acts in, or, in an account-level transaction that acts in none, in a
-- workspace the account is a member of: the workspace an account creates is not its active one yet,
-- and its creation event is written in the transaction that creates it. A transaction that acts in a
-- workspace never writes another's events, and an event with no workspace (a deployment-level one)
-- is admitted by no policy. slugbase_app holds SELECT and INSERT and nothing that changes or
-- removes a row: an event is deleted only by sys_retention_purge. slugbase_system, which bypasses
-- the policies, gets the privileges that purge needs and the INSERT of the system operations that
-- record an event no tenant policy admits, such as a deployment-level one (doc 05 section 3.3).
ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_events_tenant ON public.audit_events;
CREATE POLICY audit_events_tenant ON public.audit_events FOR SELECT
  USING (workspace_id = public.app_workspace_id());
DROP POLICY IF EXISTS audit_events_tenant_insert ON public.audit_events;
CREATE POLICY audit_events_tenant_insert ON public.audit_events FOR INSERT
  WITH CHECK (
    workspace_id = public.app_workspace_id()
    OR (public.app_workspace_id() IS NULL AND workspace_id IN (SELECT public.app_member_workspace_ids()))
  );
REVOKE ALL ON TABLE public.audit_events FROM PUBLIC, slugbase_app;
GRANT SELECT, INSERT ON TABLE public.audit_events TO slugbase_app;
GRANT SELECT, INSERT, DELETE ON TABLE public.audit_events TO slugbase_system;
