import { sql } from "drizzle-orm";
import { bigint, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

export const workspaceInvitations = pgTable(
  "workspace_invitations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    invitedEmail: text("invited_email").notNull(),
    role: text("role").notNull(),
    tokenHash: text("token_hash").notNull(),
    invitedByUserId: text("invited_by_user_id").notNull(),
    acceptedAt: bigint("accepted_at", { mode: "number" }),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
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
