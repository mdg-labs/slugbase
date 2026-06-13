import { getServerApiBaseUrl } from "../../../lib/server-api-base-url.js";

/** Fetch forbids a body on these status codes (Undici throws otherwise). */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/** Build a client Response from an upstream fetch, preserving cookies and status. */
export function buildProxiedResponse(
  upstream: Response,
  bodyText: string,
): Response {
  const responseContentType =
    upstream.headers.get("Content-Type") ?? "application/json";

  const responseHeaders = new Headers(
    NULL_BODY_STATUSES.has(upstream.status)
      ? undefined
      : { "Content-Type": responseContentType },
  );

  const location = upstream.headers.get("Location");
  if (location) responseHeaders.set("Location", location);

  for (const cookie of upstream.headers.getSetCookie()) {
    responseHeaders.append("Set-Cookie", cookie);
  }

  return new Response(
    NULL_BODY_STATUSES.has(upstream.status) ? null : bodyText,
    {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    },
  );
}

/**
 * Forwards a request to the NestJS backend at APP_BASE_URL, preserving the
 * request method, headers (Cookie, x-csrf-token, Content-Type), body, and
 * query string. Returns a Response that React Router sends to the client.
 */
export async function proxyRequest(request: Request): Promise<Response> {
  const apiBaseUrl = getServerApiBaseUrl();
  const url = new URL(request.url);
  const qs = url.searchParams.toString();
  const target = `${apiBaseUrl}${url.pathname}${qs ? `?${qs}` : ""}`;

  const cookie = request.headers.get("Cookie") ?? "";
  const csrfToken = request.headers.get("x-csrf-token") ?? "";
  const contentType = request.headers.get("Content-Type") ?? "";

  const headers: Record<string, string> = {};
  if (cookie) headers["Cookie"] = cookie;
  if (csrfToken) headers["x-csrf-token"] = csrfToken;
  if (contentType) headers["Content-Type"] = contentType;

  try {
    const method = request.method;
    const body = method !== "GET" && method !== "HEAD" ? await request.text() : undefined;

    const res = await fetch(target, {
      method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });

    const responseBody = await res.text();

    return buildProxiedResponse(res, responseBody);
  } catch {
    return Response.json({ error: "upstream_error" }, { status: 502 });
  }
}