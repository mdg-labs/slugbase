import { SHARE_TARGET_LIST_MAX_LIMIT, type ComponentTypes } from "@slugbase/contracts";
import { keepPreviousData, queryOptions, useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { meQuery } from "../account/me.ts";
import { ApiProblemError, isSessionEnded, type ApiClient } from "../api/client.ts";
import { useIsGranted } from "../entitlements/index.ts";

export type Share = ComponentTypes["schemas"]["BookmarkShare"];
export type ShareList = ComponentTypes["schemas"]["BookmarkShareList"];
export type ShareTarget = ComponentTypes["schemas"]["ShareTarget"];

/** What is shared: a bookmark or a folder of the caller, with the name the dialog's header gives it. */
export interface ShareSubject {
  readonly kind: "bookmark" | "folder";
  readonly id: string;
  readonly name: string;
}

export const SHARES_QUERY_KEY = ["shares"] as const;

/** The shares of a bookmark or a folder and the size of the audience they make; only the owner reads them. */
export function sharesQuery(api: ApiClient, subject: Pick<ShareSubject, "kind" | "id">) {
  const { kind, id } = subject;
  return queryOptions({
    queryKey: [...SHARES_QUERY_KEY, kind, id],
    queryFn: async ({ signal }): Promise<ShareList> => {
      const { data, error } =
        kind === "bookmark"
          ? await api.GET("/api/v1/bookmarks/{id}/shares", { params: { path: { id } }, signal })
          : await api.GET("/api/v1/folders/{id}/shares", { params: { path: { id } }, signal });
      if (data === undefined) {
        throw new Error("The shares request did not answer with a document", { cause: error });
      }
      return data;
    },
  });
}

/** The members and teams that match `text`, other than the caller, for the kinds the workspace may share with; the answer to the text before it stays until the next one is in. */
export function shareTargetsQuery(api: ApiClient, text: string) {
  const q = text.trim();
  return queryOptions({
    queryKey: [...SHARES_QUERY_KEY, "targets", q],
    queryFn: async ({ signal }): Promise<readonly ShareTarget[]> => {
      const { data, error } = await api.GET("/api/v1/share-targets", {
        params: { query: { limit: SHARE_TARGET_LIST_MAX_LIMIT, ...(q === "" ? {} : { q }) } },
        signal,
      });
      if (data === undefined) {
        throw new Error("The share targets request did not answer with a document", { cause: error });
      }
      return data.items;
    },
    placeholderData: keepPreviousData,
  });
}

/** Shares the subject with a member or a team. The answer is the share, whether it was made now (201) or existed already (200). */
export async function addShare(api: ApiClient, subject: ShareSubject, target: Pick<ShareTarget, "kind" | "id">): Promise<Share> {
  const { id } = subject;
  const body = target.kind === "member" ? { accountId: target.id } : { teamId: target.id };
  const { data, error } =
    subject.kind === "bookmark"
      ? await api.POST("/api/v1/bookmarks/{id}/shares", { params: { path: { id } }, body })
      : await api.POST("/api/v1/folders/{id}/shares", { params: { path: { id } }, body });
  if (data === undefined) {
    throw new Error("The share creation did not answer with a document", { cause: error });
  }
  return data;
}

/** Revokes one share of the subject. */
export async function removeShare(api: ApiClient, subject: Pick<ShareSubject, "kind" | "id">, shareId: string): Promise<void> {
  const { id } = subject;
  const { response, error } =
    subject.kind === "bookmark"
      ? await api.DELETE("/api/v1/bookmarks/{id}/shares/{shareId}", { params: { path: { id, shareId } } })
      : await api.DELETE("/api/v1/folders/{id}/shares/{shareId}", { params: { path: { id, shareId } } });
  if (!response.ok) {
    throw new Error("The share revocation did not answer with a problem document", { cause: error });
  }
}

/** The member or team a share is with, in the form a share target has. */
export function targetKey(target: Pick<ShareTarget, "kind" | "id">): string {
  return `${target.kind}:${target.id}`;
}

/** The target a share is with. */
export function shareTargetKey(share: Share): string {
  return targetKey({ kind: share.kind, id: (share.kind === "member" ? share.accountId : share.teamId) ?? "" });
}

/** Why a change to the shares did not go through, as far as the member is told. */
export type ShareFailure =
  | { readonly kind: "notFound" | "targetGone" | "unavailable" }
  | { readonly kind: "rateLimited"; readonly seconds: number | undefined };

/** The failure to show for an error; undefined for an ended session, which the app answers as a whole. */
export function shareFailureOf(error: unknown): ShareFailure | undefined {
  if (isSessionEnded(error)) {
    return undefined;
  }
  if (error instanceof ApiProblemError) {
    switch (error.status) {
      case 404:
        return { kind: "notFound" };
      case 422:
        return { kind: "targetGone" };
      case 429:
        return { kind: "rateLimited", seconds: error.retryAfterSeconds };
    }
  }
  return { kind: "unavailable" };
}

/** Whether the caller owns what has the owner `ownerId`; false while the account is not known. Only the owner manages shares. */
export function useIsOwner(ownerId: string | null): boolean {
  const api = useRouter().options.context.api;
  const me = useQuery({ ...meQuery(api), staleTime: Number.POSITIVE_INFINITY });
  return ownerId !== null && me.data?.account.id === ownerId;
}

/** Whether the workspace may share with members or with teams, which the dialog and its entry points need either of. */
export function useSharingGranted(): boolean {
  const members = useIsGranted("sharing.members");
  const teams = useIsGranted("sharing.teams");
  return members || teams;
}
