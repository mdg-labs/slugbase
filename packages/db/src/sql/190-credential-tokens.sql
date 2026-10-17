-- Row-level security, privileges and system operations of the emailed single-use
-- tokens (doc 05 sections 2.1 and 3.3, doc 02 sections 2.5 and 2.6, doc 10 T4 and
-- T8). The table is defined in src/schema/credential-tokens.ts. Both functions
-- are entered in src/system/registry.ts. slugbase_owner creates each function
-- and hands it to slugbase_system, which needs CREATE on the schema for the
-- length of those statements.
--
-- credential_tokens: a token is redeemed anonymously, by possession of the link,
-- so the table has forced row-level security and no policy, and slugbase_app
-- holds no privilege on it. sys_credential_token_issue and
-- sys_credential_token_consume are its only users; sys_retention_purge deletes a
-- token 7 days after it was used or expired (110-retention-purge.sql); its
-- FOR UPDATE SKIP LOCKED is why slugbase_system holds UPDATE as well.
ALTER TABLE public.credential_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credential_tokens FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.credential_tokens FROM PUBLIC, slugbase_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.credential_tokens TO slugbase_system;

GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_credential_token_issue(id, purpose, account_id, hash, target_email,
-- ttl_seconds): stores the SHA-256 of a token the application generated, under
-- the identifier it generated, and deletes the account's older unused tokens of
-- the same purpose in the same call, so at most one token of a purpose works at
-- a time. The expiry is set from the database clock. The account's row is locked
-- first, so two issues for one account queue and the later one leaves exactly
-- its own token. Answers false, changing nothing, for an unknown or disabled
-- account; an argument that breaks the table's checks, or a lifetime outside 1
-- second to 7 days, is refused with invalid_parameter_value.
CREATE OR REPLACE FUNCTION public.sys_credential_token_issue(
  p_id uuid,
  p_purpose text,
  p_account_id uuid,
  p_token_hash bytea,
  p_target_email text,
  p_ttl_seconds integer
) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF NOT coalesce(
    p_id IS NOT NULL AND p_account_id IS NOT NULL
    AND p_purpose IN ('email_verify', 'email_change', 'email_change_cancel', 'password_reset')
    AND octet_length(p_token_hash) = 32
    AND p_ttl_seconds BETWEEN 1 AND 604800,
    false
  ) THEN
    RAISE EXCEPTION 'sys_credential_token_issue needs an identifier, a known purpose, an account, a 32-byte token hash and a lifetime of 1 second to 7 days'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM 1 FROM public.accounts WHERE id = p_account_id AND disabled_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  DELETE FROM public.credential_tokens
  WHERE account_id = p_account_id AND purpose = p_purpose AND used_at IS NULL;

  INSERT INTO public.credential_tokens (id, purpose, account_id, token_hash, target_email, expires_at)
  VALUES (
    p_id, p_purpose, p_account_id, p_token_hash, p_target_email::public.citext,
    clock_timestamp() + p_ttl_seconds * interval '1 second'
  );
  RETURN true;
END
$$;

-- sys_credential_token_consume(purpose, hash): redeems a token. The row is marked
-- used and returned in one statement, so a token is answered once whatever the
-- number of concurrent requests; no row comes back for an unknown token, one of
-- another purpose, one already used and one past its expiry, which a caller does
-- not tell apart. What the redemption does with the account is the caller's.
CREATE OR REPLACE FUNCTION public.sys_credential_token_consume(p_purpose text, p_token_hash bytea)
  RETURNS TABLE (account_id uuid, target_email public.citext)
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    UPDATE public.credential_tokens t
    SET used_at = clock_timestamp()
    WHERE t.purpose = p_purpose
      AND t.token_hash = p_token_hash
      AND t.used_at IS NULL
      AND t.expires_at > clock_timestamp()
    RETURNING t.account_id, t.target_email
  $$;

ALTER FUNCTION public.sys_credential_token_issue(uuid, text, uuid, bytea, text, integer) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_credential_token_consume(text, bytea) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_credential_token_issue(uuid, text, uuid, bytea, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_credential_token_consume(text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_credential_token_issue(uuid, text, uuid, bytea, text, integer) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_credential_token_consume(text, bytea) TO slugbase_app;
