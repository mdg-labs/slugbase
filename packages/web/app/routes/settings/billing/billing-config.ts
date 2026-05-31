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

/** Config-driven plan display metadata (spec §12.1 — amounts live in env, not app logic). */
export function loadBillingPlanDisplayConfig(
  overrides: Partial<BillingPlanDisplayConfig> = {},
): BillingPlanDisplayConfig {
  return {
    billingEnabled: readBoolean(readEnv("VITE_BILLING_ENABLED"), false),
    personalMonthlyPrice: readEnv("VITE_PLAN_PRICE_PERSONAL_MONTHLY") ?? "",
    personalYearlyPrice: readEnv("VITE_PLAN_PRICE_PERSONAL_YEARLY") ?? "",
    teamSeatPrice: readEnv("VITE_PLAN_PRICE_TEAM_SEAT") ?? "",
    supporterPrice: readEnv("VITE_PLAN_PRICE_SUPPORTER") ?? "",
    supporterPromotionEnd: readEnv("VITE_SUPPORTER_PROMOTION_END") ?? null,
    teamBaseSeats: readPositiveInt(readEnv("VITE_TEAM_BASE_SEATS"), 5),
    freeBookmarkCap: readPositiveInt(readEnv("VITE_FREE_BOOKMARK_CAP"), FREE_BOOKMARK_CAP),
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
