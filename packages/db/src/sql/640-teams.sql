-- Row-level security, privileges and triggers of teams and team_members (doc 05 section 2.3, doc 02 section 4, doc 10 T1 and T2). The tables
-- are defined in src/schema/teams.ts.
--
-- teams: the teams of the active workspace, readable by every member (the share picker lists them). The policies name the workspace only: a
-- team belongs to the workspace and to no member, and who may create, change and delete one is the operations' rule (an admin, with the
-- `teams.manage` entitlement, which the server checks before a handler runs). slugbase_app may insert the columns a creation gives a team and
-- update the name and the description (a column grant: the workspace of a team never moves); it may delete a team, and its memberships go with
-- it by foreign key. The version and the timestamps are the triggers' alone. slugbase_system, which bypasses the policies, gets the privileges
-- the workspace deletion needs.

-- teams_bump_version(): the version of a team, the ETag of doc 04 section 2.4, moves by one with every update that changes the name or the
-- description and stays for one that writes the values the row has. The name is compared as text: `citext` calls "Design" and "design" equal,
-- but a change of the case is a change a member sees. The trigger overwrites whatever the statement wrote to version, so no role sets the
-- version of a row. It runs with the privileges of the session that writes the row.
CREATE OR REPLACE FUNCTION public.teams_bump_version() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (NEW.name::text, NEW.description) IS DISTINCT FROM (OLD.name::text, OLD.description) THEN
    NEW.version := OLD.version + 1;
  ELSE
    NEW.version := OLD.version;
  END IF;
  RETURN NEW;
END
$$;

ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teams FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS teams_tenant ON public.teams;
CREATE POLICY teams_tenant ON public.teams FOR SELECT
  USING (workspace_id = public.app_workspace_id());
DROP POLICY IF EXISTS teams_tenant_insert ON public.teams;
CREATE POLICY teams_tenant_insert ON public.teams FOR INSERT
  WITH CHECK (workspace_id = public.app_workspace_id());
DROP POLICY IF EXISTS teams_tenant_update ON public.teams;
CREATE POLICY teams_tenant_update ON public.teams FOR UPDATE
  USING (workspace_id = public.app_workspace_id())
  WITH CHECK (workspace_id = public.app_workspace_id());
DROP POLICY IF EXISTS teams_tenant_delete ON public.teams;
CREATE POLICY teams_tenant_delete ON public.teams FOR DELETE
  USING (workspace_id = public.app_workspace_id());
REVOKE ALL ON TABLE public.teams FROM PUBLIC, slugbase_app;
GRANT SELECT, DELETE ON TABLE public.teams TO slugbase_app;
GRANT INSERT (id, workspace_id, name, description) ON TABLE public.teams TO slugbase_app;
GRANT UPDATE (name, description) ON TABLE public.teams TO slugbase_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.teams TO slugbase_system;
CREATE OR REPLACE TRIGGER teams_bump_version
  BEFORE UPDATE ON public.teams
  FOR EACH ROW EXECUTE FUNCTION public.teams_bump_version();
CREATE OR REPLACE TRIGGER teams_set_updated_at
  BEFORE UPDATE ON public.teams
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- team_members: the members of a team, readable by every member of the workspace. The policies name the workspace; the operation that replaces
-- a team's member set is an admin's, and the foreign key to workspace_members keeps a row to a current member of the same workspace.
-- slugbase_app may read, insert and delete memberships; there is nothing to update.
ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_members FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS team_members_tenant ON public.team_members;
CREATE POLICY team_members_tenant ON public.team_members FOR SELECT
  USING (workspace_id = public.app_workspace_id());
DROP POLICY IF EXISTS team_members_tenant_insert ON public.team_members;
CREATE POLICY team_members_tenant_insert ON public.team_members FOR INSERT
  WITH CHECK (workspace_id = public.app_workspace_id());
DROP POLICY IF EXISTS team_members_tenant_delete ON public.team_members;
CREATE POLICY team_members_tenant_delete ON public.team_members FOR DELETE
  USING (workspace_id = public.app_workspace_id());
REVOKE ALL ON TABLE public.team_members FROM PUBLIC, slugbase_app;
GRANT SELECT, DELETE ON TABLE public.team_members TO slugbase_app;
GRANT INSERT (workspace_id, team_id, account_id) ON TABLE public.team_members TO slugbase_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.team_members TO slugbase_system;
