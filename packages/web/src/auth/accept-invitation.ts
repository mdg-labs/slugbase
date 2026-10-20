import type { ComponentTypes } from "@slugbase/contracts";
import { ApiProblemError, createApiClient, isSessionEnded, type ApiClient } from "../api/client.ts";
import { isMfaRequired } from "./mfa.ts";
import { passwordProblemOf, type PasswordProblem } from "./new-password-field.tsx";

export type InvitationPreview = ComponentTypes["schemas"]["InvitationPreview"];

/** The path of an invitation page; the token is the one segment, so it is encoded as one. */
export function invitationPath(token: string): string {
  return `/invite/${encodeURIComponent(token)}`;
}

/** What opening the link shows: the invitation, or the one answer every dead link gets. */
export type InspectOutcome =
  | { readonly status: "found"; readonly preview: InvitationPreview }
  | { readonly status: "expired" }
  | { readonly status: "rateLimited"; readonly seconds: number | undefined }
  | { readonly status: "unavailable" };

/**
 * Reads what the link is for. An unknown, malformed, used, revoked, replaced or expired token is one `410`
 * (doc 04 section 10.3), so the outcome does not say which. The token goes in this request's body and nowhere else.
 */
export async function inspectInvitation(api: ApiClient, token: string): Promise<InspectOutcome> {
  try {
    const { data, error } = await api.POST("/api/v1/invitations/inspect", { body: { token } });
    if (data === undefined) {
      throw new Error("The invitation did not answer with a document", { cause: error });
    }
    return { status: "found", preview: data };
  } catch (caught) {
    if (caught instanceof ApiProblemError) {
      if (caught.status === 410) {
        return { status: "expired" };
      }
      if (caught.status === 429) {
        return { status: "rateLimited", seconds: caught.retryAfterSeconds };
      }
    }
    return { status: "unavailable" };
  }
}

/** Who is looking at the page. */
export type Viewer =
  | { readonly status: "anonymous" }
  | { readonly status: "secondFactor" }
  | { readonly status: "account"; readonly email: string };

/**
 * Whether the visitor has a session, and whose. The page is made for visitors without one, so this asks through a
 * client of its own: a `401` here is the expected answer, not a session that ended, and must not send the visitor to
 * sign in or empty the cache. Anything but `200` or a `401` is thrown.
 */
export async function lookUpViewer(): Promise<Viewer> {
  try {
    const { data, error } = await createApiClient().GET("/api/v1/me");
    if (data === undefined) {
      throw new Error("The account request did not answer with a document", { cause: error });
    }
    return { status: "account", email: data.account.email };
  } catch (caught) {
    if (isMfaRequired(caught)) {
      return { status: "secondFactor" };
    }
    if (isSessionEnded(caught)) {
      return { status: "anonymous" };
    }
    throw caught;
  }
}

/** Whether two addresses are the same mailbox for this page; the server judges it in the end. */
export function sameAddress(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/** Why an acceptance did not go through, as far as the page tells the visitor. */
export type AcceptRefusal =
  | { readonly status: "expired" }
  | { readonly status: "alreadyMember" }
  | { readonly status: "mismatch" }
  | { readonly status: "refused" }
  | { readonly status: "emailTaken" }
  | { readonly status: "seatLimit" }
  | { readonly status: "weakPassword"; readonly problem: PasswordProblem }
  | { readonly status: "invalid" }
  | { readonly status: "rateLimited"; readonly seconds: number | undefined }
  | { readonly status: "sessionEnded" }
  | { readonly status: "unavailable" };

export type AcceptOutcome = { readonly status: "joined" } | AcceptRefusal;

/** The field code of the `403` that says the account does not hold the invited address, verified. */
const MISMATCH_FIELD_CODE = "invitation_email_mismatch";

function refusalOf(caught: unknown): AcceptRefusal {
  if (isSessionEnded(caught)) {
    // The app takes the visitor to sign in, or to the second step, by itself.
    return { status: "sessionEnded" };
  }
  if (caught instanceof ApiProblemError) {
    if (caught.status === 410) {
      return { status: "expired" };
    }
    if (caught.status === 409 && caught.code === "email_taken") {
      return { status: "emailTaken" };
    }
    if (caught.status === 409 && caught.code === "already_member") {
      return { status: "alreadyMember" };
    }
    if (caught.status === 403 && caught.code === "registration_refused") {
      return { status: "refused" };
    }
    if (caught.status === 403 && caught.errors.some(({ path, code }) => path === "token" && code === MISMATCH_FIELD_CODE)) {
      return { status: "mismatch" };
    }
    if (caught.status === 422) {
      if (caught.code === "seat_limit_reached") {
        return { status: "seatLimit" };
      }
      const problem = passwordProblemOf(caught);
      return problem === undefined ? { status: "invalid" } : { status: "weakPassword", problem };
    }
    if (caught.status === 429) {
      return { status: "rateLimited", seconds: caught.retryAfterSeconds };
    }
  }
  return { status: "unavailable" };
}

/** Accepts as the signed-in account, whose verified address is the invited one: the token alone. */
export async function acceptAsAccount(api: ApiClient, token: string): Promise<AcceptOutcome> {
  try {
    const { response, error } = await api.POST("/api/v1/invitations/accept", { body: { token } });
    if (!response.ok) {
      throw new Error("The acceptance did not answer with a problem document", { cause: error });
    }
    return { status: "joined" };
  } catch (caught) {
    return refusalOf(caught);
  }
}

/**
 * Accepts by creating the account of the invited address, which the server fixes: the token with a name and a
 * password. The answer carries the new session.
 */
export async function acceptWithNewAccount(api: ApiClient, token: string, displayName: string, password: string, signal: AbortSignal): Promise<AcceptOutcome> {
  try {
    const { response, error } = await api.POST("/api/v1/invitations/accept", { body: { token, displayName, password }, signal });
    if (!response.ok) {
      throw new Error("The sign-up did not answer with a problem document", { cause: error });
    }
    return { status: "joined" };
  } catch (caught) {
    return refusalOf(caught);
  }
}
