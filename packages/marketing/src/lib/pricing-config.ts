/** Config-driven marketing pricing display (spec §12.1).

Prices come from the public pricing API (GET /pricing/public) at build time,
keeping Stripe as the single source of truth. Non-price config stays in env. */

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

function readEnv(key: string): string | undefined {
  if (!(key in import.meta.env)) {
    const nodeValue = process.env[key];
    return typeof nodeValue === "string" && nodeValue.length > 0 ? nodeValue : undefined;
  }
  const value: unknown = import.meta.env[key as keyof ImportMetaEnv];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  const nodeValue = process.env[key];
  return typeof nodeValue === "string" && nodeValue.length > 0 ? nodeValue : undefined;
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const DEFAULT_FREE_BOOKMARK_CAP = 50;

/** Team plan minimum seats at checkout and while subscribed (spec §12.2, decision #17). */
export const TEAM_MIN_SEATS = 2;

/** Avoid hanging Vitest/CI when the pricing API is slow or behind Access. */
const PRICING_API_FETCH_TIMEOUT_MS = 3_000;

function buildPricingApiFetchInit(): RequestInit {
  const headers: Record<string, string> = {};
  const accessClientId = readEnv("CF_ACCESS_CLIENT_ID");
  const accessClientSecret = readEnv("CF_ACCESS_CLIENT_SECRET");
  if (accessClientId && accessClientSecret) {
    headers["CF-Access-Client-Id"] = accessClientId;
    headers["CF-Access-Client-Secret"] = accessClientSecret;
  }

  return {
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    signal: AbortSignal.timeout(PRICING_API_FETCH_TIMEOUT_MS),
  };
}

/**
 * Fetches pricing data from the public API (build-time).
 * Falls back to env defaults when the API is unreachable (self-hosted without Stripe).
 */
async function fetchPricingFromApi(): Promise<PricingResponse | null> {
  const apiBase = readEnv("PUBLIC_API_BASE_URL");
  if (!apiBase) return null;

  try {
    const res = await fetch(`${apiBase}/pricing/public`, buildPricingApiFetchInit());
    if (!res.ok) return null;
    return (await res.json()) as PricingResponse;
  } catch {
    return null;
  }
}

export async function loadMarketingPricingConfig(
  overrides: Partial<MarketingPricingConfig> = {},
): Promise<MarketingPricingConfig> {
  const apiPricing = await fetchPricingFromApi();

  const supporterPromotionEnd = readEnv("PUBLIC_SUPPORTER_PROMOTION_END") ?? null;

  if (apiPricing) {
    return {
      personalMonthlyPrice: apiPricing.plans.personal.monthly?.display ?? "",
      personalYearlyPrice: apiPricing.plans.personal.annual?.display ?? "",
      teamSeatMonthlyPrice: apiPricing.plans.team.monthly?.display ?? "",
      teamSeatYearlyPrice: apiPricing.plans.team.annual?.display ?? "",
      supporterPrice: apiPricing.plans.supporter?.display ?? "",
      supporterPromotionEnd,
      freeBookmarkCap: apiPricing.freeBookmarkCap,
      ...overrides,
    };
  }

  // Fallback: env-based config for self-hosted without a reachable API
  const teamSeatMonthly = readEnv("PUBLIC_PLAN_PRICE_TEAM_SEAT") ?? "";
  const teamSeatYearly =
    readEnv("PUBLIC_PLAN_PRICE_TEAM_SEAT_YEARLY") ?? teamSeatMonthly;

  return {
    personalMonthlyPrice: readEnv("PUBLIC_PLAN_PRICE_PERSONAL_MONTHLY") ?? "",
    personalYearlyPrice: readEnv("PUBLIC_PLAN_PRICE_PERSONAL_YEARLY") ?? "",
    teamSeatMonthlyPrice: teamSeatMonthly,
    teamSeatYearlyPrice: teamSeatYearly,
    supporterPrice: readEnv("PUBLIC_PLAN_PRICE_SUPPORTER") ?? "",
    supporterPromotionEnd,
    freeBookmarkCap: readPositiveInt(
      readEnv("PUBLIC_FREE_BOOKMARK_CAP"),
      DEFAULT_FREE_BOOKMARK_CAP,
    ),
    ...overrides,
  };
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
