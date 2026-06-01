import type { APIRoute } from "astro";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const prerender = true;

function readPackageVersion(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = join(currentDir, "..", "..", "package.json");
  const raw = readFileSync(packageJsonPath, "utf8");
  const parsed = JSON.parse(raw) as { version?: string };
  return parsed.version ?? "0.0.0";
}

/** Static version probe for Workers smoke (spec §22.5). */
export const GET: APIRoute = () =>
  new Response(JSON.stringify({ version: readPackageVersion() }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
