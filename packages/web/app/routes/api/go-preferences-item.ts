import type { ActionFunctionArgs } from "react-router";

import { getServerApiBaseUrl } from "../../lib/server-api-base-url.js";

/** Proxy DELETE /api/go/preferences/:id → backend DELETE /go/preferences/:id. */
export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method !== "DELETE") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  const id = params["id"] ?? "";
  const cookie = request.headers.get("Cookie") ?? "";
  const csrfToken = request.headers.get("x-csrf-token") ?? "";
  const apiBaseUrl = getServerApiBaseUrl();

  try {
    const res = await fetch(
      `${apiBaseUrl}/go/preferences/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        headers: {
          "x-csrf-token": csrfToken,
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
    );

    return new Response(null, { status: res.status });
  } catch {
    return Response.json({ error: "upstream_error" }, { status: 502 });
  }
}
