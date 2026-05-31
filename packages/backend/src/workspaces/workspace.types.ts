export type WorkspacePlan = "free" | "personal" | "team";
export type WorkspaceMemberRole = "OWNER" | "ADMIN" | "MEMBER";

export const ROLE_HIERARCHY: Record<WorkspaceMemberRole, number> = {
  OWNER: 3,
  ADMIN: 2,
  MEMBER: 1,
};

export interface WorkspaceRecord {
  id: string;
  name: string;
  slug: string;
  plan: WorkspacePlan;
  planSeats: number | null;
  planArchived: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkspaceMemberRecord {
  id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceMemberRole;
  joinedAt: Date;
}

export interface CreateWorkspaceData {
  name: string;
  slug: string;
  plan?: WorkspacePlan;
  planSeats?: number | null;
}

export interface UpdateWorkspaceData {
  name?: string;
  slug?: string;
  plan?: WorkspacePlan;
  planSeats?: number | null;
  planArchived?: boolean;
}

export interface CreateWorkspaceMemberData {
  workspaceId: string;
  userId: string;
  role: WorkspaceMemberRole;
}

export interface UpdateWorkspaceMemberData {
  role: WorkspaceMemberRole;
}
