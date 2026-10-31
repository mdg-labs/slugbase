-- Row-level security, privileges and triggers of teams and team_members (doc 05 section 2.3, doc 02 section 4, doc 10 T1 and T2). The tables
-- are defined in src/schema/teams.ts.
--
-- teams: the teams of the active workspace, readable by every member (the share picker lists them). The policies name the workspace only: a
-- team belongs to the workspace and to no member, and who may create, change and delete one is the operations' rule (an admin, with the
-- `teams.manage` entitlement, which the server checks before a handler runs). slugbase_app may insert the columns a creation gives a team and
-- update the name, the description and members_version (a column grant: the workspace of a team never moves); it may delete a team, and its
-- memberships go with it by foreign key. The version and the timestamps are the triggers' alone. slugbase_system, which bypasses the policies,
-- gets the privileges the workspace deletion needs.

-- teams_bump_version(): the version of a team, the ETag of doc 04 section 2.4, moves by one with every update that changes the name, the
-- description or the member set and stays for one that writes the values the row has. The name is compared as text: `citext` calls "Design"
-- and "design" equal, but a change of the case is a change a member sees. A replacement of the member set says so by writing members_version
-- (the memberships are rows of another table, so the team's row would otherwise not change), which a replacement of the member set does itself
-- and every join of an account to the workspace does, for every team of the workspace: the acceptance of an invitation through
-- workspace_invitations_touch_teams below and an instance admin adding themselves in sys_instance_add_membership; the trigger moves it by one
-- whatever value was written, and a change of the name or the description made with it moves the version once. Every move of the version also
-- sets versioned_at to now(), the start of the transaction that moved it; the application no longer reads it, and it stays for the replicas of
-- the release before, which compare it with workspace_members.joined_at, until a later release drops the column (Q52).
-- The trigger overwrites whatever the statement wrote to version and versioned_at, so no role sets either. It runs with the privileges of the
-- session that writes the row.
CREATE OR REPLACE FUNCTION public.teams_bump_version() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.members_version IS DISTINCT FROM OLD.members_version THEN
    NEW.members_version := OLD.members_version + 1;
    NEW.version := OLD.version + 1;
    NEW.versioned_at := now();
  ELSIF (NEW.name::text, NEW.description) IS DISTINCT FROM (OLD.name::text, OLD.description) THEN
    NEW.version := OLD.version + 1;
    NEW.versioned_at := now();
  ELSE
    NEW.version := OLD.version;
    NEW.versioned_at := OLD.versioned_at;
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
GRANT UPDATE (name, description, members_version) ON TABLE public.teams TO slugbase_app;
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

-- workspace_invitations_touch_teams(): an invitation that becomes accepted moves the version of every team of its workspace by one, once per
-- team, in the transaction that accepts it (sys_invitation_accept and sys_invitation_accept_new_account insert the memberships and then mark
-- the invitation). The accepted account has joined the workspace, and the teams it names; a form of the member set that was read before the
-- acceptance, for any team, is stale afterwards, so a replacement made from it cannot put the account into a team, and one read after the
-- acceptance is not refused. An invitation that names no
-- team moves the versions as well, although it changes no member set; a team of another workspace moves nothing. The application role
-- cannot write status 'accepted' (the policy of workspace_invitations), so the trigger runs for the two functions, as slugbase_system. The
-- other writers of memberships say what they change themselves: a replacement writes members_version. A member who leaves the workspace
-- takes its memberships without moving the version of its teams: a trigger on their deletion would take the team's row after the departing
-- member's row while a replacement holds the team's row and waits for the member's, and the two would deadlock. The other way an account
-- joins a workspace without an invitation, an instance admin adding themselves (sys_instance_add_membership), moves the versions of the
-- teams itself, in the same way and in the same order. A member who leaves and joins again therefore moves them with the join.
-- Lock order: all the teams of the workspace are locked in the order of their identifiers before any is updated. The acceptance functions
-- have locked the teams the invitation names (FOR KEY SHARE, in that order) and inserted the memberships by then. A replacement holds the row
-- of one team (FOR UPDATE) and then takes KEY SHARE on the workspace_members rows of the accounts it names; the acceptance holds no lock on a
-- row that statement can see (the membership it inserted is invisible until it commits), so the replacement never waits for the acceptance
-- while holding a team the trigger needs, and the trigger only waits for replacements. Two acceptances, and an acceptance and an instance
-- admin joining, lock the teams in the same order.
CREATE OR REPLACE FUNCTION public.workspace_invitations_touch_teams() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.status = 'accepted' AND OLD.status IS DISTINCT FROM 'accepted' THEN
    PERFORM 1 FROM public.teams t
    WHERE t.workspace_id = NEW.workspace_id
    ORDER BY t.id
    FOR NO KEY UPDATE OF t;
    UPDATE public.teams t SET members_version = t.members_version + 1
    WHERE t.workspace_id = NEW.workspace_id;
  END IF;
  RETURN NEW;
END
$$;
CREATE OR REPLACE TRIGGER workspace_invitations_touch_teams
  BEFORE UPDATE ON public.workspace_invitations
  FOR EACH ROW EXECUTE FUNCTION public.workspace_invitations_touch_teams();
