/**
 * Structured MFA audit lines for operators (JSON per line). Never log codes, secrets, or otpauth URLs.
 */

export type MfaAuditEvent =
  | 'mfa_enroll_begin'
  | 'mfa_enroll_begin_conflict'
  | 'mfa_enroll_confirm_success'
  | 'mfa_enroll_confirm_fail'
  | 'mfa_enroll_cancel'
  | 'mfa_disable_success'
  | 'mfa_disable_fail'
  | 'mfa_backup_regenerate_success'
  | 'mfa_backup_regenerate_fail'
  | 'mfa_verify_success'
  | 'mfa_verify_fail'
  | 'mfa_login_stepup_required'
  | 'mfa_email_unverified_block';

export function logMfaAudit(event: MfaAuditEvent, fields?: { user_id?: string }): void {
  const line = JSON.stringify({
    event,
    ts: new Date().toISOString(),
    ...(fields?.user_id ? { user_id: fields.user_id } : {}),
  });
  console.info(line);
}
