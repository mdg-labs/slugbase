/**
 * Client-side API origin for browser `fetch`.
 * Always empty — session cookies are `SameSite=Lax` on the web origin, so
 * browser calls must stay same-origin and flow through Worker proxy routes
 * (`/api/*`, `/auth/*`, `/folders/*`, …). Server loaders use `API_BASE_URL`.
 */
export function getApiBaseUrl(): string {
  return "";
}

/**
 * Resolves a NestJS list/mutation path for client-side fetch via `/api/*` proxies.
 * Paths covered by bare proxy routes (`/auth/*`, `/folders/:id/*`, …) are passed
 * without this helper — see `routes.ts`.
 */
export function resolveClientApiPath(apiPath: string): string {
  const normalized = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
  return `/api${normalized}`;
}
