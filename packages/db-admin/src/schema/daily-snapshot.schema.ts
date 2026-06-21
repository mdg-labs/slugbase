import {
  date,
  integer,
  jsonb,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { adminSchema } from "./admin-schema.js";

/** One row per UTC calendar day — admin PRD §7.1. */
export const dailySnapshots = adminSchema.table(
  "daily_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    snapshotDate: date("snapshot_date").notNull(),
    totalAccounts: integer("total_accounts").notNull(),
    newAccounts: integer("new_accounts").notNull(),
    verifiedAccounts: integer("verified_accounts").notNull(),
    mfaEnrolledAccounts: integer("mfa_enrolled_accounts").notNull(),
    totalWorkspaces: integer("total_workspaces").notNull(),
    newWorkspaces: integer("new_workspaces").notNull(),
    workspacesByPlan: jsonb("workspaces_by_plan").notNull(),
    totalBookmarks: integer("total_bookmarks").notNull(),
    planArchivedBookmarks: integer("plan_archived_bookmarks").notNull(),
    totalMemberships: integer("total_memberships").notNull(),
    activeSubscriptions: integer("active_subscriptions").notNull(),
    processedWebhookEvents: integer("processed_webhook_events").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("daily_snapshots_snapshot_date_unique_idx").on(t.snapshotDate)],
);
