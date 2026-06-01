/** Config-driven marketing pricing display (spec §12.1 — amounts live in env, not app logic). */

export interface MarketingPricingConfig {
  personalMonthlyPrice: string;
  personalYearlyPrice: string;
  teamSeatMonthlyPrice: string;
  teamSeatYearlyPrice: string;
  supporterPrice: string;
  supporterPromotionEnd: string | null;
  teamBaseSeats: number;
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
const DEFAULT_TEAM_BASE_SEATS = 5;

export function loadMarketingPricingConfig(
  overrides: Partial<MarketingPricingConfig> = {},
): MarketingPricingConfig {
  const teamSeatMonthly = readEnv("PUBLIC_PLAN_PRICE_TEAM_SEAT") ?? "";
  const teamSeatYearly =
    readEnv("PUBLIC_PLAN_PRICE_TEAM_SEAT_YEARLY") ?? teamSeatMonthly;

  return {
    personalMonthlyPrice: readEnv("PUBLIC_PLAN_PRICE_PERSONAL_MONTHLY") ?? "",
    personalYearlyPrice: readEnv("PUBLIC_PLAN_PRICE_PERSONAL_YEARLY") ?? "",
    teamSeatMonthlyPrice: teamSeatMonthly,
    teamSeatYearlyPrice: teamSeatYearly,
    supporterPrice: readEnv("PUBLIC_PLAN_PRICE_SUPPORTER") ?? "",
    supporterPromotionEnd: readEnv("PUBLIC_SUPPORTER_PROMOTION_END") ?? null,
    teamBaseSeats: readPositiveInt(readEnv("PUBLIC_TEAM_BASE_SEATS"), DEFAULT_TEAM_BASE_SEATS),
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

/** Feature rows aligned with spec §12.2 / §23.4 — no folder cap, API tokens on all plans. */
export function buildMarketingPlanFeatureRows(
  config: MarketingPricingConfig,
): MarketingPlanFeatureRow[] {
  const cap = String(config.freeBookmarkCap);
  const teamSeats = String(config.teamBaseSeats);

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
      team: teamSeats,
    },
    {
      labelKey: "marketing.pricing.feature.audit_log",
      free: "excluded",
      personal: "excluded",
      team: "included",
    },
  ];
}
