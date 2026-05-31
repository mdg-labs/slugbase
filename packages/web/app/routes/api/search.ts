import type { LoaderFunctionArgs } from "react-router";

import type { GlobalSearchResult } from "../../lib/search.types.js";

const getApiBaseUrl = (): string => process.env["API_BASE_URL"] ?? "";

/** Proxies authenticated global search to the NestJS API (cookie-forwarding). */
export async function loader({
  request,
}: LoaderFunctionArgs): Promise<GlobalSearchResult | Response> {
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() ?? "";

  if (!q) {
    return Response.json({ error: "q is required" }, { status: 400 });
  }

  const params = new URLSearchParams({ q });
  for (const key of ["bookmarkLimit", "folderLimit", "tagLimit"] as const) {
    const value = url.searchParams.get(key);
    if (value) params.set(key, value);
  }

  const apiBaseUrl = getApiBaseUrl();
  const cookie = request.headers.get("Cookie") ?? "";

  try {
    const res = await fetch(`${apiBaseUrl}/search?${params.toString()}`, {
      headers: cookie ? { Cookie: cookie } : {},
    });

    if (!res.ok) {
      return Response.json(
        { error: "search request failed" },
        { status: res.status },
      );
    }

    return (await res.json()) as GlobalSearchResult;
  } catch {
    return Response.json({ error: "search request failed" }, { status: 502 });
  }
}
