/** In-memory IP rate limiter — 10 attempts / 15 minutes (product posture). */

const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const loginAttemptsByIp = new Map<string, RateLimitEntry>();

export function resetLoginRateLimits(): void {
  loginAttemptsByIp.clear();
}

export interface LoginRateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

export function checkLoginRateLimit(ip: string): LoginRateLimitResult {
  const now = Date.now();
  const entry = loginAttemptsByIp.get(ip);

  if (!entry || entry.resetAt <= now) {
    loginAttemptsByIp.set(ip, {
      count: 1,
      resetAt: now + LOGIN_WINDOW_MS,
    });
    return { allowed: true };
  }

  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000),
    };
  }

  entry.count += 1;
  return { allowed: true };
}
