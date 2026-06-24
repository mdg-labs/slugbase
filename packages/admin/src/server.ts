import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { VersionResponseSchema } from "@slugbase/shared-types";
import { Hono } from "hono";
import { proxy } from "hono/proxy";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { bootstrapAdminIfNeeded } from "./auth/bootstrap.service.js";
import { createAdminAuthRoutes } from "./auth/auth.routes.js";
import { loadAdminConfig } from "./config/load-config.js";
import type { AdminEnv } from "./config/env.schema.js";
import { createAdminDb, type AdminDb } from "./db/create-db.js";
import { initAdminSentry } from "./error-reporting/sentry.js";
import { startAdminScheduler } from "./jobs/scheduler.js";
import { createInternalRoutes } from "./routes/internal.routes.js";
import { createOverviewRoutes } from "./routes/overview.routes.js";
import { createAccountsRoutes } from "./routes/accounts.routes.js";
import { createWorkspacesRoutes } from "./routes/workspaces.routes.js";
import { createBillingRoutes } from "./routes/billing.routes.js";
import { createMetricsRoutes } from "./routes/metrics.routes.js";

const VITE_DEV_SERVER_URL =
  process.env["VITE_DEV_SERVER_URL"] ?? "http://localhost:5173";

function readPackageVersion(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = join(currentDir, "..", "package.json");
  const raw = readFileSync(packageJsonPath, "utf8");
  const parsed = JSON.parse(raw) as { version?: string };
  return parsed.version ?? "0.0.0";
}

const adminPackageVersion = readPackageVersion();

export interface CreateAppOptions {
  isProduction?: boolean;
  adminDb?: AdminDb;
  config?: AdminEnv;
}

export function createApp(options?: CreateAppOptions): Hono {
  const config = options?.config ?? loadAdminConfig();
  const isProduction = options?.isProduction ?? config.NODE_ENV === "production";
  const adminDb = options?.adminDb ?? createAdminDb(config.DATABASE_URL);
  const app = new Hono();

  app.get("/health", (c) =>
    c.json({ status: "ok", service: "slugbase-admin" }, 200),
  );

  app.get("/api/health", (c) =>
    c.json({ status: "ok", service: "slugbase-admin" }, 200),
  );

  app.get("/version", (c) => {
    const body = VersionResponseSchema.parse({ version: adminPackageVersion });
    return c.json(body, 200);
  });

  app.route("/api/auth", createAdminAuthRoutes({ adminDb, config }));
  app.route("/api/internal", createInternalRoutes({ adminDb, config }));

  const directoryDeps = { adminDb, config };
  app.route("/api/overview", createOverviewRoutes(directoryDeps));
  app.route("/api/accounts", createAccountsRoutes(directoryDeps));
  app.route("/api/workspaces", createWorkspacesRoutes(directoryDeps));
  app.route("/api/billing", createBillingRoutes(directoryDeps));
  app.route("/api/metrics", createMetricsRoutes(directoryDeps));

  if (isProduction) {
    app.use(
      "/*",
      serveStatic({
        root: "./dist/client",
      }),
    );
    app.get("*", serveStatic({ path: "./dist/client/index.html" }));
  } else {
    app.all("*", async (c) => {
      const path = c.req.path;
      const target = new URL(path, VITE_DEV_SERVER_URL);
      target.search = new URL(c.req.url).search;
      return proxy(target.toString(), c.req.raw);
    });
  }

  return app;
}

export async function startServer(): Promise<void> {
  const config = loadAdminConfig();
  initAdminSentry(config);
  const adminDb = createAdminDb(config.DATABASE_URL);
  await bootstrapAdminIfNeeded(adminDb, config);
  const scheduler = startAdminScheduler(adminDb, config);
  const app = createApp({ adminDb, config });
  serve(
    {
      fetch: app.fetch,
      port: config.PORT,
    },
    (info) => {
      process.stdout.write(
        `slugbase-admin listening on http://localhost:${String(info.port)}\n`,
      );
    },
  );

  const shutdown = (): void => {
    scheduler.stop();
    void adminDb.close();
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("/server.ts") ||
    process.argv[1].endsWith("/server.js"));

if (isMain) {
  void startServer().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`slugbase-admin failed to start: ${message}\n`);
    process.exit(1);
  });
}
