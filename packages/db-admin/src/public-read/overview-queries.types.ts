/** Raw aggregate counts from `public.*` (admin PRD §9.1). Timestamps remain epoch ms. */
export type LiveOverviewRawStats = {
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
  mfaAdoption: {
    enrolled: number;
    total: number;
  };
  emailVerification: {
    verified: number;
    total: number;
  };
  activeSessions: number;
  pendingInvitations: number;
  processedWebhookEvents: {
    total: number;
    byEventType: Array<{ eventType: string; count: number }>;
  };
};
