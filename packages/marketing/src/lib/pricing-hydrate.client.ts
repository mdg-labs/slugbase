import { fetchPublicPricing } from "./pricing-api.client.js";
import {
  extractCurrencyPrefix,
  isSupporterPromotionActive,
  mapPricingResponseToConfig,
  splitPrice,
  type MarketingPricingConfig,
} from "./pricing-config.js";

function readSupporterPromotionEnd(): string | null {
  const raw = import.meta.env.PUBLIC_SUPPORTER_PROMOTION_END;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function applyPlanPriceSlots(config: MarketingPricingConfig): void {
  const personalMonthly = splitPrice(config.personalMonthlyPrice || "—");
  const personalYearly = splitPrice(config.personalYearlyPrice || "—");
  const teamMonthly = splitPrice(config.teamSeatMonthlyPrice || "—");
  const teamYearly = splitPrice(config.teamSeatYearlyPrice || "—");

  const freeCurrency = extractCurrencyPrefix(config.personalMonthlyPrice || "");
  const freePrice = freeCurrency ? `${freeCurrency}0` : "—";
  const freeMonthly = splitPrice(freePrice);
  const freeYearly = splitPrice(freePrice);

  const slots: Record<string, { monthly: string; yearly: string; periodMonthly: string; periodYearly: string }> = {
    free: {
      monthly: freeMonthly.amount,
      yearly: freeYearly.amount,
      periodMonthly: freeMonthly.period,
      periodYearly: freeYearly.period,
    },
    personal: {
      monthly: personalMonthly.amount,
      yearly: personalYearly.amount,
      periodMonthly: personalMonthly.period,
      periodYearly: personalYearly.period,
    },
    team: {
      monthly: teamMonthly.amount,
      yearly: teamYearly.amount,
      periodMonthly: teamMonthly.period,
      periodYearly: teamYearly.period,
    },
  };

  for (const [plan, prices] of Object.entries(slots)) {
    const root = document.querySelector<HTMLElement>(`[data-pricing-plan="${plan}"]`);
    if (!root) continue;

    const amountEl = root.querySelector<HTMLElement>("[data-price-monthly]");
    if (amountEl) {
      amountEl.dataset.priceMonthly = prices.monthly;
      amountEl.dataset.priceYearly = prices.yearly;
      const billing = document.querySelector<HTMLButtonElement>("[data-billing].on");
      const mode = billing?.dataset.billing === "yearly" ? "yearly" : "monthly";
      amountEl.textContent = mode === "yearly" ? prices.yearly : prices.monthly;
    }

    const periodEl = root.querySelector<HTMLElement>("[data-period-monthly]");
    if (periodEl) {
      periodEl.dataset.periodMonthly = prices.periodMonthly;
      periodEl.dataset.periodYearly = prices.periodYearly;
      const billing = document.querySelector<HTMLButtonElement>("[data-billing].on");
      const mode = billing?.dataset.billing === "yearly" ? "yearly" : "monthly";
      const period = mode === "yearly" ? prices.periodYearly : prices.periodMonthly;
      periodEl.textContent = period ? `/${period}` : "";
      periodEl.hidden = period.length === 0;
    }
  }
}

function applyLandingTeaserPrices(config: MarketingPricingConfig): void {
  const personalEl = document.querySelector<HTMLElement>('[data-pricing-teaser="personal-monthly"]');
  if (personalEl && config.personalMonthlyPrice) {
    personalEl.textContent = config.personalMonthlyPrice;
  }

  const teamEl = document.querySelector<HTMLElement>('[data-pricing-teaser="team-monthly"]');
  if (teamEl && config.teamSeatMonthlyPrice) {
    teamEl.textContent = config.teamSeatMonthlyPrice;
  }

  const freeEl = document.querySelector<HTMLElement>('[data-pricing-teaser="free"]');
  if (freeEl) {
    const freeCurrency = extractCurrencyPrefix(config.personalMonthlyPrice || "");
    freeEl.textContent = freeCurrency ? `${freeCurrency}0` : "—";
  }
}

function applySupporterSections(config: MarketingPricingConfig): void {
  const active = Boolean(config.supporterPrice) && isSupporterPromotionActive(config);

  for (const section of document.querySelectorAll<HTMLElement>("[data-pricing-supporter]")) {
    section.hidden = !active;
  }

  for (const priceEl of document.querySelectorAll<HTMLElement>("[data-pricing-supporter-price]")) {
    if (config.supporterPrice) {
      priceEl.textContent = config.supporterPrice;
    }
  }

  for (const ctaEl of document.querySelectorAll<HTMLElement>("[data-pricing-supporter-cta]")) {
    const template = ctaEl.dataset.ctaTemplate;
    if (template && config.supporterPrice) {
      ctaEl.textContent = template.replace("{price}", config.supporterPrice);
    }
  }
}

export function applyLivePricingConfig(config: MarketingPricingConfig): void {
  applyPlanPriceSlots(config);
  applyLandingTeaserPrices(config);
  applySupporterSections(config);
}

export async function initLivePricing(): Promise<void> {
  try {
    const response = await fetchPublicPricing();
    const config = mapPricingResponseToConfig(response, readSupporterPromotionEnd());
    applyLivePricingConfig(config);
  } catch {
    // Static shell keeps em-dash placeholders when the API is unreachable.
  }
}
