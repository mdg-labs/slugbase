import { Hono } from "hono";

import {
  createRequireAdminAuth,
  createRequireAdminRole,
  type AdminAuthVariables,
} from "../auth/auth.middleware.js";
import { createDirectoryRouteDeps, type DirectoryRouteDeps } from "./route-deps.js";

export function createBillingRoutes(
  deps: DirectoryRouteDeps,
): Hono<{ Variables: AdminAuthVariables }> {
  const { sessions, productRead } = createDirectoryRouteDeps(deps);
  const requireAuth = createRequireAdminAuth(sessions);
  const requireViewer = createRequireAdminRole("viewer");

  const routes = new Hono<{ Variables: AdminAuthVariables }>();

  routes.get("/summary", requireAuth, requireViewer, async (c) => {
    const summary = await productRead.getBillingSummary();
    return c.json(summary, 200);
  });

  return routes;
}
