import {
  createPublicReadDb,
  fetchLiveOverviewStats,
  FREE_BOOKMARK_CAP,
  type LiveOverviewRawStats,
  type PublicReadDb,
} from "@slugbase/db-admin/public-read";

export { FREE_BOOKMARK_CAP };

/** API-facing live overview (admin PRD §9.1). */
export type LiveOverviewStats = {
  computedAt: string;
  freeBookmarkCap: number;
  totalAccounts: number;
  totalWorkspaces: number;
  signupsLast7Days: number;
  signupsLast30Days: number;
  planDistribution: Array<{ plan: string; count: number }>;
  paidVsFree: LiveOverviewRawStats["paidVsFree"];
  activeBookmarks: number;
  planArchivedBookmarks: number;
  mfaAdoption: LiveOverviewRawStats["mfaAdoption"];
  emailVerification: LiveOverviewRawStats["emailVerification"];
  activeSessions: number;
  pendingInvitations: number;
  processedWebhookEvents: LiveOverviewRawStats["processedWebhookEvents"];
};

export function msToIso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

export class ProductReadService {
  private readonly publicReadDb: PublicReadDb;

  constructor(databaseUrl: string) {
    this.publicReadDb = createPublicReadDb(databaseUrl);
  }

  async close(): Promise<void> {
    await this.publicReadDb.close();
  }

  async getLiveOverview(nowMs: number = Date.now()): Promise<LiveOverviewStats> {
    const raw = await fetchLiveOverviewStats(this.publicReadDb, nowMs);

    return {
      computedAt: msToIso(nowMs),
      freeBookmarkCap: FREE_BOOKMARK_CAP,
      ...raw,
    };
  }
}
