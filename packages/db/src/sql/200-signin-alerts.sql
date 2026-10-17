-- The system operation behind the "new sign-in" email (doc 02 section 12, doc 05
-- sections 2.1 and 3.3, doc 10 T7), entered in src/system/registry.ts.
-- slugbase_owner creates the function and hands it to slugbase_system, which
-- needs CREATE on the schema for the length of those statements. sessions stays
-- closed to slugbase_app: this function is the only way the alert reads it.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_signin_alert_context(account_id, ip_prefix): what the sign-in of an account
-- needs to know to decide whether to alert it, read before the new session is
-- created. alerts_on is the account's signin_alerts flag; signed_in_before is
-- whether the account has had a full session before (last_sign_in_at is set by
-- every full session's creation), so the account's first session is never a new
-- device; user_agents holds the user agent of every live session of the account
-- that was created from the same stored IP prefix, each once (a session with no
-- user agent is an empty string, and an unknown prefix matches an unknown
-- prefix). A live
-- session is the one sys_list_sessions lists: full, unexpired (sliding and
-- absolute) and not older than the account's password change. No row for an
-- unknown or disabled account. The caller compares user-agent families, which
-- the database does not know.
CREATE OR REPLACE FUNCTION public.sys_signin_alert_context(p_account_id uuid, p_ip_prefix cidr)
  RETURNS TABLE (alerts_on boolean, signed_in_before boolean, user_agents text[])
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT a.signin_alerts,
           a.last_sign_in_at IS NOT NULL,
           coalesce(
             (SELECT array_agg(DISTINCT coalesce(s.user_agent, ''))
              FROM public.sessions s
              WHERE s.account_id = a.id
                AND s.level = 'full'
                AND s.expires_at > clock_timestamp()
                AND s.absolute_expires_at > clock_timestamp()
                AND (a.password_changed_at IS NULL OR s.created_at >= a.password_changed_at)
                AND s.ip_prefix IS NOT DISTINCT FROM p_ip_prefix),
             ARRAY[]::text[])
    FROM public.accounts a
    WHERE a.id = p_account_id AND a.disabled_at IS NULL
  $$;

ALTER FUNCTION public.sys_signin_alert_context(uuid, cidr) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_signin_alert_context(uuid, cidr) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_signin_alert_context(uuid, cidr) TO slugbase_app;
