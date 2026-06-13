import type { ActionFunctionArgs } from "react-router";

import { getServerApiBaseUrl } from "../../lib/server-api-base-url.js";

/** Proxy POST /api/import/netscape-html → backend POST /import/netscape-html */
export async function action({ request, params }: ActionFunctionArgs) {
  const kind = params["kind"] ?? "";
  if (kind !== "netscape-html" && kind !== "json") {
    return Response.json({ error: "unsupported_kind" }, { status: 400 });
  }

  const cookie = request.headers.get("Cookie") ?? "";
  const csrfToken = request.headers.get("x-csrf-token") ?? "";
  const apiBaseUrl = getServerApiBaseUrl();
  const body = await request.text();

  try {
    const res = await fetch(`${apiBaseUrl}/import/${kind}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-csrf-token": csrfToken,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body,
    });

    if (!res.ok) {
      return Response.json({ error: "import_failed" }, { status: res.status });
    }

    return (await res.json()) as Response;
  } catch {
    return Response.json({ error: "upstream_error" }, { status: 502 });
  }
}
