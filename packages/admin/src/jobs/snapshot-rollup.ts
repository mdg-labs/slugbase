import {
  and,
  count,
  eq,
  gte,
  lte,
} from "drizzle-orm";
import {
  billingWebhookEvents,
  bookmarks,
  createPublicReadDb,
  userAccounts,
  workspaceMembers,
  workspaces,
  type PublicReadDb,
} from "@slugbase/db-admin/public-read";

const DAY_MS = 24 * 60 * 60 * 1000;

const ACTIVE_BILLING_STATUSES = new Set(["active", "trialing", "past_due"]);

export type WorkspacesByPlan = {
  free: number;
  personal: number;
  team: number;
};

export type DailySnapshotRollup = {
  snapshotDate: string;
  totalAccounts: number;
  newAccounts: number;
  verifiedAccounts: number;
  mfaEnrolledAccounts: number;
  totalWorkspaces: number;
  newWorkspaces: number;
  workspacesByPlan: WorkspacesByPlan;
  totalBookmarks: number;
  planArchivedBookmarks: number;
  totalMemberships: number;
  activeSubscriptions: number;
  processedWebhookEvents: number;
};

function readCount(value: number | string | bigint | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  return Number(value);
}

export function formatUtcDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${String(year)}-${month}-${day}`;
}

/** UTC calendar day immediately before `reference` (default: now). */
export function priorUtcDate(reference: Date = new Date()): string {
  const prior = new Date(reference);
  prior.setUTCDate(prior.getUTCDate() - 1);
  return formatUtcDate(prior);
}

export function utcDayRangeMs(snapshotDate: string): {
  startMs: number;
  endMs: number;
} {
  const [year, month, day] = snapshotDate.split("-").map(Number);
  if (!year || !month || !day) {
    throw new Error(`Invalid snapshot date: ${snapshotDate}`);
  }

  const startMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  return { startMs, endMs: startMs + DAY_MS - 1 };
}

/** Classifies a workspace into snapshot plan buckets (admin PRD §7.1 / D18). */
export function classifyWorkspacePlanBucket(
  plan: string,
  permanentPersonal: boolean,
): keyof WorkspacesByPlan {
  if (permanentPersonal || plan === "personal") {
    return "personal";
  }
  if (plan === "team") {
    return "team";
  }
  return "free";
}

export function aggregateWorkspacesByPlan(
  rows: ReadonlyArray<{ plan: string; permanentPersonal: boolean }>,
): WorkspacesByPlan {
  const totals: WorkspacesByPlan = { free: 0, personal: 0, team: 0 };
  for (const row of rows) {
    const bucket = classifyWorkspacePlanBucket(row.plan, row.permanentPersonal);
    totals[bucket] += 1;
  }
  return totals;
}

/** Active subscription posture for snapshots (admin PRD §7.1 / D19). */
export function workspaceHasActiveSubscription(
  billingStatus: string | null,
  permanentPersonal: boolean,
): boolean {
  if (permanentPersonal) {
    return true;
  }
  return billingStatus !== null && ACTIVE_BILLING_STATUSES.has(billingStatus);
}

export function countActiveSubscriptions(
  rows: ReadonlyArray<{
    billingStatus: string | null;
    permanentPersonal: boolean;
  }>,
): number {
  return rows.filter((row) =>
    workspaceHasActiveSubscription(row.billingStatus, row.permanentPersonal),
  ).length;
}

export async function fetchDailySnapshotRollup(
  publicReadDb: PublicReadDb,
  snapshotDate: string,
): Promise<DailySnapshotRollup> {
  const { startMs, endMs } = utcDayRangeMs(snapshotDate);
  const { db } = publicReadDb;

  const [
    totalAccountsRow,
    newAccountsRow,
    verifiedAccountsRow,
    mfaEnrolledAccountsRow,
    totalWorkspacesRow,
    newWorkspacesRow,
    workspaceRows,
    activeBookmarksRow,
    planArchivedBookmarksRow,
    totalMembershipsRow,
    processedWebhookEventsRow,
  ] = await Promise.all([
    db
      .select({ value: count() })
      .from(userAccounts)
      .where(lte(userAccounts.createdAt, endMs)),
    db
      .select({ value: count() })
      .from(userAccounts)
      .where(
        and(
          gte(userAccounts.createdAt, startMs),
          lte(userAccounts.createdAt, endMs),
        ),
      ),
    db
      .select({ value: count() })
      .from(userAccounts)
      .where(
        and(
          eq(userAccounts.emailVerified, true),
          lte(userAccounts.createdAt, endMs),
        ),
      ),
    db
      .select({ value: count() })
      .from(userAccounts)
      .where(
        and(
          eq(userAccounts.mfaState, "enrolled"),
          lte(userAccounts.createdAt, endMs),
        ),
      ),
    db
      .select({ value: count() })
      .from(workspaces)
      .where(lte(workspaces.createdAt, endMs)),
    db
      .select({ value: count() })
      .from(workspaces)
      .where(
        and(
          gte(workspaces.createdAt, startMs),
          lte(workspaces.createdAt, endMs),
        ),
      ),
    db
      .select({
        plan: workspaces.plan,
        permanentPersonal: workspaces.permanentPersonal,
        billingStatus: workspaces.billingStatus,
      })
      .from(workspaces)
      .where(lte(workspaces.createdAt, endMs)),
    db
      .select({ value: count() })
      .from(bookmarks)
      .where(eq(bookmarks.planArchived, false)),
    db
      .select({ value: count() })
      .from(bookmarks)
      .where(eq(bookmarks.planArchived, true)),
    db.select({ value: count() }).from(workspaceMembers),
    db.select({ value: count() }).from(billingWebhookEvents),
  ]);

  const workspacesByPlan = aggregateWorkspacesByPlan(workspaceRows);

  return {
    snapshotDate,
    totalAccounts: readCount(totalAccountsRow[0]?.value),
    newAccounts: readCount(newAccountsRow[0]?.value),
    verifiedAccounts: readCount(verifiedAccountsRow[0]?.value),
    mfaEnrolledAccounts: readCount(mfaEnrolledAccountsRow[0]?.value),
    totalWorkspaces: readCount(totalWorkspacesRow[0]?.value),
    newWorkspaces: readCount(newWorkspacesRow[0]?.value),
    workspacesByPlan,
    totalBookmarks: readCount(activeBookmarksRow[0]?.value),
    planArchivedBookmarks: readCount(planArchivedBookmarksRow[0]?.value),
    totalMemberships: readCount(totalMembershipsRow[0]?.value),
    activeSubscriptions: countActiveSubscriptions(workspaceRows),
    processedWebhookEvents: readCount(processedWebhookEventsRow[0]?.value),
  };
}

export function createSnapshotPublicReadDb(databaseUrl: string): PublicReadDb {
  return createPublicReadDb(databaseUrl);
}
