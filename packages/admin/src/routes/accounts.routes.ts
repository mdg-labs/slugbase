import { Hono } from "hono";

import {
  createRequireAdminAuth,
  createRequireAdminRole,
  type AdminAuthVariables,
} from "../auth/auth.middleware.js";
import { accountListQuerySchema, parseQuery } from "./query-schemas.js";
import { createDirectoryRouteDeps, type DirectoryRouteDeps } from "./route-deps.js";

export function createAccountsRoutes(
  deps: DirectoryRouteDeps,
): Hono<{ Variables: AdminAuthVariables }> {
  const { sessions, productRead } = createDirectoryRouteDeps(deps);
  const requireAuth = createRequireAdminAuth(sessions);
  const requireViewer = createRequireAdminRole("viewer");

  const routes = new Hono<{ Variables: AdminAuthVariables }>();

  routes.get("/", requireAuth, requireViewer, async (c) => {
    const query = parseQuery(accountListQuerySchema, c.req.query());
    const result = await productRead.listAccounts({
      page: query.page,
      limit: query.limit,
      sort: query.sort,
      order: query.order,
    });

    return c.json(result, 200);
  });

  routes.get("/:id", requireAuth, requireViewer, async (c) => {
    const account = await productRead.getAccount(c.req.param("id"));
    if (!account) {
      return c.json({ error: "Not found" }, 404);
    }

    return c.json({ account }, 200);
  });

  return routes;
}
