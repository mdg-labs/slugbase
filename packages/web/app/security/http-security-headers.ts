import { getServerApiBaseUrl } from "../lib/server-api-base-url.js";

export interface SecurityHeaderConfig {
  /** CSP nonce for document responses (React Router inline scripts). */
  cspNonce?: string;
  /** When true, relax connect-src for Vite HMR websockets. */
  isDev?: boolean;
  /** When true, add Strict-Transport-Security (HTTPS deployments only). */
  isHttps?: boolean;
}

function readViteEnv(key: string): string | undefined {
  if (!(key in import.meta.env)) {
    return undefined;
  }
  const value: unknown = import.meta.env[key as keyof ImportMetaEnv];
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

function normalizeOrigin(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    return new URL(raw).origin;
  } catch {
    return undefined;
  }
}

function umamiOrigin(): string | undefined {
  const host = readViteEnv("VITE_UMAMI_HOST");
  return host ? normalizeOrigin(host.replace(/\/$/, "")) : undefined;
}

function sentryConnectOrigins(): string[] {
  const dsn = readViteEnv("VITE_SENTRY_DSN");
  if (!dsn) {
    return [];
  }
  try {
    const origin = new URL(dsn).origin;
    return origin ? [origin] : [];
  } catch {
    return [];
  }
}

function uniqueSources(sources: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const source of sources) {
    if (!source || seen.has(source)) {
      continue;
    }
    seen.add(source);
    result.push(source);
  }
  return result;
}

/**
 * Builds Content-Security-Policy for HTML document responses.
 *
 * Nonce strategy (React Router v7): per-request nonce on inline scripts via
 * `ServerRouter`, `renderToReadableStream({ nonce })`, and root `<Scripts nonce>`.
 * External module scripts are allowed via `'strict-dynamic'` after the nonced bootstrap.
 * Umami is allowlisted in `script-src` / `connect-src` when `VITE_UMAMI_HOST` is set.
 */
export function buildDocumentContentSecurityPolicy(config: SecurityHeaderConfig): string {
  const scriptSources = ["'self'"];
  if (config.cspNonce) {
    scriptSources.push(`'nonce-${config.cspNonce}'`, "'strict-dynamic'");
  }
  const umami = umamiOrigin();
  if (umami) {
    scriptSources.push(umami);
  }
  if (config.isDev) {
    scriptSources.push("'unsafe-eval'");
  }

  const connectSources = uniqueSources([
    "'self'",
    normalizeOrigin(getServerApiBaseUrl()),
    normalizeOrigin(readViteEnv("VITE_APP_BASE_URL")),
    umami,
    ...sentryConnectOrigins(),
    config.isDev ? "ws:" : undefined,
    config.isDev ? "wss:" : undefined,
  ]);

  const directives = [
    "default-src 'self'",
    `script-src ${scriptSources.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https: blob:",
    "font-src 'self'",
    "connect-src " + connectSources.join(" "),
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ];

  return directives.join("; ");
}

/** CSP for static assets (JS/CSS) — no inline scripts, no nonce required. */
export function buildStaticContentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; ");
}

/** Shared baseline headers for all web responses (spec §18). */
export function buildBaselineSecurityHeaders(
  config: SecurityHeaderConfig,
): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  };

  if (config.isHttps) {
    headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  }

  return headers;
}

export function applyDocumentSecurityHeaders(
  headers: Headers,
  config: SecurityHeaderConfig,
): void {
  const baseline = buildBaselineSecurityHeaders(config);
  for (const [name, value] of Object.entries(baseline)) {
    headers.set(name, value);
  }
  headers.set("Content-Security-Policy", buildDocumentContentSecurityPolicy(config));
}

export function applyStaticSecurityHeaders(headers: Headers, config: SecurityHeaderConfig): void {
  const baseline = buildBaselineSecurityHeaders(config);
  for (const [name, value] of Object.entries(baseline)) {
    if (!headers.has(name)) {
      headers.set(name, value);
    }
  }
  if (!headers.has("Content-Security-Policy")) {
    headers.set("Content-Security-Policy", buildStaticContentSecurityPolicy());
  }
}

/** Merge security headers onto a Worker response without overriding SSR document CSP. */
export function mergeWorkerSecurityHeaders(
  response: Response,
  request: Request,
  isDev: boolean,
): Response {
  const headers = new Headers(response.headers);
  const isHttps = new URL(request.url).protocol === "https:";
  const contentType = headers.get("Content-Type") ?? "";
  const isHtml = contentType.includes("text/html");

  if (isHtml && headers.has("Content-Security-Policy")) {
    applyStaticSecurityHeaders(headers, { isHttps, isDev });
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  if (isHtml) {
    applyDocumentSecurityHeaders(headers, { isHttps, isDev });
  } else {
    applyStaticSecurityHeaders(headers, { isHttps, isDev });
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
