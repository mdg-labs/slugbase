import {
  isAnalyticsConsentGranted,
  writeStoredAnalyticsConsent,
} from "./consent-storage.js";

let scriptLoaded = false;

function umamiHost(): string | undefined {
  const host = import.meta.env.VITE_UMAMI_HOST as string | undefined;
  return host && host.length > 0 ? host.replace(/\/$/, "") : undefined;
}

function umamiWebsiteId(): string | undefined {
  const id = import.meta.env.VITE_UMAMI_WEBSITE_ID as string | undefined;
  return id && id.length > 0 ? id : undefined;
}

export function isClientAnalyticsConfigured(): boolean {
  return Boolean(umamiHost() && umamiWebsiteId());
}

/**
 * Loads the Umami tracker script when analytics is configured and consent granted.
 */
export function initAnalyticsClient(): void {
  if (!isClientAnalyticsConfigured() || !isAnalyticsConsentGranted() || scriptLoaded) {
    return;
  }

  const host = umamiHost();
  const websiteId = umamiWebsiteId();
  if (!host || !websiteId) {
    return;
  }

  const script = document.createElement("script");
  script.defer = true;
  script.src = `${host}/script.js`;
  script.dataset.websiteId = websiteId;
  document.head.appendChild(script);
  scriptLoaded = true;
}

export function trackClientEvent(
  name: string,
  data?: Record<string, string | number | boolean>,
): void {
  if (!isAnalyticsConsentGranted()) {
    return;
  }
  const tracker = (
    window as Window & { umami?: { track: (event: string, data?: object) => void } }
  ).umami;
  tracker?.track(name, data);
}

export function applyAnalyticsConsent(granted: boolean): void {
  writeStoredAnalyticsConsent(granted ? "granted" : "denied");
  if (granted) {
    initAnalyticsClient();
  }
}
