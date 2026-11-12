import { AUDIT_EVENT_ACTIONS, AUDIT_EVENT_CATEGORIES } from "@slugbase/contracts";
import type { TFunction } from "i18next";
import type { AuditEvent } from "./audit.ts";

type AuditAction = (typeof AUDIT_EVENT_ACTIONS)[number];
type AuditCategory = (typeof AUDIT_EVENT_CATEGORIES)[number];

// One literal `t()` call per label, so that the catalog check sees each key; a test holds that every action and category of the contract has its entry in both languages.
const ACTION_LABELS: Readonly<Record<AuditAction, (t: TFunction) => string>> = {
  "workspace.created": (t) => t("audit.actions.workspace.created"),
  "workspace.renamed": (t) => t("audit.actions.workspace.renamed"),
  "workspace.settings_changed": (t) => t("audit.actions.workspace.settings_changed"),
  "workspace.deletion_requested": (t) => t("audit.actions.workspace.deletion_requested"),
  "workspace.ownership_transferred": (t) => t("audit.actions.workspace.ownership_transferred"),
  "member.role_changed": (t) => t("audit.actions.member.role_changed"),
  "member.removed": (t) => t("audit.actions.member.removed"),
  "member.left": (t) => t("audit.actions.member.left"),
  "member.joined": (t) => t("audit.actions.member.joined"),
  "member.instance_admin_joined": (t) => t("audit.actions.member.instance_admin_joined"),
  "invitation.created": (t) => t("audit.actions.invitation.created"),
  "invitation.resent": (t) => t("audit.actions.invitation.resent"),
  "invitation.link_created": (t) => t("audit.actions.invitation.link_created"),
  "invitation.revoked": (t) => t("audit.actions.invitation.revoked"),
  "team.created": (t) => t("audit.actions.team.created"),
  "team.updated": (t) => t("audit.actions.team.updated"),
  "team.deleted": (t) => t("audit.actions.team.deleted"),
  "team.members_changed": (t) => t("audit.actions.team.members_changed"),
  "bookmark.archived": (t) => t("audit.actions.bookmark.archived"),
  "bookmark.restored": (t) => t("audit.actions.bookmark.restored"),
  "bookmark.bulk_deleted": (t) => t("audit.actions.bookmark.bulk_deleted"),
  "bookmark.operator_deleted": (t) => t("audit.actions.bookmark.operator_deleted"),
  "share.granted": (t) => t("audit.actions.share.granted"),
  "share.revoked": (t) => t("audit.actions.share.revoked"),
  "share.bulk_granted": (t) => t("audit.actions.share.bulk_granted"),
  "export.created": (t) => t("audit.actions.export.created"),
  "import.completed": (t) => t("audit.actions.import.completed"),
};

const CATEGORY_LABELS: Readonly<Record<AuditCategory, (t: TFunction) => string>> = {
  workspace: (t) => t("audit.categories.workspace"),
  member: (t) => t("audit.categories.member"),
  invitation: (t) => t("audit.categories.invitation"),
  team: (t) => t("audit.categories.team"),
  bookmark: (t) => t("audit.categories.bookmark"),
  share: (t) => t("audit.categories.share"),
  export: (t) => t("audit.categories.export"),
  import: (t) => t("audit.categories.import"),
};

const ENTITY_LABELS: Readonly<Record<string, (t: TFunction) => string>> = {
  workspace: (t) => t("audit.entities.workspace"),
  member: (t) => t("audit.entities.member"),
  invitation: (t) => t("audit.entities.invitation"),
  team: (t) => t("audit.entities.team"),
  bookmark: (t) => t("audit.entities.bookmark"),
  folder: (t) => t("audit.entities.folder"),
};

// The metadata fields of `packages/core/src/audit/catalog.ts`, which the contract does not list (an event carries any text-to-text map): one literal `t()` call per field, so that the
// catalog check sees each key. A field added to the catalog is added here and to both catalogs; until then the panel shows the field under its recorded key.
const METADATA_LABELS: Readonly<Record<string, (t: TFunction) => string>> = {
  name: (t) => t("audit.metadata.name"),
  from: (t) => t("audit.metadata.from"),
  to: (t) => t("audit.metadata.to"),
  setting: (t) => t("audit.metadata.setting"),
  demoteSelf: (t) => t("audit.metadata.demoteSelf"),
  content: (t) => t("audit.metadata.content"),
  transferTo: (t) => t("audit.metadata.transferTo"),
  role: (t) => t("audit.metadata.role"),
  count: (t) => t("audit.metadata.count"),
  targetKind: (t) => t("audit.metadata.targetKind"),
  targetId: (t) => t("audit.metadata.targetId"),
  targetName: (t) => t("audit.metadata.targetName"),
  bookmarks: (t) => t("audit.metadata.bookmarks"),
  folders: (t) => t("audit.metadata.folders"),
  tags: (t) => t("audit.metadata.tags"),
  shared: (t) => t("audit.metadata.shared"),
  created: (t) => t("audit.metadata.created"),
  skipped: (t) => t("audit.metadata.skipped"),
  failed: (t) => t("audit.metadata.failed"),
  slugsDropped: (t) => t("audit.metadata.slugsDropped"),
  foldersCreated: (t) => t("audit.metadata.foldersCreated"),
  tagsCreated: (t) => t("audit.metadata.tagsCreated"),
  reason: (t) => t("audit.metadata.reason"),
};

function labelOf<Key extends string>(labels: Readonly<Record<Key, (t: TFunction) => string>>, t: TFunction, key: string): string | undefined {
  return Object.hasOwn(labels, key) ? labels[key as Key](t) : undefined;
}

/** The action's name in the active language. An action the catalog no longer holds, which an old event may carry, shows its recorded name. */
export function actionLabel(t: TFunction, action: string): string {
  return labelOf(ACTION_LABELS, t, action) ?? action;
}

/** The category's name in the active language; an event whose action the catalog no longer holds has no category. */
export function categoryLabel(t: TFunction, category: AuditCategory): string {
  return CATEGORY_LABELS[category](t);
}

/** The kind of thing an event is about, in the active language; a kind this version does not know shows its recorded name. */
export function entityLabel(t: TFunction, type: string): string {
  return labelOf(ENTITY_LABELS, t, type) ?? type;
}

/** The name of a metadata field in the active language; a field this version does not know shows its recorded key. */
export function metadataLabel(t: TFunction, key: string): string {
  return labelOf(METADATA_LABELS, t, key) ?? key;
}

// The metadata keys that name the thing an event is about, and the actions whose `to` is such a name (for the others it is a role or a setting's value).
const NAMED_BY_TO: ReadonlySet<string> = new Set(["workspace.renamed", "team.updated"]);

/** The name the event records for its target, when it records one: a team, a workspace, or the member or team a share went to. */
export function targetNameOf(event: Pick<AuditEvent, "action" | "metadata">): string | undefined {
  const { metadata } = event;
  const candidates = [metadata["name"], metadata["targetName"], NAMED_BY_TO.has(event.action) ? metadata["to"] : undefined];
  return candidates.find((candidate) => candidate !== undefined && candidate !== "");
}
