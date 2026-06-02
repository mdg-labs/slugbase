import type { LoaderFunctionArgs } from "react-router";

const getApiBaseUrl = (): string => process.env["API_BASE_URL"] ?? "";

/** Proxy GET /api/go/:slug → backend GET /go/:slug (returns JSON, never follows redirect). */
export async function loader({ request, params }: LoaderFunctionArgs) {
  const slug = params["slug"] ?? "";
  const cookie = request.headers.get("Cookie") ?? "";
  const apiBaseUrl = getApiBaseUrl();

  try {
    const res = await fetch(`${apiBaseUrl}/go/${encodeURIComponent(slug)}`, {
      headers: cookie ? { Cookie: cookie } : {},
      redirect: "manual",
    });

    // 302 from backend → return redirect JSON shape
    if (res.status === 302 || res.status === 301) {
      const location = res.headers.get("Location") ?? "";
      return Response.json({ kind: "redirect", url: location, bookmarkId: "" });
    }

    if (!res.ok) {
      return Response.json({ error: "not_found" }, { status: res.status });
    }

    const responseData: unknown = await res.json();
    return Response.json(responseData);
  } catch {
    return Response.json({ error: "upstream_error" }, { status: 502 });
  }
}

