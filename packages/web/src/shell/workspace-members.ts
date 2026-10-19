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
