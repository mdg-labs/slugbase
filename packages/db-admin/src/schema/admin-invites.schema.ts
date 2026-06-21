import { text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { adminSchema } from "./admin-schema.js";
import { adminUsers } from "./admin-users.schema.js";

/** Invite-only admin onboarding — admin PRD §7.4. */
export const adminInvites = adminSchema.table(
  "admin_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    role: text("role").notNull(),
    tokenHash: text("token_hash").notNull(),
    invitedBy: uuid("invited_by")
      .notNull()
      .references(() => adminUsers.id),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("admin_invites_token_hash_unique_idx").on(t.tokenHash)],
);
