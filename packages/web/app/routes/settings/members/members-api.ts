import {
  apiFetch,
  parseApiErrorMessage,
  serverFetchJson,
} from "../../../lib/client-api-fetch.js";
import type {
  InvitationRole,
  MemberRow,
  MemberRole,
  PendingInvitationRow,
  TeamRow,
  WorkspaceSummary,
} from "./members.types.js";
import { fetchMembersWithFallback } from "../members-fetch.js";

interface ApiWorkspace {
  id: string;
  name: string;
  plan: WorkspaceSummary["plan"];
  planSeats: number | null;
}

interface PaginatedTeams {
  items: TeamRow[];
  total: number;
}

export async function loadMembersSettingsData(
  request: Request,
  currentUserId: string,
): Promise<{
  workspace: WorkspaceSummary;
  members: MemberRow[];
  pendingInvitations: PendingInvitationRow[];
  teams: TeamRow[];
  currentUserRole: MemberRole;
  membersForbidden: boolean;
} | null> {
  const workspace = await serverFetchJson<ApiWorkspace>(request, "/workspaces/active");
  const { members: rawMembers, forbidden } = await fetchMembersWithFallback<MemberRow>(request);
  if (!workspace) return null;

  if (forbidden || !rawMembers) {
    return {
      workspace: {
        id: workspace.id,
        name: workspace.name,
        plan: workspace.plan,
        planSeats: workspace.planSeats,
      },
      members: [],
      pendingInvitations: [],
      teams: [],
      currentUserRole: "ADMIN",
      membersForbidden: true,
    };
  }

  const currentMember = rawMembers.find((member) => member.userId === currentUserId);
  if (!currentMember) return null;

  const pendingInvitations =
    (await serverFetchJson<PendingInvitationRow[]>(request, "/workspace/invitations")) ?? [];
  const teamsResponse = await serverFetchJson<PaginatedTeams>(request, "/teams?pageSize=100");
  const teams = teamsResponse?.items ?? [];

  return {
    workspace: {
      id: workspace.id,
      name: workspace.name,
      plan: workspace.plan,
      planSeats: workspace.planSeats,
    },
    members: rawMembers,
    pendingInvitations,
    teams,
    currentUserRole: currentMember.role,
    membersForbidden: false,
  };
}

export type InvitationDelivery = "email" | "link";

export interface CreateInvitationResult extends PendingInvitationRow {
  acceptUrl?: string;
}

export async function createInvitation(
  workspaceId: string,
  email: string,
  role: InvitationRole,
  delivery: InvitationDelivery = "email",
): Promise<CreateInvitationResult> {
  const res = await apiFetch(`/workspaces/${workspaceId}/invitations`, {
    method: "POST",
    csrf: true,
    body: JSON.stringify({ email, role, delivery }),
  });
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
  const body = (await res.json()) as {
    id: string;
    invitedEmail: string;
    role: InvitationRole;
    invitedByUserId: string;
    expiresAt: string;
    acceptUrl?: string;
  };
  return {
    id: body.id,
    invitedEmail: body.invitedEmail,
    role: body.role,
    invitedByName: "",
    expiresAt: body.expiresAt,
    acceptUrl: body.acceptUrl,
  };
}

export async function getInvitationLink(invitationId: string): Promise<string> {
  const res = await apiFetch(`/workspace/invitations/${invitationId}/link`, {
    method: "POST",
    csrf: true,
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
  const body = (await res.json()) as { acceptUrl: string };
  return body.acceptUrl;
}

export async function updateMemberRole(
  userId: string,
  role: MemberRole,
): Promise<MemberRow> {
  const res = await apiFetch(`/members/${userId}`, {
    method: "PATCH",
    csrf: true,
    body: JSON.stringify({ role }),
  });
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
  return (await res.json()) as MemberRow;
}

export async function removeMember(userId: string): Promise<void> {
  const res = await apiFetch(`/members/${userId}`, { method: "DELETE", csrf: true });
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
}

export async function transferOwnership(targetUserId: string): Promise<MemberRow[]> {
  const res = await apiFetch("/members/transfer-ownership", {
    method: "POST",
    csrf: true,
    body: JSON.stringify({ targetUserId }),
  });
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
  return (await res.json()) as MemberRow[];
}

export async function resendInvitation(invitationId: string): Promise<PendingInvitationRow> {
  const res = await apiFetch(`/workspace/invitations/${invitationId}/resend`, {
    method: "POST",
    csrf: true,
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
  return (await res.json()) as PendingInvitationRow;
}

export async function revokeInvitation(invitationId: string): Promise<void> {
  const res = await apiFetch(`/workspace/invitations/${invitationId}`, {
    method: "DELETE",
    csrf: true,
  });
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
}

export async function createTeam(name: string, description: string): Promise<TeamRow> {
  const res = await apiFetch("/teams", {
    method: "POST",
    csrf: true,
    body: JSON.stringify({ name, description: description || null }),
  });
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
  return (await res.json()) as TeamRow;
}

export async function deleteTeam(teamId: string): Promise<void> {
  const res = await apiFetch(`/teams/${teamId}`, { method: "DELETE", csrf: true });
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
}

export async function addTeamMember(teamId: string, userId: string): Promise<TeamRow> {
  const res = await apiFetch(`/teams/${teamId}/members`, {
    method: "POST",
    csrf: true,
    body: JSON.stringify({ userId }),
  });
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
  return (await res.json()) as TeamRow;
}

export async function removeTeamMember(teamId: string, userId: string): Promise<TeamRow> {
  const res = await apiFetch(`/teams/${teamId}/members/${userId}`, {
    method: "DELETE",
    csrf: true,
  });
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
  return (await res.json()) as TeamRow;
}
