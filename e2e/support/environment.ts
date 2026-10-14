import { fileURLToPath } from "node:url";

/** Where the global setup writes the session every journey starts from, and where the configuration reads it. */
export const STORAGE_STATE = fileURLToPath(new URL("../.auth/state.json", import.meta.url));

/**
 * The origin the browsers visit: the https origin the server is configured with
 * (`E2E_APP_ORIGIN`), or the address of the stack itself (`E2E_BASE_URL`) when it is
 * configured with that.
 */
export function appOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const origin = env.E2E_APP_ORIGIN;
  if (origin !== undefined && origin !== "") {
    return origin;
  }
  const base = env.E2E_BASE_URL;
  if (base === undefined || base === "") {
    throw new Error(
      "E2E_BASE_URL is not set. Start a stack and set it to its address, or run `bash e2e/with-stack.sh pnpm test:e2e`.",
    );
  }
  return base;
}
