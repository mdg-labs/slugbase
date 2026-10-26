import type { ComponentTypes } from "@slugbase/contracts";
import { infiniteQueryOptions } from "@tanstack/react-query";
import { ApiProblemError, isSessionEnded, type ApiClient } from "../api/client.ts";
import type { BookmarkListParams } from "../bookmarks/list-search.ts";

export type GoPreference = ComponentTypes["schemas"]["GoPreference"];
export type GoPreferencePage = ComponentTypes["schemas"]["GoPreferenceList"];

export const GO_PREFERENCES_QUERY_KEY = ["go-preferences"] as const;

/** How many of the remembered choices a request asks for; the API takes at most 100. */
export const GO_PREFERENCE_PAGE_SIZE = 50;

/** The slugs list: the member's own bookmarks that have a slug, forwarding or not (doc 03 section 8), newest first. */
export const SLUG_LIST_PARAMS: BookmarkListParams = { hasSlug: "true", scope: "mine", sort: "recent", limit: 48 };

/** The caller's remembered go choices in the order of their slugs, a page at a time; the next page is asked for with the cursor the last one answered. */
export function goPreferencesQuery(api: ApiClient) {
  return infiniteQueryOptions({
    queryKey: [...GO_PREFERENCES_QUERY_KEY, "list"],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }): Promise<GoPreferencePage> => {
      const { data, error } = await api.GET("/api/v1/me/go-preferences", {
        params: { query: { limit: GO_PREFERENCE_PAGE_SIZE, ...(pageParam === undefined ? {} : { cursor: pageParam }) } },
        signal,
      });
      if (data === undefined) {
        throw new Error("The remembered choices did not answer with a document", { cause: error });
      }
      return data;
    },
    getNextPageParam: (last): string | undefined => last.nextCursor ?? undefined,
  });
}

/** Forgets the caller's remembered choice for `slug`; the bookmark stays. */
export async function deleteGoPreference(api: ApiClient, slug: string): Promise<void> {
  const { response, error } = await api.DELETE("/api/v1/me/go-preferences/{slug}", { params: { path: { slug } } });
  if (!response.ok) {
    throw new Error("The removal of the remembered choice did not answer with a problem document", { cause: error });
  }
}

/** Why a change on the page did not go through, as far as the member is told. */
export type ForwardingFailure = { readonly kind: "notFound" } | { readonly kind: "unavailable" };

/** The failure to show for an error of a removal; undefined for an ended session, which the app answers as a whole. */
export function forwardingFailureOf(error: unknown): ForwardingFailure | undefined {
  if (isSessionEnded(error)) {
    return undefined;
  }
  return error instanceof ApiProblemError && error.status === 404 ? { kind: "notFound" } : { kind: "unavailable" };
}

/** The address of `slug` on the origin the app is served from (doc 02 section 6.1). */
export function goAddress(origin: string, slug: string): string {
  return `${origin.replace(/\/+$/, "")}/go/${slug}`;
}
