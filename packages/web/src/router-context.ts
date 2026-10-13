import type { QueryClient } from "@tanstack/react-query";
import type { ApiClient } from "./api/client.ts";

/** What every route can read from the router context: the shared query cache and the typed API client. */
export interface RouterContext {
  readonly queryClient: QueryClient;
  readonly api: ApiClient;
}
