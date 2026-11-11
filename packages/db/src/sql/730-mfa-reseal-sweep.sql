-- The system operations behind the re-encryption sweep of the sealed second-factor secrets (doc 01 sections 8.1 and 10, doc 05
-- section 3.3, doc 10 T7 and T17): the hourly job secrets.reseal re-seals every accounts.mfa_secret that is still under a secret-box
-- key other than the current one, so that an operator can remove the previous key (ENCRYPTION_KEY_PREVIOUS) once none is left.
-- slugbase_app has no privilege on the mfa_* columns (060-accounts-sessions.sql), and sys_mfa_set refuses a disabled account, which an
-- instance admin can enable again later; the three operations below read and write the secret of every account, disabled ones
-- included. A secret reaches and leaves them sealed by the secret box, never as plaintext. All three are entered in
-- src/system/registry.ts. slugbase_owner creates each function and hands it to slugbase_system, which needs CREATE on the schema for
-- the length of those statements. The tables are unchanged.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_mfa_secret_key_ids(): each key id that holds at least one sealed secret, with the number of secrets under it, in key id order. An
-- account with no secret is not counted; a pending enrolment and a disabled account are. It changes nothing and returns no secret.
CREATE OR REPLACE FUNCTION public.sys_mfa_secret_key_ids()
  RETURNS TABLE (key_id text, secrets bigint)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT a.mfa_secret_key_id, count(*)
    FROM public.accounts a
    WHERE a.mfa_secret IS NOT NULL
    GROUP BY a.mfa_secret_key_id
    ORDER BY a.mfa_secret_key_id
  $$;

-- sys_mfa_secrets_under_key(key_id, after_account_id, limit): the accounts whose sealed secret is under the key id, with the sealed
-- secret, in account id order, those after after_account_id (from the first when it is null), at most `limit` (1 to 1000). Disabled
-- accounts and pending enrolments are included. The key id must be 1 to 128 characters. It changes nothing.
CREATE OR REPLACE FUNCTION public.sys_mfa_secrets_under_key(p_key_id text, p_after_account_id uuid, p_limit integer)
  RETURNS TABLE (swept_account_id uuid, swept_secret bytea)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF length(p_key_id) IS NULL OR length(p_key_id) NOT BETWEEN 1 AND 128 OR p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'sys_mfa_secrets_under_key needs a key id of 1 to 128 characters and a limit of 1 to 1000'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
    SELECT a.id, a.mfa_secret
    FROM public.accounts a
    WHERE a.mfa_secret IS NOT NULL AND a.mfa_secret_key_id = p_key_id
      AND (p_after_account_id IS NULL OR a.id > p_after_account_id)
    ORDER BY a.id
    LIMIT p_limit;
END
$$;

-- sys_mfa_reseal_swept(account_id, secret, key_id, expected_secret): stores the secret, sealed under another key, and its key id for
-- the account, only while the stored ciphertext still is expected_secret, and answers whether it wrote. A secret that was replaced
-- since it was read (a new enrolment, a re-sealing made when the member signed in) and an account that turned MFA off in the meantime
-- write nothing. It treats a disabled account like any other, which sys_mfa_set(reseal) does not, and it never touches mfa_enabled_at
-- or mfa_last_step, so a pending enrolment stays pending and a replay stays refused. A sealed value is at least the 12-byte IV and
-- 16-byte tag of the secret box and one byte; any other shape of argument is refused with invalid_parameter_value.
CREATE OR REPLACE FUNCTION public.sys_mfa_reseal_swept(p_account_id uuid, p_secret bytea, p_key_id text, p_expected_secret bytea)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  c_min_sealed CONSTANT integer := 29;
  c_max_sealed CONSTANT integer := 1024;
BEGIN
  IF NOT coalesce(
    p_account_id IS NOT NULL
    AND octet_length(p_secret) BETWEEN c_min_sealed AND c_max_sealed
    AND length(p_key_id) BETWEEN 1 AND 128
    AND octet_length(p_expected_secret) BETWEEN c_min_sealed AND c_max_sealed,
    false
  ) THEN
    RAISE EXCEPTION 'sys_mfa_reseal_swept needs an account, a sealed secret with its key id and the sealed secret it replaces'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.accounts
  SET mfa_secret = p_secret, mfa_secret_key_id = p_key_id
  WHERE id = p_account_id AND mfa_secret = p_expected_secret;
  RETURN FOUND;
END
$$;

ALTER FUNCTION public.sys_mfa_secret_key_ids() OWNER TO slugbase_system;
ALTER FUNCTION public.sys_mfa_secrets_under_key(text, uuid, integer) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_mfa_reseal_swept(uuid, bytea, text, bytea) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_mfa_secret_key_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_mfa_secrets_under_key(text, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_mfa_reseal_swept(uuid, bytea, text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_mfa_secret_key_ids() TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_mfa_secrets_under_key(text, uuid, integer) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_mfa_reseal_swept(uuid, bytea, text, bytea) TO slugbase_app;
