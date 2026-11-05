import type { ComponentTypes } from "@slugbase/contracts";
import { infiniteQueryOptions } from "@tanstack/react-query";
import { isEntitlementRequired } from "../../../../entitlements/entitlements.ts";
import { ApiProblemError, isSessionEnded, type ApiClient } from "../../../../api/client.ts";

export type Invitation = ComponentTypes["schemas"]["Invitation"];
export type InvitationListItem = ComponentTypes["schemas"]["InvitationListItem"];
export type InvitationList = ComponentTypes["schemas"]["InvitationList"];

/** The roles an invitation can carry: it never grants ownership (doc 02 section 3.4). */
export type InvitationRole = "admin" | "member";

export const INVITATIONS_QUERY_KEY = ["invitations"] as const;

/** The key of the invitation list of one workspace; it sits under `INVITATIONS_QUERY_KEY`, so invalidating that key reaches it. */
function invitationsKey(workspaceId: string) {
  return [...INVITATIONS_QUERY_KEY, workspaceId] as const;
}

const PAGE_SIZE = 50;

/** The pending invitations of the workspace the session acts in, newest first, a page at a time, kept under that workspace's key. */
export function invitationsQuery(api: ApiClient, workspaceId: string) {
  return infiniteQueryOptions({
    queryKey: invitationsKey(workspaceId),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const { data, error } = await api.GET("/api/v1/invitations", {
        params: { query: { limit: PAGE_SIZE, ...(pageParam === undefined ? {} : { cursor: pageParam }) } },
        signal,
      });
      if (data === undefined) {
        throw new Error("The invitations request did not answer with a document", { cause: error });
      }
      return data;
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/** Why one address was not invited, as far as the member is told. */
export type InviteRefusal = "alreadyMember" | "invalid" | "unknownTeam" | "teamsNotIncluded" | "rateLimited" | "unavailable" | "failed";

export type InviteOutcome =
  | { readonly status: "invited"; readonly invitation: Invitation }
  | { readonly status: "refused"; readonly refusal: InviteRefusal; readonly requestId: string | undefined };

/**
 * Invites one address with the role, who joins `teamIds` on accepting, under the idempotency key, so a send that is repeated after a lost answer does
 * not invite twice. Every failure of this one address is an answer for the caller to list beside the others'; only
 * an ended session, which the app answers as a whole, is thrown.
 */
export async function inviteByEmail(api: ApiClient, email: string, role: InvitationRole, teamIds: readonly string[], idempotencyKey: string): Promise<InviteOutcome> {
  try {
    const { data, error } = await api.POST("/api/v1/invitations", {
      params: { header: { "Idempotency-Key": idempotencyKey } },
      body: { email, role, teamIds: [...teamIds] },
    });
    if (data === undefined) {
      throw new Error("The invitation did not answer with a document", { cause: error });
    }
    return { status: "invited", invitation: data };
  } catch (caught) {
    if (isSessionEnded(caught)) {
      throw caught;
    }
    if (caught instanceof ApiProblemError) {
      if (caught.status === 409 && caught.code === "already_member") {
        return { status: "refused", refusal: "alreadyMember", requestId: caught.requestId };
      }
      if (isEntitlementRequired(caught)) {
        return { status: "refused", refusal: "teamsNotIncluded", requestId: caught.requestId };
      }
      if (caught.status === 422) {
        const team = caught.errors.some(({ path }) => path.startsWith("teamIds"));
        return { status: "refused", refusal: team ? "unknownTeam" : "invalid", requestId: caught.requestId };
      }
      if (caught.status === 429) {
        return { status: "refused", refusal: "rateLimited", requestId: caught.requestId };
      }
      if (caught.status === 503) {
        return { status: "refused", refusal: "unavailable", requestId: caught.requestId };
      }
      return { status: "refused", refusal: "failed", requestId: caught.requestId };
    }
    return { status: "refused", refusal: "failed", requestId: undefined };
  }
}

export type ResendOutcome =
  | { readonly status: "sent"; readonly invitation: Invitation }
  | { readonly status: "gone" }
  | { readonly status: "mailUnavailable" };

/**
 * Emails a pending invitation again. An invitation the workspace no longer holds as pending, and a server that cannot
 * send mail, are answers the page explains; any other failure throws.
 */
export async function resendInvitation(api: ApiClient, id: string): Promise<ResendOutcome> {
  try {
    const { data, error } = await api.POST("/api/v1/invitations/{id}/resend", { params: { path: { id } } });
    if (data === undefined) {
      throw new Error("The resend did not answer with a document", { cause: error });
    }
    return { status: "sent", invitation: data };
  } catch (caught) {
    if (caught instanceof ApiProblemError) {
      if (caught.status === 404) {
        return { status: "gone" };
      }
      if (caught.status === 503 && caught.code === "mail_unavailable") {
        return { status: "mailUnavailable" };
      }
    }
    throw caught;
  }
}

export type LinkOutcome =
  | { readonly status: "created"; readonly invitation: Invitation; readonly link: string }
  | { readonly status: "gone" };

/** Makes a new copyable link for a pending invitation; the earlier link, mailed or copied, stops working. The link is in this answer only. */
export async function createInvitationLink(api: ApiClient, id: string): Promise<LinkOutcome> {
  try {
    const { data, error } = await api.POST("/api/v1/invitations/{id}/link", { params: { path: { id } } });
    if (data === undefined) {
      throw new Error("The invitation link did not answer with a document", { cause: error });
    }
    return { status: "created", invitation: data.invitation, link: data.link };
  } catch (caught) {
    if (caught instanceof ApiProblemError && caught.status === 404) {
      return { status: "gone" };
    }
    throw caught;
  }
}

export type RevokeOutcome = { readonly status: "revoked" } | { readonly status: "gone" };

/** Revokes a pending invitation. One the workspace no longer holds as pending is `gone`; any other failure throws. */
export async function revokeInvitation(api: ApiClient, id: string): Promise<RevokeOutcome> {
  try {
    const { response, error } = await api.DELETE("/api/v1/invitations/{id}", { params: { path: { id } } });
    if (!response.ok) {
      throw new Error("The revocation did not answer with a problem document", { cause: error });
    }
    return { status: "revoked" };
  } catch (caught) {
    if (caught instanceof ApiProblemError && caught.status === 404) {
      return { status: "gone" };
    }
    throw caught;
  }
}

const EMAIL_PATTERN = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const MAX_EMAIL_LENGTH = 320;

/** Whether the text can be an address; the server judges it in the end. */
export function looksLikeEmail(text: string): boolean {
  return text.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(text);
}

/** The pieces of typed or pasted text that are separated by a comma, a semicolon or white space, without empty ones. */
export function splitAddresses(text: string): readonly string[] {
  return text
    .split(/[\s,;]+/)
    .map((piece) => piece.trim())
    .filter((piece) => piece !== "");
}
