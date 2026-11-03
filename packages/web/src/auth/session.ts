import { queryOptions } from "@tanstack/react-query";
import { isExportOnlyRefusal, type ApiClient } from "../api/client.ts";

/**
 * Whether the visitor has a session: the first page of their own sessions, which the API answers `401`
 * for a visitor who is not signed in. The result is only used to tell the two apart. An account in the export-only access mode
 * (doc 02 section 2.11) is refused the list with `403 account_export_only`, which is the answer of a signed-in visitor, so it counts as a session.
 */
export function sessionQuery(api: ApiClient) {
  return queryOptions({
    queryKey: ["session"],
    // A check that cannot be answered is not worth waiting out: the visitor sees the error page or the form at once.
    retry: false,
    queryFn: async () => {
      try {
        const { data, error } = await api.GET("/api/v1/me/sessions", { params: { query: { limit: 1 } } });
        if (data === undefined) {
          throw new Error("The session check did not answer with a document", { cause: error });
        }
        return data;
      } catch (caught) {
        if (isExportOnlyRefusal(caught)) {
          return { items: [], nextCursor: null };
        }
        throw caught;
      }
    },
  });
}
