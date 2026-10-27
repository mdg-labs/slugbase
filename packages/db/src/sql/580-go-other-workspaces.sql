-- The system operation behind the offer of other workspaces on a slug miss (doc 02 section 6.2 step 3.5, doc 04 section 10.8, doc 05 sections 3.3 and 4, doc 10 T1
-- and residual 8, Q26). It is entered in src/system/registry.ts. slugbase_owner creates the function and hands it to slugbase_system, which needs CREATE on the
-- schema for the length of that statement.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_go_other_workspaces(p_slug): the workspaces other than the one of the transaction (app_workspace_id()) of which the calling account (from
-- app_account_id(), never an argument) is a member and in which that account can read a bookmark with the slug that forwards and is not plan-archived: the
-- candidates of doc 05 section 4 in each of them, asked in the one way the resolution asks them in the active workspace (a bookmark is readable by its owner
-- today, bookmarkReadableBy in src/repositories/bookmark-access.ts; sharing extends both together). The tenant policies show the account one workspace at a time, so
-- one statement across the account's workspaces is what needs this function. It answers the identifier and the name of each workspace, ordered by name and then
-- identifier, at most 20, and nothing else of a workspace or of a bookmark: no bookmark identifier, title or address. A workspace that is being deleted is not
-- named, and nothing comes back when no account is set (outside withTenant()), when no workspace is set, when the account has no other workspace or when the
-- slug is NULL or has no such bookmark anywhere. The slug is compared as text, as the candidate scan compares it, so the lookup of each workspace is an index
-- condition of bookmarks_slug_idx. The function reads and writes nothing else.
CREATE OR REPLACE FUNCTION public.sys_go_other_workspaces(p_slug text)
  RETURNS TABLE (workspace_id uuid, workspace_name text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT w.id, w.name
    FROM public.workspace_members m
    JOIN public.workspaces w ON w.id = m.workspace_id
    WHERE m.account_id = public.app_account_id()
      AND public.app_workspace_id() IS NOT NULL
      AND m.workspace_id <> public.app_workspace_id()
      AND w.deleting_at IS NULL
      AND EXISTS (
        SELECT 1 FROM public.bookmarks b
        WHERE b.workspace_id = m.workspace_id AND b.slug = p_slug AND b.forwarding AND b.plan_archived_at IS NULL
          AND b.owner_id = m.account_id)
    ORDER BY w.name, w.id
    LIMIT 20
  $$;

ALTER FUNCTION public.sys_go_other_workspaces(text) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_go_other_workspaces(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_go_other_workspaces(text) TO slugbase_app;
