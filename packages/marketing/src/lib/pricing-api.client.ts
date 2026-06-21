import type { PricingResponse } from "./pricing-api-types.js";

export function getPublicApiBaseUrl(): string | undefined {
  const raw = import.meta.env.PUBLIC_API_BASE_URL;
  if (typeof raw !== "string" || raw.length === 0) {
    return undefined;
  }
  return raw.replace(/\/$/, "");
}

/** Fetch live Stripe-backed prices from the public API (no auth). */
export async function fetchPublicPricing(): Promise<PricingResponse> {
  const apiBase = getPublicApiBaseUrl();
  if (!apiBase) {
    throw new Error("PUBLIC_API_BASE_URL is not configured");
  }

  const res = await fetch(`${apiBase}/pricing/public`);
  if (!res.ok) {
    throw new Error(`Pricing API responded with ${String(res.status)}`);
  }

  return (await res.json()) as PricingResponse;
}
