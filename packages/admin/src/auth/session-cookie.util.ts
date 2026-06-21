import { deleteCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";

import type { AdminEnv } from "../config/env.schema.js";
import { ADMIN_SESSION_COOKIE } from "./auth.constants.js";

const DAYS_TO_MS = 24 * 60 * 60 * 1000;

export function setAdminSessionCookie(
  c: Context,
  config: AdminEnv,
  token: string,
): void {
  setCookie(c, ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: config.NODE_ENV === "production",
    maxAge: config.ADMIN_SESSION_TTL_DAYS * DAYS_TO_MS / 1000,
  });
}

export function clearAdminSessionCookie(c: Context): void {
  deleteCookie(c, ADMIN_SESSION_COOKIE, {
    path: "/",
  });
}
