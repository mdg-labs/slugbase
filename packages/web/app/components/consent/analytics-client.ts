import {
  buildUmamiHostAllowlist,
  isUmamiHostAllowed,
} from "@slugbase/shared-types";

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

function umamiHostAllowlist(): Set<string> {
  const extraOrigins = import.meta.env.VITE_UMAMI_ALLOWED_ORIGINS as
    | string
    | undefined;
  return buildUmamiHostAllowlist(umamiHost(), extraOrigins);
}

function isPermittedUmamiHost(host: string): boolean {
  return isUmamiHostAllowed(host, umamiHostAllowlist());
}

export function isClientAnalyticsConfigured(): boolean {
  const host = umamiHost();
  return Boolean(host && umamiWebsiteId() && isPermittedUmamiHost(host));
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
  if (!host || !websiteId || !isPermittedUmamiHost(host)) {
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

export { isPermittedUmamiHost, umamiHostAllowlist };
