import type { LoaderFunctionArgs } from "react-router";

import { getServerApiBaseUrl } from "../../../lib/server-api-base-url.js";

/**
 * Binary-safe proxy for favicon requests from the client.
 *
 * The browser `<img src="/bookmarks/favicon?url=...">` tag cannot set cookies,
 * so the NestJS backend's TenantGuard rejects unauthenticated requests.
 * This server-side loader forwards the user's session cookie to the backend
 * and streams the binary image response back to the client.
 */
export async function loader({ request }: LoaderFunctionArgs): Promise<Response> {
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get("url");
  if (!targetUrl) {
    return new Response("", { status: 400 });
  }

  const apiBaseUrl = getServerApiBaseUrl();
  const cookie = request.headers.get("Cookie") ?? "";

  try {
    const res = await fetch(
      `${apiBaseUrl}/bookmarks/favicon?url=${encodeURIComponent(targetUrl)}`,
      {
        headers: cookie ? { Cookie: cookie } : {},
        redirect: "follow",
      },
    );

    if (!res.ok) {
      return new Response("", { status: res.status });
    }

    const contentType = res.headers.get("Content-Type") ?? "image/png";
    const cacheControl = res.headers.get("Cache-Control") ?? "public, max-age=604800";
    const body = await res.arrayBuffer();

    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": cacheControl,
      },
    });
  } catch {
    return new Response("", { status: 502 });
  }
}
