// The deployment-level audit stream (doc 05 section 2.9, doc 02 section 11, doc 10 T3 and T15): the actions an
// instance admin or the first-run setup records in `audit_events` with no workspace. Unlike a workspace event, which
// the audit writer validates before the insert, an instance event is written by a system operation of the database
// (`sys_instance_*` and `sys_setup_audit`), because no tenant policy admits a row with no workspace. This catalog
// is the list of the action names those operations write and the reader accepts, with the metadata each may carry
// (a closed object like a workspace event's: a key the catalog does not declare is not shown). Adding an action is a change to this
// file, to the operation that writes it and to the list in doc 05 section 2.9.

// `instance.settings_changed` names the settings that changed (the names of `INSTANCE_SETTING_NAMES`, comma-separated),
// never a value: the notice is free text and nothing in the stream needs it.
export const INSTANCE_AUDIT_ACTIONS = {
  "instance.setup_completed": { metadata: {} },
  "instance.status_viewed": { metadata: {} },
  "instance.settings_viewed": { metadata: {} },
  "instance.settings_changed": { metadata: { settings: "text" } },
  "instance.test_mail_queued": { metadata: {} },
  "instance.workspaces_viewed": { metadata: {} },
  // `owner` is how the first owner was chosen, `account` or `invitation`, and never who it is.
  "instance.workspace_created": { metadata: { owner: "text" } },
  "instance.workspace_deletion_requested": { metadata: {} },
  // The admin made themselves a member of the workspace the event names as entity; the workspace's own log holds the matching `member.instance_admin_joined`.
  "instance.workspace_joined": { metadata: {} },
  // The account actions carry no metadata; all but the list name the account they act on as the entity.
  "instance.accounts_viewed": { metadata: {} },
  "instance.account_admin_granted": { metadata: {} },
  "instance.account_admin_revoked": { metadata: {} },
  "instance.account_disabled": { metadata: {} },
  "instance.account_enabled": { metadata: {} },
  // The recovery actions (doc 02 section 11.2). A reset of the second factor, a resent verification email and an address marked
  // verified carry no metadata. A password-reset link names how it reached the account, `mail` or `link` (returned once to the
  // admin), and never the token.
  "instance.account_mfa_reset": { metadata: {} },
  "instance.account_reset_link_issued": { metadata: { delivery: "text" } },
  "instance.account_verification_resent": { metadata: {} },
  "instance.account_email_verified": { metadata: {} },
} as const;

export type InstanceAuditAction = keyof typeof INSTANCE_AUDIT_ACTIONS;

export const INSTANCE_AUDIT_ACTION_NAMES = Object.keys(INSTANCE_AUDIT_ACTIONS) as readonly InstanceAuditAction[];

export function isInstanceAuditAction(value: unknown): value is InstanceAuditAction {
  return typeof value === "string" && Object.hasOwn(INSTANCE_AUDIT_ACTIONS, value);
}

/** An event of the stream as `sys_list_instance_audit` returns it. */
export interface InstanceAuditEvent {
  readonly id: string;
  readonly createdAt: Date;
  /** Null once the account is deleted; the label stays. */
  readonly actorAccountId: string | null;
  /** The display name at the time; never rewritten. */
  readonly actorLabel: string;
  readonly action: InstanceAuditAction;
  readonly entityType: string | null;
  readonly entityId: string | null;
  /** The metadata the action's entry in the catalog declares, field by field. */
  readonly metadata: Readonly<Record<string, string>>;
  /** The coarse network of the request; null when unknown or cleared with the account. */
  readonly ipPrefix: string | null;
}
