import { validateRedirectUrl } from './validation.js';

const DEFAULT_FRONTEND = 'http://localhost:3000';

/**
 * Absolute browser URL for a path under the SPA (e.g. dashboard `/`, login `/login?...`).
 * When the UI is mounted under a prefix (cloud: `/app`), set `FRONTEND_APP_PATH=/app`.
 * Resolves against the configured frontend base and enforces same-origin via {@link validateRedirectUrl}.
 */
export function buildFrontendAbsoluteUrl(pathAndQuery: string, env: NodeJS.ProcessEnv = process.env): string {
  const origin = (env.FRONTEND_URL || DEFAULT_FRONTEND).replace(/\/$/, '');
  const appPath = (env.FRONTEND_APP_PATH || '').replace(/\/$/, '');
  const p = pathAndQuery.startsWith('/') ? pathAndQuery : `/${pathAndQuery}`;
  const allowedBase = `${origin}${appPath}`;
  const candidate = `${origin}${appPath}${p}`;
  const validated = validateRedirectUrl(candidate, allowedBase);
  if (validated) return validated;
  const fallback = validateRedirectUrl(`${origin}${appPath}/`, allowedBase);
  return fallback ?? `${origin}/`;
}
