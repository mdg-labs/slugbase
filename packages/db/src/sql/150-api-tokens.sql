-- Row-level security and privileges of api_tokens (doc 05 sections 2.1 and
-- 3.1). The table itself is defined in src/schema/api-tokens.ts.
--
-- Management is on the account policy: an account sees and writes its own
-- tokens only, in an account-level transaction, whatever workspace a token is
-- bound to. slugbase_app may read every column but token_hash, so no list or
-- insert result can carry a hash, may insert a token with the columns a
-- creation sets (not revoked_at, last_used_at, last_used_ip_prefix or
-- created_at, which a token starts without or takes its default for), and may
-- update revoked_at alone, the one column a revocation changes. It holds no
-- DELETE: a token leaves only by the cascade of its membership or account.
-- last_used_at and last_used_ip_prefix are written by the token lookup, a
-- system operation; the application never sets them. slugbase_system, which
-- bypasses the policy, gets the table privileges that lookup needs. The REVOKE
-- below is what takes an INSERT on the whole table from a database that held
-- it: a column-level GRANT alone adds to a table-level one.
ALTER TABLE public.api_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_tokens FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS api_tokens_account ON public.api_tokens;
CREATE POLICY api_tokens_account ON public.api_tokens
  USING (account_id = public.app_account_id())
  WITH CHECK (account_id = public.app_account_id());
REVOKE ALL ON TABLE public.api_tokens FROM PUBLIC, slugbase_app;
GRANT SELECT (
  id, account_id, workspace_id, name, token_prefix, scope, expires_at, last_used_at, revoked_at, created_at
) ON TABLE public.api_tokens TO slugbase_app;
GRANT INSERT (
  id, account_id, workspace_id, name, token_hash, token_prefix, scope, expires_at
) ON TABLE public.api_tokens TO slugbase_app;
GRANT UPDATE (revoked_at) ON TABLE public.api_tokens TO slugbase_app;
GRANT SELECT, UPDATE ON TABLE public.api_tokens TO slugbase_system;
