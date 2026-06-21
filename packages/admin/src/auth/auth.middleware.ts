import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";

import type { AdminRole } from "./admin-roles.js";
import { hasMinimumRole } from "./admin-roles.js";
import type { AdminSessionRecord } from "./auth.constants.js";
import { ADMIN_SESSION_COOKIE } from "./auth.constants.js";
import type { AdminSessionService } from "./session.service.js";

export type AdminAuthVariables = {
  adminSession: AdminSessionRecord;
};

export function createRequireAdminAuth(
  sessions: AdminSessionService,
): MiddlewareHandler<{ Variables: AdminAuthVariables }> {
  return async (c, next) => {
    const token = getCookie(c, ADMIN_SESSION_COOKIE);
    if (!token) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const session = await sessions.findSessionByToken(token);
    if (!session) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    c.set("adminSession", session);
    await next();
  };
}

export function createRequireAdminRole(
  minimum: AdminRole,
): MiddlewareHandler<{ Variables: AdminAuthVariables }> {
  return async (c, next) => {
    const session = c.get("adminSession");
    if (!hasMinimumRole(session.user.role as AdminRole, minimum)) {
      return c.json({ error: "Forbidden" }, 403);
    }

    await next();
  };
}

export function getRequestIp(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }

  return c.req.header("x-real-ip") ?? "unknown";
}
