import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LoaderFunctionArgs } from "react-router";

function readPackageVersion(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = join(currentDir, "..", "..", "package.json");
  const raw = readFileSync(packageJsonPath, "utf8");
  const parsed = JSON.parse(raw) as { version?: string };
  return parsed.version ?? "0.0.0";
}

/** Edge version probe for staging/production smoke (spec §22.5). */
export function loader(_args: LoaderFunctionArgs) {
  return Response.json({ version: readPackageVersion() });
}
