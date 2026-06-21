import { dailySnapshots } from "@slugbase/db-admin/schema";
import { desc, count } from "drizzle-orm";

import type { AdminDb } from "../db/create-db.js";
import { parsePagination, type ParsedPagination } from "@slugbase/db-admin/public-read";

export type MetricsHistoryItem = {
  snapshotDate: string;
  totalAccounts: number;
  newAccounts: number;
  verifiedAccounts: number;
  mfaEnrolledAccounts: number;
  totalWorkspaces: number;
  newWorkspaces: number;
  workspacesByPlan: {
    free: number;
    personal: number;
    team: number;
  };
  totalBookmarks: number;
  planArchivedBookmarks: number;
  totalMemberships: number;
  activeSubscriptions: number;
  processedWebhookEvents: number;
  computedAt: string;
};

export type PaginatedMetricsHistory = {
  items: MetricsHistoryItem[];
  pagination: ParsedPagination & { total: number };
};

function readCount(value: number | string | bigint | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  return Number(value);
}

function mapSnapshotRow(row: typeof dailySnapshots.$inferSelect): MetricsHistoryItem {
  const workspacesByPlan = row.workspacesByPlan as MetricsHistoryItem["workspacesByPlan"];

  return {
    snapshotDate: row.snapshotDate,
    totalAccounts: row.totalAccounts,
    newAccounts: row.newAccounts,
    verifiedAccounts: row.verifiedAccounts,
    mfaEnrolledAccounts: row.mfaEnrolledAccounts,
    totalWorkspaces: row.totalWorkspaces,
    newWorkspaces: row.newWorkspaces,
    workspacesByPlan,
    totalBookmarks: row.totalBookmarks,
    planArchivedBookmarks: row.planArchivedBookmarks,
    totalMemberships: row.totalMemberships,
    activeSubscriptions: row.activeSubscriptions,
    processedWebhookEvents: row.processedWebhookEvents,
    computedAt: row.computedAt.toISOString(),
  };
}

export class MetricsHistoryService {
  constructor(private readonly adminDb: AdminDb) {}

  async listHistory(options: {
    page?: number;
    limit?: number;
  } = {}): Promise<PaginatedMetricsHistory> {
    const pagination = parsePagination(options.page, options.limit);

    const [totalRow, rows] = await Promise.all([
      this.adminDb.db.select({ value: count() }).from(dailySnapshots),
      this.adminDb.db
        .select()
        .from(dailySnapshots)
        .orderBy(desc(dailySnapshots.snapshotDate))
        .limit(pagination.limit)
        .offset(pagination.offset),
    ]);

    return {
      items: rows.map(mapSnapshotRow),
      pagination: {
        ...pagination,
        total: readCount(totalRow[0]?.value),
      },
    };
  }
}
