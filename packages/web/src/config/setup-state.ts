import type { QueryClient } from "@tanstack/react-query";

// Whether first-run setup is pending decides where every signed-out route goes, and the routes read it before
// they render, from the router context. It is kept per query client and outside its cache, which an ended
// session or a sign-in empties, so the answer of the configuration is not lost with what the cache held.
const pending = new WeakMap<QueryClient, boolean>();

/** Records whether the instance still waits for its first account, as the configuration or a finished setup says. */
export function rememberSetupRequired(queryClient: QueryClient, required: boolean): void {
  pending.set(queryClient, required);
}

/** Whether the instance still waits for its first account; false until the configuration said otherwise. */
export function isSetupRequired(queryClient: QueryClient): boolean {
  return pending.get(queryClient) ?? false;
}
