export type WorkspacePlan = "free" | "personal" | "team";
export type WorkspaceMemberRole = "OWNER" | "ADMIN" | "MEMBER";

export const EMPTY_WORKSPACE_BILLING = {
  billingCustomerId: null,
  billingSubscriptionId: null,
  billingStatus: null,
  billingPeriodEnd: null,
  permanentPersonal: false,
} as const;

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
  billingCustomerId: string | null;
  billingSubscriptionId: string | null;
  billingStatus: string | null;
  billingPeriodEnd: Date | null;
  permanentPersonal: boolean;
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

/** Response shape for GET /workspaces - includes the caller's membership role. */
export interface WorkspaceListItemResponse {
  id: string;
  name: string;
  plan: WorkspacePlan;
  role: WorkspaceMemberRole;
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
  billingCustomerId?: string | null;
  billingSubscriptionId?: string | null;
  billingStatus?: string | null;
  billingPeriodEnd?: Date | null;
  permanentPersonal?: boolean;
}

export interface CreateWorkspaceMemberData {
  workspaceId: string;
  userId: string;
  role: WorkspaceMemberRole;
}

export interface UpdateWorkspaceMemberData {
  role: WorkspaceMemberRole;
}
