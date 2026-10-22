-- The contract half of the OIDC login state functions (doc 05 sections 3.3 and 5.2, Q52). The eight-argument
-- sys_oidc_state_create and sys_oidc_state_consume were kept while replicas of the release before the invitation
-- intent still called them; the nine-argument sys_oidc_state_create and sys_oidc_state_take of 340-oidc-invitation.sql
-- are the only ones the application calls. The statements run in a migration marked with the contract header, and the
-- registry entry sys_oidc_state_create stays: it covers the nine-argument function.
DROP FUNCTION IF EXISTS public.sys_oidc_state_create(bytea, text, text, text, bytea, text, text, uuid);
DROP FUNCTION IF EXISTS public.sys_oidc_state_consume(bytea, text);
