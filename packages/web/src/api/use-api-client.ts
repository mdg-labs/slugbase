import { useRouter } from "@tanstack/react-router";
import type { AppRouter } from "../router.ts";
import type { ApiClient } from "./client.ts";

/**
 * The web app's own typed API client (doc 04 section 1.1), the one its pages use: a problem answer throws
 * `ApiProblemError`, a `401` that ends the session ends it the way the app does, and a call that needs a
 * fresh sign-in or a second factor goes through the app's prompts. Throws outside the web app.
 */
export function useApiClient(): ApiClient {
  // Without a router in context the hook answers null although its type does not say so.
  const router = useRouter({ warn: false }) as AppRouter | null;
  if (router === null) {
    throw new Error("The API client can only be read inside the web app");
  }
  return router.options.context.api;
}
