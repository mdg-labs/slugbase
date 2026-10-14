import { queryOptions } from "@tanstack/react-query";
import type { ApiClient } from "../api/client.ts";

/**
 * Whether the visitor has a session: the first page of their own sessions, which the API answers `401`
 * for a visitor who is not signed in. The result is only used to tell the two apart.
 */
export function sessionQuery(api: ApiClient) {
  return queryOptions({
    queryKey: ["session"],
    // A check that cannot be answered is not worth waiting out: the visitor sees the error page or the form at once.
    retry: false,
    queryFn: async () => {
      const { data, error } = await api.GET("/api/v1/me/sessions", { params: { query: { limit: 1 } } });
      if (data === undefined) {
        throw new Error("The session check did not answer with a document", { cause: error });
      }
      return data;
    },
  });
}
