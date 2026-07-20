import type { APIRoute } from "astro";
import pkg from "../../package.json";

export const prerender = true;

/** Static version probe for deploy smoke (spec §22.5). */
export const GET: APIRoute = () =>
  new Response(JSON.stringify({ version: pkg.version }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
