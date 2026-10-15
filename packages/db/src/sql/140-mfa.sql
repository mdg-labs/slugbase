-- The system operations behind the second factor (doc 05 sections 2.1, 3.1 and
-- 3.3, doc 02 sections 2.3 and 2.7, doc 10 T7 and T17). The columns and the
-- table are defined in src/schema/. All ten functions are entered in
-- src/system/registry.ts. slugbase_owner creates each function and hands it to
-- slugbase_system, which needs CREATE on the schema for the length of those
-- statements.
--
-- accounts.mfa_enabled_at, mfa_secret, mfa_secret_key_id and mfa_last_step are
-- not in the column list slugbase_app may SELECT (060-accounts-sessions.sql),
-- and no UPDATE on them is granted: the application reads and writes them only
-- through sys_mfa_get_secret, sys_mfa_set and sys_mfa_accept_step. The secret
-- reaches the database sealed by the secret box; none of these functions sees
-- or returns a plaintext secret, a code or a backup code.
--
-- mfa_backup_codes: forced row-level security and no policy, and slugbase_app
-- holds no privilege on it. sys_backup_codes_replace and sys_backup_code_consume
-- are its only writers.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_mfa_get_secret(account_id): the sealed secret of the account with the id
-- of the key that sealed it, the time MFA was enabled (enabled_at) and the
-- latest accepted time step (last_step; null before the first). No row for an
-- unknown or disabled account and for one with no secret, which a caller does
-- not tell apart. A pending enrolment (a secret with enabled_at null) is
-- returned like an active one; enabled_at says which it is.
CREATE OR REPLACE FUNCTION public.sys_mfa_get_secret(p_account_id uuid)
  RETURNS TABLE (secret bytea, key_id text, enabled_at timestamptz, last_step bigint)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT a.mfa_secret, a.mfa_secret_key_id, a.mfa_enabled_at, a.mfa_last_step
    FROM public.accounts a
    WHERE a.id = p_account_id AND a.disabled_at IS NULL AND a.mfa_secret IS NOT NULL
  $$;

-- sys_mfa_set(account_id, action, secret, key_id, expected_secret): the one
-- writer of the secret and of enabled_at. It answers whether it changed the
-- account's row, and changes nothing for an unknown or disabled account. The
-- action is one of:
--   start     stores a pending secret and forgets the last accepted step. It
--             replaces an earlier pending secret and is refused (false) for an
--             account whose MFA is enabled, so the secret of an active factor is
--             never replaced through it. expected_secret must be null.
--   reseal    stores the same secret sealed under another key. It writes only
--             when the stored ciphertext still is expected_secret, so a
--             re-sealing made from a read that has since been replaced (a new
--             enrolment, another re-sealing) writes nothing. It never touches
--             enabled_at or last_step.
--   activate  sets enabled_at to now. It writes only when MFA is not yet
--             enabled, the stored ciphertext is expected_secret (the one the
--             caller verified a code against) and a time step was accepted for
--             it (sys_mfa_accept_step). secret and key_id must be null.
-- A sealed value is at least the 12-byte IV and 16-byte tag of the secret box
-- and one byte; any other shape of argument is refused with
-- invalid_parameter_value.
CREATE OR REPLACE FUNCTION public.sys_mfa_set(
  p_account_id uuid,
  p_action text,
  p_secret bytea,
  p_key_id text,
  p_expected_secret bytea
) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  c_min_sealed CONSTANT integer := 29;
  c_max_sealed CONSTANT integer := 1024;
BEGIN
  IF NOT coalesce(
    p_account_id IS NOT NULL
    AND CASE p_action
      WHEN 'start' THEN
        octet_length(p_secret) BETWEEN c_min_sealed AND c_max_sealed
        AND length(p_key_id) BETWEEN 1 AND 128 AND p_expected_secret IS NULL
      WHEN 'reseal' THEN
        octet_length(p_secret) BETWEEN c_min_sealed AND c_max_sealed
        AND length(p_key_id) BETWEEN 1 AND 128
        AND octet_length(p_expected_secret) BETWEEN c_min_sealed AND c_max_sealed
      WHEN 'activate' THEN
        p_secret IS NULL AND p_key_id IS NULL
        AND octet_length(p_expected_secret) BETWEEN c_min_sealed AND c_max_sealed
      ELSE false
    END,
    false
  ) THEN
    RAISE EXCEPTION 'sys_mfa_set needs an account, the action start, reseal or activate, and the sealed values that action takes'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_action = 'start' THEN
    UPDATE public.accounts
    SET mfa_secret = p_secret, mfa_secret_key_id = p_key_id, mfa_last_step = NULL
    WHERE id = p_account_id AND disabled_at IS NULL AND mfa_enabled_at IS NULL;
  ELSIF p_action = 'reseal' THEN
    UPDATE public.accounts
    SET mfa_secret = p_secret, mfa_secret_key_id = p_key_id
    WHERE id = p_account_id AND disabled_at IS NULL AND mfa_secret = p_expected_secret;
  ELSE
    UPDATE public.accounts
    SET mfa_enabled_at = clock_timestamp()
    WHERE id = p_account_id AND disabled_at IS NULL AND mfa_enabled_at IS NULL
      AND mfa_secret = p_expected_secret AND mfa_last_step IS NOT NULL;
  END IF;
  RETURN FOUND;
END
$$;

-- sys_mfa_accept_step(account_id, step): records the TOTP time step of a code
-- that verified, and says whether it was new: a step at or below the latest
-- accepted one (a replay, or an older code) changes nothing and answers false.
-- The comparison and the write are one statement on the locked row, so two
-- requests presenting one code never both succeed. The account must exist, not
-- be disabled and have a secret (pending or active).
CREATE OR REPLACE FUNCTION public.sys_mfa_accept_step(p_account_id uuid, p_step bigint) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF p_account_id IS NULL OR p_step IS NULL OR p_step < 1 THEN
    RAISE EXCEPTION 'sys_mfa_accept_step needs an account and a positive time step'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.accounts SET mfa_last_step = p_step
  WHERE id = p_account_id AND disabled_at IS NULL AND mfa_secret IS NOT NULL
    AND (mfa_last_step IS NULL OR mfa_last_step < p_step);
  RETURN FOUND;
END
$$;

-- sys_backup_codes_replace(account_id, ids, hashes): gives the account exactly
-- this set of backup codes, deleting the ones it had, in one call. The
-- application generates the identifiers (UUIDv7) and hashes each code with
-- argon2id; `hashes[i]` belongs to `ids[i]`. Between 1 and 20 codes, no null
-- and no empty hash. Answers false, and changes nothing, for an unknown or
-- disabled account and for one whose MFA is not enabled.
CREATE OR REPLACE FUNCTION public.sys_backup_codes_replace(p_account_id uuid, p_ids uuid[], p_hashes bytea[]) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF NOT coalesce(
    p_account_id IS NOT NULL
    AND cardinality(p_ids) BETWEEN 1 AND 20
    AND cardinality(p_ids) = cardinality(p_hashes)
    AND NOT EXISTS (SELECT 1 FROM unnest(p_ids) AS i WHERE i IS NULL)
    AND NOT EXISTS (SELECT 1 FROM unnest(p_hashes) AS h WHERE h IS NULL OR octet_length(h) = 0),
    false
  ) THEN
    RAISE EXCEPTION 'sys_backup_codes_replace needs an account and between 1 and 20 identifiers with as many non-empty hashes'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.accounts a
    WHERE a.id = p_account_id AND a.disabled_at IS NULL AND a.mfa_enabled_at IS NOT NULL
  ) THEN
    RETURN false;
  END IF;
  DELETE FROM public.mfa_backup_codes WHERE account_id = p_account_id;
  INSERT INTO public.mfa_backup_codes (id, account_id, code_hash)
  SELECT c.id, p_account_id, c.code_hash FROM unnest(p_ids, p_hashes) AS c (id, code_hash);
  RETURN true;
END
$$;

-- sys_backup_code_consume(account_id, code_id): marks one unused backup code of
-- the account as used, now, and says whether it did. A code that is already
-- used, one of another account and one that does not exist answer false alike.
-- The test and the write are one statement, so a code presented twice at once
-- is accepted once. The application has verified the typed code against the
-- code's hash before it asks.
CREATE OR REPLACE FUNCTION public.sys_backup_code_consume(p_account_id uuid, p_code_id uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF p_account_id IS NULL OR p_code_id IS NULL THEN
    RAISE EXCEPTION 'sys_backup_code_consume needs an account and a code'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.mfa_backup_codes c SET used_at = clock_timestamp()
  WHERE c.id = p_code_id AND c.account_id = p_account_id AND c.used_at IS NULL
    AND EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = c.account_id AND a.disabled_at IS NULL);
  RETURN FOUND;
END
$$;

-- sys_backup_codes_unused(account_id): the account's backup codes that are not
-- used yet, as the application checks a typed code against them: argon2id
-- hashes are salted, so the database cannot verify a code itself. It lists the
-- code's id and its hash (the argon2id PHC string, as bytes), oldest first, and
-- nothing for an unknown or disabled account and for one whose MFA is not on.
-- The application then consumes the matching code by id
-- (sys_backup_code_consume).
CREATE OR REPLACE FUNCTION public.sys_backup_codes_unused(p_account_id uuid)
  RETURNS TABLE (id uuid, code_hash bytea)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT c.id, c.code_hash
    FROM public.mfa_backup_codes c
    JOIN public.accounts a ON a.id = c.account_id
    WHERE c.account_id = p_account_id AND c.used_at IS NULL
      AND a.disabled_at IS NULL AND a.mfa_enabled_at IS NOT NULL
    ORDER BY c.id
  $$;

-- sys_session_promote(id, account_id, new_token_hash): completes the sign-in of
-- a partial session. The session becomes a full one under the new token, counted
-- as created now, with the sliding window its remember flag chose and the 180-day
-- absolute cap from now, and its failure count is cleared; the old token is
-- refused from then on, and the account's last sign-in time is set. It answers
-- false, and changes nothing, when the account has no such partial session: one
-- that is full, expired, created before the account's password change, of
-- another account, or whose account is disabled or has no MFA. The account row
-- is locked first, as every other function that touches both rows does.
CREATE OR REPLACE FUNCTION public.sys_session_promote(p_id uuid, p_account_id uuid, p_new_token_hash bytea) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_changed_at timestamptz;
BEGIN
  IF p_id IS NULL OR p_account_id IS NULL OR p_new_token_hash IS NULL OR octet_length(p_new_token_hash) <> 32 THEN
    RAISE EXCEPTION 'sys_session_promote needs a session, an account and a 32-byte token hash'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT a.password_changed_at INTO v_changed_at
  FROM public.accounts a
  WHERE a.id = p_account_id AND a.disabled_at IS NULL AND a.mfa_enabled_at IS NOT NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE public.sessions s
  SET level = 'full', token_hash = p_new_token_hash, created_at = v_now, last_seen_at = v_now,
      expires_at = v_now + CASE WHEN s.remember THEN interval '90 days' ELSE interval '30 days' END,
      absolute_expires_at = v_now + interval '180 days', mfa_failures = 0
  WHERE s.id = p_id AND s.account_id = p_account_id AND s.level = 'partial'
    AND s.expires_at > v_now AND s.absolute_expires_at > v_now
    AND (v_changed_at IS NULL OR s.created_at >= v_changed_at);
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE public.accounts SET last_sign_in_at = v_now WHERE id = p_account_id;
  RETURN true;
END
$$;

-- sys_session_mfa_failure(id, account_id): counts one refused code against a
-- partial session and deletes the session at the fifth (doc 02 section 2.3, doc
-- 04 section 4.3). It answers whether the session is over: true when it was
-- deleted by this failure, false while it still stands. A session that is gone,
-- full or of another account answers true and changes nothing. The count and
-- the deletion are one call on the locked row, so failures made at once are all
-- counted.
CREATE OR REPLACE FUNCTION public.sys_session_mfa_failure(p_id uuid, p_account_id uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  c_max_failures CONSTANT smallint := 5;
  v_failures smallint;
BEGIN
  IF p_id IS NULL OR p_account_id IS NULL THEN
    RAISE EXCEPTION 'sys_session_mfa_failure needs a session and an account'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.sessions SET mfa_failures = mfa_failures + 1
  WHERE id = p_id AND account_id = p_account_id AND level = 'partial'
  RETURNING mfa_failures INTO v_failures;
  IF NOT FOUND THEN
    RETURN true;
  END IF;
  IF v_failures >= c_max_failures THEN
    DELETE FROM public.sessions WHERE id = p_id;
    RETURN true;
  END IF;
  RETURN false;
END
$$;

-- sys_mfa_lock(account_id): takes, for the rest of the transaction, the row locks
-- that a change of the account's whole second factor needs, in the one order
-- every writer of these rows uses: the account's backup-code rows (in id
-- order), then the account row, and after them the session row (sys_session_*).
-- A sign-in with a backup code consumes the code row and then promotes the
-- session, which locks the account row; taking the account row before the code
-- rows here would let the two wait for each other. Answers false, and locks
-- nothing of the account, when it does not exist, is disabled or has MFA off. A
-- caller that rewrites the backup codes or turns MFA off calls it first, so that
-- two of them made at once queue instead of each leaving a set of codes the
-- other cannot see (each later statement of the transaction sees what the
-- earlier holder committed).
CREATE OR REPLACE FUNCTION public.sys_mfa_lock(p_account_id uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'sys_mfa_lock needs an account'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM 1 FROM public.mfa_backup_codes c WHERE c.account_id = p_account_id ORDER BY c.id FOR UPDATE;
  PERFORM 1 FROM public.accounts a
  WHERE a.id = p_account_id AND a.disabled_at IS NULL AND a.mfa_enabled_at IS NOT NULL
  FOR UPDATE;
  RETURN FOUND;
END
$$;

-- sys_mfa_disable(account_id): turns the second factor off: clears the secret,
-- its key id, enabled_at and the last accepted step, and deletes every backup
-- code of the account, used ones included. Answers false, and changes nothing,
-- for an unknown or disabled account and for one whose MFA is not enabled. The
-- application has checked the account's second factor and password before it
-- asks, and has called sys_mfa_lock in the same transaction.
CREATE OR REPLACE FUNCTION public.sys_mfa_disable(p_account_id uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'sys_mfa_disable needs an account'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.accounts
  SET mfa_secret = NULL, mfa_secret_key_id = NULL, mfa_enabled_at = NULL, mfa_last_step = NULL
  WHERE id = p_account_id AND disabled_at IS NULL AND mfa_enabled_at IS NOT NULL;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  DELETE FROM public.mfa_backup_codes WHERE account_id = p_account_id;
  RETURN true;
END
$$;

ALTER FUNCTION public.sys_mfa_get_secret(uuid) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_mfa_set(uuid, text, bytea, text, bytea) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_mfa_accept_step(uuid, bigint) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_backup_codes_replace(uuid, uuid[], bytea[]) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_backup_code_consume(uuid, uuid) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_backup_codes_unused(uuid) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_session_promote(uuid, uuid, bytea) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_session_mfa_failure(uuid, uuid) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_mfa_lock(uuid) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_mfa_disable(uuid) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_mfa_get_secret(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_mfa_set(uuid, text, bytea, text, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_mfa_accept_step(uuid, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_backup_codes_replace(uuid, uuid[], bytea[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_backup_code_consume(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_backup_codes_unused(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_session_promote(uuid, uuid, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_session_mfa_failure(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_mfa_lock(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_mfa_disable(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_mfa_get_secret(uuid) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_mfa_set(uuid, text, bytea, text, bytea) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_mfa_accept_step(uuid, bigint) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_backup_codes_replace(uuid, uuid[], bytea[]) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_backup_code_consume(uuid, uuid) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_backup_codes_unused(uuid) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_session_promote(uuid, uuid, bytea) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_session_mfa_failure(uuid, uuid) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_mfa_lock(uuid) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_mfa_disable(uuid) TO slugbase_app;

-- mfa_backup_codes: no app access and no policy, so no role that is subject to
-- row-level security sees a row; slugbase_system, which bypasses it, reaches the
-- table through the functions above.
ALTER TABLE public.mfa_backup_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mfa_backup_codes FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mfa_backup_codes FROM PUBLIC, slugbase_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mfa_backup_codes TO slugbase_system;
