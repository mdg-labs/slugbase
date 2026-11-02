import type { ComponentTypes } from "@slugbase/contracts";
import { infiniteQueryOptions, useQuery, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { ME_QUERY_KEY, meQuery, type Me } from "../account/me.ts";
import { ApiProblemError, type ApiClient } from "../api/client.ts";
import { isReauthCancelled } from "../auth/reauth.ts";
import { WORKSPACE_QUERY_KEY, type Workspace, type WorkspaceRole } from "./workspace.ts";
import { WORKSPACES_QUERY_KEY } from "./workspaces.ts";

export type Member = ComponentTypes["schemas"]["Member"];
export type MemberList = ComponentTypes["schemas"]["MemberList"];

export const MEMBERS_QUERY_KEY = ["members"] as const;

const PAGE_SIZE = 50;

/**
 * The workspace the session acts in, as the cached account has it; undefined while the account is not known or acts in
 * none. A list that belongs to one workspace is keyed by it, because its request names no workspace and a list kept
 * under one key would stand, with its row actions, in the workspace the session has moved to.
 */
export function useActiveWorkspaceId(): string | undefined {
  const api = useRouter().options.context.api;
  const me = useQuery({ ...meQuery(api), staleTime: Number.POSITIVE_INFINITY });
  return me.data?.activeWorkspaceId ?? undefined;
}

/** A page of members with the workspace the account acted in when the page was asked for. */
export type MemberPage = MemberList & { readonly workspaceId: string | null };

/**
 * The members of the workspace the session acts in, a page at a time. The request names no workspace and the list is
 * shared by everything that reads the members, so each page records the workspace the session was in when it was asked
 * for; `membersOf` tells a page's reader whether the pages are its own workspace's.
 */
export function membersQuery(api: ApiClient) {
  return infiniteQueryOptions({
    queryKey: MEMBERS_QUERY_KEY,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal, client }): Promise<MemberPage> => {
      const workspaceId = client.getQueryData<Me>(ME_QUERY_KEY)?.activeWorkspaceId ?? null;
      const { data, error } = await api.GET("/api/v1/members", {
        params: { query: { limit: PAGE_SIZE, ...(pageParam === undefined ? {} : { cursor: pageParam }) } },
        signal,
      });
      if (data === undefined) {
        throw new Error("The members request did not answer with a document", { cause: error });
      }
      return { ...data, workspaceId };
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/** Why a role change was refused, as far as the member is told. */
export type RoleChangeRefusal = "lastOwner" | "forbidden" | "notAMember";

export type RoleChange =
  | { readonly status: "changed"; readonly member: Member }
  | { readonly status: "refused"; readonly refusal: RoleChangeRefusal };

/**
 * Gives the member the role. A refusal the page explains in place (the change would leave the workspace without
 * an owner, the caller may not make it, the account is no longer a member) is an answer; any other failure throws.
 */
export async function changeMemberRole(api: ApiClient, accountId: string, role: WorkspaceRole): Promise<RoleChange> {
  try {
    const { data, error } = await api.PATCH("/api/v1/members/{accountId}", { params: { path: { accountId } }, body: { role } });
    if (data === undefined) {
      throw new Error("The role change did not answer with a document", { cause: error });
    }
    return { status: "changed", member: data };
  } catch (caught) {
    if (caught instanceof ApiProblemError) {
      if (caught.status === 409 && caught.code === "last_owner") {
        return { status: "refused", refusal: "lastOwner" };
      }
      if (caught.status === 403) {
        return { status: "refused", refusal: "forbidden" };
      }
      if (caught.status === 404) {
        return { status: "refused", refusal: "notAMember" };
      }
    }
    throw caught;
  }
}

/**
 * The loaded pages if every one of them was asked for in the workspace, and undefined if there are none or any was asked
 * for in another: after a switch the cache holds the previous workspace's list until the new one is read, and that list is
 * not the reader's to show or to act on (a role change or a removal is applied by the server to the session's workspace).
 */
export function membersOf(data: InfiniteData<MemberPage> | undefined, workspaceId: string): readonly MemberPage[] | undefined {
  return data !== undefined && data.pages.length > 0 && data.pages.every((page) => page.workspaceId === workspaceId) ? data.pages : undefined;
}

/** The loaded pages with the member replaced by its new state. */
export function withMember(data: InfiniteData<MemberPage, string | undefined> | undefined, member: Member): InfiniteData<MemberPage, string | undefined> | undefined {
  return data === undefined
    ? data
    : { ...data, pages: data.pages.map((page) => ({ ...page, items: page.items.map((item) => (item.accountId === member.accountId ? member : item)) })) };
}

/**
 * What the page knows of the caller's own role after the server changed it and rotated the session's token: the
 * account, the workspace and the list of workspaces are updated at once and read again.
 */
export function moveOwnRole(queryClient: QueryClient, role: WorkspaceRole): void {
  queryClient.setQueryData<Me>(ME_QUERY_KEY, (me) =>
    me === undefined
      ? me
      : { ...me, memberships: me.memberships.map((membership) => (membership.workspaceId === me.activeWorkspaceId ? { ...membership, role } : membership)) },
  );
  queryClient.setQueryData<Workspace>(WORKSPACE_QUERY_KEY, (workspace) => (workspace === undefined ? workspace : { ...workspace, role }));
  void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
  void queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY });
  void queryClient.invalidateQueries({ queryKey: WORKSPACES_QUERY_KEY });
}

/**
 * The roles the viewer may give the member (doc 02 section 3.3): an owner any role; an admin admin or member, and
 * nothing for an owner. The member's own role is not among them.
 */
export function assignableRoles(viewer: WorkspaceRole | undefined, member: Member): readonly WorkspaceRole[] {
  if (viewer === "owner") {
    return (["owner", "admin", "member"] as const).filter((role) => role !== member.role);
  }
  if (viewer === "admin" && member.role !== "owner") {
    return (["admin", "member"] as const).filter((role) => role !== member.role);
  }
  return [];
}

export type MembershipEnded = ComponentTypes["schemas"]["MembershipEnded"];

/** What happens to the content of a member who is removed or leaves (doc 02 section 3.6): it goes to another member, or it is deleted. */
export type ContentChoice = { readonly content: "transfer"; readonly transferTo: string } | { readonly content: "delete" };

/** Why a removal or a departure was refused, as far as the member is told. */
export type EndRefusal = "lastOwner" | "forbidden" | "notAMember" | "recipientGone";

export type EndOutcome =
  | { readonly status: "ended"; readonly ended: MembershipEnded }
  | { readonly status: "refused"; readonly refusal: EndRefusal };

function endRefusal(caught: unknown): EndRefusal | undefined {
  if (!(caught instanceof ApiProblemError)) {
    return undefined;
  }
  if (caught.status === 409 && caught.code === "last_owner") {
    return "lastOwner";
  }
  if (caught.status === 403) {
    return "forbidden";
  }
  if (caught.status === 404) {
    return caught.errors.some(({ path }) => path === "transferTo") ? "recipientGone" : "notAMember";
  }
  return undefined;
}

async function ending(request: () => Promise<{ data?: MembershipEnded | undefined; error?: unknown }>): Promise<EndOutcome> {
  try {
    const { data, error } = await request();
    if (data === undefined) {
      throw new Error("The membership change did not answer with a document", { cause: error });
    }
    return { status: "ended", ended: data };
  } catch (caught) {
    const refusal = endRefusal(caught);
    if (refusal === undefined) {
      throw caught;
    }
    return { status: "refused", refusal };
  }
}

/**
 * Removes the member with the content choice. A refusal the page explains (the member is the last owner, the caller
 * may not remove them, they or the recipient are no longer members) is an answer; any other failure throws.
 */
export function removeMember(api: ApiClient, accountId: string, choice: ContentChoice): Promise<EndOutcome> {
  return ending(() => api.DELETE("/api/v1/members/{accountId}", { params: { path: { accountId } }, body: choice }));
}

/** The caller leaves the workspace the session acts in, with the content choice. Refusals are answers, as for a removal. */
export function leaveWorkspace(api: ApiClient, choice: ContentChoice): Promise<EndOutcome> {
  return ending(() => api.POST("/api/v1/workspace/leave", { body: choice }));
}

/** Whether the viewer may remove the member (doc 02 section 3.3): an owner anyone but themself, an admin anyone but an owner or themself. Leaving is a different action. */
export function canRemove(viewer: WorkspaceRole | undefined, viewerId: string | undefined, member: Member): boolean {
  if (viewerId === undefined || member.accountId === viewerId) {
    return false;
  }
  return viewer === "owner" || (viewer === "admin" && member.role !== "owner");
}

/** The members who can receive the content of the one who departs. */
export function recipientsFor(members: readonly Member[], departingId: string): readonly Member[] {
  return members.filter((member) => member.accountId !== departingId);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The recipient the choice starts at (doc 02 section 3.6): the acting admin when one removes a member, and the
 * longest-standing owner other than the one who leaves when a member leaves, as the server resolves it.
 */
export function defaultRecipient(members: readonly Member[], departingId: string, actingId: string | undefined): Member | undefined {
  if (actingId !== undefined && actingId !== departingId) {
    return members.find((member) => member.accountId === actingId);
  }
  return [...members]
    .filter((member) => member.role === "owner" && member.accountId !== departingId)
    .sort((a, b) => compare(a.joinedAt, b.joinedAt) || compare(a.accountId, b.accountId))[0];
}

/** Why an ownership transfer was refused, as far as the member is told. */
export type OwnershipRefusal = "lastOwner" | "forbidden" | "notAMember" | "reauthRequired";

export type OwnershipTransfer =
  | { readonly status: "transferred"; readonly member: Member }
  | { readonly status: "refused"; readonly refusal: OwnershipRefusal };

/**
 * Makes the member an owner and, when `demoteSelf` is set, the caller an admin (doc 02 section 3.3). The call needs a fresh
 * re-authentication; the API client opens the shared prompt for it and sends the call again. A refusal the dialog explains
 * (the prompt was closed, the workspace would be left without an owner, the caller may not transfer, the account is no longer
 * a member) is an answer; any other failure throws.
 */
export async function transferOwnership(api: ApiClient, accountId: string, demoteSelf: boolean): Promise<OwnershipTransfer> {
  try {
    const { data, error } = await api.POST("/api/v1/workspace/transfer-ownership", { body: { accountId, demoteSelf } });
    if (data === undefined) {
      throw new Error("The ownership transfer did not answer with a document", { cause: error });
    }
    return { status: "transferred", member: data };
  } catch (caught) {
    if (isReauthCancelled(caught)) {
      return { status: "refused", refusal: "reauthRequired" };
    }
    if (caught instanceof ApiProblemError) {
      if (caught.status === 401 && caught.code === "reauth_required") {
        return { status: "refused", refusal: "reauthRequired" };
      }
      if (caught.status === 409 && caught.code === "last_owner") {
        return { status: "refused", refusal: "lastOwner" };
      }
      if (caught.status === 403) {
        return { status: "refused", refusal: "forbidden" };
      }
      if (caught.status === 404) {
        return { status: "refused", refusal: "notAMember" };
      }
    }
    throw caught;
  }
}

/** Whether the viewer may transfer ownership to the member (doc 02 section 3.3): an owner, to a member who is not an owner yet and is not themself. */
export function canTransferOwnership(viewer: WorkspaceRole | undefined, viewerId: string | undefined, member: Member): boolean {
  return viewer === "owner" && viewerId !== undefined && member.accountId !== viewerId && member.role !== "owner";
}
