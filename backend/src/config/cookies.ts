/**
 * Auth cookie options for self-hosted runtime.
 * Import only after load-env.js (used by routes/auth.ts).
 */

const baseUrl = process.env.BASE_URL || 'http://localhost:5000';
const isHttps = baseUrl.startsWith('https://');
const isProduction = process.env.NODE_ENV === 'production' && isHttps;

export interface AuthCookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'strict';
  maxAge?: number;
}

export function getAuthCookieOptions(maxAgeMs?: number): AuthCookieOptions {
  const opts: AuthCookieOptions = {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
  };
  if (maxAgeMs != null) opts.maxAge = maxAgeMs;
  return opts;
}

export function getClearAuthCookieOptions(): { httpOnly: boolean; secure: boolean; sameSite: 'strict' } {
  const opts = {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict' as const,
  };
  return opts;
}
