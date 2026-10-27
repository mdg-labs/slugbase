import type { ComponentTypes } from "@slugbase/contracts";
import { queryOptions } from "@tanstack/react-query";
import type { ApiClient } from "../api/client.ts";

export type GoResolution = ComponentTypes["schemas"]["GoResolution"];
export type GoCandidate = ComponentTypes["schemas"]["GoCandidate"];
export type GoWorkspace = ComponentTypes["schemas"]["GoWorkspace"];

export const GO_QUERY_KEY = ["go"] as const;

/**
 * What a slug resolves to for the member in a workspace (doc 02 section 6.2). The answer is read once per visit: it is
 * not kept after the page is left and not read again when the window gains focus. Switching the workspace reads every query
 * again, which is what the candidates need, since they belong to the workspace. The answer names no address and counts no use.
 */
export function resolveQuery(api: ApiClient, slug: string) {
  return queryOptions({
    queryKey: [...GO_QUERY_KEY, "resolve", slug],
    queryFn: async ({ signal }): Promise<GoResolution> => {
      const { data, error } = await api.POST("/api/v1/go/resolve", { body: { slug }, signal });
      if (data === undefined) {
        throw new Error("The slug resolution did not answer with a document", { cause: error });
      }
      return data;
    },
    gcTime: 0,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
}

export interface GoChoice {
  readonly slug: string;
  readonly bookmarkId: string;
  readonly remember: boolean;
}

/** Whether `address` is an http or https address, the only kind the page leaves for. */
export function isWebAddress(address: string): boolean {
  try {
    const { protocol } = new URL(address);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** Chooses a bookmark of the slug and answers its destination; the use is counted and the choice remembered by the server. */
export async function chooseBookmark(api: ApiClient, { slug, bookmarkId, remember }: GoChoice): Promise<string> {
  const { data, error } = await api.POST("/api/v1/go/choose", { body: { slug, bookmarkId, remember } });
  if (data === undefined) {
    throw new Error("The choice did not answer with a document", { cause: error });
  }
  if (!isWebAddress(data.url)) {
    throw new Error("The choice did not answer with an http or https address");
  }
  return data.url;
}
