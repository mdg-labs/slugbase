/**
 * The system operations (doc 05 section 3.3): the reviewed list of the
 * `SECURITY DEFINER` functions that cross the tenant or account boundary. A
 * bare name is a function of the `public` schema; a function of another schema
 * is written `schema.name`. Every overload of a listed name is covered by it.
 *
 * `pnpm db:check` fails for a `SECURITY DEFINER` function that is not listed
 * here and for an entry without a function. Adding an entry is a risk-flagged
 * change (doc 10): the function it names ships in a migration of the same
 * change, under the rules of the `system-operations` rule.
 */
export const systemOperations: readonly string[] = [
  "sys_rate_limit_take",
  "sys_rate_limit_purge",
  "sys_login_lookup",
  "sys_session_create",
  "sys_session_lookup",
  "sys_session_revoke",
  "sys_list_sessions",
  "sys_session_revoke_all",
  "app_member_workspace_ids",
  "sys_account_has_password",
  "sys_retention_purge",
  "sys_create_account",
  "sys_create_workspace",
  "sys_setup_status",
  "sys_setup_token_set",
  "sys_complete_setup",
  "sys_account_password_hash",
  "sys_session_reauth",
  "sys_password_set",
  "sys_session_rotate",
  "sys_mfa_get_secret",
  "sys_mfa_set",
  "sys_mfa_accept_step",
  "sys_backup_codes_replace",
  "sys_backup_code_consume",
  "sys_backup_codes_unused",
  "sys_session_promote",
  "sys_session_mfa_failure",
  "sys_mfa_lock",
  "sys_mfa_disable",
  "sys_account_mfa_enabled",
  "sys_api_token_lookup",
  "sys_oidc_state_create",
  "sys_oidc_state_consume",
  "sys_identity_sign_in",
  "sys_identity_link",
  "sys_identity_unlink",
  "sys_identity_reauth",
  "sys_password_set_initial",
  "sys_credential_token_issue",
  "sys_credential_token_consume",
  "sys_signin_alert_context",
  "sys_email_verify",
  "sys_create_personal_workspace",
  "sys_account_email_verified",
  "sys_password_reset",
];
