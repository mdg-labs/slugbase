import {
  apiFetch,
  fetchCsrfHeadersOrEmpty,
} from "../../lib/client-api-fetch.js";

export interface AnalyticsConsentStatus {
  enabled: boolean;
  decided: boolean;
  granted: boolean | null;
}

export async function fetchAnalyticsConsentStatus(): Promise<AnalyticsConsentStatus> {
  const res = await apiFetch("/analytics/consent");
  if (!res.ok) {
    return { enabled: false, decided: false, granted: null };
  }
  return (await res.json()) as AnalyticsConsentStatus;
}

export async function persistAnalyticsConsent(granted: boolean): Promise<void> {
  const headers = await fetchCsrfHeadersOrEmpty();
  await apiFetch("/analytics/consent", {
    method: "POST",
    headers,
    body: JSON.stringify({ granted }),
  });
}
