/**
 * Allowlisted `public.*` columns mirrored for admin read-only queries (admin PRD §8.5).
 * CI compares these snake_case names against `packages/backend/src/db/schema/*`.
 */
export const MIRROR_ALLOWLIST = {
  user_accounts: [
    "id",
    "email",
    "name",
    "created_at",
    "email_verified",
    "mfa_state",
    "language",
    "ai_opt_out",
  ],
  workspaces: [
    "id",
    "name",
    "slug",
    "plan",
    "plan_seats",
    "plan_archived",
    "billing_status",
    "billing_period_end",
    "permanent_personal",
    "created_at",
  ],
  workspace_members: ["workspace_id", "user_id", "role"],
  bookmarks: ["workspace_id", "plan_archived", "access_count"],
  folders: ["id", "workspace_id"],
  tags: ["id", "workspace_id"],
  teams: ["id", "workspace_id"],
  team_memberships: ["workspace_id"],
  workspace_invitations: ["workspace_id", "accepted_at", "expires_at"],
  billing_webhook_events: ["event_type"],
  sessions: ["expires_at"],
} as const satisfies Record<string, readonly string[]>;

export type MirrorTableName = keyof typeof MIRROR_ALLOWLIST;

export const MIRROR_TABLE_NAMES = Object.keys(MIRROR_ALLOWLIST) as MirrorTableName[];
