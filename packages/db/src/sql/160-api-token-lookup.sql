-- The system operation behind the bearer credential (doc 05 section 3.3, doc 01
-- section 4 stage 4). It is entered in src/system/registry.ts. The application
-- role cannot read api_tokens.token_hash, so a token is looked up only here.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_api_token_lookup(token_hash, ip_prefix): the principal behind a bearer
-- token, one round trip per request. A row comes back only for a token that has
-- not been revoked and has not expired, whose account is not disabled and whose
-- workspace is not being deleted; any other hash, a hash of a token that was
-- never issued included, gets no row, so the caller cannot tell the cases apart.
-- The role the account holds in the workspace is not part of the answer: the
-- tenant resolver reads it for every request. A token whose membership ended is
-- gone (the composite foreign key deletes it with the membership). A token last
-- used more than a minute ago has last_used_at and last_used_ip_prefix written
-- in the same call, from the database clock; p_ip_prefix is null when the client
-- address is unknown.
CREATE OR REPLACE FUNCTION public.sys_api_token_lookup(p_token_hash bytea, p_ip_prefix cidr)
  RETURNS TABLE (
    token_id uuid,
    account_id uuid,
    workspace_id uuid,
    scope text
  )
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_row record;
BEGIN
  IF p_token_hash IS NULL OR octet_length(p_token_hash) <> 32 THEN
    RETURN;
  END IF;

  SELECT t.id AS id, t.account_id AS account, t.workspace_id AS workspace, t.scope AS scope,
         t.last_used_at AS last_used
  INTO v_row
  FROM public.api_tokens t
  JOIN public.accounts a ON a.id = t.account_id
  JOIN public.workspaces w ON w.id = t.workspace_id
  WHERE t.token_hash = p_token_hash
    AND t.revoked_at IS NULL
    AND (t.expires_at IS NULL OR t.expires_at > v_now)
    AND a.disabled_at IS NULL
    AND w.deleting_at IS NULL;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF v_row.last_used IS NULL OR v_row.last_used <= v_now - interval '1 minute' THEN
    UPDATE public.api_tokens t
    SET last_used_at = v_now, last_used_ip_prefix = p_ip_prefix
    WHERE t.id = v_row.id AND (t.last_used_at IS NULL OR t.last_used_at <= v_now - interval '1 minute');
  END IF;

  RETURN QUERY SELECT v_row.id, v_row.account, v_row.workspace, v_row.scope;
END
$$;

ALTER FUNCTION public.sys_api_token_lookup(bytea, cidr) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_api_token_lookup(bytea, cidr) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_api_token_lookup(bytea, cidr) TO slugbase_app;
