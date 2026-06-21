import { Hono } from "hono";

import type { AdminRole } from "../auth/admin-roles.js";
import { hasMinimumRole } from "../auth/admin-roles.js";
import {
  createRequireAdminAuth,
  createRequireAdminRole,
  type AdminAuthVariables,
} from "../auth/auth.middleware.js";
import { overviewStatsToCsv } from "./csv-export.js";
import { formatQuerySchema, parseQuery } from "./query-schemas.js";
import { createDirectoryRouteDeps, type DirectoryRouteDeps } from "./route-deps.js";

export function createOverviewRoutes(
  deps: DirectoryRouteDeps,
): Hono<{ Variables: AdminAuthVariables }> {
  const { sessions, productRead } = createDirectoryRouteDeps(deps);
  const requireAuth = createRequireAdminAuth(sessions);
  const requireViewer = createRequireAdminRole("viewer");

  const routes = new Hono<{ Variables: AdminAuthVariables }>();

  routes.get("/", requireAuth, requireViewer, async (c) => {
    const { format } = parseQuery(formatQuerySchema, c.req.query());
    const overview = await productRead.getLiveOverview();

    if (format === "csv") {
      const session = c.get("adminSession");
      if (!hasMinimumRole(session.user.role as AdminRole, "operator")) {
        return c.json({ error: "Forbidden" }, 403);
      }

      return c.body(overviewStatsToCsv(overview), 200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="overview.csv"',
      });
    }

    return c.json(overview, 200);
  });

  return routes;
}
