import { initContract } from "@ts-rest/core";
import { z } from "zod";

const c = initContract();

export const WorkspacePlanSchema = z.enum(["free", "personal", "team"]);
export const WorkspaceMemberRoleSchema = z.enum(["OWNER", "ADMIN", "MEMBER"]);

export const WorkspaceSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    plan: WorkspacePlanSchema,
    planSeats: z.number().int().positive().nullable(),
    planArchived: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const WorkspaceMemberSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    userId: z.string(),
    role: WorkspaceMemberRoleSchema,
    joinedAt: z.string().datetime(),
  })
  .strict();

export const CreateWorkspaceBodySchema = z
  .object({
    name: z.string().min(1).max(100),
    slug: z
      .string()
      .min(2)
      .max(48)
      .regex(/^[a-z0-9-]+$/, "Slug must contain only lowercase letters, digits, and hyphens")
      .optional(),
  })
  .strict();

export const UpdateWorkspaceBodySchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    slug: z
      .string()
      .min(2)
      .max(48)
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    planArchived: z.boolean().optional(),
  })
  .strict();

export const AddMemberBodySchema = z
  .object({
    userId: z.string(),
    role: WorkspaceMemberRoleSchema,
  })
  .strict();

export const UpdateMemberRoleBodySchema = z
  .object({
    role: WorkspaceMemberRoleSchema,
  })
  .strict();

export type WorkspacePlan = z.infer<typeof WorkspacePlanSchema>;
export const WorkspaceMemberViewSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    userId: z.string(),
    role: WorkspaceMemberRoleSchema,
    joinedAt: z.string().datetime(),
    name: z.string(),
    email: z.string().email(),
  })
  .strict();

export const TransferOwnershipBodySchema = z
  .object({
    targetUserId: z.string(),
  })
  .strict();

export type WorkspaceMemberView = z.infer<typeof WorkspaceMemberViewSchema>;
export type Workspace = z.infer<typeof WorkspaceSchema>;
export type WorkspaceMember = z.infer<typeof WorkspaceMemberSchema>;
export type CreateWorkspaceBody = z.infer<typeof CreateWorkspaceBodySchema>;
export type UpdateWorkspaceBody = z.infer<typeof UpdateWorkspaceBodySchema>;

export const workspaceContract = c.router({
  createWorkspace: {
    method: "POST",
    path: "/workspaces",
    body: CreateWorkspaceBodySchema,
    responses: {
      201: WorkspaceSchema,
      409: z.object({ message: z.string() }).strict(),
    },
    summary: "Create a new workspace",
  },
  getWorkspace: {
    method: "GET",
    path: "/workspaces/:workspaceId",
    pathParams: z.object({ workspaceId: z.string() }),
    responses: {
      200: WorkspaceSchema,
      404: z.object({ message: z.string() }).strict(),
    },
    summary: "Get a workspace by ID",
  },
  listUserWorkspaces: {
    method: "GET",
    path: "/workspaces",
    responses: {
      200: z.array(WorkspaceSchema),
    },
    summary: "List all workspaces the current user belongs to",
  },
  updateWorkspace: {
    method: "PATCH",
    path: "/workspaces/:workspaceId",
    pathParams: z.object({ workspaceId: z.string() }),
    body: UpdateWorkspaceBodySchema,
    responses: {
      200: WorkspaceSchema,
      403: z.object({ message: z.string() }).strict(),
      404: z.object({ message: z.string() }).strict(),
      409: z.object({ message: z.string() }).strict(),
    },
    summary: "Update workspace settings (ADMIN or OWNER)",
  },
  deleteWorkspace: {
    method: "DELETE",
    path: "/workspaces/:workspaceId",
    pathParams: z.object({ workspaceId: z.string() }),
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      403: z.object({ message: z.string() }).strict(),
      404: z.object({ message: z.string() }).strict(),
    },
    summary: "Delete a workspace (OWNER only)",
  },
  updateActiveWorkspace: {
    method: "PATCH",
    path: "/workspaces/active",
    body: UpdateWorkspaceBodySchema,
    responses: {
      200: WorkspaceSchema,
      403: z.object({ message: z.string() }).strict(),
      409: z.object({ message: z.string() }).strict(),
    },
    summary: "Update the active workspace (ADMIN or OWNER)",
  },
  deleteActiveWorkspace: {
    method: "DELETE",
    path: "/workspaces/active",
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      403: z.object({ message: z.string() }).strict(),
    },
    summary: "Delete the active workspace (OWNER only, cannot delete last workspace)",
  },
  listMembers: {
    method: "GET",
    path: "/workspaces/:workspaceId/members",
    pathParams: z.object({ workspaceId: z.string() }),
    responses: {
      200: z.array(WorkspaceMemberSchema),
    },
    summary: "List all members of a workspace",
  },
  addMember: {
    method: "POST",
    path: "/workspaces/:workspaceId/members",
    pathParams: z.object({ workspaceId: z.string() }),
    body: AddMemberBodySchema,
    responses: {
      201: WorkspaceMemberSchema,
      403: z.object({ message: z.string() }).strict(),
      409: z.object({ message: z.string() }).strict(),
    },
    summary: "Add a member to a workspace (ADMIN or OWNER)",
  },
  updateMemberRole: {
    method: "PATCH",
    path: "/workspaces/:workspaceId/members/:userId",
    pathParams: z.object({ workspaceId: z.string(), userId: z.string() }),
    body: UpdateMemberRoleBodySchema,
    responses: {
      200: WorkspaceMemberSchema,
      403: z.object({ message: z.string() }).strict(),
      404: z.object({ message: z.string() }).strict(),
      422: z.object({ message: z.string() }).strict(),
    },
    summary: "Update a member's role (OWNER only)",
  },
  removeMember: {
    method: "DELETE",
    path: "/workspaces/:workspaceId/members/:userId",
    pathParams: z.object({ workspaceId: z.string(), userId: z.string() }),
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      403: z.object({ message: z.string() }).strict(),
      404: z.object({ message: z.string() }).strict(),
      422: z.object({ message: z.string() }).strict(),
    },
    summary: "Remove a member from a workspace",
  },
  listMemberViews: {
    method: "GET",
    path: "/members",
    responses: {
      200: z.array(WorkspaceMemberViewSchema),
      403: z.object({ message: z.string() }).strict(),
    },
    summary: "List workspace members with profile details (ADMIN+)",
  },
  updateMemberViewRole: {
    method: "PATCH",
    path: "/members/:userId",
    pathParams: z.object({ userId: z.string() }),
    body: UpdateMemberRoleBodySchema,
    responses: {
      200: WorkspaceMemberViewSchema,
      403: z.object({ message: z.string() }).strict(),
      404: z.object({ message: z.string() }).strict(),
      422: z.object({ message: z.string() }).strict(),
    },
    summary: "Update a member role (OWNER only)",
  },
  removeActiveMember: {
    method: "DELETE",
    path: "/members/:userId",
    pathParams: z.object({ userId: z.string() }),
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      403: z.object({ message: z.string() }).strict(),
      404: z.object({ message: z.string() }).strict(),
      422: z.object({ message: z.string() }).strict(),
    },
    summary: "Remove a member from the active workspace",
  },
  transferOwnership: {
    method: "POST",
    path: "/members/transfer-ownership",
    body: TransferOwnershipBodySchema,
    responses: {
      200: z.array(WorkspaceMemberViewSchema),
      403: z.object({ message: z.string() }).strict(),
      404: z.object({ message: z.string() }).strict(),
      422: z.object({ message: z.string() }).strict(),
    },
    summary: "Transfer workspace ownership to another member",
  },
});
