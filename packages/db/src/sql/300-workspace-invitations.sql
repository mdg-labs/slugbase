-- Row-level security, privileges and the system operation of workspace_invitations (doc 05 sections 2.2 and
-- 3.3, doc 02 section 3.4, doc 10 T1 and T19). The table itself is defined in src/schema/invitations.ts.
-- sys_invitation_invitee_locale is entered in src/system/registry.ts. slugbase_owner creates the function and
-- hands it to slugbase_system, which needs CREATE on the schema for the length of those statements.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_invitation_invitee_locale(invitation_id): the language of the account that holds the invited address of a
-- pending invitation of the workspace the transaction acts in, which the invitation email is written in; NULL
-- when no account holds the address, so the caller falls back to the inviter's language. The policy of accounts
-- shows an account that shares no workspace with the caller to nobody, so this is a function of slugbase_system.
-- It answers for an invitation of the active workspace only and only to an owner or an admin of it (the account
-- of the transaction comes from app_account_id(), never an argument), and it answers a language and nothing
-- else, so it cannot be asked about an address nobody invited into that workspace.
CREATE OR REPLACE FUNCTION public.sys_invitation_invitee_locale(p_invitation_id uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT a.locale
    FROM public.workspace_invitations i
    JOIN public.accounts a ON a.email = i.email
    WHERE i.id = p_invitation_id
      AND i.status = 'pending'
      AND i.workspace_id = public.app_workspace_id()
      AND EXISTS (
        SELECT 1 FROM public.workspace_members m
        WHERE m.workspace_id = i.workspace_id AND m.account_id = public.app_account_id() AND m.role IN ('owner', 'admin'))
  $$;

ALTER FUNCTION public.sys_invitation_invitee_locale(uuid) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_invitation_invitee_locale(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_invitation_invitee_locale(uuid) TO slugbase_app;

-- workspace_invitations: the invitations of the active workspace, read and written there only. slugbase_app
-- may insert an invitation without the columns that make one an owner's or an accepted one (instance_issued,
-- status, accepted_by: a new row is pending and never instance-issued), and change what a resend replaces:
-- the role and teams of the new request, the inviter, the token hash, the mail ticket and the expiry, and revoke a pending one
-- (the status and closed_at columns, with an update policy that lets only a pending row become pending or revoked, so the
-- application role can neither accept an invitation nor reopen a revoked one). It never deletes a row.
-- Whether the caller may invite is the invitation service's check and the role of the authorization stage;
-- that an invitation never grants owner is the CHECK of the table. Inspecting and accepting an invitation by
-- its token, and the purge of old rows, are system operations of their own. slugbase_system, which bypasses
-- the policies, gets the privileges they need.
ALTER TABLE public.workspace_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_invitations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_invitations_tenant ON public.workspace_invitations;
CREATE POLICY workspace_invitations_tenant ON public.workspace_invitations FOR SELECT
  USING (workspace_id = public.app_workspace_id());
DROP POLICY IF EXISTS workspace_invitations_tenant_insert ON public.workspace_invitations;
CREATE POLICY workspace_invitations_tenant_insert ON public.workspace_invitations FOR INSERT
  WITH CHECK (workspace_id = public.app_workspace_id());
DROP POLICY IF EXISTS workspace_invitations_tenant_update ON public.workspace_invitations;
CREATE POLICY workspace_invitations_tenant_update ON public.workspace_invitations FOR UPDATE
  USING (workspace_id = public.app_workspace_id() AND status = 'pending')
  WITH CHECK (workspace_id = public.app_workspace_id() AND status IN ('pending', 'revoked'));
REVOKE ALL ON TABLE public.workspace_invitations FROM PUBLIC, slugbase_app;
GRANT SELECT ON TABLE public.workspace_invitations TO slugbase_app;
GRANT INSERT (id, workspace_id, email, role, team_ids, token_hash, mail_ticket, invited_by, expires_at) ON TABLE public.workspace_invitations TO slugbase_app;
GRANT UPDATE (role, team_ids, token_hash, mail_ticket, invited_by, expires_at, status, closed_at) ON TABLE public.workspace_invitations TO slugbase_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.workspace_invitations TO slugbase_system;
-- workspace_invitations_track_link_issued(): records, whenever an update replaces the token hash, how the token behind the new
-- hash reaches a person: a replacement written with no mail ticket is a link returned to an admin (the one place a token is
-- handed to a request, doc 02 section 3.4), and any other (a resend, a new invite, the mail job's own token) reaches the
-- mailbox of the invited address or is held by nobody yet. An update that keeps the hash keeps the flag, so a re-invite where
-- no mail can be sent does not turn a link an admin holds into a mailed one. A row that is not instance-issued and holds no
-- mail ticket while the hash is kept is a link stored before the column existed (migrations are schema-only and the column was
-- added with DEFAULT false, so no backfill set it): the update records it as a link, since the same update may give the row a
-- ticket without replacing the token and the flag is then the only record left. A mailed row always holds the ticket of its
-- mail job and no update clears a ticket without replacing the hash, so this never marks a mailed invitation. slugbase_app has no privilege on the column, so
-- the trigger is the only writer of it for the invitations slugbase_app writes. The one insert that sets it is the owner invitation
-- of sys_instance_create_workspace and sys_instance_reissue_owner_invitation (380-instance-workspaces.sql), which a BEFORE INSERT
-- trigger cannot serve (doc 05 section 5): they write it from their p_link_issued argument.
CREATE OR REPLACE FUNCTION public.workspace_invitations_track_link_issued() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF NEW.token_hash IS DISTINCT FROM OLD.token_hash THEN
    NEW.link_issued := NEW.mail_ticket IS NULL;
  ELSE
    NEW.link_issued := OLD.link_issued OR (OLD.mail_ticket IS NULL AND NOT OLD.instance_issued);
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE TRIGGER workspace_invitations_track_link_issued
  BEFORE UPDATE ON public.workspace_invitations
  FOR EACH ROW EXECUTE FUNCTION public.workspace_invitations_track_link_issued();

CREATE OR REPLACE TRIGGER workspace_invitations_set_updated_at
  BEFORE UPDATE ON public.workspace_invitations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
