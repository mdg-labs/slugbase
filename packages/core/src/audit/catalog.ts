// The audit catalog (doc 05 section 2.9, doc 02 section 10, doc 01 section 4 step 12): the actions a
// workspace's audit log records, each named in the dotted style of the domain events and each with the
// metadata it may carry. Metadata is validated before a row exists and is a closed object: a key the
// catalog does not declare is refused, so a secret, an email address or a URL has no field to travel in
// (doc 10 T7). Adding an action is a change to this file and to the list of recorded actions in doc 02
// section 10. The catalog holds the actions that are recorded so far.

/** The groups the audit log filters by. */
export const AUDIT_CATEGORIES = ["workspace", "member", "invitation", "team", "bookmark", "share"] as const;

export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

/** The kinds of field a metadata object holds: a text of bounded length, an identifier, or a count (a whole number, as decimal text). */
export type AuditMetadataField =
  | { readonly type: "text"; readonly minLength: number; readonly maxLength: number }
  | { readonly type: "uuid" }
  | { readonly type: "count" };

export interface AuditActionDefinition {
  readonly category: AuditCategory;
  readonly metadata: Readonly<Record<string, AuditMetadataField>>;
}

/** A workspace's name has 1 to 64 characters (doc 02 section 3.1); the metadata of its creation records it. */
const WORKSPACE_NAME: AuditMetadataField = { type: "text", minLength: 1, maxLength: 64 };

/** A team's name has 1 to 64 characters (doc 02 section 4); the events of a team record it and nothing else of the team or its members. */
const TEAM_NAME: AuditMetadataField = { type: "text", minLength: 1, maxLength: 64 };

/** What a share was granted to: `member` or `team`. */
const SHARE_TARGET_KIND: AuditMetadataField = { type: "text", minLength: 4, maxLength: 6 };

/** The name a share's target had: a member's display name (1 to 100 characters) or a team's name (1 to 64). */
const SHARE_TARGET_NAME: AuditMetadataField = { type: "text", minLength: 1, maxLength: 100 };

/** The name of a setting and the value it had or has, as text: a flag is `true` or `false`. */
const SETTING_NAME: AuditMetadataField = { type: "text", minLength: 1, maxLength: 64 };
const SETTING_VALUE: AuditMetadataField = { type: "text", minLength: 1, maxLength: 64 };

/** A member's role: `owner`, `admin` or `member`. */
const MEMBER_ROLE: AuditMetadataField = { type: "text", minLength: 5, maxLength: 6 };

/** Whether an option was chosen: `true` or `false`. */
const FLAG: AuditMetadataField = { type: "text", minLength: 4, maxLength: 5 };

/** What happens to a departing member's content: `transfer` or `delete`. */
const CONTENT_CHOICE: AuditMetadataField = { type: "text", minLength: 6, maxLength: 8 };

/** How many rows a bulk change touched; the one thing such an event says about them, never a title or a URL. */
const COUNT: AuditMetadataField = { type: "count" };

// `transferTo`, and `targetId` of a share of a bookmark or a folder with a member, name an account: the deletion of that account removes the field from the stored row
// (doc 05 section 7.1), so the parser below validates what is written and is not the check for a row that was read back.
export const AUDIT_ACTIONS = {
  "workspace.created": { category: "workspace", metadata: { name: WORKSPACE_NAME } },
  "workspace.renamed": { category: "workspace", metadata: { from: WORKSPACE_NAME, to: WORKSPACE_NAME } },
  "workspace.settings_changed": { category: "workspace", metadata: { setting: SETTING_NAME, from: SETTING_VALUE, to: SETTING_VALUE } },
  "workspace.deletion_requested": { category: "workspace", metadata: {} },
  "workspace.ownership_transferred": { category: "workspace", metadata: { demoteSelf: FLAG } },
  "member.role_changed": { category: "member", metadata: { from: MEMBER_ROLE, to: MEMBER_ROLE } },
  "member.removed": { category: "member", metadata: { content: CONTENT_CHOICE, transferTo: { type: "uuid" } } },
  "member.left": { category: "member", metadata: { content: CONTENT_CHOICE, transferTo: { type: "uuid" } } },
  "member.joined": { category: "member", metadata: { role: MEMBER_ROLE } },
  // An instance admin made themselves a member of the workspace (doc 02 section 11.1). It is its own action, not a `member.joined`, so the
  // owners who read the log can tell an operator's privilege from an invitation accepted; the instance stream holds the matching event.
  "member.instance_admin_joined": { category: "member", metadata: { role: MEMBER_ROLE } },
  // The invited address is personal data and has no field: the event names the invitation and the role it grants.
  "invitation.created": { category: "invitation", metadata: { role: MEMBER_ROLE } },
  "invitation.resent": { category: "invitation", metadata: { role: MEMBER_ROLE } },
  "invitation.link_created": { category: "invitation", metadata: { role: MEMBER_ROLE } },
  "invitation.revoked": { category: "invitation", metadata: { role: MEMBER_ROLE } },
  // The name of a team is the one thing its events say: a member's name or address, and the team's description, have no field (doc 10 T7).
  "team.created": { category: "team", metadata: { name: TEAM_NAME } },
  "team.updated": { category: "team", metadata: { from: TEAM_NAME, to: TEAM_NAME } },
  "team.deleted": { category: "team", metadata: { name: TEAM_NAME } },
  "team.members_changed": { category: "team", metadata: { name: TEAM_NAME } },
  // A composition archived, or restored, bookmarks of the workspace (doc 01 section 13.3): the number whose state changed, and nothing about them.
  "bookmark.archived": { category: "bookmark", metadata: { count: COUNT } },
  "bookmark.restored": { category: "bookmark", metadata: { count: COUNT } },
  // A member deleted several of their bookmarks in one request (doc 02 section 5.8): the number deleted, and nothing about them.
  "bookmark.bulk_deleted": { category: "bookmark", metadata: { count: COUNT } },
  // A bookmark or a folder was shared with a member or a team, or a share was revoked (doc 02 section 8). The event is about the bookmark or the folder (its
  // entity type says which) and says nothing of it but its identifier: the log is read by administrators, who have no implicit access to a member's content.
  // The target is named by kind, identifier and the name it had; the deletion of a member's account removes `targetId` from the events that name it (doc 05 section 7.1).
  "share.granted": { category: "share", metadata: { targetKind: SHARE_TARGET_KIND, targetId: { type: "uuid" }, targetName: SHARE_TARGET_NAME } },
  "share.revoked": { category: "share", metadata: { targetKind: SHARE_TARGET_KIND, targetId: { type: "uuid" }, targetName: SHARE_TARGET_NAME } },
} as const satisfies Record<string, AuditActionDefinition>;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

export const AUDIT_ACTION_NAMES = Object.keys(AUDIT_ACTIONS) as readonly AuditAction[];

/** The metadata of the action `Name`, field by field. */
export type AuditMetadata<Name extends AuditAction = AuditAction> = {
  readonly [Key in keyof (typeof AUDIT_ACTIONS)[Name]["metadata"]]: string;
};

export function isAuditAction(value: unknown): value is AuditAction {
  return typeof value === "string" && Object.hasOwn(AUDIT_ACTIONS, value);
}

const COUNT_TEXT = /^(?:0|[1-9][0-9]{0,8})$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Thrown when an audit event is not the one the catalog describes; the message names fields, never values. */
export class AuditMetadataError extends Error {
  constructor(problem: string) {
    super(`the audit event ${problem}`);
    this.name = "AuditMetadataError";
  }
}

/** Whether `value` is a UUID, which the audit row holds as such. */
export function isAuditIdentifier(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function fits(field: AuditMetadataField, value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  if (field.type === "uuid") {
    return UUID.test(value);
  }
  if (field.type === "count") {
    return COUNT_TEXT.test(value);
  }
  // PostgreSQL counts a character as one code point, as Array.from does.
  const length = Array.from(value).length;
  return length >= field.minLength && length <= field.maxLength;
}

/** The metadata of the action `name` as the catalog declares it: exactly its fields, each of its kind; anything else throws. */
export function parseAuditMetadata<Name extends AuditAction>(name: Name, value: unknown): AuditMetadata<Name> {
  if (!isAuditAction(name)) {
    throw new AuditMetadataError("names an action outside the catalog");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AuditMetadataError(`of ${name} must have metadata that is an object`);
  }
  const fields: Readonly<Record<string, AuditMetadataField>> = AUDIT_ACTIONS[name].metadata;
  const given = value as Readonly<Record<string, unknown>>;
  for (const key of Object.keys(given)) {
    if (!Object.hasOwn(fields, key)) {
      throw new AuditMetadataError(`of ${name} has the metadata field ${key}, which the catalog does not declare`);
    }
  }
  const parsed: Record<string, string> = {};
  for (const [key, field] of Object.entries(fields)) {
    const item = given[key];
    if (!fits(field, item)) {
      throw new AuditMetadataError(`of ${name} has no valid metadata field ${key}`);
    }
    parsed[key] = item as string;
  }
  return parsed as AuditMetadata<Name>;
}
