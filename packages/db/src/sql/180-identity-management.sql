-- The system operations behind linking, unlinking and re-authenticating with an
-- OIDC identity, and behind setting the first password of an account that has
-- none (doc 05 section 3.3, doc 02 sections 2.5 and 2.8, doc 04 sections 4.4 and
-- 10.3, doc 10 T18 and T20). All four are entered in src/system/registry.ts.
-- slugbase_owner creates each function and hands it to slugbase_system, which
-- needs CREATE on the schema for the length of those statements. The account is
-- a parameter of each, so another account's identity, session or password is
-- never read or changed. slugbase_app still holds no write privilege on
-- account_identities: an identity is linked and unlinked here only.
GRANT INSERT, DELETE ON TABLE public.account_identities TO slugbase_system;

GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_identity_link(account_id, id, provider, subject, email): adds the identity
-- the provider asserted to the account. Answers 'linked' for a new link,
-- 'already_linked' when the account holds this identity already (nothing
-- changes), 'taken' when another account holds it (nothing changes), and
-- 'no_account' for an unknown or disabled account. The account's row is locked
-- first, so linking and unlinking an account's identities queue on it. The
-- address is stored as asserted, cut at 320 characters; an unverified address is
-- no reason to refuse an explicit link (doc 02 section 2.8).
CREATE OR REPLACE FUNCTION public.sys_identity_link(
  p_account_id uuid,
  p_id uuid,
  p_provider text,
  p_subject text,
  p_email text
) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_owner uuid;
BEGIN
  IF NOT coalesce(
    p_account_id IS NOT NULL AND p_id IS NOT NULL AND p_email IS NOT NULL
    AND length(p_provider) BETWEEN 1 AND 64
    AND length(p_subject) BETWEEN 1 AND 255,
    false
  ) THEN
    RAISE EXCEPTION 'sys_identity_link needs an account, an identifier, a provider of 1 to 64 characters, a subject of 1 to 255 characters and an address'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM 1 FROM public.accounts WHERE id = p_account_id AND disabled_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'no_account';
  END IF;

  INSERT INTO public.account_identities (id, account_id, provider, subject, email_at_link)
  VALUES (p_id, p_account_id, p_provider, p_subject, left(p_email, 320))
  ON CONFLICT (provider, subject) DO NOTHING;
  IF FOUND THEN
    RETURN 'linked';
  END IF;

  SELECT account_id INTO v_owner FROM public.account_identities WHERE provider = p_provider AND subject = p_subject;
  RETURN CASE WHEN v_owner = p_account_id THEN 'already_linked' ELSE 'taken' END;
END
$$;

-- sys_identity_unlink(account_id, id): deletes the account's identity with this
-- id. Answers 'unlinked', 'not_found' for an id the account does not hold (another
-- account's included, which a caller does not tell apart) and
-- 'last_sign_in_method', changing nothing, when the account has no password and
-- no other identity. The account's row is locked before the count, so two
-- unlinks made at once from two sessions cannot each see the other identity and
-- both delete.
CREATE OR REPLACE FUNCTION public.sys_identity_unlink(p_account_id uuid, p_id uuid) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_has_password boolean;
BEGIN
  IF p_account_id IS NULL OR p_id IS NULL THEN
    RAISE EXCEPTION 'sys_identity_unlink needs an account and an identity'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.password_hash IS NOT NULL INTO v_has_password
  FROM public.accounts a WHERE a.id = p_account_id AND a.disabled_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  PERFORM 1 FROM public.account_identities WHERE id = p_id AND account_id = p_account_id;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  IF NOT v_has_password
     AND NOT EXISTS (SELECT 1 FROM public.account_identities WHERE account_id = p_account_id AND id <> p_id) THEN
    RETURN 'last_sign_in_method';
  END IF;

  DELETE FROM public.account_identities WHERE id = p_id AND account_id = p_account_id;
  RETURN 'unlinked';
END
$$;

-- sys_identity_reauth(session_id, account_id, provider, subject): records that
-- the full session of the account re-authenticated now, on the database clock,
-- because the provider asserted an identity the account holds, and sets that
-- identity's last-used time. Answers false, changing nothing, when the account
-- does not hold the identity, is disabled, or has no full session with that id:
-- an identity of another account re-authenticates nothing.
CREATE OR REPLACE FUNCTION public.sys_identity_reauth(
  p_session_id uuid,
  p_account_id uuid,
  p_provider text,
  p_subject text
) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_identity_id uuid;
BEGIN
  IF p_session_id IS NULL OR p_account_id IS NULL OR p_provider IS NULL OR p_subject IS NULL THEN
    RAISE EXCEPTION 'sys_identity_reauth needs a session, an account, a provider and a subject'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT i.id INTO v_identity_id
  FROM public.account_identities i
  JOIN public.accounts a ON a.id = i.account_id
  WHERE i.account_id = p_account_id AND i.provider = p_provider AND i.subject = p_subject AND a.disabled_at IS NULL;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE public.sessions SET reauth_at = v_now
  WHERE id = p_session_id AND account_id = p_account_id AND level = 'full';
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE public.account_identities SET last_used_at = v_now WHERE id = v_identity_id;
  RETURN true;
END
$$;

-- sys_password_set_initial(account_id, hash): stores the first password hash of
-- an account that has none, like sys_password_set (which it calls, so the same
-- shape of an argon2id PHC string is required). Answers false, changing nothing,
-- for an unknown or disabled account and for an account that already has a
-- password, so a first password never replaces one. The account's row is locked
-- before it is read.
CREATE OR REPLACE FUNCTION public.sys_password_set_initial(p_account_id uuid, p_hash text) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_hash text;
BEGIN
  IF p_account_id IS NULL OR p_hash IS NULL THEN
    RAISE EXCEPTION 'sys_password_set_initial needs an account and a hash'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT password_hash INTO v_hash FROM public.accounts WHERE id = p_account_id AND disabled_at IS NULL FOR UPDATE;
  IF NOT FOUND OR v_hash IS NOT NULL THEN
    RETURN false;
  END IF;
  RETURN public.sys_password_set(p_account_id, p_hash);
END
$$;

ALTER FUNCTION public.sys_identity_link(uuid, uuid, text, text, text) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_identity_unlink(uuid, uuid) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_identity_reauth(uuid, uuid, text, text) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_password_set_initial(uuid, text) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_identity_link(uuid, uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_identity_unlink(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_identity_reauth(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_password_set_initial(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_identity_link(uuid, uuid, text, text, text) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_identity_unlink(uuid, uuid) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_identity_reauth(uuid, uuid, text, text) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_password_set_initial(uuid, text) TO slugbase_app;
