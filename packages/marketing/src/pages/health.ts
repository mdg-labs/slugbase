import type { APIRoute } from "astro";

export const prerender = true;

/** Static health probe for deploy smoke (spec §22.5). */
export const GET: APIRoute = () =>
  new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
