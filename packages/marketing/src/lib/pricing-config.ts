/** Marketing pricing display helpers (spec §12.1).

Live paid-tier amounts are fetched at runtime from GET /pricing/public (no auth).
Static shell uses DEFAULT_FREE_BOOKMARK_CAP; client hydration fills prices. */

import type { PricingResponse } from "./pricing-api-types.js";

export interface MarketingPricingConfig {
  personalMonthlyPrice: string;
  personalYearlyPrice: string;
  teamSeatMonthlyPrice: string;
  teamSeatYearlyPrice: string;
  supporterPrice: string;
  supporterPromotionEnd: string | null;
  freeBookmarkCap: number;
}

export const DEFAULT_FREE_BOOKMARK_CAP = 50;

/** Team plan minimum seats at checkout and while subscribed (spec §12.2, decision #17). */
export const TEAM_MIN_SEATS = 2;

/** Static shell config before client hydration (no paid-tier amounts). */
export function createStaticMarketingPricingConfig(
  overrides: Partial<MarketingPricingConfig> = {},
): MarketingPricingConfig {
  return {
    personalMonthlyPrice: "",
    personalYearlyPrice: "",
    teamSeatMonthlyPrice: "",
    teamSeatYearlyPrice: "",
    supporterPrice: "",
    supporterPromotionEnd: null,
    freeBookmarkCap: DEFAULT_FREE_BOOKMARK_CAP,
    ...overrides,
  };
}

/** Map the public API response into marketing display strings. */
export function mapPricingResponseToConfig(
  apiPricing: PricingResponse,
  supporterPromotionEnd: string | null = null,
): MarketingPricingConfig {
  return {
    personalMonthlyPrice: apiPricing.plans.personal.monthly?.display ?? "",
    personalYearlyPrice: apiPricing.plans.personal.annual?.display ?? "",
    teamSeatMonthlyPrice: apiPricing.plans.team.monthly?.display ?? "",
    teamSeatYearlyPrice: apiPricing.plans.team.annual?.display ?? "",
    supporterPrice: apiPricing.plans.supporter?.display ?? "",
    supporterPromotionEnd,
    freeBookmarkCap: apiPricing.freeBookmarkCap,
  };
}

export function splitPrice(price: string): { amount: string; period: string } {
  const slash = price.indexOf("/");
  if (slash === -1) return { amount: price || "—", period: "" };
  return {
    amount: price.slice(0, slash),
    period: price.slice(slash + 1),
  };
}

/** Extract the currency prefix from a formatted price string. */
export function extractCurrencyPrefix(price: string): string {
  const match = price.match(/^([^\d]*)/);
  return match?.[1]?.trimEnd() ?? "";
}

export function isSupporterPromotionActive(
  config: MarketingPricingConfig,
  at: Date = new Date(),
): boolean {
  if (!config.supporterPromotionEnd) {
    return true;
  }
  const end = new Date(config.supporterPromotionEnd);
  if (Number.isNaN(end.getTime())) {
    return true;
  }
  return at <= end;
}

export type PlanFeatureCell = "included" | "excluded" | "unlimited" | (string & {});

export interface MarketingPlanFeatureRow {
  labelKey: "marketing.pricing.feature.bookmarks"
    | "marketing.pricing.feature.forwarding_slugs"
    | "marketing.pricing.feature.custom_slugs"
    | "marketing.pricing.feature.ai_suggestions"
    | "marketing.pricing.feature.workspaces"
    | "marketing.pricing.feature.api_tokens"
    | "marketing.pricing.feature.team_sharing"
    | "marketing.pricing.feature.members"
    | "marketing.pricing.feature.audit_log";
  free: PlanFeatureCell;
  personal: PlanFeatureCell;
  team: PlanFeatureCell;
}

/** Feature rows aligned with spec §12.2 / §23.4 - no folder cap, API tokens on all plans. */
export function buildMarketingPlanFeatureRows(
  config: MarketingPricingConfig,
): MarketingPlanFeatureRow[] {
  const cap = String(config.freeBookmarkCap);

  return [
    {
      labelKey: "marketing.pricing.feature.bookmarks",
      free: cap,
      personal: "unlimited",
      team: "unlimited",
    },
    {
      labelKey: "marketing.pricing.feature.forwarding_slugs",
      free: "included",
      personal: "included",
      team: "included",
    },
    {
      labelKey: "marketing.pricing.feature.custom_slugs",
      free: "excluded",
      personal: "included",
      team: "included",
    },
    {
      labelKey: "marketing.pricing.feature.ai_suggestions",
      free: "excluded",
      personal: "included",
      team: "included",
    },
    {
      labelKey: "marketing.pricing.feature.workspaces",
      free: "1",
      personal: "unlimited",
      team: "unlimited",
    },
    {
      labelKey: "marketing.pricing.feature.api_tokens",
      free: "included",
      personal: "included",
      team: "included",
    },
    {
      labelKey: "marketing.pricing.feature.team_sharing",
      free: "excluded",
      personal: "excluded",
      team: "included",
    },
    {
      labelKey: "marketing.pricing.feature.members",
      free: "excluded",
      personal: "excluded",
      team: "unlimited_per_seat",
    },
    {
      labelKey: "marketing.pricing.feature.audit_log",
      free: "excluded",
      personal: "excluded",
      team: "included",
    },
  ];
}
