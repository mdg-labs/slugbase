/**
 * Auth cookie options. In CLOUD mode, use domain and SameSite=Lax for cross-subdomain.
 * Import only after load-env.js (used by routes/auth.ts).
 */

import { isCloud } from './mode.js';

const baseUrl = process.env.BASE_URL || 'http://localhost:5000';
const isHttps = baseUrl.startsWith('https://');
const isProduction = process.env.NODE_ENV === 'production' && isHttps;

/** Derive cookie domain from BASE_URL (e.g. https://api.slugbase.app -> .slugbase.app) */
function getCookieDomain(): string | undefined {
  if (!isCloud) return undefined;
  const explicit = process.env.COOKIE_DOMAIN?.trim();
  if (explicit) return explicit;
  try {
    const u = new URL(baseUrl);
    const host = u.hostname;
    const parts = host.split('.');
    if (parts.length >= 2) return '.' + parts.slice(-2).join('.');
  } catch {
    // ignore
  }
  return undefined;
}

export interface AuthCookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'strict' | 'lax';
  maxAge?: number;
  domain?: string;
}

export function getAuthCookieOptions(maxAgeMs?: number): AuthCookieOptions {
  const domain = getCookieDomain();
  const opts: AuthCookieOptions = {
    httpOnly: true,
    secure: isProduction,
    sameSite: isCloud ? 'lax' : 'strict',
  };
  if (maxAgeMs != null) opts.maxAge = maxAgeMs;
  if (domain) opts.domain = domain;
  return opts;
}

export function getClearAuthCookieOptions(): { httpOnly: boolean; secure: boolean; sameSite: 'strict' | 'lax'; domain?: string } {
  const domain = getCookieDomain();
  const opts = {
    httpOnly: true,
    secure: isProduction,
    sameSite: (isCloud ? 'lax' : 'strict') as 'strict' | 'lax',
  };
  if (domain) (opts as { domain?: string }).domain = domain;
  return opts;
}
