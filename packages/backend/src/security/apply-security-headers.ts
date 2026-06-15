import type { NestExpressApplication } from "@nestjs/platform-express";
import type { RequestHandler } from "express";
import { createRequire } from "node:module";

export type SecurityHeadersOptions = {
  /** When true, emit Strict-Transport-Security (spec §18 — TLS deployments). */
  enableHsts?: boolean;
};

type HelmetMiddlewareOptions = {
  contentSecurityPolicy?: false;
  crossOriginEmbedderPolicy?: false;
  crossOriginResourcePolicy?: { policy: "cross-origin" };
  strictTransportSecurity?:
    | false
    | { maxAge: number; includeSubDomains: boolean };
};

type HelmetMiddlewareFactory = (
  options?: Readonly<HelmetMiddlewareOptions>,
) => RequestHandler;

const helmet = createRequire(import.meta.url)("helmet") as HelmetMiddlewareFactory;

/**
 * Apply Helmet security headers for the JSON API and shared Express stack.
 *
 * CSP is disabled so optional Scalar `/docs` (CDN script) is not blocked; the web
 * client sets its own document CSP when `SERVE_WEB_CLIENT` is enabled.
 */
export function applySecurityHeaders(
  app: NestExpressApplication,
  options: SecurityHeadersOptions = {},
): void {
  const enableHsts =
    options.enableHsts ?? process.env.NODE_ENV === "production";

  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
      strictTransportSecurity: enableHsts
        ? { maxAge: 31_536_000, includeSubDomains: true }
        : false,
    }),
  );
}
