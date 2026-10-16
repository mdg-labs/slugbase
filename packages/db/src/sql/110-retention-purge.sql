-- sys_retention_purge(): the scheduled purge of what has outlived its retention
-- (doc 05 section 6, doc 01 section 8.1). It deletes at most 5 000 rows per table
-- per call and answers, per table, how many rows it deleted; a table with more
-- due rows than that is finished by the next calls. Each table's rule is one
-- statement below, in the order of the doc 05 section 6 table, and the epic that
-- creates a table adds its rule here.
--
-- sessions: past expires_at (the sliding expiry) or absolute_expires_at, whatever
-- the level; the same conditions sys_session_lookup refuses a session on. Rows
-- another statement holds are skipped and found by the next call, so the purge
-- never waits behind a request.
--
-- api_tokens: revoked_at or expires_at more than 30 days in the past, whichever
-- of the two is set and whatever the other says (a revoked token that has not
-- expired, an expired one that was never revoked). A token with no expiry that
-- is not revoked, one that is active, and one revoked or expired less than 30
-- days ago stay; the token lookup refuses a revoked or expired token from the
-- moment it is one, so deleting the row later changes no answer except that a
-- repeated revocation of a token that old is no longer answered as the first
-- one (doc 04 section 2.4). The table is created by the schema migrations, which
-- run before this file is applied, so the plpgsql body resolves it when it runs;
-- the grants it needs are in 150-api-tokens.sql.
--
-- oidc_login_states: past expires_at. A state that was consumed is already gone;
-- sys_oidc_state_consume refuses an expired one from the moment it is, so
-- deleting the row later changes no answer. The grants it needs are in
-- 170-oidc.sql.
--
-- It takes no argument, so a caller cannot widen what it deletes, and it uses no
-- dynamic SQL. It is entered in src/system/registry.ts. slugbase_system, the
-- owner, already holds DELETE on sessions (060-accounts-sessions.sql) and holds
-- DELETE on api_tokens (150-api-tokens.sql); slugbase_app reaches neither table
-- for a delete except through this function.
GRANT CREATE ON SCHEMA public TO slugbase_system;

CREATE OR REPLACE FUNCTION public.sys_retention_purge()
  RETURNS TABLE (table_name text, deleted bigint)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  c_batch CONSTANT integer := 5000;
  v_now timestamptz := clock_timestamp();
  c_token_retention CONSTANT interval := interval '30 days';
  v_deleted bigint;
BEGIN
  DELETE FROM public.sessions
  WHERE id IN (
    SELECT s.id FROM public.sessions s
    WHERE s.expires_at <= v_now OR s.absolute_expires_at <= v_now
    LIMIT c_batch
    FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN QUERY SELECT 'sessions'::text, v_deleted;

  DELETE FROM public.api_tokens
  WHERE id IN (
    SELECT t.id FROM public.api_tokens t
    WHERE t.revoked_at <= v_now - c_token_retention OR t.expires_at <= v_now - c_token_retention
    LIMIT c_batch
    FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN QUERY SELECT 'api_tokens'::text, v_deleted;

  DELETE FROM public.oidc_login_states
  WHERE state_hash IN (
    SELECT s.state_hash FROM public.oidc_login_states s
    WHERE s.expires_at <= v_now
    LIMIT c_batch
    FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN QUERY SELECT 'oidc_login_states'::text, v_deleted;
END
$$;

ALTER FUNCTION public.sys_retention_purge() OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;
REVOKE ALL ON FUNCTION public.sys_retention_purge() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_retention_purge() TO slugbase_app;
