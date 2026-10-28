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
-- sys_oidc_state_take refuses an expired one from the moment it is, so
-- deleting the row later changes no answer. The grants it needs are in
-- 170-oidc.sql.
--
-- credential_tokens: used_at or expires_at more than 7 days in the past, whichever
-- of the two is set and whatever the other says (a token used before its expiry,
-- one that expired unused). A token that is unused and unexpired, and one used or
-- expired less than 7 days ago, stay; sys_credential_token_consume refuses a used
-- or expired token from the moment it is one, so deleting the row later changes
-- no answer. The grants it needs are in 190-credential-tokens.sql.
--
-- workspace_invitations: not pending (accepted or revoked) and closed_at more than 30 days in the past.
-- closed_at is set by the statement that moves the status out of pending and by nothing else, so a later
-- change to the row (the inviter's account deleted, which nulls invited_by) does not move the deletion. A
-- pending invitation stays whatever its expiry says: it is listed, resent and revoked until it is
-- answered, and the accept refuses an expired one from the moment it is. The grants it needs are in
-- 300-workspace-invitations.sql.
--
-- idempotency_keys: past expires_at, which is 24 hours after the key was first used (doc 04 section
-- 6.3). A request that finds an expired key treats it as absent and replaces it, so deleting the row
-- later changes no answer. Rows another statement holds are skipped and found by the next call. The
-- grants it needs are in 310-idempotency-keys.sql.
--
-- audit_events: events created more than p_audit_retention_days days ago, which is the
-- operator's AUDIT_RETENTION_DAYS (Q53), those of a workspace and the instance events (no
-- workspace) alike, in one batch and counted in one row, except the one instance event
-- 'instance.setup_completed': there is one per deployment, and its existence is what makes
-- sys_setup_audit (360-instance-admin.sql, which slugbase_app may call) write it at most once.
-- 0 keeps every event forever and deletes none; a negative number or NULL is refused. Nothing
-- locks an audit row (the application role cannot update one), so the batch is selected without
-- a row lock, which slugbase_system holds no UPDATE privilege for. The grants it needs are in
-- 250-audit-events.sql.
--
-- url_metadata: past expires_at, which is seven days after the page was fetched (doc 05 section 6). A reader treats an expired row as absent and
-- the fetch job replaces it, so deleting the row later changes no answer. Rows another statement holds are skipped and found by the next call.
-- The grants it needs are in 620-url-metadata.sql.
--
-- favicons: past expires_at, which is seven days after the host was fetched (doc 05 section 6). sys_favicon_get answers nothing for an expired row from
-- the moment it is one and the fetch job replaces it, so deleting the row later changes no answer. Rows another statement holds are skipped and found by
-- the next call. The grants it needs are in 630-favicons.sql.
--
-- Every other rule is fixed in the function, and its one argument only chooses how
-- long audit events stay, so a caller cannot widen what the other tables lose; it
-- uses no dynamic SQL. The overload without an argument keeps working for a replica
-- of the previous release during a rolling deploy and deletes no audit event, instance
-- events included (it passes 0). Both are entered in src/system/registry.ts. slugbase_system, the
-- owner, already holds DELETE on sessions (060-accounts-sessions.sql) and holds
-- DELETE on api_tokens (150-api-tokens.sql); slugbase_app reaches neither table
-- for a delete except through this function.
GRANT CREATE ON SCHEMA public TO slugbase_system;

CREATE OR REPLACE FUNCTION public.sys_retention_purge(p_audit_retention_days integer)
  RETURNS TABLE (table_name text, deleted bigint)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  c_batch CONSTANT integer := 5000;
  v_now timestamptz := clock_timestamp();
  c_token_retention CONSTANT interval := interval '30 days';
  c_credential_token_retention CONSTANT interval := interval '7 days';
  c_invitation_retention CONSTANT interval := interval '30 days';
  v_deleted bigint;
BEGIN
  IF p_audit_retention_days IS NULL OR p_audit_retention_days < 0 THEN
    RAISE EXCEPTION 'sys_retention_purge needs an audit retention of 0 (keep forever) or a number of days'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

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

  DELETE FROM public.credential_tokens
  WHERE id IN (
    SELECT t.id FROM public.credential_tokens t
    WHERE t.used_at <= v_now - c_credential_token_retention OR t.expires_at <= v_now - c_credential_token_retention
    LIMIT c_batch
    FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN QUERY SELECT 'credential_tokens'::text, v_deleted;

  DELETE FROM public.workspace_invitations
  WHERE id IN (
    SELECT i.id FROM public.workspace_invitations i
    WHERE i.status <> 'pending' AND i.closed_at <= v_now - c_invitation_retention
    LIMIT c_batch
    FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN QUERY SELECT 'workspace_invitations'::text, v_deleted;

  DELETE FROM public.idempotency_keys
  WHERE (account_id, key) IN (
    SELECT k.account_id, k.key FROM public.idempotency_keys k
    WHERE k.expires_at <= v_now
    LIMIT c_batch
    FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN QUERY SELECT 'idempotency_keys'::text, v_deleted;

  DELETE FROM public.url_metadata
  WHERE (workspace_id, url_canonical) IN (
    SELECT m.workspace_id, m.url_canonical FROM public.url_metadata m
    WHERE m.expires_at <= v_now
    LIMIT c_batch
    FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN QUERY SELECT 'url_metadata'::text, v_deleted;

  DELETE FROM public.favicons
  WHERE host IN (
    SELECT f.host FROM public.favicons f
    WHERE f.expires_at <= v_now
    LIMIT c_batch
    FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN QUERY SELECT 'favicons'::text, v_deleted;

  v_deleted := 0;
  IF p_audit_retention_days > 0 THEN
    DELETE FROM public.audit_events
    WHERE id IN (
      SELECT e.id FROM public.audit_events e
      WHERE e.created_at <= v_now - p_audit_retention_days * interval '1 day'
        AND NOT (e.workspace_id IS NULL AND e.action = 'instance.setup_completed')
      LIMIT c_batch
    );
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
  END IF;
  RETURN QUERY SELECT 'audit_events'::text, v_deleted;
END
$$;

-- The overload of the previous release: the same purge with the audit log kept.
CREATE OR REPLACE FUNCTION public.sys_retention_purge()
  RETURNS TABLE (table_name text, deleted bigint)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  RETURN QUERY SELECT * FROM public.sys_retention_purge(0);
END
$$;

ALTER FUNCTION public.sys_retention_purge(integer) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_retention_purge() OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;
REVOKE ALL ON FUNCTION public.sys_retention_purge(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_retention_purge() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_retention_purge(integer) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_retention_purge() TO slugbase_app;
