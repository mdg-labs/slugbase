import type { ComponentTypes } from "@slugbase/contracts";
import { infiniteQueryOptions, type InfiniteData } from "@tanstack/react-query";
import { ApiProblemError, type ApiClient } from "../api/client.ts";
import type { WorkspaceRole } from "./workspace.ts";

export type Member = ComponentTypes["schemas"]["Member"];
export type MemberList = ComponentTypes["schemas"]["MemberList"];

export const MEMBERS_QUERY_KEY = ["members"] as const;

const PAGE_SIZE = 50;

/** The members of the workspace the session acts in, a page at a time. */
export function membersQuery(api: ApiClient) {
  return infiniteQueryOptions({
    queryKey: MEMBERS_QUERY_KEY,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const { data, error } = await api.GET("/api/v1/members", {
        params: { query: { limit: PAGE_SIZE, ...(pageParam === undefined ? {} : { cursor: pageParam }) } },
      });
      if (data === undefined) {
        throw new Error("The members request did not answer with a document", { cause: error });
      }
      return data;
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

/** The loaded pages with the member replaced by its new state. */
export function withMember(data: InfiniteData<MemberList, string | undefined> | undefined, member: Member): InfiniteData<MemberList, string | undefined> | undefined {
  return data === undefined
    ? data
    : { ...data, pages: data.pages.map((page) => ({ ...page, items: page.items.map((item) => (item.accountId === member.accountId ? member : item)) })) };
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
