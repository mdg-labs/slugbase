/**
 * Self-hosted API config always uses relative paths by default.
 */
export const apiBaseUrl: string = '';

/** Full URL to start OIDC login for a provider (for window.location.href in CLOUD). */
export function getAuthProviderUrl(providerKey: string): string {
  return apiBaseUrl ? `${apiBaseUrl}/api/auth/${providerKey}` : `/api/auth/${providerKey}`;
}

/** Base path for app routes. */
export const appBasePath: string = '';

/** Root path for the app (dashboard). */
export const appRootPath: string = '/';
