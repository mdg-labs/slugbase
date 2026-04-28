import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import crypto from 'crypto';
import { getCsrfCookieOptions } from '../config/cookies.js';

/**
 * Rate limiting configuration
 * Disabled in development for easier testing
 */
const isDevelopment = process.env.NODE_ENV === 'development';

// No-op rate limiter for development (allows all requests)
const noOpRateLimiter = (req: any, res: any, next: any) => next();

export const authRateLimiter = isDevelopment
  ? noOpRateLimiter
  : rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 300, // Limit each IP to 300 failed auth attempts per windowMs
      message: 'Too many authentication attempts, please try again later.',
      standardHeaders: true,
      legacyHeaders: false,
      skipSuccessfulRequests: true, // Don't count successful requests
    });

/** Refresh token: more lenient - 401 is expected when unauthenticated (e.g. signup/login page) */
export const refreshRateLimiter = isDevelopment
  ? noOpRateLimiter
  : rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 500, // Higher limit; failures are often from unauthenticated users checking /auth/me
      message: 'Too many requests, please try again later.',
      standardHeaders: true,
      legacyHeaders: false,
      skipSuccessfulRequests: true,
    });

export const generalRateLimiter = isDevelopment
  ? noOpRateLimiter
  : rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 2000, // Limit each IP to 2000 requests per windowMs
      standardHeaders: true,
      legacyHeaders: false,
    });

export const strictRateLimiter = isDevelopment
  ? noOpRateLimiter
  : rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 500, // Limit each IP to 500 requests per windowMs
      message: 'Too many requests, please try again later.',
      standardHeaders: true,
      legacyHeaders: false,
    });

/** Contact form: strict limit to prevent abuse and PII flooding (M1) */
export const contactRateLimiter = isDevelopment
  ? noOpRateLimiter
  : rateLimit({
      windowMs: 60 * 60 * 1000, // 1 hour
      max: 10,
      message: 'Too many contact form submissions. Please try again later.',
      standardHeaders: true,
      legacyHeaders: false,
    });

/** Redirect endpoint: stricter than general to reduce abuse/crawler load (M4) */
export const redirectRateLimiter = isDevelopment
  ? noOpRateLimiter
  : rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 200,
      message: 'Too many redirect requests. Please try again later.',
      standardHeaders: true,
      legacyHeaders: false,
    });

/** API token creation: limit to prevent abuse */
export const tokenCreateRateLimiter = isDevelopment
  ? noOpRateLimiter
  : rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 10,
      message: 'Too many token creation attempts. Please try again later.',
      standardHeaders: true,
      legacyHeaders: false,
    });

/** MFA step-up verify: stricter than login; count all attempts (success + failure). */
export const mfaVerifyRateLimiter = isDevelopment
  ? noOpRateLimiter
  : rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 40,
      message: 'Too many MFA attempts. Please try again later.',
      standardHeaders: true,
      legacyHeaders: false,
      skipSuccessfulRequests: false,
    });

/** MFA enroll begin: limit secret churn / DB abuse. */
export const mfaEnrollBeginRateLimiter = isDevelopment
  ? noOpRateLimiter
  : rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 25,
      message: 'Too many MFA setup attempts. Please try again later.',
      standardHeaders: true,
      legacyHeaders: false,
      skipSuccessfulRequests: false,
    });

/**
 * Normalize env to an origin allowed in CSP (https only in production).
 * Accepts `https://host` or `https://host/path` (e.g. Umami script URL).
 */
function cspOriginFromEnv(raw: string | undefined, allowHttp: boolean): string | null {
  const t = raw?.trim();
  if (!t) return null;
  try {
    const u = new URL(t);
    if (u.protocol === 'https:') return u.origin;
    if (allowHttp && u.protocol === 'http:') return u.origin;
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Security headers middleware
 */
export function setupSecurityHeaders() {
  // Only enable HSTS if we're actually using HTTPS
  const baseUrl = process.env.BASE_URL || 'http://localhost:5000';
  const isHttps = baseUrl.startsWith('https://');
  const allowHttpCsp = process.env.NODE_ENV !== 'production';

  const cspDirectives: any = {
    defaultSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"], // Swagger UI needs inline styles
    scriptSrc: ["'self'"],
    imgSrc: ["'self'", "data:", "https:"], // Allow data URIs and HTTPS images (for favicons)
    connectSrc: ["'self'", "https://*.ingest.sentry.io", "https://*.sentry.io"],
    fontSrc: ["'self'"],
    objectSrc: ["'none'"],
    mediaSrc: ["'self'"],
    frameSrc: ["'self'"], // Allow iframes for Swagger UI
    // Turnstile may spawn workers from blob: URLs; worker-src falls back to script-src but explicit is clearer.
    workerSrc: ["'self'", 'blob:'],
  };

  const umamiOrigin = cspOriginFromEnv(process.env.CSP_UMAMI_ORIGIN, allowHttpCsp);
  if (umamiOrigin) {
    cspDirectives.scriptSrc.push(umamiOrigin);
    cspDirectives.connectSrc.push(umamiOrigin);
  }

  // Bugsink / Sentry-compatible browser SDK (POST envelope). connect-src only — no scripts from ingest host.
  const bugsinkOrigin = cspOriginFromEnv(process.env.CSP_BUGSINK_ORIGIN, allowHttpCsp);
  if (bugsinkOrigin) {
    cspDirectives.connectSrc.push(bugsinkOrigin);
  }

  // Cloudflare Turnstile (e.g. marketing /contact): script, iframe, fetch, and workers from CF.
  // Not gated on TURNSTILE_SECRET_KEY: the site key is baked in at frontend build time (VITE_*), while
  // CSP is evaluated at runtime; if the secret were missing here, the widget would be blocked in the
  // browser even though verification could be skipped. Self-hosted installs without Turnstile never
  // request these URLs.
  const turnstileCspOrigin = 'https://challenges.cloudflare.com';
  cspDirectives.scriptSrc.push(turnstileCspOrigin);
  cspDirectives.frameSrc.push(turnstileCspOrigin);
  cspDirectives.connectSrc.push(turnstileCspOrigin);
  cspDirectives.workerSrc.push(turnstileCspOrigin);

  // Only upgrade insecure requests when using HTTPS (set to null to disable when using HTTP)
  if (isHttps) {
    cspDirectives.upgradeInsecureRequests = [];
  } else {
    cspDirectives.upgradeInsecureRequests = null; // Explicitly disable when using HTTP
  }
  
  return helmet({
    contentSecurityPolicy: {
      directives: cspDirectives,
    },
    crossOriginEmbedderPolicy: false, // Disable for compatibility
    crossOriginOpenerPolicy: false, // Disable for compatibility (can cause issues with HTTP)
    hsts: isHttps ? {
      maxAge: 31536000, // 1 year
      includeSubDomains: true,
      preload: true,
    } : false, // Disable HSTS when not using HTTPS
  });
}

/**
 * CSRF protection middleware (custom implementation for JWT-based auth)
 * Generates and validates CSRF tokens stored in httpOnly cookies
 * Note: SameSite=strict cookies provide good CSRF protection, but tokens add defense in depth
 */
export function csrfProtection(req: any, res: any, next: any) {
  // Get token from header or body
  const token = req.headers['x-csrf-token'] || req.body?.csrfToken;
  const cookieToken = req.cookies?._csrf;

  // If no cookie token exists, do not allow state-changing requests (CSRF hardening).
  // Client must GET /api/csrf-token first to receive the cookie, then retry.
  if (!cookieToken) {
    generateCSRFToken(req, res);
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }

  // Validate token for state-changing operations
  if (token && token === cookieToken) {
    return next();
  }

  // If token doesn't match, return error
  return res.status(403).json({ error: 'Invalid CSRF token' });
}

/**
 * Generate CSRF token and set cookie
 */
export function generateCSRFToken(req: any, res: any): string {
  const token = crypto.randomBytes(32).toString('hex');
  res.cookie('_csrf', token, getCsrfCookieOptions());
  return token;
}
