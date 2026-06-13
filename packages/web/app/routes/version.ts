import type { LoaderFunctionArgs } from "react-router";
import pkg from "../../package.json";

/** Edge version probe for staging/production smoke (spec §22.5). */
export function loader(_args: LoaderFunctionArgs) {
  return Response.json({ version: pkg.version });
}
