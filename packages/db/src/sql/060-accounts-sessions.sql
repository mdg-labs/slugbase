-- Row-level security and privileges of accounts and sessions (doc 05 sections
-- 2.1, 3.1 and 3.3). The tables themselves are defined in src/schema/.
--
-- accounts: forced row-level security with the own-row policy, and a second policy
-- that lets an account read the rows of the members of the workspace it acts in
-- (the members list); the two are permissive, so they add up for a read, and only
-- the own-row policy admits a write. slugbase_app may read
-- every column but password_hash and the mfa_* columns, which only the system
-- operations return (140-mfa.sql). It
-- may update display_name, locale and the preference columns of the profile
-- operation (theme, accent, default_bookmark_view, single_key_shortcuts,
-- signin_alerts, ai_opt_out, analytics_consent, consent_at, onboarding), and
-- only on its own row: the policy's WITH CHECK keeps the id, and no other
-- column is granted. It holds no INSERT or DELETE. slugbase_system gets the table
-- privileges its functions need (it bypasses row-level security).
ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS accounts_tenant ON public.accounts;
CREATE POLICY accounts_tenant ON public.accounts
  USING (id = public.app_account_id())
  WITH CHECK (id = public.app_account_id());
DROP POLICY IF EXISTS accounts_tenant_co_members ON public.accounts;
CREATE POLICY accounts_tenant_co_members ON public.accounts FOR SELECT
  USING (id IN (SELECT m.account_id FROM public.workspace_members m WHERE m.workspace_id = public.app_workspace_id()));
REVOKE ALL ON TABLE public.accounts FROM PUBLIC, slugbase_app;
GRANT SELECT (
  id, email, email_verified_at, pending_email, display_name, password_changed_at, locale, theme, accent,
  default_bookmark_view, single_key_shortcuts, signin_alerts, ai_opt_out, analytics_consent, consent_at,
  onboarding, is_instance_admin, disabled_at, last_sign_in_at, created_at, updated_at
) ON TABLE public.accounts TO slugbase_app;
GRANT UPDATE (
  display_name, locale, theme, accent, default_bookmark_view, single_key_shortcuts, signin_alerts, ai_opt_out, analytics_consent,
  consent_at, onboarding
) ON TABLE public.accounts TO slugbase_app;
GRANT SELECT, UPDATE ON TABLE public.accounts TO slugbase_system;

-- sessions: looked up by token hash before any account is known, so the table
-- has forced row-level security and no policy, and slugbase_app holds no
-- privilege on it. The sys_session_* functions and sys_login_lookup
-- (070-session-functions.sql), owned by slugbase_system, are its only users.
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.sessions FROM PUBLIC, slugbase_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.sessions TO slugbase_system;
