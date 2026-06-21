import { Hono } from "hono";

import {
  createRequireAdminAuth,
  createRequireAdminRole,
  type AdminAuthVariables,
} from "../auth/auth.middleware.js";
import { paginationQuerySchema, parseQuery } from "./query-schemas.js";
import { createDirectoryRouteDeps, type DirectoryRouteDeps } from "./route-deps.js";

export function createWorkspacesRoutes(
  deps: DirectoryRouteDeps,
): Hono<{ Variables: AdminAuthVariables }> {
  const { sessions, productRead } = createDirectoryRouteDeps(deps);
  const requireAuth = createRequireAdminAuth(sessions);
  const requireViewer = createRequireAdminRole("viewer");

  const routes = new Hono<{ Variables: AdminAuthVariables }>();

  routes.get("/", requireAuth, requireViewer, async (c) => {
    const query = parseQuery(paginationQuerySchema, c.req.query());
    const result = await productRead.listWorkspaces({
      page: query.page,
      limit: query.limit,
    });

    return c.json(result, 200);
  });

  routes.get("/:id", requireAuth, requireViewer, async (c) => {
    const workspace = await productRead.getWorkspace(c.req.param("id"));
    if (!workspace) {
      return c.json({ error: "Not found" }, 404);
    }

    return c.json({ workspace }, 200);
  });

  return routes;
}
