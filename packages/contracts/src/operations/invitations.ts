import { z } from "zod";
import { defineOperation, emptyResponse, jsonResponse, problemResponse, rateLimitedResponse } from "./define.ts";
import { DisplayNameSchema, WORKSPACE_ROLES } from "./me.ts";

// The invitations tag of doc 04 section 10.5: the operations that invite a person into the workspace the
// request acts in, and the two that the invited person redeems the emailed token with. An invitation never grants the owner role (doc 02 section 3.4): the request schema has no such
// value, and the table refuses one besides. The response is the invitation as the workspace sees it and never
// carries the token, which exists only in the email that links to `/invite/<token>` and in the one answer of
// `createInvitationLink`, which returns the link of a new token once, for a deployment that cannot send mail.

/** The roles an invitation can grant: an invitation never makes an owner. */
export const INVITATION_ROLES = ["admin", "member"] as const;

export const INVITATION_STATUSES = ["pending", "accepted", "revoked"] as const;

export const CreateInvitationRequestSchema = z
  .strictObject({
    email: z.email().max(320).describe("The address to invite; case does not matter"),
    role: z.enum(INVITATION_ROLES).describe("The role the invited person gets on accepting: admin or member, never owner"),
    teamIds: z
      .array(z.uuid())
      .max(100)
      .optional()
      .describe("The teams the invited person joins on accepting. Until team membership exists a list with an entry is refused with 422 validation_failed"),
  })
  .meta({ id: "CreateInvitationRequest" });

export const InvitationSchema = z
  .strictObject({
    id: z.uuid().describe("The invitation's identifier"),
    email: z.string().describe("The invited address"),
    role: z.enum(WORKSPACE_ROLES).describe("The role the invited person gets on accepting"),
    teamIds: z.array(z.uuid()).describe("The teams the invited person joins on accepting"),
    status: z.enum(INVITATION_STATUSES).describe("Where the invitation stands; only a pending one can be accepted"),
    invitedBy: z.uuid().nullable().describe("The account that sent the invitation last, null once that account is deleted"),
    expiresAt: z.iso.datetime().describe("When the invitation stops working, RFC 3339 UTC"),
    createdAt: z.iso.datetime().describe("When the invitation was first made, RFC 3339 UTC"),
  })
  .meta({ id: "Invitation" });

export const createInvitation = defineOperation({
  method: "post",
  path: "/api/v1/invitations",
  operationId: "createInvitation",
  tag: "invitations",
  summary: "Invite a person to the workspace by email",
  auth: "admin",
  rate: "write",
  entitlement: "members.invite",
  idempotency: true,
  request: { body: CreateInvitationRequestSchema },
  responses: {
    201: jsonResponse(
      "The invitation, pending, with a new token that expires in 7 days and is emailed once as a link to /invite/<token> when the deployment can send mail; the token is in no response. An address that already had a pending invitation is a resend: the same invitation, with the role and teams of this request, a new expiry and a new token, and the earlier link stops working. A retry with the same Idempotency-Key and the same request answers this response again with Idempotency-Replayed: true and sends no second email",
      InvitationSchema,
    ),
    400: problemResponse("The request was malformed, or the Idempotency-Key header is not a UUID"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse(
      "The request did not come from the application itself (cross_site_request), the credential is an API token, the caller is a member and not an admin or owner of the workspace (forbidden), or the workspace does not hold the members.invite entitlement (entitlement_required)",
    ),
    404: problemResponse("The request acts in no workspace"),
    409: problemResponse(
      "The address belongs to a member of the workspace (already_member), or the Idempotency-Key was used before for another request (idempotency_conflict); nothing is written",
    ),
    422: problemResponse("The body did not pass validation: an address that is not one, a role other than admin or member (owner included), or a teamIds with an entry, which cannot be invited into yet"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable, or an earlier request with the same Idempotency-Key is still running"),
  },
});

export const InvitationListItemSchema = InvitationSchema.extend({
  expired: z.boolean().describe("Whether the expiry has passed when the list is read; the invitation is still pending and can be resent, given a link or revoked, but not accepted"),
}).meta({ id: "InvitationListItem" });

export const InvitationListSchema = z
  .strictObject({
    items: z.array(InvitationListItemSchema).describe("One page of the workspace's pending invitations, newest first"),
    nextCursor: z.string().nullable().describe("Passed as `cursor` to get the next page; null on the last page"),
  })
  .meta({ id: "InvitationList" });

export const InvitationListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50).describe("The most invitations to return, at most 100"),
  cursor: z.string().min(1).max(512).optional().describe("The `nextCursor` of the previous page; valid only for the workspace that issued it"),
});

export const InvitationParamsSchema = z.strictObject({
  id: z.uuid().describe("The identifier of an invitation of the workspace, as listed"),
});

export const InvitationLinkSchema = z
  .strictObject({
    invitation: InvitationSchema.describe("The invitation, with the new expiry"),
    link: z.url().describe("The address the invited person opens to accept: the application's origin and /invite/ followed by the token. Returned this once and never again; a later request for a link makes another token and ends this one"),
  })
  .meta({ id: "InvitationLink" });

export const listInvitations = defineOperation({
  method: "get",
  path: "/api/v1/invitations",
  operationId: "listInvitations",
  tag: "invitations",
  summary: "List the workspace's pending invitations",
  auth: "admin",
  rate: "read",
  entitlement: "members.invite",
  request: { query: InvitationListQuerySchema },
  responses: {
    200: jsonResponse("One page of the workspace's pending invitations, newest first, each with whether its expiry has passed; never a token", InvitationListSchema),
    400: problemResponse("The request was malformed, or the cursor is not one this workspace issued"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse(
      "The request did not come from the application itself (cross_site_request), the credential is an API token, the caller is a member and not an admin or owner of the workspace (forbidden), or the workspace does not hold the members.invite entitlement (entitlement_required)",
    ),
    404: problemResponse("The request acts in no workspace"),
    422: problemResponse("The query did not pass validation"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const resendInvitation = defineOperation({
  method: "post",
  path: "/api/v1/invitations/{id}/resend",
  operationId: "resendInvitation",
  tag: "invitations",
  summary: "Email a pending invitation again with a new link",
  auth: "admin",
  rate: "reset",
  entitlement: "members.invite",
  request: { params: InvitationParamsSchema },
  responses: {
    200: jsonResponse(
      "The invitation with a new expiry, 7 days from now. Its token is replaced, so the earlier link stops working at once, and one email carries the new link to the invited address; the token is in no response",
      InvitationSchema,
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse(
      "The request did not come from the application itself (cross_site_request), the credential is an API token, the caller is a member and not an admin or owner of the workspace (forbidden), or the workspace does not hold the members.invite entitlement (entitlement_required)",
    ),
    404: problemResponse("The workspace has no pending invitation with this identifier: another workspace's, an accepted or revoked one and one that never existed are answered alike"),
    422: problemResponse("The identifier did not pass validation"),
    429: rateLimitedResponse("Too many requests, from this address or to the invited address; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable, or the deployment cannot send email (mail_unavailable) and nothing was changed; the link operation serves such a deployment"),
  },
});

export const createInvitationLink = defineOperation({
  method: "post",
  path: "/api/v1/invitations/{id}/link",
  operationId: "createInvitationLink",
  tag: "invitations",
  summary: "Get a link to give a pending invitation's invitee",
  auth: "admin",
  rate: "write",
  entitlement: "members.invite",
  request: { params: InvitationParamsSchema },
  responses: {
    200: jsonResponse(
      "The invitation with a new expiry, 7 days from now, and the link of a new token, returned this once and never again. The earlier link stops working at once, and no email is sent. It works on a deployment that can send mail as on one that cannot",
      InvitationLinkSchema,
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse(
      "The request did not come from the application itself (cross_site_request), the credential is an API token, the caller is a member and not an admin or owner of the workspace (forbidden), or the workspace does not hold the members.invite entitlement (entitlement_required)",
    ),
    404: problemResponse("The workspace has no pending invitation with this identifier: another workspace's, an accepted or revoked one and one that never existed are answered alike"),
    422: problemResponse("The identifier did not pass validation"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const revokeInvitation = defineOperation({
  method: "delete",
  path: "/api/v1/invitations/{id}",
  operationId: "revokeInvitation",
  tag: "invitations",
  summary: "Revoke a pending invitation",
  auth: "admin",
  rate: "write",
  request: { params: InvitationParamsSchema },
  responses: {
    204: emptyResponse(
      "The invitation is revoked and its link is refused from the next request. An invitation that was revoked before is answered the same way, with nothing written, until the retention purge removes its row, 30 days after the revocation",
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse("The request did not come from the application itself (cross_site_request), the credential is an API token, or the caller is a member and not an admin or owner of the workspace (forbidden)"),
    404: problemResponse("The workspace has no pending or revoked invitation with this identifier: another workspace's, an accepted one, one the retention purge removed and one that never existed are answered alike"),
    422: problemResponse("The identifier did not pass validation"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const InspectInvitationRequestSchema = z
  .strictObject({
    token: z.string().min(1).max(256).describe("The token of the invitation link, from the path of /invite/<token>"),
  })
  .meta({ id: "InspectInvitationRequest" });

export const InvitationPreviewSchema = z
  .strictObject({
    workspaceName: z.string().describe("The name of the workspace the invitation is into"),
    inviterName: z.string().nullable().describe("The display name of the account that sent the invitation, null once that account is deleted"),
    email: z.string().describe("The invited address; the account that accepts must hold it, verified"),
    role: z.enum(WORKSPACE_ROLES).describe("The role the invited person gets on accepting"),
    accountExists: z.boolean().describe("Whether an account holds the invited address, which tells the page to ask for a sign-in or for a sign-up"),
  })
  .meta({ id: "InvitationPreview" });

export const AcceptInvitationRequestSchema = z
  .strictObject({
    token: z.string().min(1).max(256).describe("The token of the invitation link, from the path of /invite/<token>"),
    displayName: DisplayNameSchema.optional().describe(
      "The display name of the account to create; surrounding whitespace is removed. Sent with the password, by a person whose invited address has no account, and never with a session",
    ),
    password: z.string().optional().describe("The password of the account to create, 12 to 256 characters. Sent with the display name, by a person whose invited address has no account"),
  })
  .refine((request) => (request.displayName === undefined) === (request.password === undefined), {
    path: ["password"],
    message: "The display name and the password are sent together or not at all",
  })
  .meta({ id: "AcceptInvitationRequest" });

export const InvitationAcceptedSchema = z
  .strictObject({
    workspaceId: z.uuid().describe("The workspace the account joined, which is the session's active workspace from the next request on"),
    role: z.enum(WORKSPACE_ROLES).describe("The role the membership has: exactly the invited role"),
  })
  .meta({ id: "InvitationAccepted" });

export const inspectInvitation = defineOperation({
  method: "post",
  path: "/api/v1/invitations/inspect",
  operationId: "inspectInvitation",
  tag: "invitations",
  summary: "Read what an invitation link is for",
  auth: "anonymous",
  rate: "token_redeem",
  request: { body: InspectInvitationRequestSchema },
  responses: {
    200: jsonResponse(
      "The invitation the token belongs to: the workspace's name, the inviter's name, the invited address, the role and whether an account holds the address. Nothing is changed and the token stays valid",
      InvitationPreviewSchema,
    ),
    400: problemResponse("The request was malformed"),
    403: problemResponse("The request did not come from the application itself (cross_site_request)"),
    410: problemResponse(
      "The token is unknown, expired (7 days), already used, revoked or replaced by a newer one, or its workspace is being deleted; all of them answer alike (token_expired)",
    ),
    422: problemResponse("The body did not pass validation"),
    429: rateLimitedResponse("Too many attempts from this address; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const acceptInvitation = defineOperation({
  method: "post",
  path: "/api/v1/invitations/accept",
  operationId: "acceptInvitation",
  tag: "invitations",
  summary: "Accept an invitation, as the invited account or by creating it",
  auth: "anonymous",
  rate: "token_redeem",
  request: { body: AcceptInvitationRequestSchema },
  responses: {
    200: jsonResponse(
      "A request with the token alone, from the signed-in account whose verified address is the invited one: the token is redeemed, once, the account is a member of the invitation's workspace with exactly the invited role, the invitation is accepted and the session acts in the workspace from its next request on",
      InvitationAcceptedSchema,
    ),
    201: jsonResponse(
      "A request with the token, a display name and a password, for an invited address that has no account: the token is redeemed, once, and in one transaction the account exists, verified whatever the deployment requires of other accounts because the token proves the mailbox, with the invited address, no personal workspace and a full session; it is a member of the invitation's workspace with exactly the invited role, the invitation is accepted and the new session acts in the workspace. A session cookie the request carried is replaced",
      InvitationAcceptedSchema,
      {
        headers: {
          "Set-Cookie": {
            description: "The session cookie: HttpOnly, SameSite=Lax, Path=/, Secure and __Host- prefixed when the deployment is served over https",
            schema: z.string(),
          },
        },
      },
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("A request with the token alone has no session (an API token is not one), or its second factor is not complete"),
    403: problemResponse(
      "The request did not come from the application itself (cross_site_request), or the account's verified email address is not the invited one, an unverified address included (forbidden, field code invitation_email_mismatch), or the deployment's registration policy refused the invited address for the account to create (registration_refused, one answer for every reason). Nothing is written and the invitation stays pending",
    ),
    409: problemResponse(
      "The account is a member of the workspace already (already_member), or a request that creates an account found one holding the invited address (email_taken): the person signs in and accepts with the token alone. Nothing is written and the invitation stays pending",
    ),
    410: problemResponse(
      "The token is unknown, expired (7 days), already used, revoked or replaced by a newer one, or its workspace is being deleted; all of them answer alike (token_expired) and nothing is changed",
    ),
    422: problemResponse(
      "The body did not pass validation (a display name without a password or the reverse included), the password is outside 12 to 256 characters or is on the breached list (weak_password), or the workspace has no seat left (seat_limit_reached); nothing is written and the invitation stays pending",
    ),
    429: rateLimitedResponse("Too many attempts from this address, or from this account; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});
