export type BillingPlanId = "free" | "personal" | "team";
export type BillingTabId = "plan" | "seats" | "history";
export type BillingCheckoutMode = "recurring" | "one_time";

export interface BillingPlanDisplayConfig {
  billingEnabled: boolean;
  personalMonthlyPrice: string;
  personalYearlyPrice: string;
  teamSeatPrice: string;
  supporterPrice: string;
  supporterPromotionEnd: string | null;
  teamBaseSeats: number;
  freeBookmarkCap: number;
}

export interface BillingWorkspaceSummary {
  id: string;
  name: string;
  plan: BillingPlanId;
  planSeats: number | null;
  planArchived: boolean;
  billingCustomerId: string | null;
  billingSubscriptionId: string | null;
  billingStatus: string | null;
  billingPeriodEnd: string | null;
  permanentPersonal: boolean;
}

export interface BillingSettingsData {
  workspace: BillingWorkspaceSummary;
  bookmarkCount: number;
  archivedBookmarkCount: number;
  memberCount: number;
  currentUserId: string;
  currentUserRole: "OWNER" | "ADMIN" | "MEMBER";
  planConfig: BillingPlanDisplayConfig;
  returnUrl: string;
}

export interface StartCheckoutParams {
  workspaceId: string;
  plan: Exclude<BillingPlanId, "free">;
  mode: BillingCheckoutMode;
  successUrl: string;
  cancelUrl: string;
}
