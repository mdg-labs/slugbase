-- The system operation behind the first login of an OIDC identity nobody linked
-- yet (doc 05 section 3.3, doc 02 sections 2.2 and 2.8, doc 10 T17 and T20). It
-- is entered in src/system/registry.ts. slugbase_owner creates the function and
-- hands it to slugbase_system, which needs CREATE on the schema for the length
-- of those statements.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_identity_link_by_email(id, provider, subject, email): adds the identity
-- the provider asserted to the account that holds this address, for a caller
-- that has seen the provider assert the address as verified. Only an account
-- whose own address is verified and that is not disabled is a match: an address
-- somebody registered and nobody confirmed proves nothing about who owns it, so
-- a verified address at a provider never reaches the account of that
-- registration. The match is case-insensitive (the column is citext); the
-- caller passes the trimmed, NFKC-normalised address. The account's row is
-- locked by the lookup, so the match is judged on the row as it stands when the
-- identity is written, and the link is sys_identity_link's: it answers 'linked',
-- 'already_linked' (the account holds the identity), 'taken' (another account
-- holds it; nothing moves) or 'no_account' (no verified, enabled account holds
-- the address; nothing changes).
CREATE OR REPLACE FUNCTION public.sys_identity_link_by_email(
  p_id uuid,
  p_provider text,
  p_subject text,
  p_email text
) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_account_id uuid;
BEGIN
  IF NOT coalesce(
    p_id IS NOT NULL AND p_email IS NOT NULL AND p_email <> ''
    AND length(p_provider) BETWEEN 1 AND 64
    AND length(p_subject) BETWEEN 1 AND 255,
    false
  ) THEN
    RAISE EXCEPTION 'sys_identity_link_by_email needs an identifier, a provider of 1 to 64 characters, a subject of 1 to 255 characters and an address'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.id INTO v_account_id
  FROM public.accounts a
  WHERE a.email = p_email::public.citext AND a.email_verified_at IS NOT NULL AND a.disabled_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'no_account';
  END IF;

  RETURN public.sys_identity_link(v_account_id, p_id, p_provider, p_subject, p_email);
END
$$;

ALTER FUNCTION public.sys_identity_link_by_email(uuid, text, text, text) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_identity_link_by_email(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_identity_link_by_email(uuid, text, text, text) TO slugbase_app;
