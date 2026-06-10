import type {
  BillingInterval,
  BillingPlanDisplayConfig,
  BillingPlanId,
} from "./billing.types.js";

export type PlanFeatureValue = string;

export interface PlanFeatureRow {
  key: string;
  free: PlanFeatureValue;
  personal: PlanFeatureValue;
  team: PlanFeatureValue;
}

const PLAN_RANK: Record<BillingPlanId, number> = {
  free: 0,
  personal: 1,
  team: 2,
};

export function planRank(plan: BillingPlanId): number {
  return PLAN_RANK[plan];
}

/** Plan comparison rows aligned with spec §12.2 — not prototype divergences (§23.4). */
export function buildPlanFeatureRows(config: BillingPlanDisplayConfig): PlanFeatureRow[] {
  const cap = String(config.freeBookmarkCap);
  const teamSeats = String(config.teamBaseSeats);

  return [
    {
      key: "settings.billing.feature.bookmarks",
      free: cap,
      personal: "settings.billing.feature.unlimited",
      team: "settings.billing.feature.unlimited",
    },
    {
      key: "settings.billing.feature.ai_suggestions",
      free: "excluded",
      personal: "included",
      team: "included",
    },
    {
      key: "settings.billing.feature.workspaces",
      free: "1",
      personal: "settings.billing.feature.unlimited",
      team: "settings.billing.feature.unlimited",
    },
    {
      key: "settings.billing.feature.team_sharing",
      free: "excluded",
      personal: "excluded",
      team: "included",
    },
    {
      key: "settings.billing.feature.members",
      free: "excluded",
      personal: "excluded",
      team: teamSeats,
    },
    {
      key: "settings.billing.feature.audit_log",
      free: "excluded",
      personal: "excluded",
      team: "included",
    },
  ];
}

export function resolvePlanCta(
  currentPlan: BillingPlanId,
  targetPlan: BillingPlanId,
): "current" | "upgrade" | "downgrade" {
  const current = planRank(currentPlan);
  const target = planRank(targetPlan);
  if (current === target) return "current";
  return target > current ? "upgrade" : "downgrade";
}

export function formatPlanPriceLabel(
  plan: BillingPlanId,
  config: BillingPlanDisplayConfig,
  interval: BillingInterval = "monthly",
): { price: string; periodKey: string } {
  if (plan === "free") {
    return {
      price: config.personalMonthlyPrice ? "$0" : "—",
      periodKey: "settings.billing.plan_period_forever",
    };
  }
  if (plan === "personal") {
    if (interval === "annual") {
      return {
        price: config.personalYearlyPrice || "—",
        periodKey: "settings.billing.plan_period_yearly",
      };
    }
    return {
      price: config.personalMonthlyPrice || "—",
      periodKey: "settings.billing.plan_period_monthly",
    };
  }
  // team
  if (interval === "annual" && config.teamSeatYearlyPrice) {
    return {
      price: config.teamSeatYearlyPrice,
      periodKey: "settings.billing.plan_period_seat_yearly",
    };
  }
  return {
    price: config.teamSeatPrice || "—",
    periodKey: "settings.billing.plan_period_seat_monthly",
  };
}
