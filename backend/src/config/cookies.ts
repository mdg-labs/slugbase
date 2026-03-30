/**
 * Auth cookie options for self-hosted runtime.
 * Import only after load-env.js (used by routes/auth.ts).
 *
 * Optional AUTH_COOKIE_DOMAIN (e.g. `.slugbase.app`): set on **cloud** when the browser
 * loads the internal admin SPA from a sibling subdomain of the API and you need the
 * `token` and `_csrf` cookies to be sent on credentialed API requests. **Unset** for
 * typical self-hosted (host-only cookies, default).
 */

const baseUrl = process.env.BASE_URL || 'http://localhost:5000';
const isHttps = baseUrl.startsWith('https://');
const isProduction = process.env.NODE_ENV === 'production' && isHttps;

function getOptionalAuthCookieDomain(): string | undefined {
  const d = process.env.AUTH_COOKIE_DOMAIN?.trim();
  return d || undefined;
}

export interface AuthCookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'strict';
  maxAge?: number;
  path: string;
  domain?: string;
}

export function getAuthCookieOptions(maxAgeMs?: number): AuthCookieOptions {
  const opts: AuthCookieOptions = {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    path: '/',
  };
  if (maxAgeMs != null) opts.maxAge = maxAgeMs;
  const domain = getOptionalAuthCookieDomain();
  if (domain) opts.domain = domain;
  return opts;
}

export function getClearAuthCookieOptions(): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'strict';
  path: string;
  domain?: string;
} {
  const domain = getOptionalAuthCookieDomain();
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    path: '/',
    ...(domain ? { domain } : {}),
  };
}

/**
 * CSRF (_csrf) cookie — same Domain/Secure/Path as auth cookies when AUTH_COOKIE_DOMAIN is set
 * so the internal admin app (separate subdomain) can obtain and send CSRF + JWT on the API host.
 */
export function getCsrfCookieOptions(): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'strict';
  maxAge: number;
  path: string;
  domain?: string;
} {
  const domain = getOptionalAuthCookieDomain();
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    maxAge: 24 * 60 * 60 * 1000,
    path: '/',
    ...(domain ? { domain } : {}),
  };
}
