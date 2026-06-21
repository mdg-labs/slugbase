import { text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { adminSchema } from "./admin-schema.js";

/** Platform operator account — admin PRD §7.2. */
export const adminUsers = adminSchema.table(
  "admin_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [uniqueIndex("admin_users_email_unique_idx").on(t.email)],
);
