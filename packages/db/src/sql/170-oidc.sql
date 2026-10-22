-- Row-level security, privileges and system operations of the OIDC sign-in (doc
-- 05 sections 2.1, 3.1 and 3.3, doc 02 sections 2.3 and 2.8, doc 10 T4, T17
-- and T20). The tables are defined in src/schema/identities.ts. The function
-- is entered in src/system/registry.ts. slugbase_owner creates it and hands it
-- to slugbase_system, which needs CREATE on the schema for the length of those
-- statements.
--
-- account_identities: an account sees its own identities only. slugbase_app
-- reads the columns below and writes none: an identity is linked, and its
-- last-used time written, by system operations.
--
-- oidc_login_states: the callback is anonymous, so the table has forced
-- row-level security and no policy, and slugbase_app holds no privilege on it.
-- sys_oidc_state_create and sys_oidc_state_take (340-oidc-invitation.sql) are
-- its only users; sys_retention_purge deletes what expired unconsumed (110-retention-purge.sql);
-- its FOR UPDATE SKIP LOCKED is why slugbase_system holds UPDATE as well.
ALTER TABLE public.account_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_identities FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS account_identities_account ON public.account_identities;
CREATE POLICY account_identities_account ON public.account_identities
  USING (account_id = public.app_account_id())
  WITH CHECK (account_id = public.app_account_id());
REVOKE ALL ON TABLE public.account_identities FROM PUBLIC, slugbase_app;
GRANT SELECT (id, account_id, provider, email_at_link, created_at, last_used_at) ON TABLE public.account_identities TO slugbase_app;
GRANT SELECT, UPDATE ON TABLE public.account_identities TO slugbase_system;

ALTER TABLE public.oidc_login_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oidc_login_states FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.oidc_login_states FROM PUBLIC, slugbase_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.oidc_login_states TO slugbase_system;

GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_identity_sign_in(...): signs in the account an identity is linked to. In
-- one call it finds the identity by (provider, subject), requires its account
-- to exist and not to be disabled, inserts a full session (30-day sliding
-- window, 180-day cap, created now), deletes the session of the token the
-- request carried (p_replaced_token_hash, when not null), and sets the
-- account's last sign-in time and the identity's last-used time. It answers
-- false, changing nothing, for an unknown identity and for a disabled account,
-- which a caller does not tell apart.
--
-- The session is full whether or not the account has a second factor: the
-- provider is trusted for that factor (doc 02 section 2.3), the one exception
-- to the rule of sys_session_create that a full session needs MFA off.
CREATE OR REPLACE FUNCTION public.sys_identity_sign_in(
  p_provider text,
  p_subject text,
  p_session_id uuid,
  p_ip_prefix cidr,
  p_user_agent text,
  p_token_hash bytea,
  p_replaced_token_hash bytea
) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_identity_id uuid;
  v_account_id uuid;
BEGIN
  IF NOT coalesce(
    p_provider IS NOT NULL AND p_subject IS NOT NULL AND p_session_id IS NOT NULL
    AND octet_length(p_token_hash) = 32
    AND (p_replaced_token_hash IS NULL OR octet_length(p_replaced_token_hash) = 32),
    false
  ) THEN
    RAISE EXCEPTION 'sys_identity_sign_in needs a provider, a subject, a session id and 32-byte token hashes'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT i.id, a.id INTO v_identity_id, v_account_id
  FROM public.account_identities i
  JOIN public.accounts a ON a.id = i.account_id
  WHERE i.provider = p_provider AND i.subject = p_subject AND a.disabled_at IS NULL;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  INSERT INTO public.sessions (
    id, token_hash, account_id, level, remember, created_at, last_seen_at, expires_at, absolute_expires_at,
    ip_prefix, user_agent
  ) VALUES (
    p_session_id, p_token_hash, v_account_id, 'full', false, v_now, v_now, v_now + interval '30 days', v_now + interval '180 days',
    p_ip_prefix, left(p_user_agent, 256)
  );
  IF p_replaced_token_hash IS NOT NULL THEN
    DELETE FROM public.sessions WHERE token_hash = p_replaced_token_hash;
  END IF;
  UPDATE public.accounts SET last_sign_in_at = v_now WHERE id = v_account_id;
  UPDATE public.account_identities SET last_used_at = v_now WHERE id = v_identity_id;
  RETURN true;
END
$$;

ALTER FUNCTION public.sys_identity_sign_in(text, text, uuid, cidr, text, bytea, bytea) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_identity_sign_in(text, text, uuid, cidr, text, bytea, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_identity_sign_in(text, text, uuid, cidr, text, bytea, bytea) TO slugbase_app;
