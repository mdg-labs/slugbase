import {
  createPublicReadDb,
  fetchAccountById,
  fetchAccountsPage,
  fetchBillingSummary,
  fetchLiveOverviewStats,
  fetchWorkspaceById,
  fetchWorkspacesPage,
  FREE_BOOKMARK_CAP,
  type AccountDetail,
  type AccountListItem,
  type AccountSortField,
  type BillingSummary,
  type LiveOverviewRawStats,
  type PaginatedAccounts,
  type PaginatedWorkspaces,
  type PublicReadDb,
  type SortOrder,
  type WorkspaceDetail,
  type WorkspaceListItem,
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

export type ApiAccountListItem = Omit<AccountListItem, "createdAt"> & {
  createdAt: string;
};

export type ApiAccountDetail = Omit<AccountDetail, "createdAt"> & {
  createdAt: string;
};

export type ApiWorkspaceListItem = Omit<WorkspaceListItem, "createdAt" | "billingPeriodEnd"> & {
  createdAt: string;
  billingPeriodEnd: string | null;
};

export type ApiWorkspaceDetail = Omit<WorkspaceDetail, "createdAt" | "billingPeriodEnd"> & {
  createdAt: string;
  billingPeriodEnd: string | null;
};

export type ApiPaginatedAccounts = {
  items: ApiAccountListItem[];
  pagination: PaginatedAccounts["pagination"];
};

export type ApiPaginatedWorkspaces = {
  items: ApiWorkspaceListItem[];
  pagination: PaginatedWorkspaces["pagination"];
};

export function msToIso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function mapAccountListItem(account: AccountListItem): ApiAccountListItem {
  return {
    ...account,
    createdAt: msToIso(account.createdAt),
  };
}

function mapAccountDetail(account: AccountDetail): ApiAccountDetail {
  return {
    ...account,
    createdAt: msToIso(account.createdAt),
  };
}

function mapWorkspaceListItem(workspace: WorkspaceListItem): ApiWorkspaceListItem {
  return {
    ...workspace,
    createdAt: msToIso(workspace.createdAt),
    billingPeriodEnd:
      workspace.billingPeriodEnd === null
        ? null
        : msToIso(workspace.billingPeriodEnd),
  };
}

function mapWorkspaceDetail(workspace: WorkspaceDetail): ApiWorkspaceDetail {
  return {
    ...workspace,
    createdAt: msToIso(workspace.createdAt),
    billingPeriodEnd:
      workspace.billingPeriodEnd === null
        ? null
        : msToIso(workspace.billingPeriodEnd),
  };
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

  async listAccounts(options: {
    page?: number;
    limit?: number;
    sort?: AccountSortField;
    order?: SortOrder;
  } = {}): Promise<ApiPaginatedAccounts> {
    const result = await fetchAccountsPage(this.publicReadDb, options);
    return {
      items: result.items.map(mapAccountListItem),
      pagination: result.pagination,
    };
  }

  async getAccount(accountId: string): Promise<ApiAccountDetail | null> {
    const account = await fetchAccountById(this.publicReadDb, accountId);
    return account ? mapAccountDetail(account) : null;
  }

  async listWorkspaces(options: {
    page?: number;
    limit?: number;
  } = {}): Promise<ApiPaginatedWorkspaces> {
    const result = await fetchWorkspacesPage(this.publicReadDb, options);
    return {
      items: result.items.map(mapWorkspaceListItem),
      pagination: result.pagination,
    };
  }

  async getWorkspace(workspaceId: string): Promise<ApiWorkspaceDetail | null> {
    const workspace = await fetchWorkspaceById(this.publicReadDb, workspaceId);
    return workspace ? mapWorkspaceDetail(workspace) : null;
  }

  async getBillingSummary(): Promise<BillingSummary> {
    return fetchBillingSummary(this.publicReadDb);
  }
}
