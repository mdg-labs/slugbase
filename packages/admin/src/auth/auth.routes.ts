import type { ContentfulStatusCode } from "hono/utils/http-status";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";

import type { AdminEnv } from "../config/env.schema.js";
import type { AdminDb } from "../db/create-db.js";
import { AdminAuthError, AdminAuthService } from "./auth.service.js";
import {
  createRequireAdminAuth,
  createRequireAdminRole,
  getRequestIp,
  type AdminAuthVariables,
} from "./auth.middleware.js";
import {
  acceptInviteBodySchema,
  createInviteBodySchema,
  loginBodySchema,
} from "./auth.types.js";
import { AdminInviteError, AdminInviteService } from "./invite.service.js";
import { checkLoginRateLimit } from "./rate-limit.js";
import {
  clearAdminSessionCookie,
  setAdminSessionCookie,
} from "./session-cookie.util.js";
import { AdminSessionService } from "./session.service.js";
import { ADMIN_SESSION_COOKIE } from "./auth.constants.js";

export interface AdminAuthRouteDeps {
  adminDb: AdminDb;
  config: AdminEnv;
  auth?: AdminAuthService;
  invites?: AdminInviteService;
  sessions?: AdminSessionService;
}

export function createAdminAuthRoutes(deps: AdminAuthRouteDeps): Hono<{ Variables: AdminAuthVariables }> {
  const auth = deps.auth ?? new AdminAuthService(deps.adminDb, deps.config);
  const invites = deps.invites ?? new AdminInviteService(deps.adminDb, deps.config);
  const sessions = deps.sessions ?? new AdminSessionService(deps.adminDb, deps.config);
  const requireAuth = createRequireAdminAuth(sessions);
  const requirePlatformAdmin = createRequireAdminRole("platform_admin");

  const routes = new Hono<{ Variables: AdminAuthVariables }>();

  routes.post("/login", async (c) => {
    const ip = getRequestIp(c);
    const rateLimit = checkLoginRateLimit(ip);
    if (!rateLimit.allowed) {
      if (rateLimit.retryAfterSeconds !== undefined) {
        c.header("Retry-After", String(rateLimit.retryAfterSeconds));
      }
      return c.json({ error: "Too many login attempts" }, 429);
    }

    const parsed = loginBodySchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "Invalid request body" }, 400);
    }

    try {
      const result = await auth.login(parsed.data);
      setAdminSessionCookie(c, deps.config, result.token);
      return c.json({ user: result.user }, 200);
    } catch (error) {
      if (error instanceof AdminAuthError) {
        return c.json(
          { error: error.message },
          error.status as ContentfulStatusCode,
        );
      }
      throw error;
    }
  });

  routes.post("/logout", requireAuth, async (c) => {
    const token = getCookie(c, ADMIN_SESSION_COOKIE);
    if (token) {
      await sessions.revokeByToken(token);
    }
    clearAdminSessionCookie(c);
    return c.body(null, 204);
  });

  routes.get("/me", requireAuth, (c) => {
    const session = c.get("adminSession");
    return c.json({
      id: session.user.id,
      email: session.user.email,
      role: session.user.role,
    });
  });

  routes.post("/invites", requireAuth, requirePlatformAdmin, async (c) => {
    const parsed = createInviteBodySchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "Invalid request body" }, 400);
    }

    const session = c.get("adminSession");
    try {
      const result = await invites.createInvite({
        email: parsed.data.email,
        role: parsed.data.role,
        invitedByUserId: session.user.id,
      });

      return c.json(
        {
          invite: {
            id: result.invite.id,
            email: result.invite.email,
            role: result.invite.role,
            invitedBy: result.invite.invitedBy,
            expiresAt: result.invite.expiresAt.toISOString(),
            acceptedAt: result.invite.acceptedAt?.toISOString() ?? null,
            createdAt: result.invite.createdAt.toISOString(),
          },
        },
        201,
      );
    } catch (error) {
      if (error instanceof AdminInviteError) {
        return c.json(
          { error: error.message },
          error.status as ContentfulStatusCode,
        );
      }
      throw error;
    }
  });

  routes.get("/invites", requireAuth, requirePlatformAdmin, async (c) => {
    const rows = await invites.listInvites();
    return c.json({
      invites: rows.map((invite) => ({
        id: invite.id,
        email: invite.email,
        role: invite.role,
        invitedBy: invite.invitedBy,
        expiresAt: invite.expiresAt.toISOString(),
        acceptedAt: invite.acceptedAt?.toISOString() ?? null,
        createdAt: invite.createdAt.toISOString(),
      })),
    });
  });

  routes.delete("/invites/:id", requireAuth, requirePlatformAdmin, async (c) => {
    const inviteId = c.req.param("id");
    const session = c.get("adminSession");

    try {
      await invites.revokeInvite({
        inviteId,
        actorUserId: session.user.id,
      });
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof AdminInviteError) {
        return c.json(
          { error: error.message },
          error.status as ContentfulStatusCode,
        );
      }
      throw error;
    }
  });

  routes.post("/invites/accept", async (c) => {
    const parsed = acceptInviteBodySchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "Invalid request body" }, 400);
    }

    try {
      const user = await invites.acceptInvite(parsed.data);
      const session = await sessions.createSession({
        id: user.userId,
        email: user.email,
        role: user.role,
      });
      setAdminSessionCookie(c, deps.config, session.token);

      return c.json(
        {
          user: {
            id: user.userId,
            email: user.email,
            role: user.role,
          },
        },
        200,
      );
    } catch (error) {
      if (error instanceof AdminInviteError) {
        return c.json(
          { error: error.message },
          error.status as ContentfulStatusCode,
        );
      }
      if (error instanceof Error && error.message.includes("Password must be")) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }
  });

  return routes;
}
