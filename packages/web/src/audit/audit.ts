import type { ComponentTypes } from "@slugbase/contracts";
import { infiniteQueryOptions } from "@tanstack/react-query";
import type { ApiClient } from "../api/client.ts";
import type { AuditCategory } from "./audit-search.ts";

export type AuditEvent = ComponentTypes["schemas"]["AuditEvent"];

export const AUDIT_QUERY_KEY = ["audit"] as const;

/** How many events a page of the log holds; the API's own default. */
export const AUDIT_PAGE_SIZE = 50;

/** What narrows the list: the page asks for the whole log until a filter adds its field here. */
export interface AuditListParams {
  readonly limit?: number;
  /** Only events made by this account. */
  readonly actorAccountId?: string;
  /** Only events of these groups of actions, any of them. */
  readonly category?: readonly AuditCategory[];
}

/**
 * The events of the workspace the session acts in, newest first, a page at a time by the keyset cursor, kept under that
 * workspace's key. The request names no workspace, so a list under one key for all of them would stand in the next one; a
 * caller does not start the read while the workspace is unknown. The params are part of the key, and a cursor is valid only
 * with the params it was issued for.
 */
export function auditEventsQuery(api: ApiClient, workspaceId: string | undefined, params: AuditListParams = {}) {
  const limit = params.limit ?? AUDIT_PAGE_SIZE;
  const filters = {
    ...(params.actorAccountId === undefined ? {} : { actorAccountId: params.actorAccountId }),
    ...(params.category === undefined || params.category.length === 0 ? {} : { category: [...params.category] }),
  };
  return infiniteQueryOptions({
    queryKey: [...AUDIT_QUERY_KEY, "list", workspaceId ?? null, { limit, ...filters }],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const { data, error } = await api.GET("/api/v1/audit-events", {
        params: { query: { limit, ...filters, ...(pageParam === undefined ? {} : { cursor: pageParam }) } },
        signal,
      });
      if (data === undefined) {
        throw new Error("The audit events request did not answer with a document", { cause: error });
      }
      return data;
    },
    getNextPageParam: (last): string | undefined => last.nextCursor ?? undefined,
  });
}
