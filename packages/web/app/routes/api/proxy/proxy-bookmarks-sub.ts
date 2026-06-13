import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { buildProxiedResponse } from "../utils/proxy.js";

import { getServerApiBaseUrl } from "../../../lib/server-api-base-url.js";

/**
 * Proxy /api/bookmarks/:subpath → backend /bookmarks/:subpath
 * (e.g. /api/bookmarks/some-id → /bookmarks/some-id for PATCH).
 */
async function forwardToBookmarksSub(request: Request): Promise<Response> {
  const apiBaseUrl = getServerApiBaseUrl();
  const url = new URL(request.url);
  const backendPath = url.pathname.replace(/^\/api\/bookmarks/, "/bookmarks");
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
  return buildProxiedResponse(res, responseBody);
}

export async function loader({
  request,
}: LoaderFunctionArgs): Promise<Response> {
  return forwardToBookmarksSub(request);
}

export async function action({
  request,
}: ActionFunctionArgs): Promise<Response> {
  return forwardToBookmarksSub(request);
}
