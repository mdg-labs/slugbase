import type { Response } from "express";

import type { ConfigService } from "../config/config.service.js";
import { SESSION_COOKIE } from "./session-constants.js";

const DAYS_TO_MS = 24 * 60 * 60 * 1000;

/** Sets the session cookie with optional extended maxAge when remember-me is enabled. */
export function setSessionCookie(
  res: Response,
  config: ConfigService,
  cookieValue: string,
  rememberMe: boolean,
): void {
  const options: {
    httpOnly: boolean;
    sameSite: "lax";
    path: string;
    secure: boolean;
    maxAge?: number;
  } = {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: config.cookieSecure(),
  };

  if (rememberMe) {
    options.maxAge = config.get("SESSION_REMEMBER_TTL_DAYS") * DAYS_TO_MS;
  }

  res.cookie(SESSION_COOKIE, cookieValue, options);
}
