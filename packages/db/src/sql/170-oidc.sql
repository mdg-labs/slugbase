-- Row-level security, privileges and system operations of the OIDC sign-in (doc
-- 05 sections 2.1, 3.1 and 3.3, doc 02 sections 2.3 and 2.8, doc 10 T4, T17
-- and T20). The tables are defined in src/schema/identities.ts. The three
-- functions are entered in src/system/registry.ts. slugbase_owner creates each
-- function and hands it to slugbase_system, which needs CREATE on the schema
-- for the length of those statements.
--
-- account_identities: an account sees its own identities only. slugbase_app
-- reads the columns below and writes none: an identity is linked, and its
-- last-used time written, by system operations.
--
-- oidc_login_states: the callback is anonymous, so the table has forced
-- row-level security and no policy, and slugbase_app holds no privilege on it.
-- sys_oidc_state_create and sys_oidc_state_consume are its only users;
-- sys_retention_purge deletes what expired unconsumed (110-retention-purge.sql);
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

-- sys_oidc_state_create(...): stores the state of a handshake that is starting.
-- The state arrives as its SHA-256 and the PKCE verifier already sealed by the
-- secret box with the id of the key that sealed it; the record expires 10
-- minutes from now, on the database clock. The return path must be a relative
-- one and the link account must be given for the link and reauth intents only
-- (the table's checks); any argument that breaks them is refused with
-- invalid_parameter_value.
CREATE OR REPLACE FUNCTION public.sys_oidc_state_create(
  p_state_hash bytea,
  p_provider text,
  p_intent text,
  p_nonce text,
  p_code_verifier bytea,
  p_code_verifier_key_id text,
  p_return_to text,
  p_link_account_id uuid
) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF NOT coalesce(
    octet_length(p_state_hash) = 32
    AND p_provider IS NOT NULL AND p_provider <> ''
    AND p_intent IN ('login', 'link', 'reauth')
    AND p_nonce IS NOT NULL AND p_nonce <> ''
    AND p_code_verifier IS NOT NULL AND octet_length(p_code_verifier) > 0
    AND p_code_verifier_key_id IS NOT NULL AND p_code_verifier_key_id <> ''
    AND p_return_to LIKE '/%' AND length(p_return_to) <= 2048
    AND ((p_intent = 'login') = (p_link_account_id IS NULL)),
    false
  ) THEN
    RAISE EXCEPTION 'sys_oidc_state_create needs a 32-byte state hash, a provider, a login, link or reauth intent, a nonce, a sealed verifier with its key id, a relative return path and a link account for the link and reauth intents only'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO public.oidc_login_states (
    state_hash, provider, intent, nonce, code_verifier, code_verifier_key_id, return_to, link_account_id, expires_at
  ) VALUES (
    p_state_hash, p_provider, p_intent, p_nonce, p_code_verifier, p_code_verifier_key_id, p_return_to, p_link_account_id,
    clock_timestamp() + interval '10 minutes'
  );
END
$$;

-- sys_oidc_state_consume(state_hash, provider): the state of a handshake that is
-- ending. It deletes the record and returns it in one statement, so a state is
-- answered once whatever the number of concurrent callbacks; no row comes back
-- for an unknown state, a state that expired, one already consumed and one of
-- another provider, which a caller does not tell apart.
CREATE OR REPLACE FUNCTION public.sys_oidc_state_consume(p_state_hash bytea, p_provider text)
  RETURNS TABLE (
    intent text,
    nonce text,
    code_verifier bytea,
    code_verifier_key_id text,
    return_to text,
    link_account_id uuid
  )
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    DELETE FROM public.oidc_login_states s
    WHERE s.state_hash = p_state_hash
      AND s.provider = p_provider
      AND s.expires_at > clock_timestamp()
    RETURNING s.intent, s.nonce, s.code_verifier, s.code_verifier_key_id, s.return_to, s.link_account_id
  $$;

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

ALTER FUNCTION public.sys_oidc_state_create(bytea, text, text, text, bytea, text, text, uuid) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_oidc_state_consume(bytea, text) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_identity_sign_in(text, text, uuid, cidr, text, bytea, bytea) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_oidc_state_create(bytea, text, text, text, bytea, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_oidc_state_consume(bytea, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_identity_sign_in(text, text, uuid, cidr, text, bytea, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_oidc_state_create(bytea, text, text, text, bytea, text, text, uuid) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_oidc_state_consume(bytea, text) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_identity_sign_in(text, text, uuid, cidr, text, bytea, bytea) TO slugbase_app;
