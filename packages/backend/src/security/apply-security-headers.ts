import type { NestExpressApplication } from "@nestjs/platform-express";
import helmet from "helmet";

export type SecurityHeadersOptions = {
  /** When true, emit Strict-Transport-Security (spec §18 — TLS deployments). */
  enableHsts?: boolean;
};

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
