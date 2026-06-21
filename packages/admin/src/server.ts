import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { proxy } from "hono/proxy";

import { loadAdminConfig } from "./config/load-config.js";

const VITE_DEV_SERVER_URL =
  process.env["VITE_DEV_SERVER_URL"] ?? "http://localhost:5173";

export function createApp(options?: { isProduction?: boolean }): Hono {
  const config = loadAdminConfig();
  const isProduction = options?.isProduction ?? config.NODE_ENV === "production";
  const app = new Hono();

  app.get("/health", (c) =>
    c.json({ status: "ok", service: "slugbase-admin" }, 200),
  );

  app.get("/api/health", (c) =>
    c.json({ status: "ok", service: "slugbase-admin" }, 200),
  );

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

export function startServer(): void {
  const config = loadAdminConfig();
  const app = createApp();
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
}

const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("/server.ts") ||
    process.argv[1].endsWith("/server.js"));

if (isMain) {
  startServer();
}
