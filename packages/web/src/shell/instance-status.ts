import type { ComponentTypes } from "@slugbase/contracts";
import { queryOptions } from "@tanstack/react-query";
import type { ApiClient } from "../api/client.ts";

export type InstanceStatus = ComponentTypes["schemas"]["InstanceStatus"];

export const INSTANCE_STATUS_QUERY_KEY = ["admin", "instance-status"] as const;

/** The version, migration level, configured ports, registration settings, counts and job health of the instance. Only an instance admin with a second factor may ask. */
export function instanceStatusQuery(api: ApiClient) {
  return queryOptions({
    queryKey: INSTANCE_STATUS_QUERY_KEY,
    queryFn: async ({ signal }): Promise<InstanceStatus> => {
      const { data, error } = await api.GET("/api/v1/instance/status", { signal });
      if (data === undefined) {
        throw new Error("The instance status request did not answer with a document", { cause: error });
      }
      return data;
    },
  });
}
