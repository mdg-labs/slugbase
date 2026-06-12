import { createRequestListener } from "@mjackson/node-fetch-server";
import { createRequestHandler } from "@react-router/express";
import type { NestExpressApplication } from "@nestjs/platform-express";
import compression from "compression";
import express, { type Request as ExpressRequest, type RequestHandler } from "express";
import { dirname, join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ServerBuild } from "react-router";

type CloudflareStyleBuild = {
  default: {
    fetch: (request: globalThis.Request) => Response | Promise<Response>;
  };
  unstable_reactRouterServeConfig?: {
    publicPath?: string;
    assetsBuildDirectory?: string;
  };
};

/** GET paths served only by the API even when Accept includes HTML. */
const API_ONLY_GET_PATHS = new Set([
  "/health",
  "/version",
  "/openapi.json",
  "/docs",
  "/setup/status",
]);

function isCloudflareStyleBuild(
  buildModule: unknown,
): buildModule is CloudflareStyleBuild {
  return (
    typeof buildModule === "object" &&
    buildModule !== null &&
    "default" in buildModule &&
    typeof buildModule.default === "object" &&
    buildModule.default !== null &&
    "fetch" in buildModule.default &&
    typeof buildModule.default.fetch === "function"
  );
}

/**
 * Route browser document navigations and HTML form posts to the React Router
 * app. JSON/API traffic continues to Nest controllers on the same port.
 */
export function shouldServeWebClient(req: ExpressRequest): boolean {
  const path = req.path;

  if (path.startsWith("/assets/")) {
    return true;
  }

  // React Router single-fetch client navigations (e.g. /_root.data, /login.data)
  if (path.endsWith(".data")) {
    return true;
  }

  // Lazy route discovery for fetcher.load / client navigations (RR7 single-fetch)
  if (path === "/__manifest" || path.startsWith("/__manifest/")) {
    return true;
  }

  // RR proxy routes under /api/* (Nest has no /api controllers)
  if (path.startsWith("/api/")) {
    return true;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    if (API_ONLY_GET_PATHS.has(path)) {
      return false;
    }

    const accept = req.headers.accept ?? "";
    const wantsHtml =
      accept.includes("text/html") ||
      accept.includes("application/xhtml+xml");

    return wantsHtml;
  }

  if (req.method === "POST") {
    const contentType = req.headers["content-type"] ?? "";
    return (
      contentType.includes("application/x-www-form-urlencoded") ||
      contentType.includes("multipart/form-data")
    );
  }

  return false;
}

/**
 * Mount the bundled React Router client on the Nest Express app.
 *
 * Must run before `app.init()` so document requests are handled before Nest's
 * 404 handler. Mirrors `@react-router/serve` for Cloudflare-style builds.
 */
export async function registerWebClientMiddleware(
  app: NestExpressApplication,
  serverBuildPath: string,
): Promise<void> {
  const buildPath = serverBuildPath;
  const buildModule: unknown = await import(pathToFileURL(buildPath).href);

  const buildDir = dirname(buildPath);
  let publicPath = "/";
  let assetsBuildDirectory = join(buildDir, "..", "client");
  let webHandler: RequestHandler;

  if (isCloudflareStyleBuild(buildModule)) {
    const config = {
      publicPath: "/",
      assetsBuildDirectory: join("..", "client"),
      ...buildModule.unstable_reactRouterServeConfig,
    };
    publicPath = config.publicPath;
    assetsBuildDirectory = resolve(buildDir, config.assetsBuildDirectory);
    webHandler = createRequestListener(buildModule.default.fetch);
  } else {
    const classicBuild =
      (buildModule as { default?: ServerBuild }).default ??
      (buildModule as ServerBuild);
    publicPath = classicBuild.publicPath;
    assetsBuildDirectory = join(buildDir, "..", "client");
    webHandler = createRequestHandler({
      build: classicBuild,
      mode: process.env.NODE_ENV,
    });
  }

  const httpApp = app.getHttpAdapter().getInstance();

  httpApp.use(compression());
  httpApp.use(
    posix.join(publicPath, "assets"),
    express.static(join(assetsBuildDirectory, "assets"), {
      immutable: true,
      maxAge: "1y",
    }),
  );
  httpApp.use(publicPath, express.static(assetsBuildDirectory));

  httpApp.use((req: ExpressRequest, res, next) => {
    if (!shouldServeWebClient(req)) {
      next();
      return;
    }
    webHandler(req, res, next);
  });
}

/** @deprecated Use registerWebClientMiddleware before app.init(). */
export async function mountWebClient(
  app: NestExpressApplication,
  serverBuildPath: string,
): Promise<void> {
  await registerWebClientMiddleware(app, serverBuildPath);
}
