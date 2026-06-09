export type WorkspacePlan = "free" | "personal" | "team";
export type MemberRole = "OWNER" | "ADMIN" | "MEMBER";
export type InvitationRole = "ADMIN" | "MEMBER";

export interface WorkspaceSummary {
  id: string;
  name: string;
  plan: WorkspacePlan;
  planSeats: number | null;
}

export interface MemberRow {
  id: string;
  userId: string;
  role: MemberRole;
  joinedAt: string;
  name: string;
  email: string;
}

export interface PendingInvitationRow {
  id: string;
  invitedEmail: string;
  role: InvitationRole;
  invitedByName: string;
  expiresAt: string;
}

export interface TeamRow {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
  memberIds: string[];
}

export interface MembersSettingsData {
  workspace: WorkspaceSummary;
  members: MemberRow[];
  pendingInvitations: PendingInvitationRow[];
  teams: TeamRow[];
  currentUserId: string;
  currentUserRole: MemberRole;
  membersForbidden: boolean;
}

export type MembersTabId = "members" | "teams";
