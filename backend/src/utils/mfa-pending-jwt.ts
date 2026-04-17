/**
 * Short-lived JWT for the MFA step-up state (httpOnly cookie `slugbase.mfa_pending`).
 * Signed with JWT_SECRET, HS256 — distinct from the access JWT; Passport must reject `pur: mfa_pending`.
 */

import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET as string;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required. Please set it before starting the server.');
}

export const MFA_PENDING_PURPOSE = 'mfa_pending' as const;

/** Plan §3: 5 minutes. */
export const MFA_PENDING_JWT_TTL_SECONDS = 300;

export const MFA_PENDING_JWT_TTL_MS = MFA_PENDING_JWT_TTL_SECONDS * 1000;

export interface MfaPendingClaims {
  sub: string;
  pur: typeof MFA_PENDING_PURPOSE;
  iat: number;
  exp: number;
}

export function signMfaPendingToken(userId: string): string {
  return jwt.sign(
    { sub: userId, pur: MFA_PENDING_PURPOSE },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: MFA_PENDING_JWT_TTL_SECONDS }
  );
}

/**
 * Returns `{ sub }` if the token is valid, purpose matches, and `sub` is a non-empty string.
 */
export function verifyMfaPendingToken(token: string): { sub: string } | null {
  if (!token || typeof token !== 'string') {
    return null;
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as jwt.JwtPayload & {
      sub?: string;
      pur?: string;
    };
    if (decoded.pur !== MFA_PENDING_PURPOSE) {
      return null;
    }
    if (typeof decoded.sub !== 'string' || decoded.sub.length === 0) {
      return null;
    }
    return { sub: decoded.sub };
  } catch {
    return null;
  }
}
