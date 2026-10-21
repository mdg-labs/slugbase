import type { ComponentTypes } from "@slugbase/contracts";
import { queryOptions } from "@tanstack/react-query";
import type { ApiClient } from "../api/client.ts";

export type InstanceAccount = ComponentTypes["schemas"]["InstanceAccount"];

export const ADMIN_ACCOUNTS_QUERY_KEY = ["admin", "accounts"] as const;

/** Every account of the instance, oldest first. Only an instance admin with a second factor may ask. */
export function instanceAccountsQuery(api: ApiClient) {
  return queryOptions({
    queryKey: ADMIN_ACCOUNTS_QUERY_KEY,
    queryFn: async ({ signal }): Promise<readonly InstanceAccount[]> => {
      const { data, error } = await api.GET("/api/v1/instance/accounts", { signal });
      if (data === undefined) {
        throw new Error("The instance accounts request did not answer with a document", { cause: error });
      }
      return data.items;
    },
  });
}
