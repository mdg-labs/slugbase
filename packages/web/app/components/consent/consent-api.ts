const API_BASE_URL = () =>
  (import.meta.env.VITE_API_URL as string | undefined) ??
  (typeof window !== "undefined" ? window.location.origin : "");

async function csrfHeaders(): Promise<HeadersInit> {
  const res = await fetch(`${API_BASE_URL()}/auth/csrf-token`, {
    credentials: "include",
  });
  if (!res.ok) {
    return {};
  }
  const data = (await res.json()) as { csrfToken: string };
  return {
    "Content-Type": "application/json",
    "x-csrf-token": data.csrfToken,
  };
}

export interface AnalyticsConsentStatus {
  enabled: boolean;
  decided: boolean;
  granted: boolean | null;
}

export async function fetchAnalyticsConsentStatus(): Promise<AnalyticsConsentStatus> {
  const res = await fetch(`${API_BASE_URL()}/analytics/consent`, {
    credentials: "include",
  });
  if (!res.ok) {
    return { enabled: false, decided: false, granted: null };
  }
  return (await res.json()) as AnalyticsConsentStatus;
}

export async function persistAnalyticsConsent(granted: boolean): Promise<void> {
  const headers = await csrfHeaders();
  await fetch(`${API_BASE_URL()}/analytics/consent`, {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify({ granted }),
  });
}
