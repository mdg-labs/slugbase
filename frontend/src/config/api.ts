/**
 * API base URL for requests and OAuth redirects.
 * In CLOUD mode, use VITE_API_URL (e.g. https://api.slugbase.app).
 * In SELFHOSTED, use empty string so requests are relative to current origin.
 */

import { isCloud } from './mode';

export const apiBaseUrl: string = isCloud && import.meta.env.VITE_API_URL
  ? (import.meta.env.VITE_API_URL as string).replace(/\/$/, '')
  : '';

/** Full URL to start OIDC login for a provider (for window.location.href in CLOUD). */
export function getAuthProviderUrl(providerKey: string): string {
  return apiBaseUrl ? `${apiBaseUrl}/api/auth/${providerKey}` : `/api/auth/${providerKey}`;
}

/** Base path for app routes: '' in SELFHOSTED, '/app' in CLOUD. Use for links like to={`${appBasePath}/bookmarks`}. */
export const appBasePath: string = isCloud ? '/app' : '';
