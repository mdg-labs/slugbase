export const FREE_BOOKMARK_CAP = 50;

export type AdminUser = {
  id: string;
  email: string;
  role: string;
};

export type LiveOverviewStats = {
  computedAt: string;
  freeBookmarkCap: number;
  totalAccounts: number;
  totalWorkspaces: number;
  signupsLast7Days: number;
  signupsLast30Days: number;
  planDistribution: Array<{ plan: string; count: number }>;
  paidVsFree: {
    freeWorkspaces: number;
    paidWorkspaces: number;
    byBillingStatus: Array<{ billingStatus: string | null; count: number }>;
  };
  activeBookmarks: number;
  planArchivedBookmarks: number;
  mfaAdoption: { enrolled: number; total: number };
  emailVerification: { verified: number; total: number };
  activeSessions: number;
  pendingInvitations: number;
  processedWebhookEvents: {
    total: number;
    byEventType: Array<{ eventType: string; count: number }>;
  };
};

export type AccountListItem = {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  emailVerified: boolean;
  mfaState: string;
  language: string;
  aiOptOut: boolean;
  workspaceCount: number;
};

export type AccountMembership = {
  workspaceId: string;
  workspaceName: string;
  role: string;
};

export type AccountDetail = AccountListItem & {
  memberships: AccountMembership[];
};

export type WorkspaceListItem = {
  id: string;
  name: string;
  slug: string;
  plan: string;
  planSeats: number | null;
  planArchived: boolean;
  billingStatus: string | null;
  billingPeriodEnd: string | null;
  permanentPersonal: boolean;
  createdAt: string;
  memberCount: number;
  activeBookmarkCount: number;
  archivedBookmarkCount: number;
};

export type WorkspaceMemberDetail = {
  userId: string;
  email: string;
  role: string;
};

export type WorkspaceDetail = WorkspaceListItem & {
  members: WorkspaceMemberDetail[];
  freeBookmarkCap: number | null;
  bookmarkUsage: {
    active: number;
    archived: number;
    cap: number | null;
  };
};

export type Pagination = {
  page: number;
  limit: number;
  offset: number;
  total: number;
};

export type PaginatedAccounts = {
  items: AccountListItem[];
  pagination: Pagination;
};

export type PaginatedWorkspaces = {
  items: WorkspaceListItem[];
  pagination: Pagination;
};

export type MetricsHistoryItem = {
  snapshotDate: string;
  totalAccounts: number;
  newAccounts: number;
  verifiedAccounts: number;
  mfaEnrolledAccounts: number;
  totalWorkspaces: number;
  newWorkspaces: number;
  workspacesByPlan: { free: number; personal: number; team: number };
  totalBookmarks: number;
  planArchivedBookmarks: number;
  totalMemberships: number;
  activeSubscriptions: number;
  processedWebhookEvents: number;
  computedAt: string;
};

export type PaginatedMetricsHistory = {
  items: MetricsHistoryItem[];
  pagination: Pagination;
};

export type BillingSummary = {
  stripeDashboardUrl: string;
  workspacesByPlan: Array<{ plan: string; count: number }>;
  workspacesByBillingStatus: Array<{ billingStatus: string | null; count: number }>;
  teamSeatUtilization: Array<{
    workspaceId: string;
    workspaceName: string;
    planSeats: number | null;
    memberCount: number;
    utilization: number | null;
  }>;
};

export type AdminInvite = {
  id: string;
  email: string;
  role: string;
  invitedBy: string;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
};

export type ApiError = {
  error: string;
};
