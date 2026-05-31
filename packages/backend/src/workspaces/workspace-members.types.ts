import type { WorkspaceMemberRole } from "./workspace.types.js";

export interface WorkspaceMemberView {
  id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceMemberRole;
  joinedAt: Date;
  name: string;
  email: string;
}

export interface TransferOwnershipBody {
  targetUserId: string;
}

export interface UpdateMemberRoleBody {
  role: WorkspaceMemberRole;
}
