import type { ActionFunctionArgs } from "react-router";

import { getServerApiBaseUrl } from "../../lib/server-api-base-url.js";

/** Proxy POST /api/go/:slug/choose → backend POST /go/:slug/choose. */
export async function action({ request, params }: ActionFunctionArgs) {
  const slug = params["slug"] ?? "";
  const cookie = request.headers.get("Cookie") ?? "";
  const csrfToken = request.headers.get("x-csrf-token") ?? "";
  const apiBaseUrl = getServerApiBaseUrl();
  const body = await request.text();

  try {
    const res = await fetch(
      `${apiBaseUrl}/go/${encodeURIComponent(slug)}/choose`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": csrfToken,
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body,
        redirect: "manual",
      },
    );

    if (res.status === 302 || res.status === 301) {
      const location = res.headers.get("Location") ?? "";
      return Response.json({ kind: "redirect", url: location });
    }

    if (!res.ok) {
      return Response.json({ error: "choose_failed" }, { status: res.status });
    }

    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "upstream_error" }, { status: 502 });
  }
}
