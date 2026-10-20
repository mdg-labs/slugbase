// The deployment-level audit stream (doc 05 section 2.9, doc 02 section 11, doc 10 T3 and T15): the actions an
// instance admin or the first-run setup records in `audit_events` with no workspace. Unlike a workspace event, which
// the audit writer validates before the insert, an instance event is written by a system operation of the database
// (`sys_instance_*` and `sys_setup_audit`), because no tenant policy admits a row with no workspace. This catalog
// is the list of the action names those operations write and the reader accepts, with the metadata each may carry
// (none so far, and the metadata is a closed object like a workspace event's). Adding an action is a change to this
// file, to the operation that writes it and to the list in doc 05 section 2.9.

export const INSTANCE_AUDIT_ACTIONS = {
  "instance.setup_completed": { metadata: {} },
  "instance.status_viewed": { metadata: {} },
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
  /** The coarse network of the request; null when unknown or cleared with the account. */
  readonly ipPrefix: string | null;
}
