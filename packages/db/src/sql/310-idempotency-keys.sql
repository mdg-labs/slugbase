-- Row-level security and privileges of idempotency_keys (doc 05 sections 2.10 and 3.1, doc 04 section 6.3, doc
-- 10 T1). The table itself is defined in src/schema/idempotency-keys.ts.
--
-- The rows are the account's own: one policy on the account of the transaction, for reads and writes, so a key
-- of another account is neither seen nor changed whatever UUID is named, and the same UUID from two accounts
-- is two rows. slugbase_app may insert a key with the columns a request names (status starts in_progress and
-- created_at takes its default), and update what completing a key or reusing an expired one replaces; it never
-- deletes a row: sys_retention_purge removes a key once it has expired (110-retention-purge.sql), and the
-- cascade of the account removes the rest. slugbase_system, which bypasses the policy, gets the privileges
-- the purge needs; its FOR UPDATE SKIP LOCKED is why it holds UPDATE as well.
ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.idempotency_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS idempotency_keys_account ON public.idempotency_keys;
CREATE POLICY idempotency_keys_account ON public.idempotency_keys
  USING (account_id = public.app_account_id())
  WITH CHECK (account_id = public.app_account_id());
REVOKE ALL ON TABLE public.idempotency_keys FROM PUBLIC, slugbase_app;
GRANT SELECT ON TABLE public.idempotency_keys TO slugbase_app;
GRANT INSERT (account_id, key, operation, request_hash, expires_at) ON TABLE public.idempotency_keys TO slugbase_app;
GRANT UPDATE (operation, request_hash, status, response_status, response_body, created_at, expires_at) ON TABLE public.idempotency_keys TO slugbase_app;
GRANT SELECT, UPDATE, DELETE ON TABLE public.idempotency_keys TO slugbase_system;
