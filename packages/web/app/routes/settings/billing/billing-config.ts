import { FREE_BOOKMARK_CAP } from "../../../components/dashboard/dashboard.constants.js";
import type { BillingPlanDisplayConfig } from "./billing.types.js";

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

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === "true" || value === "1";
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const getApiBaseUrl = (): string => {
  const fromProcess = typeof process !== "undefined" ? process.env["API_BASE_URL"] : undefined;
  if (typeof fromProcess === "string" && fromProcess.length > 0) return fromProcess.replace(/\/$/, "");
  const fromVite = typeof import.meta !== "undefined" ? (import.meta as { env: { VITE_API_URL?: string } }).env.VITE_API_URL : undefined;
  if (typeof fromVite === "string" && fromVite.length > 0) return fromVite.replace(/\/$/, "");
  return "";
};

interface PublicPriceInfo {
  priceId: string;
  unitAmount: number;
  currency: string;
  interval: string | null;
  type: "recurring" | "one_time";
  display: string;
}

interface PublicPlanPriceGroup {
  monthly?: PublicPriceInfo;
  annual?: PublicPriceInfo;
}

interface PricingApiResponse {
  plans: {
    personal: PublicPlanPriceGroup;
    team: PublicPlanPriceGroup;
    supporter?: PublicPriceInfo;
  };
  freeBookmarkCap: number;
}

async function fetchPricingFromApi(): Promise<PricingApiResponse | null> {
  const apiBase = getApiBaseUrl();
  if (!apiBase) return null;

  try {
    const res = await fetch(`${apiBase}/pricing/public`);
    if (!res.ok) return null;
    return (await res.json()) as PricingApiResponse;
  } catch {
    return null;
  }
}

/**
 * Config-driven plan display metadata (spec §12.1).
 * Prices come from the public pricing API - Stripe is the single source of truth.
 * Falls back to env-based config when the API is unreachable (self-hosted without Stripe).
 */
export async function loadBillingPlanDisplayConfig(
  overrides: Partial<BillingPlanDisplayConfig> = {},
): Promise<BillingPlanDisplayConfig> {
  const billingEnabled = readBoolean(readEnv("VITE_BILLING_ENABLED"), false);
  const supporterPromotionEnd = readEnv("VITE_SUPPORTER_PROMOTION_END") ?? null;
  const freeBookmarkCap = readPositiveInt(readEnv("VITE_FREE_BOOKMARK_CAP"), FREE_BOOKMARK_CAP);

  const apiPricing = await fetchPricingFromApi();

  if (apiPricing) {
    return {
      billingEnabled,
      personalMonthlyPrice: apiPricing.plans.personal.monthly?.display ?? "",
      personalYearlyPrice: apiPricing.plans.personal.annual?.display ?? "",
      teamSeatPrice: apiPricing.plans.team.monthly?.display ?? "",
      teamSeatYearlyPrice: apiPricing.plans.team.annual?.display ?? "",
      supporterPrice: apiPricing.plans.supporter?.display ?? "",
      supporterPromotionEnd,
      freeBookmarkCap: apiPricing.freeBookmarkCap,
      ...overrides,
    };
  }

  // Fallback: env-based config for self-hosted without a reachable API
  return {
    billingEnabled,
    personalMonthlyPrice: readEnv("VITE_PLAN_PRICE_PERSONAL_MONTHLY") ?? "",
    personalYearlyPrice: readEnv("VITE_PLAN_PRICE_PERSONAL_YEARLY") ?? "",
    teamSeatPrice: readEnv("VITE_PLAN_PRICE_TEAM_SEAT") ?? "",
    teamSeatYearlyPrice: readEnv("VITE_PLAN_PRICE_TEAM_SEAT") ?? "",
    supporterPrice: readEnv("VITE_PLAN_PRICE_SUPPORTER") ?? "",
    supporterPromotionEnd,
    freeBookmarkCap,
    ...overrides,
  };
}

export function isSupporterPromotionActive(
  config: BillingPlanDisplayConfig,
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
