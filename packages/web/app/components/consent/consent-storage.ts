export const ANALYTICS_CONSENT_STORAGE_KEY = "slugbase_analytics_consent";

export type StoredAnalyticsConsent = "granted" | "denied";

export function readStoredAnalyticsConsent(): StoredAnalyticsConsent | null {
  if (typeof window === "undefined") {
    return null;
  }
  const value = window.localStorage.getItem(ANALYTICS_CONSENT_STORAGE_KEY);
  if (value === "granted" || value === "denied") {
    return value;
  }
  return null;
}

export function writeStoredAnalyticsConsent(value: StoredAnalyticsConsent): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(ANALYTICS_CONSENT_STORAGE_KEY, value);
}

export function isAnalyticsConsentGranted(): boolean {
  return readStoredAnalyticsConsent() === "granted";
}
