import { z } from "zod";
import { defineOperation, jsonResponse, problemResponse, rateLimitedResponse } from "./define.ts";
import { WORKSPACE_ROLES } from "./me.ts";

// The invitations tag of doc 04 section 10.5, so far the operation that invites a person into the workspace the
// request acts in. An invitation never grants the owner role (doc 02 section 3.4): the request schema has no such
// value, and the table refuses one besides. The response is the invitation as the workspace sees it and never
// carries the token, which exists only in the email that links to `/invite/<token>`.

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
