import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { buildProxiedResponse } from "../utils/proxy.js";

const getApiBaseUrl = (): string => process.env["API_BASE_URL"] ?? "";

/**
 * Proxy /api/folders → backend /folders (list, create).
 */
async function forwardToFolders(request: Request): Promise<Response> {
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
  return buildProxiedResponse(res, responseBody);
}

export async function loader({
  request,
}: LoaderFunctionArgs): Promise<Response> {
  return forwardToFolders(request);
}

export async function action({
  request,
}: ActionFunctionArgs): Promise<Response> {
  return forwardToFolders(request);
}
