export {
  MIRROR_ALLOWLIST,
  MIRROR_TABLE_NAMES,
  type MirrorTableName,
} from "./mirror-allowlist.js";
export { userAccounts } from "./user-account.schema.js";
export { workspaces } from "./workspace.schema.js";
export { workspaceMembers } from "./workspace-member.schema.js";
export { bookmarks } from "./bookmark.schema.js";
export { folders } from "./folder.schema.js";
export { tags } from "./tag.schema.js";
export { teams } from "./team.schema.js";
export { teamMemberships } from "./team-membership.schema.js";
export { workspaceInvitations } from "./workspace-invitation.schema.js";
export { billingWebhookEvents } from "./billing-webhook-event.schema.js";
export { sessions } from "./session.schema.js";

import { billingWebhookEvents } from "./billing-webhook-event.schema.js";
import { bookmarks } from "./bookmark.schema.js";
import { folders } from "./folder.schema.js";
import { sessions } from "./session.schema.js";
import { tags } from "./tag.schema.js";
import { teamMemberships } from "./team-membership.schema.js";
import { teams } from "./team.schema.js";
import { userAccounts } from "./user-account.schema.js";
import { workspaceInvitations } from "./workspace-invitation.schema.js";
import { workspaceMembers } from "./workspace-member.schema.js";
import { workspaces } from "./workspace.schema.js";

/** Mirrored public tables keyed by Postgres table name (admin PRD §8.5). */
export const publicReadTables = {
  user_accounts: userAccounts,
  workspaces,
  workspace_members: workspaceMembers,
  bookmarks,
  folders,
  tags,
  teams,
  team_memberships: teamMemberships,
  workspace_invitations: workspaceInvitations,
  billing_webhook_events: billingWebhookEvents,
  sessions,
} as const;

export type PublicReadTables = typeof publicReadTables;
