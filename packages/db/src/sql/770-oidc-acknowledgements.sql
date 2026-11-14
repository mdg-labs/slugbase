-- The system operations behind the registration acknowledgements an OIDC handshake carries (doc 05 sections 2.1 and 3.3, doc 02
-- section 2.8, doc 04 sections 4.5 and 10.2, doc 10 T7, T17 and T18): a person who signs in with a provider for the first time
-- acknowledges what the registration policy asks before the handshake starts, and the callback reads the answer from the state
-- the start stored, never from its own query. oidc_login_states.acknowledgements holds identifiers and version labels only.
-- Both functions are entered in src/system/registry.ts. slugbase_owner creates each function and hands it to slugbase_system, which
-- needs CREATE on the schema for the length of those statements.
--
-- The column is an expand step: it has a default, so the functions of the release before this one (the nine-argument
-- sys_oidc_state_create and sys_oidc_state_take of 340-oidc-invitation.sql, which stay until a later release drops them) keep
-- working against it and store no acknowledgements.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_oidc_state_create(..., invitation_token_hash, acknowledgements): the nine-argument function with the acknowledgements the
-- handshake carries. A list is accepted for the `login` and `invite` intents only, holds at most 8 entries, each an object of
-- exactly an identifier (1 to 32 characters of a-z, 0-9, underscore and hyphen) and a version label (1 to 32 characters, no control
-- character), and names an identifier at most once: the limits of REGISTRATION_ACKNOWLEDGEMENTS_MAX and the schema of
-- packages/contracts/src/operations/acknowledgements.ts. Any other argument is refused with invalid_parameter_value, and nothing is
-- stored.
CREATE OR REPLACE FUNCTION public.sys_oidc_state_create(
  p_state_hash bytea,
  p_provider text,
  p_intent text,
  p_nonce text,
  p_code_verifier bytea,
  p_code_verifier_key_id text,
  p_return_to text,
  p_link_account_id uuid,
  p_invitation_token_hash bytea,
  p_acknowledgements jsonb
) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF NOT coalesce(
    octet_length(p_state_hash) = 32
    AND p_provider IS NOT NULL AND p_provider <> ''
    AND p_intent IN ('login', 'link', 'reauth', 'invite')
    AND p_nonce IS NOT NULL AND p_nonce <> ''
    AND p_code_verifier IS NOT NULL AND octet_length(p_code_verifier) > 0
    AND p_code_verifier_key_id IS NOT NULL AND p_code_verifier_key_id <> ''
    AND p_return_to LIKE '/%' AND length(p_return_to) <= 2048
    AND ((p_intent IN ('link', 'reauth')) = (p_link_account_id IS NOT NULL))
    AND ((p_intent = 'invite') = (p_invitation_token_hash IS NOT NULL))
    AND (p_invitation_token_hash IS NULL OR octet_length(p_invitation_token_hash) = 32)
    AND jsonb_typeof(p_acknowledgements) = 'array',
    false
  ) THEN
    RAISE EXCEPTION 'sys_oidc_state_create needs a 32-byte state hash, a provider, a login, link, reauth or invite intent, a nonce, a sealed verifier with its key id, a relative return path, a link account for the link and reauth intents only, a 32-byte invitation token hash for the invite intent only and a list of acknowledgements'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF NOT coalesce(
    jsonb_array_length(p_acknowledgements) <= 8
    AND (p_intent IN ('login', 'invite') OR jsonb_array_length(p_acknowledgements) = 0)
    AND (SELECT count(DISTINCT a.entry ->> 'id') FROM jsonb_array_elements(p_acknowledgements) AS a(entry)) = jsonb_array_length(p_acknowledgements)
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(p_acknowledgements) AS a(entry)
      WHERE NOT CASE
        WHEN jsonb_typeof(a.entry) = 'object' THEN
          (SELECT array_agg(k.key ORDER BY k.key) FROM jsonb_object_keys(a.entry) AS k(key)) = ARRAY['id', 'version']
          AND jsonb_typeof(a.entry -> 'id') = 'string'
          AND jsonb_typeof(a.entry -> 'version') = 'string'
          AND (a.entry ->> 'id') ~ '^[a-z0-9_-]{1,32}$'
          AND length(a.entry ->> 'version') BETWEEN 1 AND 32
          AND (a.entry ->> 'version') !~ '[\x01-\x1f\x7f-\x9f]'
        ELSE false
      END
    ),
    false
  ) THEN
    RAISE EXCEPTION 'sys_oidc_state_create takes at most 8 acknowledgements, for the login and invite intents only, each an identifier and a version label, an identifier at most once'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO public.oidc_login_states (
    state_hash, provider, intent, nonce, code_verifier, code_verifier_key_id, return_to, link_account_id,
    invitation_token_hash, acknowledgements, expires_at
  ) VALUES (
    p_state_hash, p_provider, p_intent, p_nonce, p_code_verifier, p_code_verifier_key_id, p_return_to, p_link_account_id,
    p_invitation_token_hash, p_acknowledgements, clock_timestamp() + interval '10 minutes'
  );
END
$$;

-- sys_oidc_state_take_with_acknowledgements(state_hash, provider): sys_oidc_state_take with the acknowledgements the record holds.
-- It deletes the record and returns it in one statement, so a state is answered once whatever the number of concurrent callbacks,
-- and the acknowledgements it holds are used by at most one callback; no row comes back for an unknown state, one that expired,
-- one already consumed and one of another provider, which a caller does not tell apart.
CREATE OR REPLACE FUNCTION public.sys_oidc_state_take_with_acknowledgements(p_state_hash bytea, p_provider text)
  RETURNS TABLE (
    intent text,
    nonce text,
    code_verifier bytea,
    code_verifier_key_id text,
    return_to text,
    link_account_id uuid,
    invitation_token_hash bytea,
    acknowledgements jsonb
  )
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    DELETE FROM public.oidc_login_states s
    WHERE s.state_hash = p_state_hash
      AND s.provider = p_provider
      AND s.expires_at > clock_timestamp()
    RETURNING s.intent, s.nonce, s.code_verifier, s.code_verifier_key_id, s.return_to, s.link_account_id, s.invitation_token_hash, s.acknowledgements
  $$;

ALTER FUNCTION public.sys_oidc_state_create(bytea, text, text, text, bytea, text, text, uuid, bytea, jsonb) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_oidc_state_take_with_acknowledgements(bytea, text) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_oidc_state_create(bytea, text, text, text, bytea, text, text, uuid, bytea, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_oidc_state_take_with_acknowledgements(bytea, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_oidc_state_create(bytea, text, text, text, bytea, text, text, uuid, bytea, jsonb) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_oidc_state_take_with_acknowledgements(bytea, text) TO slugbase_app;
