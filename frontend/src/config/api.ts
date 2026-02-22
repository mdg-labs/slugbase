/**
 * Self-hosted API config always uses relative paths by default.
 */
export const apiBaseUrl: string = '';

/** Full URL to start OIDC login for a provider. Pass apiBaseUrl when using from context (e.g. useAppConfig().apiBaseUrl). */
export function getAuthProviderUrl(providerKey: string, baseUrl?: string): string {
  const url = baseUrl ?? apiBaseUrl;
  return url ? `${url.replace(/\/$/, '')}/api/auth/${providerKey}` : `/api/auth/${providerKey}`;
}

/** Base path for app routes. */
export const appBasePath: string = '';

/** Root path for the app (dashboard). */
export const appRootPath: string = '/';
