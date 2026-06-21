import {
  and,
  count,
  eq,
  gt,
  isNull,
  ne,
} from "drizzle-orm";

import type { PublicReadDb } from "./create-public-read-db.js";
import { billingWebhookEvents } from "./billing-webhook-event.schema.js";
import { bookmarks } from "./bookmark.schema.js";
import { sessions } from "./session.schema.js";
import { userAccounts } from "./user-account.schema.js";
import { workspaceInvitations } from "./workspace-invitation.schema.js";
import { workspaces } from "./workspace.schema.js";
import type { LiveOverviewRawStats } from "./overview-queries.types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function readCount(value: number | string | bigint | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  return Number(value);
}

/**
 * Live overview aggregates for the admin home dashboard (admin PRD §9.1).
 * Uses §8.5 column projections only — no sensitive fields selected.
 */
export async function fetchLiveOverviewStats(
  publicReadDb: PublicReadDb,
  nowMs: number = Date.now(),
): Promise<LiveOverviewRawStats> {
  const { db } = publicReadDb;
  const sevenDaysAgo = nowMs - 7 * DAY_MS;
  const thirtyDaysAgo = nowMs - 30 * DAY_MS;

  const [
    totalAccountsRow,
    totalWorkspacesRow,
    signupsLast7DaysRow,
    signupsLast30DaysRow,
    planDistributionRows,
    freeWorkspacesRow,
    paidWorkspacesRow,
    billingStatusRows,
    activeBookmarksRow,
    planArchivedBookmarksRow,
    mfaEnrolledRow,
    emailVerifiedRow,
    activeSessionsRow,
    pendingInvitationsRow,
    processedWebhookTotalRow,
    processedWebhookByTypeRows,
  ] = await Promise.all([
    db.select({ value: count() }).from(userAccounts),
    db.select({ value: count() }).from(workspaces),
    db
      .select({ value: count() })
      .from(userAccounts)
      .where(gt(userAccounts.createdAt, sevenDaysAgo)),
    db
      .select({ value: count() })
      .from(userAccounts)
      .where(gt(userAccounts.createdAt, thirtyDaysAgo)),
    db
      .select({
        plan: workspaces.plan,
        count: count(),
      })
      .from(workspaces)
      .groupBy(workspaces.plan),
    db
      .select({ value: count() })
      .from(workspaces)
      .where(eq(workspaces.plan, "free")),
    db
      .select({ value: count() })
      .from(workspaces)
      .where(ne(workspaces.plan, "free")),
    db
      .select({
        billingStatus: workspaces.billingStatus,
        count: count(),
      })
      .from(workspaces)
      .groupBy(workspaces.billingStatus),
    db
      .select({ value: count() })
      .from(bookmarks)
      .where(eq(bookmarks.planArchived, false)),
    db
      .select({ value: count() })
      .from(bookmarks)
      .where(eq(bookmarks.planArchived, true)),
    db
      .select({ value: count() })
      .from(userAccounts)
      .where(eq(userAccounts.mfaState, "enrolled")),
    db
      .select({ value: count() })
      .from(userAccounts)
      .where(eq(userAccounts.emailVerified, true)),
    db
      .select({ value: count() })
      .from(sessions)
      .where(gt(sessions.expiresAt, nowMs)),
    db
      .select({ value: count() })
      .from(workspaceInvitations)
      .where(
        and(
          isNull(workspaceInvitations.acceptedAt),
          gt(workspaceInvitations.expiresAt, nowMs),
        ),
      ),
    db.select({ value: count() }).from(billingWebhookEvents),
    db
      .select({
        eventType: billingWebhookEvents.eventType,
        count: count(),
      })
      .from(billingWebhookEvents)
      .groupBy(billingWebhookEvents.eventType),
  ]);

  const totalAccounts = readCount(totalAccountsRow[0]?.value);
  const totalWorkspaces = readCount(totalWorkspacesRow[0]?.value);

  return {
    totalAccounts,
    totalWorkspaces,
    signupsLast7Days: readCount(signupsLast7DaysRow[0]?.value),
    signupsLast30Days: readCount(signupsLast30DaysRow[0]?.value),
    planDistribution: planDistributionRows.map((row) => ({
      plan: row.plan,
      count: readCount(row.count),
    })),
    paidVsFree: {
      freeWorkspaces: readCount(freeWorkspacesRow[0]?.value),
      paidWorkspaces: readCount(paidWorkspacesRow[0]?.value),
      byBillingStatus: billingStatusRows.map((row) => ({
        billingStatus: row.billingStatus,
        count: readCount(row.count),
      })),
    },
    activeBookmarks: readCount(activeBookmarksRow[0]?.value),
    planArchivedBookmarks: readCount(planArchivedBookmarksRow[0]?.value),
    mfaAdoption: {
      enrolled: readCount(mfaEnrolledRow[0]?.value),
      total: totalAccounts,
    },
    emailVerification: {
      verified: readCount(emailVerifiedRow[0]?.value),
      total: totalAccounts,
    },
    activeSessions: readCount(activeSessionsRow[0]?.value),
    pendingInvitations: readCount(pendingInvitationsRow[0]?.value),
    processedWebhookEvents: {
      total: readCount(processedWebhookTotalRow[0]?.value),
      byEventType: processedWebhookByTypeRows.map((row) => ({
        eventType: row.eventType,
        count: readCount(row.count),
      })),
    },
  };
}
