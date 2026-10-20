-- The system operation behind accepting an invitation with registration fields (doc 05 section 3.3, doc 02 sections
-- 2.2 and 3.4, doc 04 section 10.5, doc 10 T1, T8 and T19). It is entered in src/system/registry.ts. slugbase_owner
-- creates the function and hands it to slugbase_system, which needs CREATE on the schema for the length of those
-- statements.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_invitation_accept_new_account(...): for an invitation that is pending and unexpired, of a workspace that is not
-- being deleted, creates the account the invitation is for, with the address the invitation names and never one the
-- caller names, verified because the token that arrived in the mailbox proves it; adds it to the workspace with exactly
-- the invited role; marks the invitation accepted; and signs the account in with a full session whose active workspace
-- is that one: all in the calling transaction, so a failure at any step leaves nothing. It makes no personal
-- workspace. The password arrives hashed. The outcome is one of: 'accepted'; 'gone' for an unknown, used, revoked,
-- replaced or expired token or a workspace being deleted, which a caller does not tell apart; 'seat_limit_reached'
-- (seat_limit is the seats the workspace may hold, NULL meaning unlimited); 'email_taken' when an account holds the
-- address or the address is reserved by an unused "this wasn't me" token (sys_create_account decides). The checks run
-- in that order and a refusal writes nothing, so the invitation stays pending and usable.
--
-- Rows are locked parent first, as sys_invitation_accept does: the workspace (FOR UPDATE, the lock every acceptance
-- into the workspace takes), then the invitation, found by its token before any lock only to learn the workspace and
-- read again under the locks, so of two requests for one token the second finds the invitation accepted and answers
-- 'gone', and one token creates one account and one membership however many requests carry it. The account insert
-- comes after both locks, so a request that finds the address taken has held the locks only to read. The deletion of an
-- account (sys_delete_account) takes the same order: it locks the workspaces the account is a member of or created
-- before the account row, so an insert that waits for a deleted row with the invited address never waits on a
-- transaction that waits for the workspace this one holds.
-- The operation is the anonymous caller's: it refuses ('gone') inside a transaction that acts for an account, and
-- needs no account to exist.
CREATE OR REPLACE FUNCTION public.sys_invitation_accept_new_account(
  p_token_hash bytea,
  p_account_id uuid,
  p_display_name text,
  p_password_hash text,
  p_locale text,
  p_seat_limit integer,
  p_session_id uuid,
  p_session_token_hash bytea,
  p_replaced_token_hash bytea,
  p_ip_prefix cidr,
  p_user_agent text
) RETURNS TABLE (outcome text, accepted_workspace_id uuid, accepted_invitation_id uuid, accepted_role text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_workspace uuid;
  v_invitation uuid;
  v_invited_email citext;
  v_role member_role;
BEGIN
  IF NOT coalesce(
    p_token_hash IS NOT NULL AND octet_length(p_token_hash) = 32
    AND p_account_id IS NOT NULL AND p_display_name IS NOT NULL AND p_password_hash IS NOT NULL AND p_locale IS NOT NULL
    AND p_session_id IS NOT NULL AND octet_length(p_session_token_hash) = 32
    AND (p_replaced_token_hash IS NULL OR octet_length(p_replaced_token_hash) = 32)
    AND (p_seat_limit IS NULL OR p_seat_limit >= 0),
    false
  ) THEN
    RAISE EXCEPTION 'sys_invitation_accept_new_account needs a 32-byte token hash, the account and its session, a password hash and a seat limit that is not negative'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF public.app_account_id() IS NOT NULL THEN
    outcome := 'gone';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT i.workspace_id INTO v_workspace FROM public.workspace_invitations i WHERE i.token_hash = p_token_hash;
  IF v_workspace IS NULL THEN
    outcome := 'gone';
    RETURN NEXT;
    RETURN;
  END IF;

  PERFORM 1 FROM public.workspaces w WHERE w.id = v_workspace AND w.deleting_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    outcome := 'gone';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT i.id, i.email, i.role INTO v_invitation, v_invited_email, v_role
  FROM public.workspace_invitations i
  WHERE i.token_hash = p_token_hash AND i.workspace_id = v_workspace AND i.status = 'pending' AND i.expires_at > clock_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN
    outcome := 'gone';
    RETURN NEXT;
    RETURN;
  END IF;

  IF p_seat_limit IS NOT NULL AND (SELECT count(*) FROM public.workspace_members m WHERE m.workspace_id = v_workspace) >= p_seat_limit THEN
    outcome := 'seat_limit_reached';
    RETURN NEXT;
    RETURN;
  END IF;

  IF NOT public.sys_create_account(p_account_id, v_invited_email::text, p_display_name, p_password_hash, p_locale, true) THEN
    outcome := 'email_taken';
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO public.workspace_members (workspace_id, account_id, role) VALUES (v_workspace, p_account_id, v_role);
  UPDATE public.workspace_invitations
  SET status = 'accepted', accepted_by = p_account_id, closed_at = clock_timestamp()
  WHERE id = v_invitation;

  IF NOT public.sys_session_create(
    p_session_id, p_account_id, 'full', false, p_ip_prefix, p_user_agent, p_session_token_hash, p_replaced_token_hash
  ) THEN
    RAISE EXCEPTION 'the session of the account that accepted the invitation could not be created';
  END IF;
  UPDATE public.sessions SET active_workspace_id = v_workspace WHERE id = p_session_id;

  outcome := 'accepted';
  accepted_workspace_id := v_workspace;
  accepted_invitation_id := v_invitation;
  accepted_role := v_role::text;
  RETURN NEXT;
END
$$;

ALTER FUNCTION public.sys_invitation_accept_new_account(bytea, uuid, text, text, text, integer, uuid, bytea, bytea, cidr, text) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_invitation_accept_new_account(bytea, uuid, text, text, text, integer, uuid, bytea, bytea, cidr, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_invitation_accept_new_account(bytea, uuid, text, text, text, integer, uuid, bytea, bytea, cidr, text) TO slugbase_app;
