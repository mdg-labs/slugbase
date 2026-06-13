import type { LoaderFunctionArgs } from "react-router";

/** Edge health probe for staging/production smoke (spec §22.5). */
export function loader(_args: LoaderFunctionArgs) {
  return Response.json({ status: "ok" as const });
}
