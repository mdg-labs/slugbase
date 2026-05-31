import { initContract } from "@ts-rest/core";
import { z } from "zod";

const c = initContract();

export const InvitationRoleSchema = z.enum(["ADMIN", "MEMBER"]);
export type InvitationRole = z.infer<typeof InvitationRoleSchema>;

export const InvitationSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    invitedEmail: z.string().email(),
    role: InvitationRoleSchema,
    invitedByUserId: z.string(),
    acceptedAt: z.string().datetime().nullable(),
    expiresAt: z.string().datetime(),
    createdAt: z.string().datetime(),
  })
  .strict();

export const InvitationMetadataSchema = z
  .object({
    workspaceId: z.string(),
    workspaceName: z.string(),
    inviterName: z.string(),
    invitedEmail: z.string().email(),
    role: InvitationRoleSchema,
    expiresAt: z.string().datetime(),
  })
  .strict();

export const CreateInvitationBodySchema = z
  .object({
    email: z.string().email(),
    role: InvitationRoleSchema,
  })
  .strict();

export const AcceptInvitationBodySchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    password: z.string().min(12).optional(),
  })
  .strict();

export const AcceptInvitationResponseSchema = z
  .object({
    userId: z.string(),
    workspaceId: z.string(),
  })
  .strict();

export const PendingInvitationViewSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    invitedEmail: z.string().email(),
    role: InvitationRoleSchema,
    invitedByUserId: z.string(),
    invitedByName: z.string(),
    expiresAt: z.string().datetime(),
    createdAt: z.string().datetime(),
  })
  .strict();

export type PendingInvitationView = z.infer<typeof PendingInvitationViewSchema>;
export type InvitationMetadata = z.infer<typeof InvitationMetadataSchema>;
export type CreateInvitationBody = z.infer<typeof CreateInvitationBodySchema>;
export type AcceptInvitationBody = z.infer<typeof AcceptInvitationBodySchema>;
export type AcceptInvitationResponse = z.infer<typeof AcceptInvitationResponseSchema>;

export const invitationContract = c.router({
  createInvitation: {
    method: "POST",
    path: "/workspaces/:workspaceId/invitations",
    pathParams: z.object({ workspaceId: z.string() }),
    body: CreateInvitationBodySchema,
    responses: {
      201: InvitationSchema,
      403: z.object({ message: z.string() }).strict(),
      409: z.object({ message: z.string() }).strict(),
    },
    summary: "Create a workspace invitation (OWNER or ADMIN only)",
  },
  getInvitationMetadata: {
    method: "GET",
    path: "/invitations/:token",
    pathParams: z.object({ token: z.string() }),
    responses: {
      200: InvitationMetadataSchema,
      404: z.object({ message: z.string() }).strict(),
      410: z.object({ message: z.string() }).strict(),
    },
    summary: "Get invitation metadata — does not accept the invitation (public)",
  },
  acceptInvitation: {
    method: "POST",
    path: "/invitations/:token/accept",
    pathParams: z.object({ token: z.string() }),
    body: AcceptInvitationBodySchema,
    responses: {
      200: AcceptInvitationResponseSchema,
      404: z.object({ message: z.string() }).strict(),
      409: z.object({ message: z.string() }).strict(),
      410: z.object({ message: z.string() }).strict(),
      422: z.object({ message: z.string() }).strict(),
    },
    summary: "Accept a workspace invitation — creates account if needed (public)",
  },
  listPendingInvitations: {
    method: "GET",
    path: "/workspace/invitations",
    responses: {
      200: z.array(PendingInvitationViewSchema),
      403: z.object({ message: z.string() }).strict(),
    },
    summary: "List pending invitations for the active workspace",
  },
  resendInvitation: {
    method: "POST",
    path: "/workspace/invitations/:id/resend",
    pathParams: z.object({ id: z.string() }),
    body: c.noBody(),
    responses: {
      200: PendingInvitationViewSchema,
      403: z.object({ message: z.string() }).strict(),
      404: z.object({ message: z.string() }).strict(),
      409: z.object({ message: z.string() }).strict(),
    },
    summary: "Resend a pending workspace invitation",
  },
  revokeInvitation: {
    method: "DELETE",
    path: "/workspace/invitations/:id",
    pathParams: z.object({ id: z.string() }),
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      403: z.object({ message: z.string() }).strict(),
      404: z.object({ message: z.string() }).strict(),
      409: z.object({ message: z.string() }).strict(),
    },
    summary: "Revoke a pending workspace invitation",
  },
});
