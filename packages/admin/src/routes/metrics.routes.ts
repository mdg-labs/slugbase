import { Hono } from "hono";

import type { AdminRole } from "../auth/admin-roles.js";
import { hasMinimumRole } from "../auth/admin-roles.js";
import {
  createRequireAdminAuth,
  createRequireAdminRole,
  type AdminAuthVariables,
} from "../auth/auth.middleware.js";
import { metricsHistoryToCsv } from "./csv-export.js";
import { metricsHistoryQuerySchema, parseQuery } from "./query-schemas.js";
import { createDirectoryRouteDeps, type DirectoryRouteDeps } from "./route-deps.js";

export function createMetricsRoutes(
  deps: DirectoryRouteDeps,
): Hono<{ Variables: AdminAuthVariables }> {
  const { sessions, metricsHistory } = createDirectoryRouteDeps(deps);
  const requireAuth = createRequireAdminAuth(sessions);
  const requireViewer = createRequireAdminRole("viewer");

  const routes = new Hono<{ Variables: AdminAuthVariables }>();

  routes.get("/history", requireAuth, requireViewer, async (c) => {
    const query = parseQuery(metricsHistoryQuerySchema, c.req.query());
    const result = await metricsHistory.listHistory({
      page: query.page,
      limit: query.limit,
    });

    if (query.format === "csv") {
      const session = c.get("adminSession");
      if (!hasMinimumRole(session.user.role as AdminRole, "operator")) {
        return c.json({ error: "Forbidden" }, 403);
      }

      return c.body(metricsHistoryToCsv(result.items), 200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="metrics-history.csv"',
      });
    }

    return c.json(result, 200);
  });

  return routes;
}
