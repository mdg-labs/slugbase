import { getServerApiBaseUrl } from "./server-api-base-url.js";

/**
 * Client API routing (hosted + self-host)
 *
 * Browser fetch: always same-origin via Worker proxies. Session cookies are
 * SameSite=Lax on the web origin and are not sent cross-site.
 *
 * Server loaders/actions/proxies: absolute API origin via getServerApiBaseUrl().
 *
 * Path cheat sheet (see routes.ts):
 * - resolveClientApiPath() → /api/... when bare path hits a page loader:
 *   /bookmarks, /bookmarks/:id, /folders, /tags (list/create in modal)
 * - Bare same-origin paths (no /api prefix):
 *   /auth/*, /workspaces, /members, /teams, /workspace/*, /sharing/*, /audit/*,
 *   /ai/*, /bookmarks/bulk/*, /folders/:id, /tags/:id
 */

/** Same-origin origin for browser fetch — always empty. */
export function getClientApiOrigin(): string {
  return "";
}

/** @deprecated Prefer getClientApiOrigin — kept for existing call sites. */
export function getApiBaseUrl(): string {
  return getClientApiOrigin();
}

/**
 * Base URL for a fetch: server-side when `request` is passed, same-origin in browser.
 */
export function resolveFetchBase(request?: Request): string {
  if (request !== undefined) {
    return getServerApiBaseUrl();
  }
  return getClientApiOrigin();
}

/**
 * Resolves a NestJS list/mutation path for client-side fetch via `/api/*` proxies.
 * Do not use for paths that already have bare proxy routes — see cheat sheet above.
 */
export function resolveClientApiPath(apiPath: string): string {
  const normalized = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
  return `/api${normalized}`;
}
