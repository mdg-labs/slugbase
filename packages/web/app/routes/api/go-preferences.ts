import type { LoaderFunctionArgs } from "react-router";

import { getServerApiBaseUrl } from "../../lib/server-api-base-url.js";

/** Proxy GET /api/go/preferences → backend GET /go/preferences. */
export async function loader({ request }: LoaderFunctionArgs) {
  const cookie = request.headers.get("Cookie") ?? "";
  const apiBaseUrl = getServerApiBaseUrl();

  try {
    const res = await fetch(`${apiBaseUrl}/go/preferences`, {
      headers: cookie ? { Cookie: cookie } : {},
    });

    if (!res.ok) {
      return Response.json({ error: "preferences_failed" }, { status: res.status });
    }

    const responseData: unknown = await res.json();
    return Response.json(responseData);
  } catch {
    return Response.json({ error: "upstream_error" }, { status: 502 });
  }
}
