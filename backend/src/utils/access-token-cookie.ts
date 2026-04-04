/**
 * HttpOnly access JWT cookie (`token`) — shared by login, OIDC, setup, and MFA verify.
 */

import type { Response } from 'express';
import { getAuthCookieOptions } from '../config/cookies.js';

const ACCESS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function setAccessTokenCookie(res: Response, accessToken: string): void {
  res.cookie('token', accessToken, { ...getAuthCookieOptions(ACCESS_MAX_AGE_MS), maxAge: ACCESS_MAX_AGE_MS });
}
