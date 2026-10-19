import { z } from "zod";
import { defineOperation, emptyResponse, jsonResponse, problemResponse, rateLimitedResponse } from "./define.ts";
import { WORKSPACE_ROLES } from "./me.ts";

// The invitations tag of doc 04 section 10.5, so far the operation that invites a person into the workspace the
// request acts in. An invitation never grants the owner role (doc 02 section 3.4): the request schema has no such
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
