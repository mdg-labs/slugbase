-- The system operations behind inspecting and accepting an invitation by its token (doc 05 section 3.3, doc 02
-- section 3.4, doc 04 section 10.5, doc 10 T1, T4 and T19). Both are entered in src/system/registry.ts.
-- slugbase_owner creates each function and hands it to slugbase_system, which needs CREATE on the schema for the
-- length of those statements.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_invitation_inspect(token_hash): what the page behind an invitation link shows of it: the name of the
-- workspace, the display name of the account that invited (NULL once that account is deleted), the invited
-- address, the role and whether an account holds the address. It answers for a pending invitation that has not
-- expired, of a workspace that is not being deleted, and for nothing else; whether the token is unknown, used,
-- revoked, replaced or expired is not told apart, since no row comes back for any of them. The token is the only
-- credential, so it is a function of slugbase_system: the policies of workspace_invitations, workspaces and
-- accounts show an anonymous caller nothing.
CREATE OR REPLACE FUNCTION public.sys_invitation_inspect(p_token_hash bytea)
  RETURNS TABLE (workspace_name text, inviter_name text, invited_email text, invited_role text, account_exists boolean)
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT w.name, inviter.display_name, i.email::text, i.role::text,
           EXISTS (SELECT 1 FROM public.accounts holder WHERE holder.email = i.email)
    FROM public.workspace_invitations i
    JOIN public.workspaces w ON w.id = i.workspace_id
    LEFT JOIN public.accounts inviter ON inviter.id = i.invited_by
    WHERE octet_length(p_token_hash) = 32
      AND i.token_hash = p_token_hash
      AND i.status = 'pending'
      AND i.expires_at > clock_timestamp()
      AND w.deleting_at IS NULL
  $$;

-- sys_invitation_accept(token_hash, account_id, seat_limit): adds the account to the workspace of the invitation
-- the token belongs to, with exactly the invited role, and marks the invitation accepted (status, accepted_by and
-- closed_at in the one statement the CHECK of the table needs), all in the calling transaction. The outcome is one
-- of: 'accepted'; 'gone' for an unknown, used, revoked, replaced or expired token, a workspace being deleted and an
-- account that does not exist or is disabled, which a caller does not tell apart; 'email_mismatch' when the verified
-- address of the account is not the invited one; 'already_member'; 'seat_limit_reached'. The checks run in that
-- order, and a refusal writes nothing and leaves the invitation pending. seat_limit is the seats the workspace may
-- hold, NULL meaning unlimited (the entitlement engine supplies it); the members are counted under the lock of the
-- workspace's row, which every acceptance into the workspace takes, so two acceptances cannot both take the last seat.
-- When app_account_id() names an account, p_account_id must be that account.
--
-- Rows are locked parent first and the same way every time: the workspace (FOR UPDATE, the lock the removal of a
-- member and the deletion of the workspace take), the account (FOR SHARE, so a change of its address waits and the
-- address checked is the address the membership is given for), then the invitation. The invitation is found by its
-- token before any lock only to learn the workspace; it is read again under the locks by the token, so a resend or a
-- link that replaced the token in between ends this acceptance, and of two requests for one token the second finds the
-- invitation accepted.
CREATE OR REPLACE FUNCTION public.sys_invitation_accept(p_token_hash bytea, p_account_id uuid, p_seat_limit integer)
  RETURNS TABLE (outcome text, accepted_workspace_id uuid, accepted_invitation_id uuid, accepted_role text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_workspace uuid;
  v_invitation uuid;
  v_invited_email citext;
  v_role member_role;
  v_account_email citext;
  v_account_verified boolean;
BEGIN
  IF p_token_hash IS NULL OR octet_length(p_token_hash) <> 32 OR p_account_id IS NULL OR p_seat_limit < 0 THEN
    RAISE EXCEPTION 'sys_invitation_accept needs a 32-byte token hash, an account and a seat limit that is not negative'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF public.app_account_id() IS NOT NULL AND p_account_id <> public.app_account_id() THEN
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

  SELECT a.email, a.email_verified_at IS NOT NULL INTO v_account_email, v_account_verified
  FROM public.accounts a WHERE a.id = p_account_id AND a.disabled_at IS NULL FOR SHARE;
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

  IF NOT v_account_verified OR v_account_email IS DISTINCT FROM v_invited_email THEN
    outcome := 'email_mismatch';
    RETURN NEXT;
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.workspace_id = v_workspace AND m.account_id = p_account_id) THEN
    outcome := 'already_member';
    RETURN NEXT;
    RETURN;
  END IF;

  IF p_seat_limit IS NOT NULL AND (SELECT count(*) FROM public.workspace_members m WHERE m.workspace_id = v_workspace) >= p_seat_limit THEN
    outcome := 'seat_limit_reached';
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO public.workspace_members (workspace_id, account_id, role) VALUES (v_workspace, p_account_id, v_role);
  UPDATE public.workspace_invitations
  SET status = 'accepted', accepted_by = p_account_id, closed_at = clock_timestamp()
  WHERE id = v_invitation;

  outcome := 'accepted';
  accepted_workspace_id := v_workspace;
  accepted_invitation_id := v_invitation;
  accepted_role := v_role::text;
  RETURN NEXT;
END
$$;

ALTER FUNCTION public.sys_invitation_inspect(bytea) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_invitation_accept(bytea, uuid, integer) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_invitation_inspect(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_invitation_accept(bytea, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_invitation_inspect(bytea) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_invitation_accept(bytea, uuid, integer) TO slugbase_app;
