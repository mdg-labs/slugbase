const getApiBaseUrl = (): string => process.env["API_BASE_URL"] ?? "";

/**
 * Forwards a request to the NestJS backend at APP_BASE_URL, preserving the
 * request method, headers (Cookie, x-csrf-token, Content-Type), body, and
 * query string. Returns a Response that React Router sends to the client.
 */
export async function proxyRequest(request: Request): Promise<Response> {
  const apiBaseUrl = getApiBaseUrl();
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
    });

    const responseBody = await res.text();
    const responseContentType = res.headers.get("Content-Type") ?? "application/json";

    const location = res.headers.get("Location");
    const responseHeaders: Record<string, string> = {
      "Content-Type": responseContentType,
    };
    if (location) responseHeaders["Location"] = location;

    return new Response(responseBody, {
      status: res.status,
      statusText: res.statusText,
      headers: responseHeaders,
    });
  } catch {
    return Response.json({ error: "upstream_error" }, { status: 502 });
  }
}