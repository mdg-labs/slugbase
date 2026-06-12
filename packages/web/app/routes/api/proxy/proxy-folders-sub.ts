import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

const getApiBaseUrl = (): string => process.env["API_BASE_URL"] ?? "";

/**
 * Proxy /api/folders/:id/* → backend /folders/:id/* (e.g. bookmark membership).
 */
async function forwardToFoldersSub(request: Request): Promise<Response> {
  const apiBaseUrl = getApiBaseUrl();
  const url = new URL(request.url);
  const backendPath = url.pathname.replace(/^\/api\/folders/, "/folders");
  const qs = url.searchParams.toString();
  const target = `${apiBaseUrl}${backendPath}${qs ? `?${qs}` : ""}`;

  const cookie = request.headers.get("Cookie") ?? "";
  const csrfToken = request.headers.get("x-csrf-token") ?? "";
  const contentType = request.headers.get("Content-Type") ?? "";

  const headers: Record<string, string> = {};
  if (cookie) headers["Cookie"] = cookie;
  if (csrfToken) headers["x-csrf-token"] = csrfToken;
  if (contentType) headers["Content-Type"] = contentType;

  const method = request.method;
  const body =
    method !== "GET" && method !== "HEAD" ? await request.text() : undefined;

  const res = await fetch(target, {
    method,
    headers,
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });

  const responseBody = await res.text();
  const responseContentType =
    res.headers.get("Content-Type") ?? "application/json";
  const responseHeaders = new Headers({ "Content-Type": responseContentType });

  const location = res.headers.get("Location");
  if (location) responseHeaders.set("Location", location);

  for (const c of res.headers.getSetCookie()) {
    responseHeaders.append("Set-Cookie", c);
  }

  return new Response(responseBody, {
    status: res.status,
    statusText: res.statusText,
    headers: responseHeaders,
  });
}

export async function loader({
  request,
}: LoaderFunctionArgs): Promise<Response> {
  return forwardToFoldersSub(request);
}

export async function action({
  request,
}: ActionFunctionArgs): Promise<Response> {
  return forwardToFoldersSub(request);
}
