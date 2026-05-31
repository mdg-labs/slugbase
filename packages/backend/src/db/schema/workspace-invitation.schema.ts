import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const workspaceInvitations = sqliteTable(
  "workspace_invitations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    invitedEmail: text("invited_email").notNull(),
    role: text("role").notNull(),
    tokenHash: text("token_hash").notNull(),
    invitedByUserId: text("invited_by_user_id").notNull(),
    acceptedAt: integer("accepted_at", { mode: "timestamp_ms" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("workspace_invitations_token_hash_unique_idx").on(t.tokenHash),
    uniqueIndex("workspace_invitations_pending_email_unique_idx")
      .on(t.workspaceId, t.invitedEmail)
      .where(sql`${t.acceptedAt} IS NULL`),
    index("workspace_invitations_workspace_id_idx").on(t.workspaceId),
    index("workspace_invitations_invited_email_idx").on(t.invitedEmail),
  ],
);
