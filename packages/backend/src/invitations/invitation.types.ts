export type InvitationRole = "ADMIN" | "MEMBER";

export interface WorkspaceInvitationRecord {
  id: string;
  workspaceId: string;
  invitedEmail: string;
  role: InvitationRole;
  tokenHash: string;
  invitedByUserId: string;
  acceptedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

export interface CreateInvitationData {
  workspaceId: string;
  invitedEmail: string;
  role: InvitationRole;
  tokenHash: string;
  invitedByUserId: string;
  expiresAt: Date;
}
