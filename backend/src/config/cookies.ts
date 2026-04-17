/**
 * Auth cookie options for self-hosted runtime.
 * Import only after load-env.js (used by routes/auth.ts).
 *
 * Optional AUTH_COOKIE_DOMAIN (e.g. `.slugbase.app`): set on **cloud** when the browser
 * loads the internal admin SPA from a sibling subdomain of the API and you need the
 * `token` and `_csrf` cookies to be sent on credentialed API requests. **Unset** for
 * typical self-hosted (host-only cookies, default).
 *
 * When AUTH_COOKIE_DOMAIN is set and BASE_URL is HTTPS, cookies use **SameSite=None** and
 * **Secure** so cross-subdomain XHR/fetch (admin host → API host) still sends `token` and
 * `_csrf`. SameSite=Strict alone often omits them on those POSTs, which breaks CSRF checks.
 */

const baseUrl = process.env.BASE_URL || 'http://localhost:5000';
const isHttps = baseUrl.startsWith('https://');
const isProduction = process.env.NODE_ENV === 'production' && isHttps;

function getOptionalAuthCookieDomain(): string | undefined {
  const d = process.env.AUTH_COOKIE_DOMAIN?.trim();
  return d || undefined;
}

/** Cross-subdomain cloud (admin SPA + API): need None + Secure for credentialed API calls. */
function useCrossSubdomainCookiePolicy(): boolean {
  return Boolean(getOptionalAuthCookieDomain() && isHttps);
}

function cookieSecureFlag(): boolean {
  if (useCrossSubdomainCookiePolicy()) return true;
  return isProduction;
}

function cookieSameSiteFlag(): 'strict' | 'none' {
  return useCrossSubdomainCookiePolicy() ? 'none' : 'strict';
}

export interface AuthCookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'strict' | 'none' | 'lax';
  maxAge?: number;
  path: string;
  domain?: string;
}

export function getAuthCookieOptions(maxAgeMs?: number): AuthCookieOptions {
  const opts: AuthCookieOptions = {
    httpOnly: true,
    secure: cookieSecureFlag(),
    sameSite: cookieSameSiteFlag(),
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
  sameSite: 'strict' | 'none' | 'lax';
  path: string;
  domain?: string;
} {
  const domain = getOptionalAuthCookieDomain();
  return {
    httpOnly: true,
    secure: cookieSecureFlag(),
    sameSite: cookieSameSiteFlag(),
    path: '/',
    ...(domain ? { domain } : {}),
  };
}

/** HttpOnly cookie for MFA step-up JWT (plan §3). Not the access `token` cookie. */
export const MFA_PENDING_COOKIE_NAME = 'slugbase.mfa_pending';

/**
 * Options for `slugbase.mfa_pending`: httpOnly, secure in HTTPS/prod (same rule as auth),
 * **SameSite=Lax** (plan §3), path `/`, optional AUTH_COOKIE_DOMAIN.
 * Pass `maxAgeMs` aligned with the pending JWT `exp` (default TTL: 5 minutes = 300_000 ms).
 */
export function getMfaPendingCookieOptions(maxAgeMs: number): AuthCookieOptions {
  const domain = getOptionalAuthCookieDomain();
  return {
    httpOnly: true,
    secure: cookieSecureFlag(),
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeMs,
    ...(domain ? { domain } : {}),
  };
}

/** Match set options so `clearCookie` removes the pending cookie reliably. */
export function getClearMfaPendingCookieOptions(): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  domain?: string;
} {
  const domain = getOptionalAuthCookieDomain();
  return {
    httpOnly: true,
    secure: cookieSecureFlag(),
    sameSite: 'lax',
    path: '/',
    ...(domain ? { domain } : {}),
  };
}

/**
 * CSRF (_csrf) cookie — same Domain/Secure/SameSite as auth cookies when AUTH_COOKIE_DOMAIN is set
 * so the internal admin app (separate subdomain) can obtain and send CSRF + JWT on the API host.
 */
export function getCsrfCookieOptions(): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'strict' | 'none' | 'lax';
  maxAge: number;
  path: string;
  domain?: string;
} {
  const domain = getOptionalAuthCookieDomain();
  return {
    httpOnly: true,
    secure: cookieSecureFlag(),
    sameSite: cookieSameSiteFlag(),
    maxAge: 24 * 60 * 60 * 1000,
    path: '/',
    ...(domain ? { domain } : {}),
  };
}
