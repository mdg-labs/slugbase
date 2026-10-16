import type { ComponentTypes } from "@slugbase/contracts";
import { infiniteQueryOptions } from "@tanstack/react-query";
import { ApiProblemError, type ApiClient } from "../api/client.ts";
import { navigateTo } from "../auth/navigate.ts";
import { oidcStartPath } from "../auth/oidc.ts";
import { ReauthCancelled, type Reauth } from "../auth/reauth.ts";

export type Identity = ComponentTypes["schemas"]["Identity"];

export const IDENTITIES_QUERY_KEY = ["account", "identities"] as const;

const PAGE_SIZE = 100;

/** The identities linked to the account, newest first, a page at a time. */
export function identitiesQuery(api: ApiClient) {
  return infiniteQueryOptions({
    queryKey: IDENTITIES_QUERY_KEY,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const { data, error } = await api.GET("/api/v1/me/identities", {
        params: { query: { limit: PAGE_SIZE, ...(pageParam === undefined ? {} : { cursor: pageParam }) } },
      });
      if (data === undefined) {
        throw new Error("The identities request did not answer with a document", { cause: error });
      }
      return data;
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/** Whether a refusal of an unlink is the rule that one way to sign in must remain (doc 04 section 10.2). */
export function isLastSignInMethod(error: unknown): boolean {
  return (
    error instanceof ApiProblemError &&
    error.status === 422 &&
    error.errors.some(({ path, code }) => path === "id" && code === "last_sign_in_method")
  );
}

/**
 * Sends the member to the provider to link its identity. Starting a link needs a session that re-authenticated
 * within the last ten minutes, and the start is a redirect the browser follows, so a stale session would land on
 * a raw problem document. The start is therefore asked once without following its redirect: a `401
 * reauth_required` opens the re-authentication prompt first, and only once the member has confirmed (or when
 * nothing was wrong) the browser navigates to the start itself. Giving up the prompt throws `ReauthCancelled`.
 */
export async function startLink(api: ApiClient, reauth: Reauth, provider: string, returnTo: string): Promise<void> {
  try {
    await api.GET("/api/v1/auth/oidc/{provider}/start", {
      params: { path: { provider }, query: { intent: "link", returnTo } },
      redirect: "manual",
    });
  } catch (caught) {
    if (!(caught instanceof ApiProblemError && caught.status === 401 && caught.code === "reauth_required")) {
      throw caught;
    }
    if (!(await reauth.request())) {
      throw new ReauthCancelled();
    }
  }
  navigateTo(oidcStartPath(provider, "link", returnTo));
}
